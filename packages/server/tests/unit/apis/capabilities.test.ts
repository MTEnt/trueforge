import type { IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import { createCapabilitiesRouter } from '../../../src/apis/capabilities';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import type { SandboxProviderManifest } from '../../../src/schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../../../src/schemas/sandboxSnapshot';
import {
  createTestSandboxSnapshotSync,
  readySandboxSnapshotSync,
  testSandboxDigest,
  testSandboxImage,
  testSandboxSnapshotName,
  testSandboxSnapshotSpec,
} from '../support/sandboxSnapshotSync';

const config: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const syncBase = {
  desired_image: testSandboxSnapshotSpec.docker_image,
  active: undefined,
  pending: undefined,
  error_message: undefined,
  superseded: [],
  updated_at: new Date().toISOString(),
};
const syncingSync: SandboxSnapshotSyncState = {
  ...syncBase,
  pending: { snapshot_name: testSandboxSnapshotName, image: testSandboxImage, digest: testSandboxDigest },
};
const failedSync: SandboxSnapshotSyncState = { ...syncBase, error_message: 'manifest unknown' };

/** Capabilities must answer from persisted state, so this double fails loudly if used. */
const unusableSnapshots: IDaytonaSnapshots = {
  get: () => Promise.reject(new Error('capabilities must not call Daytona')),
  initiateCreate: () => Promise.reject(new Error('capabilities must not call Daytona')),
  activate: () => Promise.reject(new Error('capabilities must not call Daytona')),
  delete: () => Promise.reject(new Error('capabilities must not call Daytona')),
};

describe('capabilities router', () => {
  let store: ISandboxProviderStore;
  let router: ReturnType<typeof createCapabilitiesRouter>;

  beforeEach(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    store = new SqliteSandboxProviderStore(db);
    router = createCapabilitiesRouter({
      sandboxProviderStore: store,
      sandboxSnapshotSync: createTestSandboxSnapshotSync({ store, snapshots: unusableSnapshots }),
    });
  });

  it('disables sandbox and skills when no provider is configured', async () => {
    const response = await router.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'No sandbox provider is configured.' },
        skill: {
          enabled: false,
          reason: 'Skills run in a sandbox, which is unavailable. No sandbox provider is configured.',
        },
        settings: { enabled: true },
      },
    });
  });

  it('enables sandbox and skills once the snapshot is ready', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: readySandboxSnapshotSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
      },
    });
  });

  it('keeps sandbox disabled while the first image is still being prepared', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: syncingSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'The sandbox image is still being prepared in Daytona.' },
        skill: {
          enabled: false,
          reason:
            'Skills run in a sandbox, which is unavailable. The sandbox image is still being prepared in Daytona.',
        },
        settings: { enabled: true },
      },
    });
  });

  it('reports the sync failure as the reason sandbox is unavailable', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: failedSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'manifest unknown' },
        skill: { enabled: false, reason: 'Skills run in a sandbox, which is unavailable. manifest unknown' },
        settings: { enabled: true },
      },
    });
  });

  it('disables sandbox for a configured provider that has never synced', async () => {
    await store.upsertSandboxProvider({ tenant_id: 'default', manifest: config });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'The sandbox image has not been synced to Daytona yet.' },
        skill: {
          enabled: false,
          reason:
            'Skills run in a sandbox, which is unavailable. The sandbox image has not been synced to Daytona yet.',
        },
        settings: { enabled: true },
      },
    });
  });
});
