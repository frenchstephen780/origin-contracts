// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FundraisingCurve} from "./libraries/FundraisingCurve.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {IFundraisingPolicy} from "./interfaces/IFundraisingPolicy.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";
import {PermanentLiquidityLocker} from "./PermanentLiquidityLocker.sol";

interface ICreatorVestingGovernance {
    function terminatedAt() external view returns (uint256);
    function developer() external view returns (address);
}

/// @notice ETH crowdfunding with optional immutable V4 migration configuration.
/// @dev A factory without a coordinator remains refund-only. The V4 factory
/// creates a real token and can atomically migrate through the pinned coordinator.
contract ProjectEscrow is ReentrancyGuard {
    enum State { Funding, AwaitingMigration, Refunding, Launched }

    struct Contribution {
        uint256 ethPaid;
        uint256 tokenUnits;
        bool refunded;
    }

    uint256 public constant IMPLEMENTATION_STAGE = 9;
    bool public constant subscriptionTokensImmediate = true;
    uint256 public constant TOTAL_SUPPLY = FundraisingCurve.TOTAL_SUPPLY;
    uint256 public constant CREATOR_SUPPLY = FundraisingCurve.CREATOR_SUPPLY;
    uint256 public creatorTokensClaimed;
    uint256 public immutable SALE_SUPPLY;
    uint256 public immutable LIQUIDITY_SUPPLY;
    /// @notice Fixed at creation; later platform fee changes apply only to new projects.
    uint256 public immutable migrationFeeBps;
    uint256 public immutable fundraisingPolicyVersion;
    uint256 public constant MAX_FUNDING_DURATION = 15 days;
    uint256 public constant MIGRATION_TIMEOUT = 72 hours;

    address public immutable factory;
    address public immutable creator;
    uint256 public immutable target;
    uint256 public immutable deadline;
    bytes32 public immutable metadataHash;
    string public metadataURI;

    /// @notice Lifetime accepted principal, not the current raw ETH balance.
    uint256 public raised;
    uint256 public totalTokenUnits;
    uint256 public fundedAt;
    uint256 public refundedTotal;
    uint256 public contributorCount;
    mapping(address => Contribution) public contributions;
    IMigrationCoordinator public immutable coordinator;
    ProjectToken public immutable token;
    address public governance;
    address public liquidityLocker;
    bytes32 public poolId;
    uint256 public launchTime;
    mapping(address => bool) public tokensClaimed;
    uint256 public claimedTokenUnits;
    uint256 public constant MIN_FUNDRAISING_TARGET = 1 ether;
    /// @notice Absolute ceiling for the Timelock-configurable reimbursement budget.
    uint256 public constant MAX_MIGRATION_GAS_REFUND = 0.3 ether;
    address public migrationGasBeneficiary;
    /// @notice Coordinator allowance captured at launch, not measured execution gas.
    uint256 public migrationGasUnits;
    /// @notice Legacy getter retained as an alias of the configured allowance.
    /// No gasleft-based measurement is performed.
    uint256 public migrationGasMeteredUnits;
    uint256 public migrationGasPrice;
    uint256 public migrationGasRefund;
    uint256 public migrationGasRefundPending;

    error InvalidCreator();
    error InvalidDeadline();
    error InvalidMetadata();
    error NotFunding();
    error NotRefunding();
    error ZeroContribution();
    error ZeroAllocation();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error InvalidRecipient();
    error NothingToRefund();
    error EtherTransferFailed();
    error DirectEtherNotAccepted();
    error MigrationUnavailable();
    error MigrationGasBudgetExceeded(uint256 gasUnits, uint256 gasPrice, uint256 budget);
    error Unauthorized();
    error NotLaunched();
    error NothingToClaim();

    event ContributionAccepted(
        address indexed contributor,
        uint256 acceptedEth,
        uint256 tokenUnits,
        uint256 excessRefunded,
        uint256 totalRaised
    );
    event FundingTargetReached(uint256 target, uint256 fundedAt, uint256 refundAvailableAt);
    event PrincipalRefunded(address indexed contributor, address indexed recipient, uint256 amount);
    event MigrationCompleted(address governance, address locker, bytes32 indexed poolId, uint256 launchTime);
    event MigrationDeferred();
    event TokensClaimed(address indexed contributor, address indexed recipient, uint256 amount);
    event CreatorTokensClaimed(address indexed creator, uint256 amount, uint256 totalClaimed);
    event MigrationRemainderBurned(uint256 amount);
    event MigrationGasReimbursed(address indexed beneficiary, uint256 gasUnits, uint256 gasPrice, uint256 amount);
    event MigrationGasRefundPaid(address indexed beneficiary, address indexed recipient, uint256 amount);

    constructor(
        address creator_,
        uint256 target_,
        uint256 deadline_,
        bytes32 metadataHash_,
        string memory metadataURI_,
        IMigrationCoordinator coordinator_
    ) {
        if (creator_ == address(0)) revert InvalidCreator();
        FundraisingCurve.validateTarget(target_);
        if (target_ < MIN_FUNDRAISING_TARGET) revert FundraisingCurve.InvalidTarget();
        if (deadline_ < block.timestamp + 1 days || deadline_ - block.timestamp > MAX_FUNDING_DURATION) {
            revert InvalidDeadline();
        }
        uint256 uriLength = bytes(metadataURI_).length;
        if (metadataHash_ == bytes32(0) || uriLength == 0 || uriLength > 2048) revert InvalidMetadata();
        factory = msg.sender;
        creator = creator_;
        target = target_;
        deadline = deadline_;
        metadataHash = metadataHash_;
        metadataURI = metadataURI_;
        coordinator = coordinator_;
        uint256 feeBps = address(coordinator_) == address(0) ? 0 : coordinator_.migrationFeeBps();
        migrationFeeBps = feeBps;
        uint256 policy = 1;
        if (address(coordinator_) != address(0)) {
            try IFundraisingPolicy(address(coordinator_)).fundraisingPolicyVersion() returns (uint256 version) {
                require(version == 1 || version == 2, "Unsupported fundraising policy");
                policy = version;
            } catch {}
        }
        fundraisingPolicyVersion = policy;
        SALE_SUPPLY = address(coordinator_) == address(0) ? FundraisingCurve.SALE_SUPPLY : coordinator_.saleSupplyForFee(target_, feeBps);
        LIQUIDITY_SUPPLY = TOTAL_SUPPLY - CREATOR_SUPPLY - SALE_SUPPLY;
        token = address(coordinator_) == address(0) ? ProjectToken(address(0)) :
            ProjectToken(coordinator_.createToken());
    }

    /// @notice Derived from chain time; no backend/finalize transaction required.
    function configureTokenMetadata(string calldata name_, string calldata symbol_) external {
        if (msg.sender != factory || raised != 0 || address(token) == address(0)) revert Unauthorized();
        token.configureMetadata(name_, symbol_);
    }

    function state() public view returns (State) {
        if (launchTime != 0) return State.Launched;
        if (fundedAt != 0) {
            return block.timestamp >= fundedAt + MIGRATION_TIMEOUT ? State.Refunding : State.AwaitingMigration;
        }
        return block.timestamp >= deadline ? State.Refunding : State.Funding;
    }

    function remainingCapacity() public view returns (uint256) {
        return target - raised;
    }

    /// @notice Zero means the selected project policy has no per-address cap.
    function maxContributionPerAddress() public view returns (uint256) {
        return fundraisingPolicyVersion == 2 ? target / 20 : 0;
    }

    function remainingContributionFor(address contributor) public view returns (uint256) {
        uint256 remaining = remainingCapacity();
        if (fundraisingPolicyVersion == 2) {
            uint256 cap = maxContributionPerAddress();
            uint256 paid = contributions[contributor].ethPaid;
            uint256 allowance = paid >= cap ? 0 : cap - paid;
            if (allowance < remaining) remaining = allowance;
        }
        return remaining;
    }

    /// @notice Token amounts use 18 decimal units and are delivered on contribution.
    function quoteContribution(uint256 offeredEth)
        public view returns (uint256 acceptedEth, uint256 tokenUnits, uint256 excessEth)
    {
        return quoteContributionFor(msg.sender, offeredEth);
    }

    /// @notice An explicit address makes unsigned RPC quotes identical to its purchase.
    function quoteContributionFor(address contributor, uint256 offeredEth)
        public view returns (uint256 acceptedEth, uint256 tokenUnits, uint256 excessEth)
    {
        if (state() != State.Funding) revert NotFunding();
        if (offeredEth == 0) revert ZeroContribution();
        uint256 remaining = remainingContributionFor(contributor);
        acceptedEth = offeredEth > remaining ? remaining : offeredEth;
        tokenUnits = (fundraisingPolicyVersion == 2
            ? FundraisingCurve.communityTokensAt(raised + acceptedEth, target, SALE_SUPPLY)
            : FundraisingCurve.tokensAt(raised + acceptedEth, target, SALE_SUPPLY)) - totalTokenUnits;
        excessEth = offeredEth - acceptedEth;
    }

    function contribute(uint256 minTokenUnits) external payable nonReentrant {
        (uint256 acceptedEth, uint256 tokenUnits, uint256 excessEth) = quoteContribution(msg.value);
        if (tokenUnits == 0) revert ZeroAllocation();
        if (tokenUnits < minTokenUnits) revert SlippageExceeded(tokenUnits, minTokenUnits);

        Contribution storage contribution = contributions[msg.sender];
        if (contribution.ethPaid == 0) ++contributorCount;
        contribution.ethPaid += acceptedEth;
        contribution.tokenUnits += tokenUnits;
        raised += acceptedEth;
        totalTokenUnits += tokenUnits;
        if (address(token) != address(0)) {
            tokensClaimed[msg.sender] = true;
            claimedTokenUnits += tokenUnits;
            token.issueSubscription(msg.sender, tokenUnits);
            emit TokensClaimed(msg.sender, msg.sender, tokenUnits);
        }

        if (raised == target) {
            fundedAt = block.timestamp;
            emit FundingTargetReached(target, fundedAt, fundedAt + MIGRATION_TIMEOUT);
        }
        emit ContributionAccepted(msg.sender, acceptedEth, tokenUnits, excessEth, raised);

        // A recipient that refuses its excess rolls back its own purchase only.
        if (excessEth != 0) _sendEth(payable(msg.sender), excessEth);
        // Migration is a separate transaction. A final investor never pays its gas.
    }

    /// @notice Backend-only migration with no caller-supplied business parameters.
    /// An eth_call simulation returns the currently configured reimbursement
    /// allowance; the execution gas limit and fee parameters belong to the transaction.
    function migrate() external nonReentrant returns (uint256 reimbursedGasUnits) {
        _migrate();
        return migrationGasUnits;
    }

    /// @notice Current shared budget, default 0.1 ETH; absolute ceiling 0.3 ETH.
    function migrationGasRefundLimit() public view returns (uint256) {
        if (address(coordinator) == address(0)) return 0;
        uint256 configured = coordinator.migrationGasRefundLimit();
        return configured > MAX_MIGRATION_GAS_REFUND ? MAX_MIGRATION_GAS_REFUND : configured;
    }

    /// @notice Backend migration account; no transaction can replace this authority.
    function migrationExecutor() public view returns (address) {
        return address(coordinator) == address(0) ? address(0) : coordinator.migrationExecutor();
    }

    function _migrate() private {
        if (address(coordinator) == address(0)) revert MigrationUnavailable();
        if (msg.sender != migrationExecutor()) revert Unauthorized();
        if (state() != State.AwaitingMigration) revert MigrationUnavailable();
        uint256 reimbursementLimit = migrationGasRefundLimit();
        uint256 reimbursementUnits = coordinator.migrationReimbursementGasUnits();
        // Reject rather than truncate reimbursement. Division also avoids an
        // overflow at an extreme effective transaction fee.
        if (tx.gasprice != 0 && reimbursementUnits > reimbursementLimit / tx.gasprice) {
            revert MigrationGasBudgetExceeded(reimbursementUnits, tx.gasprice, reimbursementLimit);
        }
        token.approve(address(coordinator), LIQUIDITY_SUPPLY);
        (governance, liquidityLocker, poolId) = coordinator.migrate{value: target}();
        token.approve(address(coordinator), 0);
        uint256 retained = SALE_SUPPLY - claimedTokenUnits + CREATOR_SUPPLY;
        uint256 remainder = token.balanceOf(address(this)) - retained;
        if (remainder != 0) {
            token.burn(remainder);
            emit MigrationRemainderBurned(remainder);
        }
        if (token.balanceOf(address(this)) != retained) revert MigrationUnavailable();
        migrationGasBeneficiary = msg.sender;
        migrationGasMeteredUnits = reimbursementUnits;
        migrationGasUnits = reimbursementUnits;
        migrationGasPrice = tx.gasprice;
        // Validate against actual LP funds before multiplying, including overflow.
        uint256 available = PermanentLiquidityLocker(payable(liquidityLocker)).initialEthBudget();
        if (tx.gasprice != 0 && migrationGasUnits > (available - 1) / tx.gasprice) {
            revert PermanentLiquidityLocker.InsufficientLiquidityBudget(available, migrationGasUnits, tx.gasprice);
        }
        uint256 requestedRefund = migrationGasUnits * tx.gasprice;
        migrationGasRefund = PermanentLiquidityLocker(payable(liquidityLocker)).finalizeMigration(requestedRefund);
        migrationGasRefundPending = migrationGasRefund;
        emit MigrationGasReimbursed(msg.sender, migrationGasUnits, tx.gasprice, migrationGasRefund);
        launchTime = block.timestamp;
        token.launch();
        emit MigrationCompleted(governance, liquidityLocker, poolId, launchTime);
        if (migrationGasRefund != 0) {
            // Rejecting or complex wallet callbacks cannot roll back a launch.
            migrationGasRefundPending = 0;
            (bool paid,) = payable(msg.sender).call{value: migrationGasRefund, gas: 30_000}("");
            if (paid) emit MigrationGasRefundPaid(msg.sender, msg.sender, migrationGasRefund);
            else migrationGasRefundPending = migrationGasRefund;
        }
    }

    function claimMigrationGasRefund(address payable recipient) external nonReentrant {
        if (msg.sender != migrationGasBeneficiary) revert Unauthorized();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = migrationGasRefundPending;
        if (amount == 0) revert NothingToClaim();
        migrationGasRefundPending = 0;
        _sendEth(recipient, amount);
        emit MigrationGasRefundPaid(msg.sender, recipient, amount);
    }

    function claimTokens(address recipient) external nonReentrant {
        if (state() != State.Launched) revert NotLaunched();
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 amount = contributions[msg.sender].tokenUnits;
        if (amount == 0 || tokensClaimed[msg.sender]) revert NothingToClaim();
        tokensClaimed[msg.sender] = true;
        claimedTokenUnits += amount;
        token.claim(msg.sender, recipient, amount);
        emit TokensClaimed(msg.sender, recipient, amount);
    }

    /// @notice Cumulative cliffs from actual launch; percentages use initial supply.
    /// Unclaimed reserve stays in this excluded escrow with no votes or age.
    function creatorTokensVested() public view returns (uint256) {
        if (launchTime == 0) return 0;
        uint256 cutoff = block.timestamp;
        uint256 endedAt = ICreatorVestingGovernance(governance).terminatedAt();
        if (endedAt != 0 && endedAt < cutoff) cutoff = endedAt;
        uint256 elapsed = cutoff - launchTime;
        if (elapsed >= 180 days) return CREATOR_SUPPLY;
        if (elapsed >= 60 days) return TOTAL_SUPPLY * 250 / 10_000;
        if (elapsed >= 30 days) return TOTAL_SUPPLY * 100 / 10_000;
        if (elapsed >= 15 days) return TOTAL_SUPPLY * 50 / 10_000;
        return 0;
    }

    function claimableCreatorTokens() public view returns (uint256) {
        return creatorTokensVested() - creatorTokensClaimed;
    }

    /// @notice Project management carries the remaining reserve and refundable deposit.
    /// Before migration there is no management handover, so the original creator owns it.
    function creatorBeneficiary() public view returns (address) {
        return governance == address(0) ? creator : ICreatorVestingGovernance(governance).developer();
    }

    function claimCreatorTokens() external nonReentrant {
        if (launchTime == 0) revert NotLaunched();
        address beneficiary = creatorBeneficiary();
        if (msg.sender != beneficiary) revert Unauthorized();
        uint256 amount = claimableCreatorTokens();
        if (amount == 0) revert NothingToClaim();
        creatorTokensClaimed += amount;
        if (!token.transfer(beneficiary, amount)) revert NothingToClaim();
        emit CreatorTokensClaimed(beneficiary, amount, creatorTokensClaimed);
    }

    function refundableAmount(address contributor) public view returns (uint256) {
        if (state() != State.Refunding) return 0;
        Contribution storage contribution = contributions[contributor];
        return contribution.refunded ? 0 : contribution.ethPaid;
    }

    /// @notice Only the original contributor chooses where its refund is paid.
    /// A contract wallet may choose another recipient if it cannot receive ETH.
    function refund(address payable recipient) external nonReentrant {
        if (state() != State.Refunding) revert NotRefunding();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        Contribution storage contribution = contributions[msg.sender];
        uint256 amount = contribution.ethPaid;
        if (amount == 0 || contribution.refunded) revert NothingToRefund();

        contribution.refunded = true;
        refundedTotal += amount;
        if (address(token) != address(0)) token.burnSubscription(msg.sender, contribution.tokenUnits);
        emit PrincipalRefunded(msg.sender, recipient, amount);
        _sendEth(recipient, amount);
    }

    /// @notice Accepted principal still owed to contributors, ignoring forced ETH.
    function accountedPrincipal() public view returns (uint256) {
        return launchTime == 0 ? raised - refundedTotal : 0;
    }

    function unaccountedSurplus() external view returns (uint256) {
        return address(this).balance - accountedPrincipal() - migrationGasRefundPending;
    }

    function _sendEth(address payable recipient, uint256 amount) private {
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert EtherTransferFailed();
    }

    receive() external payable {
        if (msg.sender != liquidityLocker || liquidityLocker == address(0) || launchTime != 0) revert DirectEtherNotAccepted();
    }
}
