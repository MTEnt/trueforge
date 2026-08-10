import { CancellationReason } from '@truefoundry/utils-core/agent-session';
import { PromiseTimeoutError } from '@truefoundry/utils-core/core';
import configuration from '../../../src/config';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';

async function* values<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function* throwingStream(): AsyncGenerator<number> {
  yield 1;
  throw new Error('stream boom');
}

/**
 * Yields once, then waits until `signal` aborts before completing — used to
 * prove cancelIfRunning / shutdownAndWait wait for tracked streams after abort.
 */
async function* gateOnAbort(signal: AbortSignal): AsyncGenerator<string> {
  yield 'started';
  if (signal.aborted) {
    return;
  }
  await new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Starts consuming a tracked stream so its `finally` can mark the run complete. */
function drain<T>(stream: AsyncIterable<T>): Promise<void> {
  return (async () => {
    for await (const value of stream) {
      void value;
    }
  })();
}

describe('ActiveTurnRegistry', () => {
  it('track passes events through and removes the run when the stream completes', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: values([1, 2, 3]),
    });

    const seen: number[] = [];
    for await (const value of tracked) {
      seen.push(value);
    }
    expect(seen).toEqual([1, 2, 3]);
    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('not-running');
  });

  it('track cleans up when the consumer breaks early', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: values([1, 2, 3]),
    });

    for await (const value of tracked) {
      expect(value).toBe(1);
      break;
    }
    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('not-running');
  });

  it('track cleans up when the stream throws', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: throwingStream(),
    });

    await expect(async () => {
      for await (const value of tracked) {
        void value;
      }
    }).rejects.toThrow(/stream boom/);
    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('not-running');
  });

  it('cancelIfRunning aborts, waits for teardown, and returns cancelled', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: gateOnAbort(abortController.signal),
    });
    const draining = drain(tracked);

    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('cancelled');
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(CancellationReason.ClientCancelled);
    await draining;
  });

  it('cancelIfRunning returns not-running for unknown ids', async () => {
    const registry = new ActiveTurnRegistry();
    await expect(
      registry.cancelIfRunning({
        sessionId: 'missing',
        turnId: 'missing',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('not-running');
  });

  it('cancelIfRunning does not re-abort an already-aborted controller', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: gateOnAbort(abortController.signal),
    });
    const draining = drain(tracked);
    abortController.abort(CancellationReason.ClientCancelled);

    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.Abandoned,
      }),
    ).resolves.toBe('cancelled');
    expect(abortController.signal.reason).toBe(CancellationReason.ClientCancelled);
    await draining;
  });

  it('cancelIfRunning throws PromiseTimeoutError when teardown does not finish', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: (async function* () {
        await new Promise(() => undefined);
        yield 'never';
      })(),
    });
    void drain(tracked);

    const previousTimeout = configuration.AGENT_CANCEL_RESPONSE_TIMEOUT_MS;
    configuration.AGENT_CANCEL_RESPONSE_TIMEOUT_MS = 20;
    try {
      await expect(
        registry.cancelIfRunning({
          sessionId: 's1',
          turnId: 't1',
          abortReason: CancellationReason.ClientCancelled,
        }),
      ).rejects.toBeInstanceOf(PromiseTimeoutError);
    } finally {
      configuration.AGENT_CANCEL_RESPONSE_TIMEOUT_MS = previousTimeout;
    }
  });

  it('shutdownAndWait aborts runs and waits until tracked streams finish', async () => {
    const registry = new ActiveTurnRegistry();
    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 't1',
      abortController,
      stream: gateOnAbort(abortController.signal),
    });

    const draining = drain(tracked);

    await registry.shutdownAndWait(CancellationReason.Abandoned);
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(CancellationReason.Abandoned);
    await draining;
    await expect(
      registry.cancelIfRunning({
        sessionId: 's1',
        turnId: 't1',
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toBe('not-running');
  });

  it('late track after shutdownAndWait aborts immediately with the shutdown reason', async () => {
    const registry = new ActiveTurnRegistry();
    await registry.shutdownAndWait(CancellationReason.Abandoned);

    const abortController = new AbortController();
    const tracked = registry.track({
      sessionId: 's1',
      turnId: 'late',
      abortController,
      stream: values(['x']),
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(CancellationReason.Abandoned);

    for await (const value of tracked) {
      void value;
    }
  });
});
