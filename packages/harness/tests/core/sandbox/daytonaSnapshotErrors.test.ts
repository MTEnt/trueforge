/**
 * A refused snapshot request is where an operator learns the configured image can never
 * work, and an axios message carries only the status code. These drive the real client
 * against a server answering the way Daytona does, so the envelope is the real one.
 */
import { createServer, type Server } from 'node:http';
import { DaytonaSnapshotAuthError, DaytonaSnapshots } from '../../../src/core/sandbox/provider/DaytonaSnapshots';

interface StubbedDaytona {
  apiUrl: string;
  close: () => Promise<void>;
}

async function startStubbedDaytona({ status, body }: { status: number; body: unknown }): Promise<StubbedDaytona> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  const apiUrl = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('stub server reported no port'));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
  return {
    apiUrl,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function createAgainst(stub: StubbedDaytona): Promise<unknown> {
  const snapshots = new DaytonaSnapshots({ apiKey: 'dtn-test', apiUrl: stub.apiUrl });
  try {
    await snapshots.initiateCreate({
      name: 'trueforge-sandbox-test',
      imageName: 'ghcr.io/org/app:stable',
      entrypoint: undefined,
      resources: undefined,
    });
  } catch (error) {
    return error;
  }
  throw new Error('expected the create to reject');
}

describe('DaytonaSnapshots error reporting', () => {
  it('surfaces the reason Daytona gave for rejecting the request', async () => {
    const stub = await startStubbedDaytona({
      status: 400,
      body: { statusCode: 400, error: 'Bad Request', message: 'Images with tag ":latest" are not allowed' },
    });
    try {
      const error = await createAgainst(stub);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DaytonaSnapshotAuthError);
      const { message } = error instanceof Error ? error : { message: '' };
      expect(message).toContain('Images with tag ":latest" are not allowed');
      expect(message).toContain('400');
    } finally {
      await stub.close();
    }
  });

  it.each([401, 403])('still reports a rejected key as an auth failure on %s', async status => {
    const stub = await startStubbedDaytona({ status, body: { statusCode: status, message: 'Unauthorized' } });
    try {
      expect(await createAgainst(stub)).toBeInstanceOf(DaytonaSnapshotAuthError);
    } finally {
      await stub.close();
    }
  });

  it('keeps the failure when Daytona explains nothing', async () => {
    const stub = await startStubbedDaytona({ status: 500, body: { statusCode: 500 } });
    try {
      const error = await createAgainst(stub);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DaytonaSnapshotAuthError);
    } finally {
      await stub.close();
    }
  });
});
