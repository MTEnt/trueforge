import type { SandboxProvider } from '../../../../src/core/sandbox/provider/Provider';
import { ensureExecSuccess } from '../../../../src/core/sandbox/provider/Provider';

export type SandboxProviderContractFixture = {
  provider: SandboxProvider;
  dispose: () => Promise<void>;
};

/**
 * SandboxProvider contract suite — factory-injected so backends can reuse it.
 * Skips `getNatsBridgeUrl` (Daytona-only; local/SRT providers are not required to implement it).
 */
export function runSandboxProviderContractSuite(
  createFixture: () => SandboxProviderContractFixture | Promise<SandboxProviderContractFixture>,
): void {
  describe('SandboxProvider contract', () => {
    let fixture: SandboxProviderContractFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    }, 120_000);

    afterEach(async () => {
      await fixture.dispose();
    }, 60_000);

    it('exec is stateful across calls in the same sandbox', async () => {
      const { sandboxId } = await fixture.provider.createSandbox();
      const write = await fixture.provider.exec({
        sandboxId,
        command: "printf 'persist-ok\\n' > persist.txt",
      });
      ensureExecSuccess(write);
      const read = await fixture.provider.exec({
        sandboxId,
        command: 'cat persist.txt',
      });
      ensureExecSuccess(read);
      if (!read.success) throw new Error('unreachable');
      expect(read.response.result).toBe('persist-ok\n');
    });

    it('sandboxes are isolated from each other', async () => {
      const a = await fixture.provider.createSandbox();
      const b = await fixture.provider.createSandbox();
      expect(a.sandboxId).not.toBe(b.sandboxId);

      const write = await fixture.provider.exec({
        sandboxId: a.sandboxId,
        command: "printf 'only-in-a\\n' > secret.txt",
      });
      ensureExecSuccess(write);

      const readB = await fixture.provider.exec({
        sandboxId: b.sandboxId,
        command: 'cat secret.txt',
      });
      expect(readB.success).toBe(true);
      if (!readB.success) throw new Error('unreachable');
      expect(readB.response.exitCode).not.toBe(0);
      expect(readB.response.result).not.toMatch(/only-in-a/);
    });

    it('upload then download round-trips bytes', async () => {
      const { sandboxId } = await fixture.provider.createSandbox();
      const payload = Buffer.from('upload-download-contract\n', 'utf8');
      await fixture.provider.uploadFile({
        sandboxId,
        remotePath: 'roundtrip.bin',
        content: payload,
      });
      const downloaded = await fixture.provider.downloadFile({
        sandboxId,
        path: 'roundtrip.bin',
      });
      expect(Buffer.compare(downloaded, payload)).toBe(0);
    });
  });
}
