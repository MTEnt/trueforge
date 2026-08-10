import type { DaytonaSnapshot, IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import { DaytonaSnapshotAuthError } from '@truefoundry/utils-core/core';
import { createSandboxProvidersRouter } from '../../../src/apis/sandboxProviders';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { ImageResolutionError, type IImageDigestResolver } from '../../../src/sandbox/ImageDigestResolver';
import {
  testSandboxCatalog as catalog,
  createTestSandboxSnapshotSync,
  imagesResolvingTo,
  testSandboxSnapshotName as NAME,
  testSandboxSnapshotSpec as SPEC,
  testSandboxDigest,
  testSandboxImage,
} from '../support/sandboxSnapshotSync';

const putBody = {
  type: 'daytona' as const,
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const activeRef = { snapshot_name: NAME, image: testSandboxImage, digest: testSandboxDigest };

function putInit(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function snapshot(overrides: Partial<DaytonaSnapshot> = {}): DaytonaSnapshot {
  return {
    id: 'snap-1',
    name: NAME,
    imageName: testSandboxImage,
    state: 'active',
    errorReason: null,
    ...overrides,
  };
}

/** Snapshot double whose behaviour tests swap per case. */
class ScriptedSnapshots implements IDaytonaSnapshots {
  result: DaytonaSnapshot | undefined | Error = undefined;

  async get(): Promise<DaytonaSnapshot | undefined> {
    if (this.result instanceof Error) throw this.result;
    return await Promise.resolve(this.result);
  }

  async initiateCreate(): Promise<DaytonaSnapshot> {
    return await Promise.resolve(snapshot({ state: 'pending' }));
  }

  async activate(): Promise<DaytonaSnapshot> {
    return await Promise.resolve(snapshot());
  }

  async delete(): Promise<void> {
    await Promise.resolve();
  }
}

describe('sandboxProviders router', () => {
  let settingsRouter: ReturnType<typeof createSandboxProvidersRouter>;
  let store: ISandboxProviderStore;
  let snapshots: ScriptedSnapshots;

  const mount = (images: IImageDigestResolver = imagesResolvingTo()) => {
    settingsRouter = createSandboxProvidersRouter({
      sandboxCatalog: catalog,
      sandboxProviderStore: store,
      sandboxSnapshotSync: createTestSandboxSnapshotSync({ store, snapshots, images }),
    });
  };

  beforeEach(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    store = new SqliteSandboxProviderStore(db);
    snapshots = new ScriptedSnapshots();
    mount();
  });

  it('GET /catalog returns the shipped presets verbatim', async () => {
    const response = await settingsRouter.request('/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [...catalog.list()] });
  });

  it('GET /catalog does not leak the sandbox image', async () => {
    const body: unknown = await (await settingsRouter.request('/catalog')).json();
    expect(JSON.stringify(body)).not.toContain(SPEC.docker_image);
  });

  it('GET / returns 404 when none configured', async () => {
    const response = await settingsRouter.request('/');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: 'No sandbox provider configured' } });
  });

  it('PUT starts a snapshot sync and reports what is being prepared', async () => {
    const response = await settingsRouter.request('/', putInit(putBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        ...putBody,
        snapshot_sync: {
          desired_image: SPEC.docker_image,
          pending: activeRef,
          updated_at: expect.any(String),
        },
      },
    });
  });

  it('PUT reports an active snapshot when Daytona already holds it', async () => {
    snapshots.result = snapshot();

    const response = await settingsRouter.request('/', putInit(putBody));

    expect(await response.json()).toMatchObject({ data: { snapshot_sync: { active: activeRef } } });
  });

  it('PUT rejects credentials Daytona refuses and stores nothing', async () => {
    snapshots.result = new DaytonaSnapshotAuthError({ cause: 'bad key' });

    const response = await settingsRouter.request('/', putInit(putBody));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { message: 'Daytona rejected this API key.' } });
    expect(await store.getSandboxProvider('default')).toBeUndefined();
  });

  /**
   * The key was accepted when it was saved; Daytona rejecting it later is news the
   * settings page has to be able to render, not a 500 on every poll.
   */
  it('GET reports a key Daytona has since revoked instead of failing', async () => {
    // Left mid-sync, so the poll genuinely reconciles rather than trusting the state.
    await settingsRouter.request('/', putInit(putBody));
    snapshots.result = new DaytonaSnapshotAuthError({ cause: 'revoked' });

    const response = await settingsRouter.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { snapshot_sync: { error_message: expect.stringContaining('rejected the configured API key') } },
    });
  });

  it('PUT still saves when the registry is unreachable, since the key is valid', async () => {
    mount({ resolve: () => Promise.reject(new ImageResolutionError('ghcr.io answered 503')) });

    const response = await settingsRouter.request('/', putInit(putBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { snapshot_sync: { error_message: expect.stringContaining('ghcr.io answered 503') } },
    });
    expect(await store.getSandboxProvider('default')).toBeDefined();
  });

  it('PUT rejects a client-supplied snapshot name', async () => {
    const response = await settingsRouter.request('/', putInit({ ...putBody, snapshot_name: 'mine' }));
    expect(response.status).toBe(400);
  });

  it('PUT rejects server-owned sync state in the body', async () => {
    const response = await settingsRouter.request('/', putInit({ ...putBody, snapshot_sync: { active: activeRef } }));
    expect(response.status).toBe(400);
  });

  it('PUT rejects invalid bodies at the Zod layer', async () => {
    const { auth: _auth, ...withoutAuth } = putBody;
    expect((await settingsRouter.request('/', putInit(withoutAuth))).status).toBe(400);
    expect((await settingsRouter.request('/', putInit({ ...putBody, type: 'unknown' }))).status).toBe(400);
  });

  it('GET advances a sync in progress, so polling it reaches an active snapshot', async () => {
    await settingsRouter.request('/', putInit(putBody));
    snapshots.result = snapshot({ state: 'pulling' });

    const pulling: unknown = await (await settingsRouter.request('/')).json();
    expect(pulling).toMatchObject({ data: { snapshot_sync: { pending: activeRef } } });

    snapshots.result = snapshot();
    const ready: unknown = await (await settingsRouter.request('/')).json();
    expect(ready).toMatchObject({ data: { snapshot_sync: { active: activeRef } } });
  });

  it('GET reports a failed sync with 200 so the settings page can explain it', async () => {
    await settingsRouter.request('/', putInit(putBody));
    snapshots.result = snapshot({ state: 'build_failed', errorReason: 'manifest unknown' });

    const response = await settingsRouter.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { snapshot_sync: { error_message: 'manifest unknown' } },
    });
  });

  it('GET returns exactly the configuration plus sync, without internal cleanup state', async () => {
    snapshots.result = snapshot();
    await settingsRouter.request('/', putInit(putBody));

    const response = await settingsRouter.request('/');

    expect(await response.json()).toEqual({
      data: {
        ...putBody,
        snapshot_sync: {
          desired_image: SPEC.docker_image,
          active: activeRef,
          updated_at: expect.any(String),
        },
      },
    });
  });

  it('PUT preserves the active snapshot when only credentials are rotated', async () => {
    snapshots.result = snapshot();
    await settingsRouter.request('/', putInit(putBody));

    const rotated: unknown = await (
      await settingsRouter.request('/', putInit({ ...putBody, auth: { api_key: 'dtn-rotated' } }))
    ).json();

    expect(rotated).toMatchObject({ data: { snapshot_sync: { active: activeRef } } });
    expect((await store.getSandboxProvider('default'))?.manifest.auth.api_key).toBe('dtn-rotated');
  });
});
