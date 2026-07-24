/** Command executed in sandbox — exitCode may be non-zero but the infra call succeeded. */
export interface ExecSuccessResult {
  success: true;
  response: { exitCode: number; result: string };
}

/** Sandbox infrastructure failure — command never ran (e.g. network error, auth failure). */
export interface ExecErrorResult {
  success: false;
  error: string;
}

export type ExecResult = ExecSuccessResult | ExecErrorResult;

/** Throws if the exec result indicates failure (infra error or non-zero exit code). */
export function ensureExecSuccess(result: ExecResult): void {
  if (!result.success) {
    throw new Error(result.error);
  }
  if (result.response.exitCode !== 0) {
    throw new Error(`(exit code ${String(result.response.exitCode)}): ${result.response.result}`);
  }
}

export interface SandboxFileInfo {
  size: number;
  isDir: boolean;
}

export interface SandboxProvider {
  createSandbox(): Promise<{ sandboxId: string }>;
  exec(params: {
    sandboxId: string;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<ExecResult>;
  /** Provider-specific instructions appended to the agent system prompt. */
  getAdditionalInstructions(): string | undefined;
  /** Directory inside the sandbox where large tool responses are dumped. */
  getToolResultDumpDir(sandboxId: string): string;
  /** Absolute path for the git credential-store file (per logical sandbox when sharing a pod). */
  getGitCredentialsPath(sandboxId: string): string;
  /** Downloads a file from the sandbox as a Buffer. Throws SandboxFileNotFoundError / SandboxNotAvailableError / SandboxPathIsDirectoryError / SandboxFileTooLargeError. */
  downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer>;
  /** Uploads a file to the sandbox. */
  uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void>;

  /**
   * Returns a ready-to-use `ws(s)://` URL for this sandbox's pod-local NATS broker, which the
   * gateway connects to as the MCP responder. Throws on failure (caller retries on a later exec).
   */
  getNatsBridgeUrl(sandboxId: string): Promise<string>;
}
