/**
 * Mirrors `@truefoundry/utils-core` SandboxProvider contract for this standalone PoC.
 * Keep shapes aligned with packages/harness/src/core/sandbox/provider/Provider.ts.
 */

export interface ExecSuccessResult {
  success: true;
  response: { exitCode: number; result: string };
}

export interface ExecErrorResult {
  success: false;
  error: string;
}

export type ExecResult = ExecSuccessResult | ExecErrorResult;

export interface SandboxExecParams {
  sandboxId: string;
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutSeconds?: number | undefined;
}

export interface SandboxProvider {
  createSandbox(): Promise<{ sandboxId: string }>;
  exec(params: SandboxExecParams): Promise<ExecResult>;
  getAdditionalInstructions(): string | undefined;
  getToolResultDumpDir(sandboxId: string): string;
  getGitCredentialsPath(sandboxId: string): string;
  downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer>;
  uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void>;
  getNatsBridgeUrl(sandboxId: string): Promise<string>;
}
