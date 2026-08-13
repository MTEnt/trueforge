/**
 * Host-side sandboxed exec (in-process supervisor).
 * Only the untrusted command argv is SRT-wrapped; the host owns Code Mode UDS.
 */
import { getDefaultWritePaths, SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameParser } from './frame.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root from src/ or dist/src/ (Jest runs TypeScript source). */
function packageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'fixtures'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`local-sandbox package root not found from ${startDir}`);
    }
    dir = parent;
  }
}
const ROOT = packageRoot(HERE);
const FIXTURES = join(ROOT, 'fixtures');
/** SRT ships Linux helpers (e.g. apply-seccomp) under vendor/; the wrapped command must read them. */
// Package-root resolve (not app-module loading): Jest's CJS transform breaks import.meta.resolve.
const SRT_VENDOR = join(
  dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')),
  'vendor',
);

/**
 * Cap for buffered stdout+stderr per exec.
 * Sized for base64 of a max-sized download (10 MiB → ~13.3 MiB) plus headroom.
 */
export const MAX_OUTPUT_BYTES = 14 * 1024 * 1024;

/**
 * PATH for sandboxed commands — must stay aligned with allowRead exec roots.
 * On macOS, prefer Homebrew ahead of `/usr/bin` shims (those need Xcode select
 * paths that we intentionally do not allow-read).
 */
export const COMMAND_PATH =
  process.platform === 'darwin' ? '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' : '/usr/bin:/bin:/usr/sbin:/sbin';

export type SessionResult = {
  stdoutText: string;
  stderrText: string;
  exitCode: number;
  protocolError: string | undefined;
  timedOut: boolean;
  /** Process-group leader pid of the sandboxed command (Unix). */
  childPid: number | undefined;
  /** Host Code Mode UDS path for this exec (if created). */
  codeModeSockPath: string | undefined;
};

/**
 * SRT always unions getDefaultWritePaths() into allowWrite. There is no config
 * flag to disable that. Deny the shared/host defaults (not /dev/*) so they are
 * not usable as cross-sandbox writable storage. denyWrite wins over allowWrite.
 */
function denySharedDefaultWritePaths(): string[] {
  return getDefaultWritePaths().filter(path => !path.startsWith('/dev/'));
}

function platformAllowRead(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/usr/lib',
        '/System/Library',
        '/Library',
        '/private/var/db/dyld',
        '/private/var/select',
        '/opt/homebrew',
        '/dev',
      ];
    case 'linux':
      return [
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/lib',
        '/lib64',
        '/usr/lib',
        '/usr/lib64',
        '/usr/local',
        '/etc',
        '/dev',
        '/proc',
        '/sys',
        '/tmp',
        SRT_VENDOR,
      ];
    default:
      throw new Error(`unsupported platform for filesystemPolicy: ${process.platform}`);
  }
}

/**
 * Policy for the untrusted command only (deny-by-default reads).
 * The host (in-process supervisor) is never placed under this policy.
 */
function filesystemPolicy(workspace: string): {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
} {
  return {
    allowWrite: [workspace],
    denyWrite: denySharedDefaultWritePaths(),
    denyRead: ['/'],
    allowRead: [workspace, ...platformAllowRead()],
  };
}

/** Curated env for the sandboxed command — never the full host process.env. */
function commandEnv(workspace: string, extra?: Record<string, string>): Record<string, string> {
  const tmp = join(workspace, '.tmp');
  const home = join(workspace, '.home');
  const locked = {
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PATH: COMMAND_PATH,
  };
  return {
    ...extra,
    ...locked,
  };
}

/** Session filesystem floor (per-exec customConfig still tightens allowWrite/allowRead). */
function sessionFilesystem() {
  return {
    allowWrite: [] as string[],
    denyWrite: denySharedDefaultWritePaths(),
    denyRead: ['/'],
    allowRead: platformAllowRead(),
  };
}

/**
 * AF_UNIX policy is session-scoped only (wrap customConfig cannot set it).
 * - Linux: allowAllUnixSockets; pathname connect still needs FS allowRead (bwrap).
 * - macOS: allowAllUnixSockets does NOT consult allowRead for connect — use
 *   allowUnixSockets subpath, synced at workspace create/remove.
 */
function sessionNetwork(unixSockets?: string[]) {
  if (process.platform === 'linux') {
    return {
      allowedDomains: [] as string[],
      deniedDomains: [] as string[],
      allowAllUnixSockets: true,
    };
  }
  return {
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
    allowAllUnixSockets: false,
    allowUnixSockets: unixSockets ?? [],
  };
}

/** Active workspace roots allowed for macOS pathname UDS (seatbelt subpath). */
const darwinUnixSocketWorkspaces = new Set<string>();

function syncDarwinUnixSockets(): void {
  if (process.platform !== 'darwin') return;
  if (SandboxManager.getConfig() === undefined) return;
  SandboxManager.updateConfig({
    network: sessionNetwork([...darwinUnixSocketWorkspaces]),
    filesystem: sessionFilesystem(),
  });
}

export async function createWorkspace(params?: { sandboxId?: string; workspacesRoot?: string }): Promise<string> {
  const root = params?.workspacesRoot ?? join(ROOT, 'workspaces');
  const name = params?.sandboxId ?? `poc-${randomUUID()}`;
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, '.tmp'), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, '.home'), { recursive: true, mode: 0o700 });
  darwinUnixSocketWorkspaces.add(workspace);
  syncDarwinUnixSockets();
  return workspace;
}

export async function removeWorkspace(workspace: string): Promise<void> {
  darwinUnixSocketWorkspaces.delete(workspace);
  syncDarwinUnixSockets();
  await rm(workspace, { recursive: true, force: true });
}

/**
 * Process-scoped SRT init. Per-exec filesystem policy is applied in
 * {@link runSupervisorSession} via wrapWithSandboxArgv customConfig.
 */
export async function initSrt(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('this PoC supports macOS and Linux only');
  }

  await SandboxManager.initialize({
    network: sessionNetwork([...darwinUnixSocketWorkspaces]),
    filesystem: sessionFilesystem(),
  });
}

export async function resetSrt(): Promise<void> {
  await SandboxManager.reset();
}

function toolRequestId(request: object): string | undefined {
  if (!('request_id' in request)) return undefined;
  const value = Reflect.get(request, 'request_id');
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function childToolResponseFrame(requestId: string, response: unknown): Record<string, unknown> {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('tool response must be an object');
  }
  const frame: Record<string, unknown> = { request_id: requestId };
  for (const key of Reflect.ownKeys(response)) {
    if (typeof key !== 'string' || key === 'request_id') continue;
    frame[key] = Reflect.get(response, key);
  }
  return frame;
}

/**
 * Tear down the sandboxed exec and every process in its group.
 * Child is spawned as a process-group leader (`detached: true` on Unix).
 */
export function killExecTree(child: ChildProcess | undefined): void {
  if (!child) return;
  const pid = child.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // ESRCH if the group is already gone — fall through.
    }
  }
  if (!child.killed) {
    child.kill('SIGKILL');
  }
}

async function listenCodeModeSock(sockPath: string): Promise<Server> {
  await unlink(sockPath).catch(() => undefined);
  const server = createServer();
  // macOS sun_path ~104 bytes: bind via basename after chdir when absolute is too long.
  const shortBind = process.platform === 'darwin' && Buffer.byteLength(sockPath) >= 104;
  const bindPath = shortBind ? basename(sockPath) : sockPath;
  const prevCwd = shortBind ? process.cwd() : undefined;
  if (shortBind) {
    process.chdir(dirname(sockPath));
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    if (prevCwd !== undefined) {
      process.chdir(prevCwd);
    }
  }
  return server;
}

async function closeCodeModeSock(server: Server | undefined, sockPath: string): Promise<void> {
  if (server !== undefined) {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
  await unlink(sockPath).catch(() => undefined);
}

/**
 * Run one SRT-wrapped command. Host owns Code Mode UDS (listen/accept) in-process.
 */
export async function runSupervisorSession(params: {
  workspace: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Optional stdin bytes for the sandboxed command (e.g. upload payload). */
  stdin?: Buffer;
  onToolRequest?: (req: unknown) => unknown | Promise<unknown>;
  /** Host-visible pid of the sandboxed process-group leader (after spawn). */
  onChildSpawn?: (pid: number) => void;
  timeoutMs?: number;
}): Promise<SessionResult> {
  const { workspace, command, cwd = workspace, env, stdin, onToolRequest, onChildSpawn, timeoutMs = 15_000 } = params;

  // Workspace top-level sock. macOS sun_path is ~104 bytes — absolute workspace paths
  // often overflow, so TFY_MCP_SOCK may be the basename (clients connect with cwd=workspace).
  const sockName = `t${randomUUID().replaceAll('-', '').slice(0, 8)}.sock`;
  const sockPath = join(workspace, sockName);
  const sockForClient = process.platform === 'darwin' && Buffer.byteLength(sockPath) >= 104 ? sockName : sockPath;
  const server = await listenCodeModeSock(sockPath);

  const wrap = await SandboxManager.wrapWithSandboxArgv(
    command,
    '/bin/bash',
    {
      filesystem: filesystemPolicy(workspace),
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    },
    undefined,
    workspace,
    { commandId: randomUUID(), commandText: command },
  );

  const [argv0, ...argvRest] = wrap.argv;
  if (argv0 === undefined) {
    await closeCodeModeSock(server, sockPath);
    throw new Error('wrapWithSandboxArgv returned empty argv');
  }

  // Curated env only — do not spread wrap.env (it can carry ambient host secrets).
  const childEnv: NodeJS.ProcessEnv = {
    ...commandEnv(workspace, env),
    TFY_MCP_SOCK: sockForClient,
  };

  const child = spawn(argv0, argvRest, {
    cwd,
    env: childEnv,
    shell: false,
    // Detached process groups break stdin forwarding for upload (`cat` via pipe) under Jest.
    detached: stdin === undefined && process.platform !== 'win32',
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (child.pid !== undefined) {
    onChildSpawn?.(child.pid);
  }
  if (stdin !== undefined) {
    const stdinStream = child.stdin;
    if (stdinStream === null) {
      killExecTree(child);
      await closeCodeModeSock(server, sockPath);
      SandboxManager.cleanupAfterCommand();
      throw new Error('stdin unavailable for sandboxed command');
    }
    stdinStream.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      stdinStream.end(stdin, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  const inflight = new Set<string>();
  let stdoutText = '';
  let stderrText = '';
  let bufferedOutput = 0;
  let protocolError: string | undefined;
  let timedOut = false;
  let closed = false;

  const ignoreStreamError = (
    stream:
      | {
          on: (event: 'error', cb: (err: Error) => void) => void;
        }
      | null
      | undefined,
  ): void => {
    stream?.on('error', () => undefined);
  };

  const finishConn = (socket: Socket, requestId: string, response: unknown): void => {
    try {
      socket.write(encodeFrame(childToolResponseFrame(requestId, response)));
    } catch (error) {
      protocolError = error instanceof Error ? error.message : String(error);
      killExecTree(child);
    } finally {
      socket.end();
    }
  };

  const handleConnection = (socket: Socket): void => {
    const parser = new FrameParser();
    ignoreStreamError(socket);
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = parser.push(chunk);
        if (frames.length === 0) return;
        if (frames.length !== 1) {
          protocolError = 'Code Mode UDS expects one request frame per connection';
          killExecTree(child);
          socket.destroy();
          return;
        }
        const request = frames[0];
        if (typeof request !== 'object' || request === null || !('op' in request)) {
          protocolError = 'invalid inner tool request';
          killExecTree(child);
          socket.destroy();
          return;
        }
        const requestId = toolRequestId(request);
        if (requestId === undefined) {
          protocolError = 'tool request missing request_id';
          killExecTree(child);
          socket.destroy();
          return;
        }
        if (inflight.has(requestId)) {
          protocolError = `duplicate request_id ${requestId}`;
          killExecTree(child);
          socket.destroy();
          return;
        }
        inflight.add(requestId);
        void (async () => {
          if (!onToolRequest) {
            finishConn(socket, requestId, {
              ok: false,
              error: 'no tool handler configured',
              source: 'bridge',
            });
            inflight.delete(requestId);
            return;
          }
          try {
            const result = await onToolRequest(request);
            finishConn(socket, requestId, { ok: true, result });
          } catch (error) {
            finishConn(socket, requestId, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              source: 'gateway',
            });
          } finally {
            inflight.delete(requestId);
          }
        })();
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        killExecTree(child);
        socket.destroy();
      }
    });
  };

  server.on('connection', handleConnection);

  const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    bufferedOutput += chunk.length;
    if (bufferedOutput > MAX_OUTPUT_BYTES) {
      protocolError = `buffered output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`;
      killExecTree(child);
      return;
    }
    const text = chunk.toString('utf8');
    if (stream === 'stdout') stdoutText += text;
    else stderrText += text;
  };

  ignoreStreamError(child.stdout);
  ignoreStreamError(child.stderr);
  child.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));

  try {
    return await new Promise<SessionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killExecTree(child);
      }, timeoutMs);

      child.on('error', error => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        void closeCodeModeSock(server, sockPath).finally(() => {
          SandboxManager.cleanupAfterCommand();
          reject(error);
        });
      });

      child.on('close', code => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        void closeCodeModeSock(server, sockPath).finally(() => {
          SandboxManager.cleanupAfterCommand();
          resolve({
            stdoutText,
            stderrText,
            exitCode: typeof code === 'number' ? code : timedOut ? 1 : 0,
            protocolError,
            timedOut,
            childPid: child.pid,
            codeModeSockPath: sockPath,
          });
        });
      });
    });
  } catch (error) {
    await closeCodeModeSock(server, sockPath);
    throw error;
  }
}

/** Copy the PoC MCP client into the workspace (isolation: only workspace is writable). */
export async function installMcpFixture(workspace: string): Promise<string> {
  const dest = join(workspace, 'mcp_pipe_client.py');
  await copyFile(join(FIXTURES, 'mcp_pipe_client.py'), dest);
  return dest;
}
