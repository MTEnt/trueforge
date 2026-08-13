/**
 * LocalSandboxProvider smoke (macOS host or Linux via Lima)
 * plus Code Mode UDS and security probes. Run via `pnpm smoke`.
 */
import { getDefaultWritePaths, SandboxManager } from '@anthropic-ai/sandbox-runtime';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_PATH,
  createWorkspace,
  installMcpFixture,
  MAX_OUTPUT_BYTES,
  removeWorkspace,
  runSupervisorSession,
} from '../src/core/hostRun.js';
import { LocalSandboxProvider } from '../src/provider/LocalSandboxProvider.js';
import { ToolRequestViewSchema } from '../src/schemas/codeMode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = join(ROOT, 'workspaces');
const DENY_READ_SECRET = join(WORKSPACES, '.poc-deny-read-secret');
const DEFAULT_TMP_CLAUDE = '/tmp/claude';
const DELETE_TARGET = join(DEFAULT_TMP_CLAUDE, 'poc-delete-target.txt');
const SECRET_CONTENTS = 'host-secret-should-not-leak\n';
const HOST_HOME = process.env['HOME'];
const ENV_LEAK_MARKER = 'TFY_SMOKE_HOST_SECRET';
const ENV_LEAK_VALUE = 'host-env-must-not-reach-sandbox';
const ENV_INHERIT_MARKER = 'TFY_SMOKE_INHERIT';
const ENV_INHERIT_VALUE = `inherit-${randomUUID()}`;
const ENV_PEER_MARKER = 'TFY_SMOKE_PEER_ENV';
const ENV_PEER_VALUE = `peer-secret-${randomUUID()}`;
// Package-root resolve: Jest's CJS transform breaks import.meta.resolve.
const SRT_VENDOR = join(
  dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')),
  'vendor',
);
async function prepareHostProbeFiles(): Promise<void> {
  await mkdir(DEFAULT_TMP_CLAUDE, { recursive: true, mode: 0o700 });
  await mkdir(WORKSPACES, { recursive: true, mode: 0o700 });
  await writeFile(DELETE_TARGET, 'delete-me\n', { mode: 0o600 });
  await writeFile(DENY_READ_SECRET, SECRET_CONTENTS, { mode: 0o600 });
}

async function cleanupHostProbeFiles(): Promise<void> {
  await rm(DELETE_TARGET, { force: true });
  await rm(DENY_READ_SECRET, { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function onToolRequest(request: unknown): Promise<unknown> {
  const parsed = ToolRequestViewSchema.safeParse(request);
  if (!parsed.success) {
    throw new Error(`unsupported tool op: undefined`);
  }
  const { op, arguments: args = {} } = parsed.data;
  if (op === 'list_tools') {
    return [{ name: 'ping' }];
  }
  if (op === 'call_tool') {
    const delayRaw = args['delay_ms'];
    const delayMs = typeof delayRaw === 'number' && Number.isFinite(delayRaw) ? delayRaw : 0;
    if (delayMs > 0) await sleep(delayMs);
    return { echo: args };
  }
  throw new Error(`unsupported tool op: ${op}`);
}

async function smokeCodeMode(workspace: string): Promise<void> {
  await installMcpFixture(workspace);
  let toolRequests = 0;
  const countingHandler = async (request: unknown): Promise<unknown> => {
    toolRequests += 1;
    return onToolRequest(request);
  };

  const list = await runSupervisorSession({
    workspace,
    command: 'python3 mcp_pipe_client.py list-tools --server demo',
    onToolRequest: countingHandler,
  });
  assert.equal(list.protocolError, undefined, list.protocolError);
  assert.equal(list.exitCode, 0, list.stderrText);
  assert.match(list.stdoutText, /list-tools-ok/);
  console.log('ok: Code Mode list-tools (UDS)');

  // Oversized inbound JSON (read-side byte cap) must set protocolError.
  const oversizeCap = 1024;
  const oversize = await runSupervisorSession({
    workspace,
    command: [
      "python3 - <<'PY'",
      'import os, socket, time',
      'path = os.environ["TFY_MCP_SOCK"]',
      's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      's.connect(path)',
      `s.sendall(b"x" * ${String(oversizeCap + 1)})`,
      's.shutdown(socket.SHUT_WR)',
      'time.sleep(2)',
      'PY',
    ].join('\n'),
    onToolRequest: countingHandler,
    maxMessageBytes: oversizeCap,
    timeoutMs: 10_000,
  });
  assert.match(String(oversize.protocolError), /exceeds max/);
  console.log('ok: Code Mode oversized message is terminal');

  const badJson = await runSupervisorSession({
    workspace,
    command: [
      "python3 - <<'PY'",
      'import os, socket, time',
      'path = os.environ["TFY_MCP_SOCK"]',
      's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      's.connect(path)',
      's.sendall(b"not")',
      's.shutdown(socket.SHUT_WR)',
      'time.sleep(2)',
      'PY',
    ].join('\n'),
    onToolRequest: countingHandler,
    timeoutMs: 10_000,
  });
  assert.match(String(badJson.protocolError), /invalid JSON message/);
  console.log('ok: Code Mode malformed JSON message is terminal');

  const multiplex = await runSupervisorSession({
    workspace,
    command: 'python3 mcp_pipe_client.py multiplex --server demo --count 2',
    onToolRequest: countingHandler,
    timeoutMs: 15_000,
  });
  assert.equal(multiplex.protocolError, undefined, multiplex.protocolError);
  assert.equal(multiplex.exitCode, 0, multiplex.stderrText);
  const multiplexMatch = /multiplex-ok (\d+)/.exec(multiplex.stdoutText);
  assert.ok(multiplexMatch, multiplex.stdoutText);
  const multiplexMs = Number(multiplexMatch[1]);
  assert.ok(multiplexMs < 280, `multiplex looked serial: gather ${String(multiplexMs)}ms (expected < 280ms)`);
  console.log('ok: Code Mode concurrent UDS multiplex', `${String(multiplexMs)}ms`);

  // Without TFY_MCP_SOCK, client cannot reach Code Mode.
  const beforeMissing = toolRequests;
  const missingSock = await runSupervisorSession({
    workspace,
    command: [
      'set -euo pipefail',
      'unset TFY_MCP_SOCK',
      'if python3 mcp_pipe_client.py list-tools --server demo; then',
      '  echo "expected missing-sock failure" >&2',
      '  exit 1',
      'fi',
      'echo ok-missing-sock',
    ].join('\n'),
    onToolRequest: countingHandler,
    timeoutMs: 10_000,
  });
  assert.equal(missingSock.exitCode, 0, missingSock.stderrText);
  assert.match(missingSock.stdoutText, /ok-missing-sock/);
  assert.equal(toolRequests, beforeMissing, 'missing sock must not deliver tool requests');
  console.log('ok: Code Mode requires TFY_MCP_SOCK');

  // Same-UID host that knows the path can connect (path UDS ambient endpoint).
  let hostInjected = 0;
  let holdPid: number | undefined;
  const hostHandler = async (request: unknown): Promise<unknown> => {
    hostInjected += 1;
    return onToolRequest(request);
  };
  const holdSession = runSupervisorSession({
    workspace,
    command: [
      'set -euo pipefail',
      "python3 - <<'PY'",
      'import os, time',
      'open(".uds-ready", "w").write(os.environ["TFY_MCP_SOCK"] + "\\n")',
      'time.sleep(60)',
      'PY',
    ].join('\n'),
    onToolRequest: hostHandler,
    onChildSpawn: pid => {
      holdPid = pid;
    },
    timeoutMs: 15_000,
  });
  let sockFromSandbox = '';
  for (let i = 0; i < 80 && sockFromSandbox === ''; i++) {
    try {
      sockFromSandbox = (await readFile(join(workspace, '.uds-ready'), 'utf8')).trim();
    } catch {
      await sleep(50);
    }
  }
  assert.match(sockFromSandbox, /\.sock$/, 'sandbox never published TFY_MCP_SOCK');
  // TFY_MCP_SOCK may be basename when absolute workspace path exceeds macOS sun_path.
  const hostSockPath = sockFromSandbox.startsWith('/') ? sockFromSandbox : join(workspace, sockFromSandbox);
  const hostConnect = await new Promise<{ code: number | null; err: string }>((resolve, reject) => {
    const child = spawn(
      'python3',
      [
        '-c',
        [
          'import os, socket, sys, json',
          'path = sys.argv[1]',
          'req = {"request_id":"host-1","op":"list_tools","server":"demo"}',
          'body = json.dumps(req).encode()',
          's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
          // macOS sun_path ~104: connect via basename from the sock directory.
          'if len(path.encode()) >= 104:',
          '  os.chdir(os.path.dirname(path))',
          '  path = os.path.basename(path)',
          's.connect(path)',
          's.sendall(body)',
          's.shutdown(socket.SHUT_WR)',
          'chunks = []',
          'while True:',
          '  c = s.recv(65536)',
          '  if not c: break',
          '  chunks.append(c)',
          'print(b"".join(chunks).decode())',
        ].join('\n'),
        hostSockPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, err }));
  });
  assert.equal(hostConnect.code, 0, hostConnect.err);
  for (let i = 0; i < 50 && hostInjected === 0; i++) {
    await sleep(50);
  }
  assert.equal(hostInjected, 1, 'same-UID host connect to Code Mode UDS must work');
  console.log('ok: same-UID host can connect to Code Mode UDS (expected for path UDS)');
  if (holdPid !== undefined) {
    try {
      process.kill(-holdPid, 'SIGKILL');
    } catch {
      try {
        process.kill(holdPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  await holdSession;
}

/**
 * Prove Unix env inheritance with no explicit env= copying:
 * 1) curated exec env → python child → python grandchild
 * 2) bash `cmd1 & cmd2` — both jobs are shell children and must see the marker
 */
async function smokeEnvInheritance(provider: LocalSandboxProvider, sandboxId: string): Promise<void> {
  const pyResult = await provider.exec({
    sandboxId,
    env: { [ENV_INHERIT_MARKER]: ENV_INHERIT_VALUE },
    command: [
      "python3 - <<'PY'",
      'import os, subprocess, sys',
      `marker = ${JSON.stringify(ENV_INHERIT_MARKER)}`,
      `expected = ${JSON.stringify(ENV_INHERIT_VALUE)}`,
      'child_val = os.environ.get(marker)',
      'if child_val != expected:',
      '  print(f"child-missing:{child_val!r}", file=sys.stderr)',
      '  raise SystemExit(1)',
      '# Grandchild: subprocess with default env inheritance (no env= override).',
      'grand = subprocess.run(',
      '  [sys.executable, "-c", f"import os; print(os.environ[{marker!r}])"],',
      '  check=True,',
      '  capture_output=True,',
      '  text=True,',
      ')',
      'got = grand.stdout.strip()',
      'if got != expected:',
      '  print(f"grandchild-missing:{got!r}", file=sys.stderr)',
      '  raise SystemExit(1)',
      'print("env-inherit-ok", expected)',
      'PY',
    ].join('\n'),
  });
  assert.equal(pyResult.success, true, JSON.stringify(pyResult));
  if (!pyResult.success) throw new Error('unreachable');
  assert.equal(pyResult.response.exitCode, 0, pyResult.response.result);
  assert.match(pyResult.response.result, new RegExp(`env-inherit-ok ${ENV_INHERIT_VALUE}`));
  console.log('ok: env auto-inherits parent → child → grandchild (no extra code)');

  // Background job + foreground job are both subprocesses of the exec shell.
  const marker = ENV_INHERIT_MARKER;
  const expected = ENV_INHERIT_VALUE;
  const bashResult = await provider.exec({
    sandboxId,
    env: { [marker]: expected },
    command: [
      // workspace-local file (mktemp may target a denied host TMPDIR)
      'bg_out="./.tfy-smoke-env-bg"',
      // command 1: background — writes marker value then exits
      `( printenv ${marker} > "$bg_out" ) &`,
      'bg_pid=$!',
      // command 2: foreground — must see the same env
      `fg_val="$(printenv ${marker})"`,
      'wait "$bg_pid"',
      'bg_val="$(cat "$bg_out")"',
      'rm -f "$bg_out"',
      `test "$fg_val" = ${JSON.stringify(expected)} || { echo "fg-missing:$fg_val" >&2; exit 1; }`,
      `test "$bg_val" = ${JSON.stringify(expected)} || { echo "bg-missing:$bg_val" >&2; exit 1; }`,
      `echo "env-bg-ok ${expected}"`,
    ].join('\n'),
  });
  assert.equal(bashResult.success, true, JSON.stringify(bashResult));
  if (!bashResult.success) throw new Error('unreachable');
  assert.equal(bashResult.response.exitCode, 0, bashResult.response.result);
  assert.match(bashResult.response.result, new RegExp(`env-bg-ok ${expected}`));
  console.log('ok: env auto-inherits to bash background + foreground jobs (cmd1 & cmd2)');
}

function runCapture(command: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}

function assertPeerSecretAbsent(label: string, sample: string): void {
  assert.ok(
    !sample.includes(ENV_PEER_VALUE),
    `${label} unexpectedly exposed peer env secret:\n${sample.slice(0, 2000)}`,
  );
}

function assertPeerSecretPresent(label: string, sample: string): void {
  assert.ok(
    sample.includes(ENV_PEER_VALUE),
    `${label} did not expose peer env secret (expected same-UID visibility):\n${sample.slice(0, 2000)}`,
  );
}

/**
 * Same-UID peer env visibility (host processes, not sandbox policy):
 * - Linux: /proc/<pid>/environ exposes it
 * - macOS: no /proc; `ps -E` still exposes same-UID env (KERN_PROCARGS2 / libproc differ)
 */
async function smokeSameUidEnvironRead(): Promise<void> {
  const holder = spawn(
    'python3',
    ['-c', ['import os, time', 'print(os.getpid(), flush=True)', 'time.sleep(30)'].join('\n')],
    {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        [ENV_PEER_MARKER]: ENV_PEER_VALUE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let pidLine = '';
  holder.stdout?.on('data', (chunk: Buffer) => {
    pidLine += chunk.toString('utf8');
  });

  try {
    for (let i = 0; i < 50 && !/^\d+/m.test(pidLine); i++) {
      await sleep(50);
    }
    const peerPid = Number(pidLine.trim().split(/\s+/)[0]);
    assert.ok(Number.isInteger(peerPid) && peerPid > 0, `holder pid missing: ${pidLine}`);

    if (process.platform === 'linux') {
      const environ = await readFile(`/proc/${String(peerPid)}/environ`);
      const decoded = environ.toString('utf8').replaceAll('\0', '\n');
      assertPeerSecretPresent('/proc/<pid>/environ', decoded);
      console.log('ok: same-UID can read peer process environ via /proc (Linux)');
      return;
    }

    // --- macOS-specific probes ---
    let procEnvironError = '';
    try {
      await readFile(`/proc/${String(peerPid)}/environ`);
    } catch (error) {
      procEnvironError = error instanceof Error ? error.message : String(error);
    }
    assert.ok(procEnvironError.length > 0, 'expected /proc environ to be unavailable on macOS');
    console.log('ok: macOS has no /proc/<pid>/environ');

    // `ps -E` is the macOS flag to include environment; same-UID can see it.
    const psE = await runCapture('ps', ['-E', '-p', String(peerPid), '-ww']);
    assertPeerSecretPresent('ps -E -p', psE.out);
    console.log('ok: same-UID can read peer env via macOS ps -E');

    // `ps eww` may or may not be accepted; if it runs, record whether secret appears.
    const psEww = await runCapture('ps', ['eww', '-p', String(peerPid)]);
    if (psEww.code === 0 && psEww.out.includes(ENV_PEER_VALUE)) {
      console.log('ok: macOS ps eww also exposed peer env secret');
    } else {
      assertPeerSecretAbsent('ps eww -p', psEww.out);
      console.log('ok: macOS ps eww did not expose peer env secret');
    }

    // Plain command column should not include the env block.
    const psCmd = await runCapture('ps', ['-p', String(peerPid), '-ww', '-o', 'command=']);
    assertPeerSecretAbsent('ps -o command=', psCmd.out);
    console.log('ok: macOS ps -o command= does not include env block');

    // sysctl KERN_PROCARGS2 — argv/env region; may include env for same-UID.
    const kern = await runCapture('python3', [
      '-c',
      [
        'import ctypes, ctypes.util, sys',
        'pid = int(sys.argv[1])',
        'libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)',
        'CTL_KERN, KERN_PROCARGS2 = 1, 49',
        'mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)',
        'size = ctypes.c_size_t(0)',
        'rc = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)',
        'if rc != 0 or size.value == 0:',
        '  print(f"kern-procargs2-unavailable errno={ctypes.get_errno()} size={size.value}")',
        '  raise SystemExit(0)',
        'buf = ctypes.create_string_buffer(size.value)',
        'rc = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)',
        'if rc != 0:',
        '  print(f"kern-procargs2-read-failed errno={ctypes.get_errno()}")',
        '  raise SystemExit(0)',
        'data = buf.raw[: size.value]',
        'print(data.replace(b"\\x00", b"\\n").decode("utf-8", "replace"))',
      ].join('\n'),
      String(peerPid),
    ]);
    if (kern.out.includes(ENV_PEER_VALUE)) {
      console.log('ok: same-UID can read peer env via macOS KERN_PROCARGS2');
    } else {
      assert.match(kern.out, /kern-procargs2-/);
      console.log('ok: macOS KERN_PROCARGS2 did not return peer env secret');
    }

    // libproc has path APIs, not environ.
    const libproc = await runCapture('python3', [
      '-c',
      [
        'import ctypes, ctypes.util, sys',
        'pid = int(sys.argv[1])',
        'lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)',
        'buf = ctypes.create_string_buffer(4096)',
        'n = lib.proc_pidpath(pid, buf, ctypes.c_uint32(len(buf)))',
        'print(f"proc_pidpath n={n} path={buf.value!r}")',
        'print("no-environ-api")',
      ].join('\n'),
      String(peerPid),
    ]);
    assertPeerSecretAbsent('libproc proc_pidpath', libproc.out);
    assert.match(libproc.out, /no-environ-api/);
    console.log('ok: macOS libproc has no environ API; path-only read hid secret');
  } finally {
    holder.kill('SIGKILL');
    await new Promise<void>(resolve => {
      holder.on('close', () => resolve());
      setTimeout(resolve, 1000);
    });
  }
}

/**
 * Exec timeout must SIGKILL the process group — not only the direct child —
 * so a forked `while True` grandchild dies too.
 */
async function smokeProcessGroupTimeout(workspace: string): Promise<void> {
  const session = await runSupervisorSession({
    workspace,
    command: [
      "python3 - <<'PY'",
      'import os, time',
      'open("leader.pid","w").write(str(os.getpid()))',
      'child = os.fork()',
      'if child == 0:',
      '  while True:',
      '    time.sleep(1)',
      'open("grandchild.pid","w").write(str(child))',
      'time.sleep(3600)',
      'PY',
    ].join('\n'),
    timeoutMs: 1500,
  });
  assert.equal(session.timedOut, true, 'session should time out');
  const leaderPid = Number((await readFile(join(workspace, 'leader.pid'), 'utf8')).trim());
  const grandchildPid = Number((await readFile(join(workspace, 'grandchild.pid'), 'utf8')).trim());
  assert.ok(leaderPid > 0 && grandchildPid > 0);
  // Give the kernel a moment after SIGKILL.
  await sleep(200);
  assert.equal(pidAlive(leaderPid), false, `leader ${String(leaderPid)} still alive`);
  assert.equal(pidAlive(grandchildPid), false, `grandchild ${String(grandchildPid)} still alive`);
  console.log('ok: exec timeout kills process group (leader + while-True grandchild)');
}

async function assertExecFails(
  provider: LocalSandboxProvider,
  sandboxId: string,
  command: string,
  label: string,
  options?: {
    timeoutSeconds?: number;
    /** Reject these exits as "wrong reason" (e.g. 127 = command missing). */
    forbidExitCodes?: number[];
    /** Require output evidence of policy/IO denial, not just any failure. */
    outputMustMatch?: RegExp;
  },
): Promise<{ exitCode: number; result: string }> {
  const result = await provider.exec({
    sandboxId,
    command,
    ...(options?.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
  });
  assert.equal(result.success, true, `${label}: provider error ${JSON.stringify(result)}`);
  if (!result.success) throw new Error('unreachable');
  assert.notEqual(result.response.exitCode, 0, `${label}: expected non-zero exit\n${result.response.result}`);
  if (options?.forbidExitCodes?.includes(result.response.exitCode)) {
    assert.fail(`${label}: exit ${String(result.response.exitCode)} is not a policy denial\n${result.response.result}`);
  }
  if (options?.outputMustMatch !== undefined) {
    assert.match(
      result.response.result,
      options.outputMustMatch,
      `${label}: output lacked denial evidence\n${result.response.result}`,
    );
  }
  console.log(`ok: ${label}`);
  return { exitCode: result.response.exitCode, result: result.response.result };
}

/**
 * Host TCP listeners on loopback must be unreachable from the sandbox
 * (macOS Seatbelt deny, or Linux netns isolation).
 */
async function smokeLoopbackDenied(provider: LocalSandboxProvider, sandboxId: string): Promise<void> {
  const listen = async (host: string): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer(socket => {
      socket.end('loopback-open\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error(`expected TCP address for ${host}`);
    }
    return {
      port: addr.port,
      close: () =>
        new Promise((resolve, reject) => {
          server.close(err => (err ? reject(err) : resolve()));
        }),
    };
  };

  const v4 = await listen('127.0.0.1');
  let v6: { port: number; close: () => Promise<void> } | undefined;
  try {
    v6 = await listen('::1');
  } catch {
    v6 = undefined;
  }

  try {
    await assertExecFails(
      provider,
      sandboxId,
      [
        "python3 - <<'PY'",
        'import socket, sys',
        `port = ${String(v4.port)}`,
        'try:',
        '  s = socket.create_connection(("127.0.0.1", port), timeout=2)',
        '  data = s.recv(64)',
        '  s.close()',
        '  print("loopback-v4-open", data)',
        '  raise SystemExit(0)',
        'except OSError as e:',
        '  print("loopback-v4-blocked", type(e).__name__, e)',
        '  raise SystemExit(2)',
        'PY',
      ].join('\n'),
      'host 127.0.0.1 listener unreachable from sandbox',
      { outputMustMatch: /loopback-v4-blocked/ },
    );

    if (v6 !== undefined) {
      const v6Port = v6.port;
      await assertExecFails(
        provider,
        sandboxId,
        [
          "python3 - <<'PY'",
          'import socket, sys',
          `port = ${String(v6Port)}`,
          'try:',
          '  s = socket.create_connection(("::1", port), timeout=2)',
          '  data = s.recv(64)',
          '  s.close()',
          '  print("loopback-v6-open", data)',
          '  raise SystemExit(0)',
          'except OSError as e:',
          '  print("loopback-v6-blocked", type(e).__name__, e)',
          '  raise SystemExit(2)',
          'PY',
        ].join('\n'),
        'host ::1 listener unreachable from sandbox',
        { outputMustMatch: /loopback-v6-blocked/ },
      );
    } else {
      console.log('ok: skip ::1 listener (host cannot bind)');
    }

    // Private / link-local: no controlled listener; still must not connect.
    await assertExecFails(
      provider,
      sandboxId,
      [
        "python3 - <<'PY'",
        'import socket, sys',
        'targets = [("10.255.255.1", 9), ("169.254.169.254", 80), ("192.168.255.1", 9)]',
        'opened = []',
        'for host, port in targets:',
        '  try:',
        '    s = socket.create_connection((host, port), timeout=1)',
        '    s.close()',
        '    opened.append(f"{host}:{port}")',
        '  except OSError as e:',
        '    print(f"private-blocked {host}:{port} {type(e).__name__}")',
        'if opened:',
        '  print("private-open", opened)',
        '  raise SystemExit(0)',
        'raise SystemExit(2)',
        'PY',
      ].join('\n'),
      'private/link-local TCP connect denied',
      { outputMustMatch: /private-blocked/ },
    );
  } finally {
    await v4.close().catch(() => undefined);
    if (v6 !== undefined) {
      await v6.close().catch(() => undefined);
    }
  }
}

/**
 * setsid/double-fork vs kill(-pgid):
 * - macOS: no PID ns — escape leaves the process group and survives killpg
 *   (known limitation; host must reap via the written host pid).
 * - Linux SRT: PID ns + die-with-parent — escape dies with the sandbox; in-ns
 *   pids are not host-visible, so we watch a heartbeat file instead of kill(pid).
 */
async function smokeSetsidEscapeSurvivesKillpg(workspace: string): Promise<void> {
  const heartbeatPath = join(workspace, 'escaped.heartbeat');
  // Escaped child drops stdio so host pipes can close after killpg.
  // Cap wait: SRT wrapper teardown can still lag; do not hang the suite.
  const sessionPromise = runSupervisorSession({
    workspace,
    command: [
      "python3 - <<'PY'",
      'import os, time',
      'open("leader.pid", "w", encoding="utf-8").write(str(os.getpid()))',
      'child = os.fork()',
      'if child == 0:',
      '  os.setsid()',
      '  grand = os.fork()',
      '  if grand > 0:',
      '    os._exit(0)',
      '  dn = os.open("/dev/null", os.O_RDWR)',
      '  os.dup2(dn, 0); os.dup2(dn, 1); os.dup2(dn, 2)',
      '  if dn > 2: os.close(dn)',
      '  # Close Code Mode fds if present so host is not held open.',
      '  for fd in (3, 4):',
      '    try: os.close(fd)',
      '    except OSError: pass',
      '  open("escaped.pid", "w", encoding="utf-8").write(str(os.getpid()))',
      '  n = 0',
      '  while True:',
      '    n += 1',
      '    open("escaped.heartbeat", "w", encoding="utf-8").write(str(n))',
      '    time.sleep(0.2)',
      'os.waitpid(child, 0)',
      'time.sleep(3600)',
      'PY',
    ].join('\n'),
    timeoutMs: 1500,
  });

  let escapedRaw = '';
  for (let i = 0; i < 60 && !/^\d+$/.test(escapedRaw); i++) {
    try {
      escapedRaw = (await readFile(join(workspace, 'escaped.pid'), 'utf8')).trim();
    } catch {
      // not yet
    }
    await sleep(50);
  }
  assert.match(escapedRaw, /^\d+$/, 'escaped.pid missing — setsid child never started');
  const escapedPid = Number(escapedRaw);

  let heartbeatBeforeSession = '';
  for (let i = 0; i < 40 && heartbeatBeforeSession === ''; i++) {
    try {
      heartbeatBeforeSession = (await readFile(heartbeatPath, 'utf8')).trim();
    } catch {
      // not yet
    }
    await sleep(50);
  }
  assert.match(heartbeatBeforeSession, /^\d+$/, 'escaped.heartbeat missing — escape never ran');

  const sessionOrTimeout = await Promise.race([
    sessionPromise.then(session => ({ kind: 'session' as const, session })),
    sleep(5000).then(() => ({ kind: 'hung' as const })),
  ]);
  if (sessionOrTimeout.kind === 'hung') {
    // Last resort: session did not settle after killpg (SRT wrapper leak).
    if (process.platform === 'darwin') {
      try {
        process.kill(escapedPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    assert.fail('runSupervisorSession hung after timeout — killpg did not finish teardown');
  }
  const { session } = sessionOrTimeout;
  assert.equal(session.timedOut, true, 'session should time out');
  await sleep(500);

  const hb1 = (await readFile(heartbeatPath, 'utf8')).trim();
  await sleep(600);
  const hb2 = (await readFile(heartbeatPath, 'utf8')).trim();

  if (process.platform === 'linux') {
    // In-ns pid is not the host pid; survival is judged by heartbeat freeze.
    assert.equal(hb2, hb1, 'Linux: setsid escape should die with PID ns / die-with-parent (heartbeat still advancing)');
    console.log('ok: setsid escape dies with Linux PID ns / die-with-parent');
    return;
  }

  // macOS: host-visible pid; kill(-pgid) misses the new session.
  assert.notEqual(hb2, hb1, 'macOS: expected setsid escape to keep writing heartbeat after kill(-pgid)');
  assert.equal(pidAlive(escapedPid), true, `expected setsid escape pid ${String(escapedPid)} to survive kill(-pgid)`);
  try {
    process.kill(escapedPid, 'SIGKILL');
  } catch {
    // already gone
  }
  console.log('ok: setsid/double-fork escape survives killpg on macOS (known limitation)');
}

/**
 * Match initSrt AF_UNIX policy (allowAllUnixSockets on macOS + Linux), then prove
 * pathname connect is still gated by allowRead (FS), not by the Unix-socket toggle.
 * On Linux, also prove /proc/net/unix is the sandbox netns table (host abstract absent).
 */
async function smokeUnixSocketFsGate(): Promise<void> {
  // Keep paths short: macOS sun_path is ~104 bytes (long workspace UUIDs → EINVAL).
  const id = randomUUID().replaceAll('-', '').slice(0, 8);
  const workspace = join(WORKSPACES, `u${id}`);
  const insideSock = join(workspace, 'c.sock');
  const outsideSock = join(WORKSPACES, `o${id}.sock`);
  // Host-owned fake Docker socket (path shape only) — must not be in allowRead / allowUnixSockets.
  const emulatedDockerRoot = join(WORKSPACES, `v${id}`);
  const emulatedDockerSock = join(emulatedDockerRoot, 'run', 'docker.sock');
  const hostAbstractName = `\0tfy-abs-${id}`;
  const hostAbstractProcMarker = `@tfy-abs-${id}`;

  const allowRead =
    process.platform === 'darwin'
      ? [
          workspace,
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
          SRT_VENDOR,
        ]
      : [
          workspace,
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
          SRT_VENDOR,
        ];

  const denyWrite = getDefaultWritePaths().filter(path => !path.startsWith('/dev/'));

  const listenUds = async (path: string): Promise<{ close: () => Promise<void> }> => {
    await unlink(path).catch(() => undefined);
    const server = createServer(socket => {
      socket.end('uds-ok\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    return {
      close: async () => {
        await new Promise<void>(resolve => {
          server.close(() => resolve());
        });
        await unlink(path).catch(() => undefined);
      },
    };
  };

  const runSandboxed = async (command: string): Promise<{ code: number | null; out: string }> => {
    const wrap = await SandboxManager.wrapWithSandboxArgv(
      command,
      '/bin/bash',
      {
        filesystem: {
          allowWrite: [workspace],
          denyWrite,
          denyRead: ['/'],
          allowRead,
        },
        network: { allowedDomains: [], deniedDomains: [] },
      },
      undefined,
      workspace,
      { commandId: randomUUID(), commandText: command },
    );
    const [argv0, ...argvRest] = wrap.argv;
    if (argv0 === undefined) throw new Error('empty argv');
    return await new Promise((resolve, reject) => {
      const child = spawn(argv0, argvRest, {
        cwd: workspace,
        env: {
          HOME: join(workspace, '.home'),
          TMPDIR: join(workspace, '.tmp'),
          PATH: COMMAND_PATH,
          ...wrap.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out }));
    });
  };

  const connectScript = (sockPath: string): string =>
    [
      "python3 - <<'PY'",
      'import socket, sys',
      `path = ${JSON.stringify(sockPath)}`,
      'try:',
      '  s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      '  s.settimeout(2)',
      '  s.connect(path)',
      '  data = s.recv(64)',
      '  s.close()',
      '  print("CONNECT_OK", data)',
      '  sys.exit(0)',
      'except OSError as e:',
      '  print("CONNECT_FAIL", type(e).__name__, e.errno, e)',
      '  sys.exit(2)',
      'PY',
    ].join('\n');

  /** Prove path is not discoverable/readable and connect also fails (no discover-then-connect shortcut). */
  const discoverAndConnectDeniedScript = (sockPath: string): string =>
    [
      "python3 - <<'PY'",
      'import os, socket, stat, sys',
      `path = ${JSON.stringify(sockPath)}`,
      'parent = os.path.dirname(path)',
      'base = os.path.basename(path)',
      'discover_ok = False',
      'try:',
      '  st = os.stat(path)',
      '  print("STAT_OK", int(st.st_mode))',
      '  if stat.S_ISSOCK(st.st_mode):',
      '    discover_ok = True',
      '    print("DISCOVER_STAT_SOCK")',
      'except OSError as e:',
      '  print("STAT_FAIL", type(e).__name__, getattr(e, "errno", None))',
      'try:',
      '  if os.path.exists(path):',
      '    discover_ok = True',
      '    print("DISCOVER_EXISTS")',
      '  else:',
      '    print("EXISTS_FALSE")',
      'except OSError as e:',
      '  print("EXISTS_FAIL", type(e).__name__, getattr(e, "errno", None))',
      'try:',
      '  names = os.listdir(parent)',
      '  print("LISTDIR_OK", names)',
      '  if base in names:',
      '    discover_ok = True',
      '    print("DISCOVER_LISTDIR")',
      'except OSError as e:',
      '  print("LISTDIR_FAIL", type(e).__name__, getattr(e, "errno", None))',
      'if discover_ok:',
      '  print("DISCOVER_REACHABLE")',
      '  sys.exit(1)',
      'print("DISCOVER_DENIED")',
      'try:',
      '  s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      '  s.settimeout(2)',
      '  s.connect(path)',
      '  s.close()',
      '  print("CONNECT_OK")',
      '  sys.exit(2)',
      'except OSError as e:',
      '  print("CONNECT_FAIL", type(e).__name__, getattr(e, "errno", None))',
      '  sys.exit(0)',
      'PY',
    ].join('\n');

  await mkdir(join(workspace, '.tmp'), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, '.home'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(emulatedDockerSock), { recursive: true, mode: 0o700 });
  const inside = await listenUds(insideSock);
  const outside = await listenUds(outsideSock);
  const emulatedDocker = await listenUds(emulatedDockerSock);

  // Match hostRun: Linux allowAll + FS gate; macOS allowUnixSockets=[workspace] (FS does not gate UDS).
  const network =
    process.platform === 'darwin'
      ? {
          allowedDomains: [] as string[],
          deniedDomains: [] as string[],
          allowAllUnixSockets: false,
          allowUnixSockets: [workspace],
        }
      : {
          allowedDomains: [] as string[],
          deniedDomains: [] as string[],
          allowAllUnixSockets: true,
        };

  await SandboxManager.initialize({
    network,
    filesystem: {
      allowWrite: [],
      denyWrite,
      denyRead: ['/'],
      allowRead,
    },
  });

  let hostAbstract: { close: () => Promise<void> } | undefined;
  try {
    const ok = await runSandboxed(connectScript(insideSock));
    assert.equal(ok.code, 0, `inside sock should connect:\n${ok.out}`);
    assert.match(ok.out, /CONNECT_OK/);
    console.log('ok: sandbox can connect to workspace UDS (allowRead)');

    await access(outsideSock);
    const denied = await runSandboxed(connectScript(outsideSock));
    assert.notEqual(denied.code, 0, `outside sock must not connect:\n${denied.out}`);
    assert.match(denied.out, /CONNECT_FAIL/);
    console.log(
      process.platform === 'linux'
        ? 'ok: FS-denied path UDS connect fails under allowAllUnixSockets'
        : 'ok: path outside allowUnixSockets=[workspace] connect fails (macOS seatbelt)',
    );

    // Prove the emulated docker listener is live on the host, then denied from the sandbox.
    const hostDockerConnect = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(
        'python3',
        [
          '-c',
          [
            'import socket, sys',
            'path = sys.argv[1]',
            's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
            's.settimeout(2)',
            's.connect(path)',
            'print(s.recv(64))',
            's.close()',
          ].join('\n'),
          emulatedDockerSock,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out }));
    });
    assert.equal(hostDockerConnect.code, 0, `host must reach emulated docker.sock:\n${hostDockerConnect.out}`);
    assert.match(hostDockerConnect.out, /uds-ok/);
    console.log('ok: host can connect to emulated docker.sock');

    const dockerDenied = await runSandboxed(connectScript(emulatedDockerSock));
    assert.notEqual(dockerDenied.code, 0, `sandbox must not connect to emulated docker.sock:\n${dockerDenied.out}`);
    assert.match(dockerDenied.out, /CONNECT_FAIL/);
    console.log('ok: sandbox cannot connect to host-created emulated docker.sock');

    const inventory = await runSandboxed(
      [
        "python3 - <<'PY'",
        'import os, socket, stat, sys',
        'roots = ["/dev", "/etc", "/usr"]',
        'found = []',
        'for root in roots:',
        '  if not os.path.isdir(root):',
        '    continue',
        '  for dirpath, dirnames, filenames in os.walk(root):',
        '    if dirpath.count(os.sep) - root.count(os.sep) > 3:',
        '      dirnames[:] = []',
        '      continue',
        '    for name in filenames:',
        '      p = os.path.join(dirpath, name)',
        '      try:',
        '        st = os.stat(p)',
        '      except OSError:',
        '        continue',
        '      if stat.S_ISSOCK(st.st_mode):',
        '        found.append(p)',
        'print("FOUND", len(found))',
        'for p in found[:20]:',
        '  print("SOCK", p)',
        'bad = 0',
        'for p in found:',
        '  try:',
        '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
        '    s.settimeout(0.3)',
        '    s.connect(p)',
        '    s.close()',
        '    print("CONNECTED", p)',
        '    bad += 1',
        '  except OSError as e:',
        '    print("BLOCKED_OR_USELESS", p, type(e).__name__)',
        'sys.exit(1 if bad else 0)',
        'PY',
      ].join('\n'),
    );
    const invLines = inventory.out.trim().split('\n').slice(0, 40);
    console.log(invLines.join('\n'));
    assert.equal(inventory.code, 0, `sandbox connected to a socket under /dev|/etc|/usr:\n${inventory.out}`);
    console.log('ok: no successful connect to sockets under /dev|/etc|/usr (if any visible)');

    if (process.platform === 'linux') {
      // Host abstract listener (Linux-only). Sandbox has --unshare-net → own /proc/net/unix.
      const absServer = createServer(socket => {
        socket.end('abs-ok\n');
      });
      await new Promise<void>((resolve, reject) => {
        absServer.once('error', reject);
        absServer.listen(hostAbstractName, () => resolve());
      });
      hostAbstract = {
        close: async () => {
          await new Promise<void>(resolve => {
            absServer.close(() => resolve());
          });
        },
      };

      const hostProc = await readFile('/proc/net/unix', 'utf8');
      assert.match(
        hostProc,
        new RegExp(hostAbstractProcMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'host /proc/net/unix must list the abstract listener',
      );

      const procUnix = await runSandboxed(
        [
          "python3 - <<'PY'",
          'import sys',
          `marker = ${JSON.stringify(hostAbstractProcMarker)}`,
          'path = "/proc/net/unix"',
          'try:',
          '  text = open(path, "r", encoding="utf-8", errors="replace").read()',
          'except OSError as e:',
          '  print("PROC_NET_UNIX_UNREADABLE", getattr(e, "errno", None), e)',
          '  sys.exit(2)',
          'print("PROC_NET_UNIX_READABLE", "bytes", len(text), "lines", len(text.splitlines()))',
          'if marker in text:',
          '  print("HOST_ABSTRACT_VISIBLE", marker)',
          '  sys.exit(3)',
          'print("HOST_ABSTRACT_ABSENT", marker)',
          // Also prove connect to host abstract fails (different netns).
          'import socket',
          `abs_name = ${JSON.stringify(hostAbstractName)}`,
          'try:',
          '  s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
          '  s.settimeout(1)',
          '  s.connect(abs_name)',
          '  s.close()',
          '  print("HOST_ABSTRACT_CONNECT_OK")',
          '  sys.exit(4)',
          'except OSError as e:',
          '  print("HOST_ABSTRACT_CONNECT_FAIL", type(e).__name__, getattr(e, "errno", None))',
          'sys.exit(0)',
          'PY',
        ].join('\n'),
      );
      assert.equal(procUnix.code, 0, procUnix.out);
      assert.match(procUnix.out, /PROC_NET_UNIX_READABLE/);
      assert.match(procUnix.out, /HOST_ABSTRACT_ABSENT/);
      assert.match(procUnix.out, /HOST_ABSTRACT_CONNECT_FAIL/);
      console.log('ok: /proc/net/unix is sandbox netns (host abstract not listed / not connectable)');
      console.log(procUnix.out.trim().split('\n').filter(Boolean).join(' | '));
    } else {
      console.log('ok: skip Linux abstract /proc/net/unix netns probe (not Linux)');
    }

    console.log(
      process.platform === 'linux'
        ? 'ok: Linux allowAllUnixSockets + FS allowRead gates pathname UDS'
        : 'ok: macOS allowUnixSockets=[workspace] gates pathname UDS (not allowRead)',
    );
  } finally {
    await hostAbstract?.close().catch(() => undefined);
    await emulatedDocker.close().catch(() => undefined);
    await inside.close().catch(() => undefined);
    await outside.close().catch(() => undefined);
    await SandboxManager.reset().catch(() => undefined);
    await removeWorkspace(workspace).catch(() => undefined);
    await rm(emulatedDockerRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function smokeHostPackageManagerDenied(provider: LocalSandboxProvider, sandboxId: string): Promise<void> {
  if (process.platform === 'darwin') {
    await assertExecFails(
      provider,
      sandboxId,
      "printf 'poc\\n' > /opt/homebrew/Cellar/.tfy-poc-write || exit 2",
      'host Homebrew Cellar write denied',
      { outputMustMatch: /Permission|Read-only|Operation not permitted|denied|No such|cannot/i },
    );
    // Prefer reinstall so an already-installed keg cannot no-op to exit 0.
    // Brew also needs host API/cache reads + network; both are denied under SRT.
    await assertExecFails(
      provider,
      sandboxId,
      [
        'set +e',
        'command -v brew >/dev/null 2>&1 || { echo "brew-missing" >&2; exit 127; }',
        'export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1',
        'brew install lima',
        'install_rc=$?',
        'if [ "$install_rc" -eq 0 ]; then',
        '  brew reinstall lima',
        '  install_rc=$?',
        'fi',
        'exit "$install_rc"',
      ].join('\n'),
      'brew install/reinstall lima denied',
      {
        // Brew may stall on network/API; fail-closed quickly under SRT.
        timeoutSeconds: 20,
        forbidExitCodes: [127],
        outputMustMatch: /not writable|Permission|Operation not permitted|Read-only|denied|Failed to download|Error:/i,
      },
    );
    return;
  }

  await assertExecFails(
    provider,
    sandboxId,
    "printf 'poc\\n' > /usr/bin/.tfy-poc-write || exit 2",
    'host /usr/bin write denied',
    { outputMustMatch: /Permission|Read-only|Operation not permitted|denied|No such file|cannot/i },
  );
  await assertExecFails(
    provider,
    sandboxId,
    [
      'set +e',
      'command -v apt-get >/dev/null 2>&1 || { echo "apt-get-missing" >&2; exit 127; }',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get install -y cowsay',
      'exit $?',
    ].join('\n'),
    'apt-get install denied',
    {
      timeoutSeconds: 20,
      forbidExitCodes: [127],
      outputMustMatch: /Permission|Read-only|Operation not permitted|denied|not open|Could not|E:/i,
    },
  );
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    console.error('smoke: skipping (darwin/linux only)');
    process.exit(0);
  }

  process.env[ENV_LEAK_MARKER] = ENV_LEAK_VALUE;

  const provider = new LocalSandboxProvider({ tenantName: 'poc' });
  await prepareHostProbeFiles();
  let codeModeWorkspace: string | undefined;
  try {
    const { sandboxId } = await provider.createSandbox();
    console.log('sandboxId', sandboxId);

    const printf = await provider.exec({
      sandboxId,
      command: "printf 'poc-ok\\n'",
    });
    assert.equal(printf.success, true);
    if (!printf.success) throw new Error('unreachable');
    assert.equal(printf.response.exitCode, 0);
    assert.equal(printf.response.result, 'poc-ok\n');
    console.log('ok: provider exec printf');

    const write = await provider.exec({
      sandboxId,
      command: "printf 'workspace-ok\\n' > note.txt && cat note.txt",
    });
    assert.equal(write.success, true);
    if (!write.success) throw new Error('unreachable');
    assert.equal(write.response.exitCode, 0);
    assert.equal(write.response.result, 'workspace-ok\n');
    console.log('ok: workspace-local write/read');

    await provider.uploadFile({
      sandboxId,
      remotePath: 'uploads/hello.txt',
      content: Buffer.from('upload-ok\n'),
    });
    const downloaded = await provider.downloadFile({
      sandboxId,
      path: 'uploads/hello.txt',
    });
    assert.equal(downloaded.toString('utf8'), 'upload-ok\n');
    const catUpload = await provider.exec({
      sandboxId,
      command: 'cat uploads/hello.txt',
    });
    assert.equal(catUpload.success, true);
    if (!catUpload.success) throw new Error('unreachable');
    assert.equal(catUpload.response.result, 'upload-ok\n');
    console.log('ok: upload/download');

    await assertExecFails(
      provider,
      sandboxId,
      "printf 'leak\\n' > /tmp/claude/poc-should-fail.txt || exit 2",
      'SRT default /tmp/claude write denied',
      { outputMustMatch: /Permission|Read-only|Operation not permitted|denied|No such|cannot/i },
    );

    const before = await readFile(DELETE_TARGET, 'utf8');
    assert.equal(before, 'delete-me\n');
    await assertExecFails(
      provider,
      sandboxId,
      `python3 -c 'import os; os.unlink(${JSON.stringify(DELETE_TARGET)})'`,
      'SRT default /tmp/claude delete denied',
    );
    await access(DELETE_TARGET);

    const denyRead = await provider.exec({
      sandboxId,
      command: `cat ${JSON.stringify(DENY_READ_SECRET)}`,
    });
    assert.equal(denyRead.success, true);
    if (!denyRead.success) throw new Error('unreachable');
    assert.notEqual(denyRead.response.exitCode, 0);
    assert.ok(!denyRead.response.result.includes('host-secret-should-not-leak'));
    console.log('ok: host secret outside workspace blocked');

    assert.ok(HOST_HOME && HOST_HOME.length > 0);
    await assertExecFails(provider, sandboxId, `ls ${JSON.stringify(HOST_HOME)}`, 'host home listing denied');

    await smokeHostPackageManagerDenied(provider, sandboxId);

    // System pip install (no --user/--target): must fail closed without network.
    // Local trivial package so the failure is install/prefix write, not PyPI fetch.
    await assertExecFails(
      provider,
      sandboxId,
      [
        'set -euo pipefail',
        // ensurepip covers guests that only have python3 (no python3-pip package).
        'python3 -m pip --version >/dev/null 2>&1 || python3 -m ensurepip --upgrade >/dev/null 2>&1 || true',
        'python3 -m pip --version >/dev/null || { echo "pip-missing" >&2; exit 127; }',
        'mkdir -p tfy_poc_pip_pkg/tfy_poc_pip',
        "cat > tfy_poc_pip_pkg/setup.py <<'EOF'",
        'from setuptools import setup',
        'setup(name="tfy-poc-pip", version="0.0.1", packages=["tfy_poc_pip"])',
        'EOF',
        'touch tfy_poc_pip_pkg/tfy_poc_pip/__init__.py',
        'python3 -m pip install --no-input --no-deps --no-build-isolation ./tfy_poc_pip_pkg',
      ].join('\n'),
      'system pip install denied',
      {
        forbidExitCodes: [127],
        outputMustMatch: /Permission|Read-only|Operation not permitted|denied|ERROR:|Could not|No module|error/i,
      },
    );

    await smokeLoopbackDenied(provider, sandboxId);

    await assertExecFails(
      provider,
      sandboxId,
      'python3 -c \'import socket,sys\ntry:\n socket.create_connection(("1.1.1.1",443),timeout=2)\n print("network-open"); sys.exit(0)\nexcept OSError as e:\n print("network-blocked:%s"%e); sys.exit(2)\'',
      'egress to 1.1.1.1:443 denied',
      { outputMustMatch: /network-blocked:/ },
    );
    await assertExecFails(
      provider,
      sandboxId,
      'python3 -c \'import socket,sys\ntry:\n socket.getaddrinfo("example.com",443)\n print("dns-open"); sys.exit(0)\nexcept OSError as e:\n print("dns-blocked:%s"%e); sys.exit(2)\'',
      'DNS for example.com denied',
      { outputMustMatch: /dns-blocked:/ },
    );

    const envLeak = await provider.exec({
      sandboxId,
      command: `printenv ${ENV_LEAK_MARKER} || true`,
    });
    assert.equal(envLeak.success, true);
    if (!envLeak.success) throw new Error('unreachable');
    assert.ok(!envLeak.response.result.includes(ENV_LEAK_VALUE));
    console.log('ok: host env secret not visible in sandbox');

    await smokeEnvInheritance(provider, sandboxId);
    await smokeSameUidEnvironRead();

    await assertExecFails(
      provider,
      sandboxId,
      `cat ${JSON.stringify('../.poc-deny-read-secret')}`,
      'path escape via .. denied',
    );

    await assertExecFails(
      provider,
      sandboxId,
      ['set -e', `ln -sf ${JSON.stringify(DENY_READ_SECRET)} escape-link`, 'cat escape-link'].join('\n'),
      'symlink escape read denied',
    );

    // Plain sandboxed open() following a workspace→host symlink must not leak the host file.
    await assertExecFails(
      provider,
      sandboxId,
      [
        `ln -sf ${JSON.stringify(DENY_READ_SECRET)} escape-open`,
        "python3 - <<'PY'",
        'import sys',
        'try:',
        '  data = open("escape-open", "rb").read()',
        '  sys.stdout.write(data.decode("utf-8", "replace"))',
        '  raise SystemExit(0)',
        'except OSError as e:',
        '  print(f"open-blocked {type(e).__name__}", file=sys.stderr)',
        '  raise SystemExit(2)',
        'PY',
      ].join('\n'),
      'sandbox open() symlink follow read denied',
      {
        outputMustMatch: /open-blocked|Permission|Operation not permitted|denied|No such file/i,
      },
    );
    assert.equal(await readFile(DENY_READ_SECRET, 'utf8'), SECRET_CONTENTS);

    // Write follow: macOS SRT fails open; Linux bwrap may exit 0 without persisting — host must stay intact.
    const writeFollow = await provider.exec({
      sandboxId,
      command: [
        `ln -sf ${JSON.stringify(DENY_READ_SECRET)} escape-open-w`,
        "python3 - <<'PY'",
        'import sys',
        'try:',
        '  open("escape-open-w", "wb").write(b"pwned-exec\\n")',
        '  print("open-write-ok")',
        '  raise SystemExit(0)',
        'except OSError as e:',
        '  print(f"open-write-blocked {type(e).__name__}", file=sys.stderr)',
        '  raise SystemExit(2)',
        'PY',
      ].join('\n'),
    });
    assert.equal(writeFollow.success, true);
    if (!writeFollow.success) throw new Error('unreachable');
    assert.equal(
      await readFile(DENY_READ_SECRET, 'utf8'),
      SECRET_CONTENTS,
      'sandbox symlink follow write must not mutate host secret',
    );
    if (writeFollow.response.exitCode === 0) {
      console.log('ok: sandbox open() symlink follow write did not persist (Linux bwrap quirk)');
    } else {
      assert.match(writeFollow.response.result, /open-write-blocked|Permission|Operation not permitted|denied/i);
      console.log('ok: sandbox open() symlink follow write denied');
    }

    // Provider upload/download rely on SRT for symlink follow (no extra test ! -L).
    const mkDlLink = await provider.exec({
      sandboxId,
      command: `ln -sf ${JSON.stringify(DENY_READ_SECRET)} api-escape-dl && test -L api-escape-dl`,
    });
    assert.equal(mkDlLink.success, true);
    if (!mkDlLink.success) throw new Error('unreachable');
    assert.equal(mkDlLink.response.exitCode, 0, mkDlLink.response.result);
    let downloadLeaked = false;
    try {
      const leaked = await provider.downloadFile({ sandboxId, path: 'api-escape-dl' });
      downloadLeaked = leaked.toString('utf8').includes('host-secret-should-not-leak');
    } catch {
      // expected: SRT blocks follow-read
    }
    assert.equal(downloadLeaked, false, 'downloadFile must not return host secret via symlink');
    assert.equal(await readFile(DENY_READ_SECRET, 'utf8'), SECRET_CONTENTS);
    console.log('ok: downloadFile does not leak host via symlink (SRT)');

    const mkUlLink = await provider.exec({
      sandboxId,
      command: `ln -sf ${JSON.stringify(DENY_READ_SECRET)} api-escape-ul && test -L api-escape-ul`,
    });
    assert.equal(mkUlLink.success, true);
    if (!mkUlLink.success) throw new Error('unreachable');
    assert.equal(mkUlLink.response.exitCode, 0, mkUlLink.response.result);
    try {
      await provider.uploadFile({
        sandboxId,
        remotePath: 'api-escape-ul',
        content: Buffer.from('pwned-via-host-api\n'),
      });
      // Linux may report success without persisting — host check below is the gate.
    } catch {
      // macOS / strict deny — also fine
    }
    assert.equal(
      await readFile(DENY_READ_SECRET, 'utf8'),
      SECRET_CONTENTS,
      'uploadFile must not mutate host via symlink',
    );
    console.log('ok: uploadFile does not mutate host via symlink (SRT)');

    const { sandboxId: otherId } = await provider.createSandbox();
    await provider.uploadFile({
      sandboxId,
      remotePath: 'cross-secret.txt',
      content: Buffer.from('cross-sandbox-secret\n'),
    });
    const otherRead = await provider.exec({
      sandboxId: otherId,
      command: `cat ${JSON.stringify(join(WORKSPACES, sandboxId, 'cross-secret.txt'))}`,
    });
    assert.equal(otherRead.success, true);
    if (!otherRead.success) throw new Error('unreachable');
    assert.notEqual(otherRead.response.exitCode, 0);
    assert.ok(!otherRead.response.result.includes('cross-sandbox-secret'));
    console.log('ok: cross-sandbox absolute path read denied');

    const otherWrite = await provider.exec({
      sandboxId: otherId,
      command: `printf 'cross-write\\n' > ${JSON.stringify(join(WORKSPACES, sandboxId, 'cross-write.txt'))}`,
    });
    assert.equal(otherWrite.success, true);
    if (!otherWrite.success) throw new Error('unreachable');
    assert.notEqual(otherWrite.response.exitCode, 0);
    await assert.rejects(async () => readFile(join(WORKSPACES, sandboxId, 'cross-write.txt')));
    console.log('ok: cross-sandbox absolute path write denied');

    const persist1 = await provider.exec({
      sandboxId,
      command: "printf 'persist-ok\\n' > persist.txt",
    });
    assert.equal(persist1.success, true);
    if (!persist1.success) throw new Error('unreachable');
    assert.equal(persist1.response.exitCode, 0);
    const persist2 = await provider.exec({
      sandboxId,
      command: 'cat persist.txt',
    });
    assert.equal(persist2.success, true);
    if (!persist2.success) throw new Error('unreachable');
    assert.equal(persist2.response.result, 'persist-ok\n');
    console.log('ok: workspace persists across execs');

    const flood = await provider.exec({
      sandboxId,
      command: `python3 -c 'import sys; sys.stdout.write("x" * ${String(MAX_OUTPUT_BYTES + 1)})'`,
      timeoutSeconds: 30,
    });
    assert.equal(flood.success, false);
    if (flood.success) throw new Error('unreachable');
    assert.match(flood.error, /buffered output exceeded/);
    console.log(`ok: oversized stdout is terminal (${String(MAX_OUTPUT_BYTES)} byte cap)`);

    assert.match(provider.getToolResultDumpDir(sandboxId), /tool-results$/);
    assert.match(provider.getGitCredentialsPath(sandboxId), /\.git-credentials$/);
    console.log('ok: dump/git credential paths');

    codeModeWorkspace = await createWorkspace({ sandboxId: `poc-codemode-${Date.now()}` });
    await smokeProcessGroupTimeout(codeModeWorkspace);
    await smokeSetsidEscapeSurvivesKillpg(codeModeWorkspace);
    await smokeCodeMode(codeModeWorkspace);

    console.log('all LocalSandboxProvider + Code Mode smokes passed');
  } finally {
    delete process.env[ENV_LEAK_MARKER];
    await provider.dispose();
    if (codeModeWorkspace !== undefined) {
      await removeWorkspace(codeModeWorkspace).catch(() => undefined);
    }
    await cleanupHostProbeFiles().catch(() => undefined);
  }

  // Own SRT session: AF_UNIX enabled so FS / allowUnixSockets gating is what we measure.
  await smokeUnixSocketFsGate();
  console.log('all smokes passed');
}

test('local-sandbox smoke', async () => {
  await main();
}, 600_000);
