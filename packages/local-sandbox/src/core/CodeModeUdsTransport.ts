/**
 * Handle-scoped Code Mode UDS transport. Listen/accept live for the Sandbox handle lifetime;
 * one UTF-8 JSON request/reply per connection (peer write-close); no request_id.
 */
import type {
  CodeModeDispatcher,
  CodeModeReply,
  CodeModeRequest,
  CodeModeTransport,
} from '@truefoundry/trueforge-core/core';
import { CodeModeRequestSchema } from '@truefoundry/trueforge-core/core';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { encodeJsonMessage, JsonMessageReader, MAX_MESSAGE_BYTES } from './frame.js';

export interface CodeModeUdsTransportOptions {
  resolveWorkspace: (sandboxId: string) => string;
  maxMessageBytes?: number | undefined;
  /** Optional: observe inbound protocol failures (oversized / malformed). */
  onProtocolError?: ((message: string) => void) | undefined;
}

export class CodeModeUdsTransport implements CodeModeTransport {
  private readonly resolveWorkspace: (sandboxId: string) => string;
  private readonly maxMessageBytes: number;
  private readonly onProtocolError: ((message: string) => void) | undefined;

  private sessionPromise: Promise<{ env: Record<string, string> }> | undefined;
  private server: Server | undefined;
  private sockPath: string | undefined;
  private dispatcher: CodeModeDispatcher | undefined;
  private cachedEnv: Record<string, string> | undefined;

  constructor(options: CodeModeUdsTransportOptions) {
    this.resolveWorkspace = options.resolveWorkspace;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.onProtocolError = options.onProtocolError;
  }

  start(params: {
    codeModeDispatcher: CodeModeDispatcher;
    sandboxId: string;
    requestTimeoutSeconds: number;
  }): Promise<{ env: Record<string, string> }> {
    this.dispatcher = params.codeModeDispatcher;
    this.sessionPromise ??= this.listenSession(params).catch((e: unknown) => {
      this.sessionPromise = undefined;
      this.cachedEnv = undefined;
      throw e;
    });
    return this.sessionPromise;
  }

  async stop(): Promise<void> {
    const pending = this.sessionPromise;
    this.sessionPromise = undefined;
    this.cachedEnv = undefined;
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        // Listen failed; nothing to close.
      }
    }
    const server = this.server;
    const sockPath = this.sockPath;
    this.server = undefined;
    this.sockPath = undefined;
    if (server !== undefined) {
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });
    }
    if (sockPath !== undefined) {
      await unlink(sockPath).catch(() => undefined);
    }
  }

  private async listenSession(params: {
    sandboxId: string;
    requestTimeoutSeconds: number;
  }): Promise<{ env: Record<string, string> }> {
    if (this.server !== undefined && this.cachedEnv !== undefined) {
      return { env: this.cachedEnv };
    }

    const workspace = this.resolveWorkspace(params.sandboxId);
    const sockName = `cm${randomUUID().replaceAll('-', '').slice(0, 8)}.sock`;
    const sockPath = join(workspace, sockName);
    // macOS sun_path ~104 bytes — absolute workspace paths often overflow, so we
    // chdir + listen(basename). process.chdir is process-global: concurrent short-binds
    // can race. Prefer later: bind under a short absolute path (e.g. /tmp/tfy-cm-…) or
    // shorten the workspace root so absolute listen always fits (no chdir).
    const sockForClient = process.platform === 'darwin' && Buffer.byteLength(sockPath) >= 104 ? sockName : sockPath;

    await unlink(sockPath).catch(() => undefined);
    const server = createServer({ allowHalfOpen: true });
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

    this.server = server;
    this.sockPath = sockPath;
    server.on('connection', socket => {
      this.handleConnection(socket);
    });

    const env = {
      TFY_MCP_SOCK: sockForClient,
      TFY_CM_REQUEST_TIMEOUT_SECONDS: String(params.requestTimeoutSeconds),
    };
    this.cachedEnv = env;
    return { env };
  }

  private handleConnection(socket: Socket): void {
    const reader = new JsonMessageReader({ maxBytes: this.maxMessageBytes });
    let settled = false;

    socket.on('error', () => undefined);

    // Oversized / malformed frames only tear down this connection (and notify
    // onProtocolError). Unlike the old per-exec hostRun path, we do not kill the
    // sandboxed process group — transport lifetime is handle-scoped, not tied to one exec.
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      this.onProtocolError?.(message);
      socket.destroy();
    };

    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

    socket.on('end', () => {
      if (settled) return;
      settled = true;
      void this.dispatchConnection(socket, reader).catch((error: unknown) => {
        this.onProtocolError?.(error instanceof Error ? error.message : String(error));
        socket.destroy();
      });
    });
  }

  private async dispatchConnection(socket: Socket, reader: JsonMessageReader): Promise<void> {
    let request: CodeModeRequest;
    try {
      const parsed = CodeModeRequestSchema.safeParse(reader.finish());
      if (!parsed.success) {
        const reply: CodeModeReply = {
          ok: false,
          error: 'Malformed Code Mode request',
          source: 'caller',
        };
        socket.write(encodeJsonMessage(reply));
        socket.end();
        return;
      }
      request = parsed.data;
    } catch (error) {
      this.onProtocolError?.(error instanceof Error ? error.message : String(error));
      socket.destroy();
      return;
    }

    const dispatcher = this.dispatcher;
    if (dispatcher === undefined) {
      const reply: CodeModeReply = {
        ok: false,
        error: 'Code Mode dispatcher is not configured',
        source: 'internal',
      };
      socket.write(encodeJsonMessage(reply));
      socket.end();
      return;
    }

    const reply = await dispatcher.dispatch({ request, traceCarrier: {} });
    try {
      socket.write(encodeJsonMessage(reply));
    } finally {
      socket.end();
    }
  }
}
