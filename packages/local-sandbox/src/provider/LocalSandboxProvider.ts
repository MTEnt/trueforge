/**
 * Local SRT SandboxProvider. Code Mode UDS is handle-scoped via {@link CodeModeUdsTransport}.
 */
import type {
  CodeModeTransport,
  ExecResult,
  SandboxBuild,
  SandboxExecParams,
  SandboxProvider,
} from '@truefoundry/trueforge-core/core';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  shellEscape,
  validateNoPathTraversal,
} from '@truefoundry/trueforge-core/core';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CodeModeUdsTransport } from '../core/CodeModeUdsTransport.js';
import { createWorkspace, initSrt, removeWorkspace, resetSrt, runSupervisorSession } from '../core/hostRun.js';
import { XferFileInfoSchema, type XferFileInfo } from '../schemas/xferFileInfo.js';

const DEFAULT_EXEC_TIMEOUT_SECONDS = 60;
const DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface LocalSandboxProviderOptions {
  tenantName: string;
  fileMaxBytesForDownload?: number | undefined;
  defaultExecTimeoutSeconds?: number | undefined;
  /** Root for per-sandbox workspaces; defaults to packages/local-sandbox/workspaces. */
  workspacesRoot?: string | undefined;
}

/** Workspace-relative path for sandboxed commands (avoids /var vs /private/var seatbelt mismatches). */
function sandboxRelativePath(userPath: string): string {
  return userPath.replace(/^\.\/+/, '');
}

function pythonC(code: string, relPath: string): string {
  return `python3 -c ${shellEscape(code)} ${shellEscape(relPath)}`;
}

function statCommand(relPath: string): string {
  const code = [
    'import json, os, sys',
    'p = sys.argv[1]',
    'st = os.stat(p)',
    'print(json.dumps({"size": st.st_size, "isDir": os.path.isdir(p)}))',
  ].join('\n');
  return pythonC(code, relPath);
}

function base64EncodeCommand(relPath: string): string {
  const code = [
    'import base64, sys',
    'p = sys.argv[1]',
    'sys.stdout.write(base64.b64encode(open(p, "rb").read()).decode("ascii"))',
  ].join('\n');
  return pythonC(code, relPath);
}

export class LocalSandboxProvider implements SandboxProvider {
  private readonly tenantName: string;
  private readonly fileMaxBytesForDownload: number;
  private readonly defaultExecTimeoutSeconds: number;
  private readonly workspacesRoot: string | undefined;
  private readonly workspaces = new Map<string, string>();
  private srtInitialized = false;

  /** Local SRT has no image build step — always ready. */
  private static readonly readyBuild: SandboxBuild = {
    status: 'ready',
    reason: null,
    metadata: null,
  };

  constructor(options: LocalSandboxProviderOptions) {
    this.tenantName = options.tenantName;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload ?? DEFAULT_FILE_MAX_BYTES;
    this.defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    this.workspacesRoot = options.workspacesRoot;
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(LocalSandboxProvider.readyBuild);
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(LocalSandboxProvider.readyBuild);
  }

  private async ensureSrt(): Promise<void> {
    if (this.srtInitialized) return;
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('LocalSandboxProvider supports macOS and Linux only');
    }
    await initSrt();
    this.srtInitialized = true;
  }

  private workspaceFor(sandboxId: string): string {
    const workspace = this.workspaces.get(sandboxId);
    if (workspace === undefined) {
      throw new SandboxNotAvailableError(sandboxId);
    }
    return workspace;
  }

  private resolveInWorkspace(workspace: string, userPath: string): string {
    validateNoPathTraversal(userPath);
    const resolved = userPath.startsWith('/') ? resolve(userPath) : resolve(workspace, userPath);
    const root = resolve(workspace);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new SandboxFileNotFoundError(userPath);
    }
    return resolved;
  }

  private async runSandboxCommand(params: {
    workspace: string;
    command: string;
    stdin?: Buffer;
  }): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
    const session = await runSupervisorSession({
      workspace: params.workspace,
      command: params.command,
      ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
      timeoutMs: this.defaultExecTimeoutSeconds * 1000,
    });
    if (session.protocolError !== undefined) {
      throw new Error(session.protocolError);
    }
    return {
      exitCode: session.exitCode,
      stdoutText: session.stdoutText,
      stderrText: session.stderrText,
    };
  }

  private async getFileInfo(params: { workspace: string; relPath: string; userPath: string }): Promise<XferFileInfo> {
    const result = await this.runSandboxCommand({
      workspace: params.workspace,
      command: statCommand(params.relPath),
    });
    if (result.exitCode !== 0) {
      throw new SandboxFileNotFoundError(params.userPath);
    }
    return XferFileInfoSchema.parse(JSON.parse(result.stdoutText.trim()));
  }

  async createSandbox(): Promise<{ sandboxId: string }> {
    await this.ensureSrt();
    const sandboxId = `${this.tenantName}.${randomUUID()}`;
    const workspace = await createWorkspace({
      sandboxId,
      ...(this.workspacesRoot === undefined ? {} : { workspacesRoot: this.workspacesRoot }),
    });
    this.workspaces.set(sandboxId, workspace);
    await mkdir(join(workspace, 'tool-results'), { recursive: true, mode: 0o700 });
    await mkdir(join(workspace, 'uploads'), { recursive: true, mode: 0o700 });
    return { sandboxId };
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    try {
      await this.ensureSrt();
      const workspace = this.workspaceFor(params.sandboxId);
      const cwd =
        params.cwd === undefined || params.cwd === '' ? workspace : this.resolveInWorkspace(workspace, params.cwd);
      const timeoutSeconds = params.timeoutSeconds ?? this.defaultExecTimeoutSeconds;
      const session = await runSupervisorSession({
        workspace,
        command: params.command,
        cwd,
        ...(params.env === undefined ? {} : { env: params.env }),
        timeoutMs: timeoutSeconds * 1000,
      });
      if (session.protocolError !== undefined) {
        return { success: false, error: session.protocolError };
      }
      const result = session.stdoutText + (session.stderrText ? session.stderrText : '');
      return {
        success: true,
        response: { exitCode: session.exitCode, result },
      };
    } catch (error) {
      if (error instanceof SandboxNotAvailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  getAdditionalInstructions(): string {
    return [
      'SANDBOX RULES:',
      "- The Agent's first sandbox command should be `pwd` to discover the working directory.",
      '- ALL file creation and writes MUST stay within that working directory.',
      '- The Agent must NOT write outside the working directory (including host home and /tmp).',
    ].join('\n');
  }

  getToolResultDumpDir(sandboxId: string): string {
    return join(this.workspaceFor(sandboxId), 'tool-results');
  }

  getGitCredentialsPath(sandboxId: string): string {
    return join(this.workspaceFor(sandboxId), '.git-credentials');
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    await this.ensureSrt();
    const workspace = this.workspaceFor(params.sandboxId);
    this.resolveInWorkspace(workspace, params.path);
    const relPath = sandboxRelativePath(params.path);
    const info = await this.getFileInfo({ workspace, relPath, userPath: params.path });
    if (info.isDir) {
      throw new SandboxPathIsDirectoryError(params.path);
    }
    if (info.size > this.fileMaxBytesForDownload) {
      throw new SandboxFileTooLargeError(params.path, info.size, this.fileMaxBytesForDownload);
    }
    const result = await this.runSandboxCommand({
      workspace,
      command: base64EncodeCommand(relPath),
    });
    if (result.exitCode !== 0) {
      throw new SandboxFileNotFoundError(params.path);
    }
    const buf = Buffer.from(result.stdoutText.trim(), 'base64');
    if (buf.length > this.fileMaxBytesForDownload) {
      throw new SandboxFileTooLargeError(params.path, buf.length, this.fileMaxBytesForDownload);
    }
    return buf;
  }

  /** Payload on stdin so large uploads stay off argv. */
  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    await this.ensureSrt();
    if (params.content.length > this.fileMaxBytesForDownload) {
      throw new SandboxFileTooLargeError(params.remotePath, params.content.length, this.fileMaxBytesForDownload);
    }
    const workspace = this.workspaceFor(params.sandboxId);
    // Resolve for traversal checks, but pass workspace-relative paths to the shell.
    // Absolute /var/folders/... paths lose quoting under SRT and become mkdir /var.
    this.resolveInWorkspace(workspace, params.remotePath);
    const remotePath = sandboxRelativePath(params.remotePath);
    const parent = dirname(remotePath);
    const mkdirPart = parent === '.' ? '' : `mkdir -p ${shellEscape(parent)} && `;
    const result = await this.runSandboxCommand({
      workspace,
      command: `${mkdirPart}cat > ${shellEscape(remotePath)}`,
      stdin: params.content,
    });
    if (result.exitCode !== 0) {
      throw new SandboxFileNotFoundError(params.remotePath);
    }
  }

  createCodeModeTransport(): CodeModeTransport {
    return new CodeModeUdsTransport({
      resolveWorkspace: (sandboxId: string) => this.workspaceFor(sandboxId),
    });
  }

  /** PoC helper — not part of SandboxProvider. */
  async destroySandbox(sandboxId: string): Promise<void> {
    const workspace = this.workspaces.get(sandboxId);
    if (workspace === undefined) return;
    this.workspaces.delete(sandboxId);
    await removeWorkspace(workspace);
  }

  /** PoC helper — reset process-scoped SRT after tests. */
  async dispose(): Promise<void> {
    for (const sandboxId of [...this.workspaces.keys()]) {
      await this.destroySandbox(sandboxId);
    }
    if (this.srtInitialized) {
      await resetSrt().catch(() => undefined);
      this.srtInitialized = false;
    }
  }
}
