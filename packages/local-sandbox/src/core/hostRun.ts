/**
 * Host-side sandboxed exec (in-process supervisor).
 * Only the untrusted command argv is SRT-wrapped. Code Mode UDS is owned by
 * {@link CodeModeUdsTransport} (handle-scoped); pass TFY_MCP_SOCK via `env` when needed.
 */
import { getDefaultWritePaths, SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export interface SessionResult {
  stdoutText: string;
  stderrText: string;
  exitCode: number;
  protocolError: string | undefined;
  timedOut: boolean;
  /** Process-group leader pid of the sandboxed command (Unix). */
  childPid: number | undefined;
}

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
function filesystemPolicy(sandboxRootPath: string): {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
} {
  return {
    allowWrite: [sandboxRootPath],
    denyWrite: denySharedDefaultWritePaths(),
    denyRead: ['/'],
    allowRead: [sandboxRootPath, ...platformAllowRead()],
  };
}

/** Curated env for the sandboxed command — never the full host process.env. */
function commandEnv(sandboxRootPath: string, extra?: Record<string, string>): Record<string, string> {
  const tmp = join(sandboxRootPath, '.tmp');
  const home = join(sandboxRootPath, '.home');
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
 *   allowUnixSockets subpath, synced at sandbox create/remove.
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

/** Active sandbox roots allowed for macOS pathname UDS (seatbelt subpath). */
const darwinUnixSocketSandboxRoots = new Set<string>();

function syncDarwinUnixSockets(): void {
  if (process.platform !== 'darwin') return;
  if (SandboxManager.getConfig() === undefined) return;
  SandboxManager.updateConfig({
    network: sessionNetwork([...darwinUnixSocketSandboxRoots]),
    filesystem: sessionFilesystem(),
  });
}

/** Create a sandbox directory at `sandboxRootPath` (also the sandbox id). */
export async function createSandbox(sandboxRootPath: string): Promise<string> {
  await mkdir(sandboxRootPath, { recursive: true, mode: 0o700 });
  await mkdir(join(sandboxRootPath, '.tmp'), { recursive: true, mode: 0o700 });
  await mkdir(join(sandboxRootPath, '.home'), { recursive: true, mode: 0o700 });
  darwinUnixSocketSandboxRoots.add(sandboxRootPath);
  syncDarwinUnixSockets();
  return sandboxRootPath;
}

export async function removeSandbox(sandboxRootPath: string): Promise<void> {
  darwinUnixSocketSandboxRoots.delete(sandboxRootPath);
  syncDarwinUnixSockets();
  await rm(sandboxRootPath, { recursive: true, force: true });
}

/**
 * Process-scoped SRT init. Per-exec filesystem policy is applied in
 * {@link runSupervisorSession} via wrapWithSandboxArgv customConfig.
 */
export async function initSrt(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('LocalSandboxProvider supports macOS and Linux only');
  }

  await SandboxManager.initialize({
    network: sessionNetwork([...darwinUnixSocketSandboxRoots]),
    filesystem: sessionFilesystem(),
  });
}

export async function resetSrt(): Promise<void> {
  await SandboxManager.reset();
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

/**
 * Run one SRT-wrapped command. Code Mode UDS (if any) is supplied via `env.TFY_MCP_SOCK`
 * from {@link CodeModeUdsTransport.start}.
 */
export async function runSupervisorSession(params: {
  sandboxRootPath: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Optional stdin bytes for the sandboxed command (e.g. upload payload). */
  stdin?: Buffer;
  /** Host-visible pid of the sandboxed process-group leader (after spawn). */
  onChildSpawn?: (pid: number) => void;
  timeoutMs?: number;
}): Promise<SessionResult> {
  const { sandboxRootPath, command, cwd = sandboxRootPath, env, stdin, onChildSpawn, timeoutMs = 15_000 } = params;

  const wrap = await SandboxManager.wrapWithSandboxArgv(
    command,
    '/bin/bash',
    {
      filesystem: filesystemPolicy(sandboxRootPath),
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    },
    undefined,
    sandboxRootPath,
    { commandId: randomUUID(), commandText: command },
  );

  const [argv0, ...argvRest] = wrap.argv;
  if (argv0 === undefined) {
    throw new Error('wrapWithSandboxArgv returned empty argv');
  }

  // Curated env only — do not spread wrap.env (it can carry ambient host secrets).
  // Code Mode sock path (TFY_MCP_SOCK) is expected in `env` when the caller started a transport.
  const childEnv: NodeJS.ProcessEnv = {
    ...commandEnv(sandboxRootPath, env),
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
  child.stdout?.on('data', (chunk: Buffer) => {
    appendOutput('stdout', chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    appendOutput('stderr', chunk);
  });

  return await new Promise<SessionResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killExecTree(child);
    }, timeoutMs);

    child.on('error', error => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      SandboxManager.cleanupAfterCommand();
      reject(error);
    });

    child.on('close', code => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      SandboxManager.cleanupAfterCommand();
      resolve({
        stdoutText,
        stderrText,
        exitCode: typeof code === 'number' ? code : timedOut ? 1 : 0,
        protocolError,
        timedOut,
        childPid: child.pid,
      });
    });
  });
}

/** Copy the MCP client fixture into the sandbox (isolation: only sandbox root is writable). */
export async function installMcpFixture(sandboxRootPath: string): Promise<string> {
  const dest = join(sandboxRootPath, 'mcp_pipe_client.py');
  await copyFile(join(FIXTURES, 'mcp_pipe_client.py'), dest);
  return dest;
}
