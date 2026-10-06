// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {GovernanceDeployer} from "./GovernanceDeployer.sol";
import {PermanentLiquidityLocker} from "./PermanentLiquidityLocker.sol";
import {PermanentLiquidityDeployer} from "./PermanentLiquidityDeployer.sol";
import {V4FeeHook} from "./V4FeeHook.sol";
import {FundraisingCurve} from "./libraries/FundraisingCurve.sol";
import {MigrationMath} from "./libraries/MigrationMath.sol";
import {FeeRewardsDeployer} from "./FeeRewardsDeployer.sol";
import {IWeightedToken, IFeeRewardGovernance} from "./ProjectFeeRewards.sol";
import {ITransferRewards} from "./interfaces/ITransferRewards.sol";
import {ProjectTokenDeployer} from "./ProjectTokenDeployer.sol";
import {AllocationVerifier} from "./AllocationVerifier.sol";
import {LPRewardDistributor} from "./LPRewardDistributor.sol";
import {V4FeeHookLP} from "./V4FeeHookLP.sol";
import {ProxyLPRewardsDeployer} from "./upgrades/OperatingRewardsLP.sol";

interface IRegisteredFactory {
    function isProject(address) external view returns (bool);
    function coordinator() external view returns (address);
    function platformTreasury() external view returns (address);
    function depositMigrationFee(address project) external payable;
}
interface IFundedProject {
    function token() external view returns (ProjectToken);
    function target() external view returns (uint256);
    function creator() external view returns (address);
    function coordinator() external view returns (address);
    function migrationFeeBps() external view returns (uint256);
    function SALE_SUPPLY() external view returns (uint256);
}
interface IProxyTemplate {
    function implementation() external view returns (address);
    function authority() external view returns (address);
}
interface ICombinedRewardsTemplate { function rewardsImplementation() external view returns(address); }
interface IProxyPolicy {
    function upgradeAuthority() external view returns (address);
    function implementationAddress() external view returns (address);
}

/// @notice One atomic call creates governance, initializes V4 liquidity, locks
/// the position and funds the dev vault. No arbitrary targets/calldata are accepted.
abstract contract V4MigrationCoordinatorCore is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    IPoolManager public immutable poolManager;
    GovernanceDeployer public immutable governanceDeployer;
    FeeRewardsDeployer public feeRewardsDeployer;
    ProjectTokenDeployer public immutable tokenDeployer;
    PermanentLiquidityDeployer public immutable liquidityDeployer;
    address public immutable bootstrapper;
    IRegisteredFactory public factory;
    V4FeeHook public hook;
    address public dividendService;
    address public allocationVerifier;
    address public swapRouter;
    mapping(address => bool) public migrated;
    bool public upgradeServicesConfigured;
    address[] public upgradeProtocolAddresses;
    LPRewardDistributor public lpDistributor;
    uint256 public migrationFeeBps = MigrationMath.DEFAULT_MIGRATION_FEE_BPS;
    uint256 public constant MAX_MIGRATION_GAS_REFUND = 0.3 ether;
    uint256 public migrationGasRefundLimit = 0.1 ether;
    address public migrationFeeAuthority;
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidMigration();
    error InvalidMigrationGasRefundLimit();
    event Configured(address factory, address hook);
    event ProjectMigrated(address indexed project, bytes32 indexed poolId, address governance, address locker);
    event UpgradeServicesConfigured(address rewardsDeployer, address feePolicy);
    event MigrationFeeChanged(uint256 previousBps, uint256 newBps);
    event MigrationGasRefundLimitChanged(uint256 previousLimit, uint256 newLimit);

    constructor(IPoolManager manager, GovernanceDeployer deployer, address rewardsDeployer_, address tokenDeployer_) {
        if (address(manager).code.length == 0 || address(deployer).code.length == 0) revert InvalidConfiguration();
        poolManager = manager;
        governanceDeployer = deployer;
        bootstrapper = msg.sender;
        migrationFeeAuthority = msg.sender;
        liquidityDeployer = new PermanentLiquidityDeployer();
        if (rewardsDeployer_.code.length == 0 || tokenDeployer_.code.length == 0) revert InvalidConfiguration();
        feeRewardsDeployer = FeeRewardsDeployer(rewardsDeployer_);
        tokenDeployer = ProjectTokenDeployer(tokenDeployer_);
    }

    /// @notice Register protocol recipients before activating this factory.
    function configureServices(address dividends_, address verifier_, address router_) external {
        if (msg.sender != bootstrapper || address(factory) != address(0) || allocationVerifier != address(0)) revert Unauthorized();
        if ((dividends_ != address(0) && dividends_.code.length == 0) || verifier_.code.length == 0 || router_.code.length == 0) revert InvalidConfiguration();
        dividendService = dividends_; allocationVerifier = verifier_; swapRouter = router_;
    }

    /// @notice Optional LP services are frozen before factory activation.
    function configureLPServices(LPRewardDistributor distributor, V4FeeHookLP hook_) external {
        if (msg.sender != bootstrapper || address(factory) != address(0) || address(lpDistributor) != address(0)) revert Unauthorized();
        if (address(distributor).code.length == 0 || distributor.coordinator() != address(this) ||
            address(distributor.poolManager()) != address(poolManager) || hook_.coordinator() != address(this) ||
            address(hook_.lpDistributor()) != address(distributor)) revert InvalidConfiguration();
        lpDistributor = distributor;
        distributor.configureHook(address(hook_));
        upgradeProtocolAddresses.push(address(distributor));
    }

    /// @notice Optional one-time proxy services, before accepting projects.
    /// Deployment wiring freezes at configure(); existing projects cannot be
    /// switched to unrelated deployers or hooks by a bootstrap account.
    function configureUpgradeServices(FeeRewardsDeployer rewardsDeployer_, V4FeeHook hook_, address policy) external {
        if (msg.sender != bootstrapper || address(factory) != address(0) || upgradeServicesConfigured) revert Unauthorized();
        if (address(rewardsDeployer_).code.length == 0 || policy.code.length == 0 ||
            hook_.coordinator() != address(this) || address(hook_.poolManager()) != address(poolManager)) revert InvalidConfiguration();
        address authority = IProxyPolicy(policy).upgradeAuthority();
        IProxyTemplate governanceTemplate = IProxyTemplate(address(governanceDeployer));
        IProxyTemplate rewardsTemplate = IProxyTemplate(address(rewardsDeployer_));
        if (authority.code.length == 0 || governanceTemplate.authority() != authority || rewardsTemplate.authority() != authority) revert InvalidConfiguration();
        migrationFeeAuthority = authority;
        upgradeProtocolAddresses.push(authority);
        upgradeProtocolAddresses.push(policy);
        upgradeProtocolAddresses.push(IProxyPolicy(policy).implementationAddress());
        upgradeProtocolAddresses.push(address(governanceDeployer));
        upgradeProtocolAddresses.push(governanceTemplate.implementation());
        upgradeProtocolAddresses.push(address(rewardsDeployer_));
        // Combined deployment services expose separate governance/reward templates.
        try ICombinedRewardsTemplate(address(rewardsDeployer_)).rewardsImplementation() returns(address impl) {
            upgradeProtocolAddresses.push(impl);
        } catch { upgradeProtocolAddresses.push(rewardsTemplate.implementation()); }
        if (address(lpDistributor) != address(0)) {
            upgradeProtocolAddresses.push(ProxyLPRewardsDeployer(address(rewardsDeployer_)).operatingImplementation());
        }
        // Include the unused default deployer as a known non-voting recipient.
        upgradeProtocolAddresses.push(address(feeRewardsDeployer));
        upgradeServicesConfigured = true;
        feeRewardsDeployer = rewardsDeployer_;
        hook_.configureFeePolicy(policy);
        emit UpgradeServicesConfigured(address(rewardsDeployer_), policy);
    }

    /// @dev One-time bootstrap only; no subsequent admin changes are possible.
    function configure(IRegisteredFactory factory_, V4FeeHook hook_) external {
        if (msg.sender != bootstrapper || address(factory) != address(0)) revert Unauthorized();
        if (address(factory_).code.length == 0 || address(hook_).code.length == 0 ||
            factory_.coordinator() != address(this) || hook_.coordinator() != address(this) ||
            address(hook_.poolManager()) != address(poolManager) || hook_.platform() != factory_.platformTreasury()) {
            revert InvalidConfiguration();
        }
        factory = factory_;
        hook = hook_;
        if (!upgradeServicesConfigured) migrationFeeAuthority = factory_.platformTreasury();
        emit Configured(address(factory_), address(hook_));
    }

    /// @notice Timelock-controlled after upgrade services are configured.
    /// The default starts at 1% and can be adjusted within the hard 1% ceiling.
    /// Existing escrows keep their immutable fee and sale-supply snapshots.
    function setMigrationFeeBps(uint256 feeBps) external {
        if (msg.sender != migrationFeeAuthority) revert Unauthorized();
        if (feeBps > MigrationMath.MAX_MIGRATION_FEE_BPS) revert MigrationMath.InvalidMigrationFee();
        uint256 previous = migrationFeeBps;
        migrationFeeBps = feeBps;
        emit MigrationFeeChanged(previous, feeBps);
    }

    /// @notice Timelock-controlled in production; applies when a project migrates.
    /// The total ETH ceiling cannot exceed 0.3 ETH, regardless of gas prices.
    function setMigrationGasRefundLimit(uint256 limit) external {
        if (msg.sender != migrationFeeAuthority) revert Unauthorized();
        if (limit > MAX_MIGRATION_GAS_REFUND) revert InvalidMigrationGasRefundLimit();
        uint256 previous = migrationGasRefundLimit;
        migrationGasRefundLimit = limit;
        emit MigrationGasRefundLimitChanged(previous, limit);
    }

    /// @notice Immutable economics selector. Legacy suites retain their original rules.
    function fundraisingPolicyVersion() public pure virtual returns (uint256) { return 1; }

    function quote(uint256 target) external view returns (MigrationMath.Quote memory) {
        return MigrationMath.quote(target, migrationFeeBps, fundraisingPolicyVersion() == 2);
    }

    function quoteForFee(uint256 target, uint256 feeBps) external pure returns (MigrationMath.Quote memory) {
        return MigrationMath.quote(target, feeBps, fundraisingPolicyVersion() == 2);
    }

    /// @notice Preview LP tokens at the fixed sale price after the estimated gas fee.
    function quoteAfterGas(uint256 target, uint256 feeBps, uint256 gasRefund) external pure returns (MigrationMath.Quote memory) {
        MigrationMath.Quote memory q = MigrationMath.quote(target, feeBps, fundraisingPolicyVersion() == 2);
        if (gasRefund >= q.ethAmount) revert MigrationMath.InvalidAllocation();
        return MigrationMath.quoteForLiquidity(target, q.saleSupply, q.ethAmount - gasRefund, fundraisingPolicyVersion() == 2);
    }

    function saleSupply(uint256 target) external view returns (uint256) {
        return MigrationMath.quote(target, migrationFeeBps, fundraisingPolicyVersion() == 2).saleSupply;
    }

    function saleSupplyForFee(uint256 target, uint256 feeBps) external pure returns (uint256) {
        return MigrationMath.quote(target, feeBps, fundraisingPolicyVersion() == 2).saleSupply;
    }

    /// @dev Called by an escrow constructor. A standalone call can create only
    /// the caller's own token; it cannot register a project or migrate funds.
    function createToken() external returns (address) {
        return address(tokenDeployer.deploy(msg.sender, address(this), address(poolManager)));
    }

    function migrate() external payable nonReentrant returns (address governanceAddress, address lockerAddress, bytes32 poolId) {
        if (address(factory) == address(0) || !factory.isProject(msg.sender) || migrated[msg.sender]) revert Unauthorized();
        IFundedProject project = IFundedProject(msg.sender);
        uint256 target = project.target();
        if (project.coordinator() != address(this) || msg.value != target) revert InvalidMigration();
        uint256 projectFeeBps = project.migrationFeeBps();
        MigrationMath.Quote memory q = MigrationMath.quote(target, projectFeeBps, fundraisingPolicyVersion() == 2);
        if (q.saleSupply != project.SALE_SUPPLY()) revert InvalidMigration();
        ProjectToken token = project.token();
        if (token.escrow() != msg.sender || token.launched()) revert InvalidMigration();
        migrated[msg.sender] = true;
        ProjectGovernance governance = allocationVerifier == address(0)
            ? governanceDeployer.deploy(project.creator(), token)
            : governanceDeployer.deployCommunity(project.creator(), token, AllocationVerifier(allocationVerifier));
        token.configureFeeRewards(ITransferRewards(address(feeRewardsDeployer.deploy(
            IWeightedToken(address(token)), IFeeRewardGovernance(address(governance)), address(hook)
        ))));
        // Independent ETH custody for developer-funded operating dividends.
        // Both reward vaults read the same token age weights and receive its
        // pre-transfer capture callback, so either round survives mid-scan trades.
        token.configureOperatingRewards(ITransferRewards(address(address(lpDistributor) == address(0)
            ? feeRewardsDeployer.deploy(IWeightedToken(address(token)), IFeeRewardGovernance(address(governance)), address(this))
            : ProxyLPRewardsDeployer(address(feeRewardsDeployer)).deployOperating(
                IWeightedToken(address(token)), IFeeRewardGovernance(address(governance)), address(this))
        )));
        if (upgradeServicesConfigured) token.configureRecoveryAuthority(IProxyTemplate(address(governanceDeployer)).authority());
        address[] memory excluded = new address[](12 + upgradeProtocolAddresses.length);
        excluded[0] = address(governance); excluded[1] = address(governance.devVault());
        excluded[2] = address(governance.insuranceVault()); excluded[3] = address(governance.settlement());
        excluded[4] = address(factory); excluded[5] = address(hook); excluded[6] = dividendService;
        excluded[7] = allocationVerifier; excluded[8] = swapRouter;
        excluded[9] = address(tokenDeployer); excluded[10] = hook.deployedBy();
        excluded[11] = address(liquidityDeployer);
        for (uint256 i; i < upgradeProtocolAddresses.length; ++i) excluded[12 + i] = upgradeProtocolAddresses[i];
        token.registerProtocolAddresses(excluded);
        PermanentLiquidityLocker locker = liquidityDeployer.deploy(
            poolManager, IERC20(address(token)), IHooks(address(hook)), governance, target, projectFeeBps
        );
        token.registerLocker(address(locker));
        IERC20(address(token)).safeTransferFrom(msg.sender, address(locker), q.tokenAmount);
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(address(hook)));
        hook.register(key, address(locker), governance, q.sqrtPriceX96);
        if (address(lpDistributor) != address(0)) lpDistributor.register(key, address(token.operatingRewards()));
        locker.initialize{value: q.ethAmount}();
        governance.devVault().deposit{value: target / 2}();
        factory.depositMigrationFee{value: target / 2 - q.ethAmount}(msg.sender);
        governanceAddress = address(governance);
        lockerAddress = address(locker);
        poolId = PoolId.unwrap(key.toId());
        emit ProjectMigrated(msg.sender, poolId, governanceAddress, lockerAddress);
    }
}

contract V4MigrationCoordinator is V4MigrationCoordinatorCore {
    constructor(IPoolManager manager, GovernanceDeployer deployer, address rewards, address tokens)
        V4MigrationCoordinatorCore(manager, deployer, rewards, tokens) {}
}

/// @notice Reuses stateless deployment services; all project tokens still bind
/// the new coordinator and escrow. These service addresses are immutable.
contract SharedV4MigrationCoordinator is V4MigrationCoordinatorCore {
    constructor(IPoolManager manager, GovernanceDeployer deployer, address rewards, address tokens)
        V4MigrationCoordinatorCore(manager, deployer, rewards, tokens) {
        require(rewards != address(0) && tokens != address(0));
    }
}

/// @notice Pricing and address cap for newly created community projects.
contract CommunityV4MigrationCoordinator is SharedV4MigrationCoordinator {
    constructor(IPoolManager manager, GovernanceDeployer deployer, address rewards, address tokens)
        SharedV4MigrationCoordinator(manager, deployer, rewards, tokens) {}
    function fundraisingPolicyVersion() public pure override returns (uint256) { return 2; }
}
