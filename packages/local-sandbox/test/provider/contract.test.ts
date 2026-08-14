import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxProviderContractSuite } from '../../../harness/tests/core/sandbox/provider/sandboxProviderContractSuite';
import { LocalSandboxProvider } from '../../src/provider/LocalSandboxProvider';

describe('LocalSandboxProvider (SandboxProvider contract)', () => {
  runSandboxProviderContractSuite(async () => {
    const sandboxRootPathParent = await mkdtemp(join(tmpdir(), 'tfy-local-sandbox-contract-'));
    const provider = new LocalSandboxProvider({
      sandboxRootPathParent,
    });
    return {
      provider,
      dispose: async () => {
        await provider.dispose();
        await rm(sandboxRootPathParent, { recursive: true, force: true });
      },
    };
  });
});
