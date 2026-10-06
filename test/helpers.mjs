import {createLocalChain} from '../scripts/local-chain.mjs';
import {deployV4Fixture} from '../scripts/local-v4.mjs';

export const tx = async operation => (await operation).wait();

// A test owns its chain and closes it even when setup or an assertion fails.
export async function withLocalChain(run) {
  const chain = await createLocalChain();
  try {
    return await run(chain);
  } finally {
    await chain.close();
  }
}

export function withV4Fixture(run, options = {}) {
  return withLocalChain(async chain => run(chain, await deployV4Fixture(chain, options)));
}
