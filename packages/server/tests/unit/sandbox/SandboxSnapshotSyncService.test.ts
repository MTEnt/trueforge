import type { DaytonaSnapshot, IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import winston from 'winston';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { ImageResolutionError, type IImageDigestResolver } from '../../../src/sandbox/ImageDigestResolver';
import { SandboxSnapshotSyncService } from '../../../src/sandbox/SandboxSnapshotSyncService';
import { deriveSandboxSnapshotName } from '../../../src/sandbox/snapshotName';
import type { SandboxProviderManifest } from '../../../src/schemas/sandboxProvider';
import {
  sandboxSnapshotStatus,
  type SandboxSnapshotSpec,
  type SandboxSnapshotSyncState,
} from '../../../src/schemas/sandboxSnapshot';

const TENANT = 'default';
const TAG = 'ghcr.io/truefoundry/trueforge-sandbox:latest';
const SPEC: SandboxSnapshotSpec = { docker_image: TAG };
const DIGEST = `sha256:${'1'.repeat(64)}`;
const NAME = deriveSandboxSnapshotName({ spec: SPEC, digest: DIGEST });

const manifest: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const activeRef = { snapshot_name: NAME, image: TAG, digest: DIGEST };

function activeSnapshot(): DaytonaSnapshot {
  return { id: 'snap-1', name: NAME, imageName: TAG, state: 'active', errorReason: null };
}

/** Counts round-trips so throttling and single-flight are observable. */
class CountingSnapshots implements IDaytonaSnapshots {
  getCalls = 0;
  createCalls = 0;

  constructor(private readonly result: DaytonaSnapshot | undefined) {}

  async get(): Promise<DaytonaSnapshot | undefined> {
    this.getCalls += 1;
    return await Promise.resolve(this.result);
  }

  async initiateCreate(): Promise<DaytonaSnapshot> {
    this.createCalls += 1;
    return await Promise.resolve({ ...activeSnapshot(), state: 'pending' });
  }

  async activate(): Promise<DaytonaSnapshot> {
    return await Promise.resolve(activeSnapshot());
  }

  async delete(): Promise<void> {
    await Promise.resolve();
  }
}

/** Counts resolutions so the registry call budget is observable. */
class CountingImages implements IImageDigestResolver {
  calls = 0;

  constructor(private readonly digest = DIGEST) {}

  async resolve(): Promise<string> {
    this.calls += 1;
    return await Promise.resolve(this.digest);
  }
}

function serviceFor({
  store,
  snapshots,
  images = new CountingImages(),
  spec = SPEC,
}: {
  store: ISandboxProviderStore;
  snapshots: IDaytonaSnapshots;
  images?: IImageDigestResolver;
  spec?: SandboxSnapshotSpec;
}): SandboxSnapshotSyncService {
  return new SandboxSnapshotSyncService({
    store,
    catalog: new SandboxCatalog({ providers: [], snapshot: spec }),
    createSnapshots: () => snapshots,
    images,
    logger: winston.createLogger({ silent: true }),
  });
}

/** Daytona that answers `get` only once the test says so, to observe what waits on it. */
function gatedSnapshots(): { snapshots: IDaytonaSnapshots; answer: (snapshot: DaytonaSnapshot) => void } {
  let answer: ((snapshot: DaytonaSnapshot) => void) | undefined;
  const gate = new Promise<DaytonaSnapshot>(resolve => {
    answer = resolve;
  });
  if (answer === undefined) {
    throw new Error('Promise executors run synchronously');
  }
  return {
    answer,
    snapshots: {
      get: async () => await gate,
      initiateCreate: async () => await gate,
      activate: async () => await gate,
      delete: async () => await Promise.resolve(),
    },
  };
}

function syncedState(overrides: Partial<SandboxSnapshotSyncState> = {}): SandboxSnapshotSyncState {
  return {
    desired_image: TAG,
    active: activeRef,
    pending: undefined,
    error_message: undefined,
    superseded: [],
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('SandboxSnapshotSyncService', () => {
  let store: ISandboxProviderStore;

  beforeEach(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    store = new SqliteSandboxProviderStore(db);
  });

  describe('readiness', () => {
    it('is not ready and still syncing before the first reconcile', () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(undefined) });

      expect(service.readiness(manifest)).toEqual({
        ready: false,
        syncing: true,
        reason: expect.stringContaining('has not been synced'),
      });
    });

    it('is ready with the active snapshot name', () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });

      expect(service.readiness({ ...manifest, snapshot_sync: syncedState() })).toEqual({
        ready: true,
        snapshotName: NAME,
      });
    });

    // An active snapshot decides readiness on its own: neither a newer image being
    // prepared nor a failed attempt to move to one takes sandboxes away.
    it('stays ready while an update is pending, and after one failed', () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      const updating = syncedState({
        pending: { snapshot_name: 'trueforge-sandbox-next', image: TAG, digest: `sha256:${'2'.repeat(64)}` },
        error_message: 'manifest unknown',
      });

      expect(service.readiness({ ...manifest, snapshot_sync: updating })).toEqual({ ready: true, snapshotName: NAME });
    });

    it('surfaces the failure message and stops calling it syncing', () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(undefined) });
      const failed = syncedState({ active: undefined, error_message: 'manifest unknown' });

      expect(service.readiness({ ...manifest, snapshot_sync: failed })).toEqual({
        ready: false,
        syncing: false,
        reason: 'manifest unknown',
      });
    });

    it('is still ready when the catalog tag changed, since the old snapshot serves on', () => {
      const service = serviceFor({
        store,
        snapshots: new CountingSnapshots(activeSnapshot()),
        spec: { docker_image: 'ghcr.io/truefoundry/trueforge-sandbox:next' },
      });

      expect(service.readiness({ ...manifest, snapshot_sync: syncedState() })).toEqual({
        ready: true,
        snapshotName: NAME,
      });
    });
  });

  describe('refresh', () => {
    it('persists the reconciled state', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      const sync = await service.refresh({ record });

      expect(sync.active).toEqual(activeRef);
      expect((await store.getSandboxProvider(TENANT))?.manifest.snapshot_sync).toEqual(sync);
    });

    it('leaves the configuration untouched when persisting sync', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await service.refresh({ record });

      const stored = await store.getSandboxProvider(TENANT);
      expect(stored?.manifest.auth.api_key).toBe('dtn-test');
      expect(stored?.manifest.exec_timeout_ms).toBe(60_000);
    });

    it('trusts a recent synced state instead of calling Daytona or the registry again', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const images = new CountingImages();
      const service = serviceFor({ store, snapshots, images });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState() },
      });

      await service.refresh({ record });

      expect(snapshots.getCalls).toBe(0);
      expect(images.calls).toBe(0);
    });

    it('re-checks once a synced state ages past the refresh window', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState({ updated_at: '2020-01-01T00:00:00.000Z' }) },
      });

      await service.refresh({ record });

      expect(snapshots.getCalls).toBe(1);
    });

    it('always re-checks while a snapshot is being prepared, which is what makes polling work', async () => {
      const snapshots = new CountingSnapshots(undefined);
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState({ active: undefined, pending: activeRef }) },
      });

      await service.refresh({ record });

      expect(snapshots.getCalls).toBe(1);
    });

    it('does not re-ask Daytona about a settled failure on every request', async () => {
      const snapshots = new CountingSnapshots(undefined);
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState({ active: undefined, error_message: 'pull failed' }) },
      });

      const sync = await service.refresh({ record });

      expect(snapshots.getCalls).toBe(0);
      expect(sync.error_message).toBe('pull failed');
    });

    // Observed against a real account whose key could not delete snapshots: counting the
    // undrained entry as unsettled made every poll and turn start pay for a reconcile.
    it('does not re-check on every call just because a snapshot awaits cleanup', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState({ superseded: [{ ...activeRef, snapshot_name: 'old' }] }) },
      });

      await service.refresh({ record });

      expect(snapshots.getCalls).toBe(0);
    });

    it('still retries the cleanup once the refresh window has passed', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: {
          ...manifest,
          snapshot_sync: syncedState({
            superseded: [{ ...activeRef, snapshot_name: 'old' }],
            updated_at: '2020-01-01T00:00:00.000Z',
          }),
        },
      });

      const refreshed = await service.refresh({ record });

      expect(snapshots.getCalls).toBeGreaterThan(0);
      expect(refreshed.superseded).toEqual([]);
    });

    it('re-checks immediately when the catalog names a different image', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const service = serviceFor({
        store,
        snapshots,
        spec: { docker_image: 'ghcr.io/truefoundry/trueforge-sandbox:next' },
      });
      const record = await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState() },
      });

      const refreshed = await service.refresh({ record });

      expect(snapshots.getCalls).toBeGreaterThan(0);
      expect(refreshed.desired_image).toBe('ghcr.io/truefoundry/trueforge-sandbox:next');
    });

    it('collapses concurrent reconciles so a snapshot is never created twice', async () => {
      const snapshots = new CountingSnapshots(undefined);
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await Promise.all([service.refresh({ record }), service.refresh({ record }), service.refresh({ record })]);

      expect(snapshots.createCalls).toBe(1);
    });

    it('reconciles again after an in-flight reconcile settles', async () => {
      const snapshots = new CountingSnapshots(undefined);
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await service.refresh({ record });
      await service.refresh({ record });

      expect(snapshots.getCalls).toBe(2);
    });

    it('reports a registry that cannot be reached without losing the configuration', async () => {
      const service = serviceFor({
        store,
        snapshots: new CountingSnapshots(activeSnapshot()),
        images: { resolve: () => Promise.reject(new ImageResolutionError('ghcr.io answered 503')) },
      });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      const sync = await service.refresh({ record });

      expect(sandboxSnapshotStatus(sync)).toBe('failed');
      expect(sync.error_message).toContain('ghcr.io answered 503');
    });

    /**
     * Both writes are for the same tenant, so the reconcile's patch would land on
     * the saved configuration and advertise a snapshot that only exists in the
     * account the user just moved off.
     */
    it('does not record a reconcile against an API key that has since been replaced', async () => {
      const snapshots: IDaytonaSnapshots = {
        // Stands in for a save landing after this reconcile read its credentials.
        get: async () => {
          await store.upsertSandboxProvider({
            tenant_id: TENANT,
            manifest: { ...manifest, auth: { api_key: 'dtn-other' } },
          });
          return activeSnapshot();
        },
        initiateCreate: async () => await Promise.resolve(activeSnapshot()),
        activate: async () => await Promise.resolve(activeSnapshot()),
        delete: async () => await Promise.resolve(),
      };
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await service.refresh({ record });

      expect((await store.getSandboxProvider(TENANT))?.manifest.snapshot_sync).toBeUndefined();
    });
  });

  describe('load', () => {
    it('returns undefined when no provider is configured', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });

      expect(await service.load({ tenant_id: TENANT })).toBeUndefined();
    });

    it('returns the manifest with freshly reconciled sync merged in', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      const loaded = await service.load({ tenant_id: TENANT });

      expect(loaded?.snapshot_sync.active).toEqual(activeRef);
      expect(loaded?.manifest.snapshot_sync).toEqual(loaded?.snapshot_sync);
    });
  });

  describe('reconcileForSave', () => {
    /**
     * Overlapping reconciles send conflicting commands for the same snapshot names —
     * a save deleting one a poll is mid-inspection of — and then both write what they
     * saw. Saves and polls are the two triggers most likely to arrive together.
     */
    it('does not run while a poll is reconciling the same tenant', async () => {
      let inFlight = 0;
      let overlapped = false;
      const snapshots: IDaytonaSnapshots = {
        get: async () => {
          inFlight += 1;
          // Held long enough that a second reconcile getting this far is observable.
          await new Promise(resolve => setTimeout(resolve, 10));
          overlapped = overlapped || inFlight > 1;
          inFlight -= 1;
          return activeSnapshot();
        },
        initiateCreate: async () => await Promise.resolve(activeSnapshot()),
        activate: async () => await Promise.resolve(activeSnapshot()),
        delete: async () => await Promise.resolve(),
      };
      const service = serviceFor({ store, snapshots });
      const record = await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await Promise.all([
        service.refresh({ record }),
        service.reconcileForSave({ tenant_id: TENANT, manifest }),
        service.refresh({ record }),
      ]);

      expect(overlapped).toBe(false);
    });

    it('reconciles from the stored snapshot state, not from what the caller holds', async () => {
      const deleted: string[] = [];
      const snapshots: IDaytonaSnapshots = {
        get: async name => await Promise.resolve({ ...activeSnapshot(), name }),
        initiateCreate: async () => await Promise.resolve(activeSnapshot()),
        activate: async () => await Promise.resolve(activeSnapshot()),
        delete: async target => {
          deleted.push(target.name);
          await Promise.resolve();
        },
      };
      const service = serviceFor({ store, snapshots });
      const stale = { snapshot_name: 'trueforge-sandbox-stale', image: TAG, digest: `sha256:${'9'.repeat(64)}` };
      await store.upsertSandboxProvider({
        tenant_id: TENANT,
        manifest: { ...manifest, snapshot_sync: syncedState({ superseded: [stale] }) },
      });

      const saved = await service.reconcileForSave({ tenant_id: TENANT, manifest });

      expect(deleted).toEqual([stale.snapshot_name]);
      expect(saved.superseded).toEqual([]);
    });
  });

  describe('loadForTurn', () => {
    it('does not make the turn wait on Daytona once a snapshot is serving', async () => {
      const { snapshots, answer } = gatedSnapshots();
      const service = serviceFor({ store, snapshots });
      await store.upsertSandboxProvider({
        tenant_id: TENANT,
        // Stale enough that a blocking refresh would have to reach Daytona first.
        manifest: { ...manifest, snapshot_sync: syncedState({ updated_at: '2020-01-01T00:00:00.000Z' }) },
      });

      const loaded = await service.loadForTurn({ tenant_id: TENANT });

      expect(loaded?.snapshot_sync.active).toEqual(activeRef);
      answer(activeSnapshot());
    });

    it('waits when nothing is serving yet, which is what heals a sync nobody is polling', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      const loaded = await service.loadForTurn({ tenant_id: TENANT });

      expect(loaded?.snapshot_sync.active).toEqual(activeRef);
      expect((await store.getSandboxProvider(TENANT))?.manifest.snapshot_sync?.active).toEqual(activeRef);
    });
  });

  describe('reconcileAtBoot', () => {
    it('syncs an existing provider so a new image converges without the settings page', async () => {
      const service = serviceFor({ store, snapshots: new CountingSnapshots(activeSnapshot()) });
      await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await service.reconcileAtBoot({ tenant_id: TENANT });

      expect((await store.getSandboxProvider(TENANT))?.manifest.snapshot_sync?.active).toEqual(activeRef);
    });

    it('does nothing when no provider is configured', async () => {
      const snapshots = new CountingSnapshots(activeSnapshot());
      const service = serviceFor({ store, snapshots });

      await service.reconcileAtBoot({ tenant_id: TENANT });

      expect(snapshots.getCalls).toBe(0);
    });

    it('never throws, so Daytona cannot stop the server from booting', async () => {
      const failing: IDaytonaSnapshots = {
        get: () => Promise.reject(new Error('daytona down')),
        initiateCreate: () => Promise.reject(new Error('daytona down')),
        activate: () => Promise.reject(new Error('daytona down')),
        delete: () => Promise.reject(new Error('daytona down')),
      };
      const service = serviceFor({ store, snapshots: failing });
      await store.upsertSandboxProvider({ tenant_id: TENANT, manifest });

      await expect(service.reconcileAtBoot({ tenant_id: TENANT })).resolves.toBeUndefined();
      const stored = await store.getSandboxProvider(TENANT);
      expect(stored?.manifest.snapshot_sync?.error_message).toContain('daytona down');
    });
  });
});
