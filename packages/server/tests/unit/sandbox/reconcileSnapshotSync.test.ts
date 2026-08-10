import type { CreateDaytonaSnapshotParams, DaytonaSnapshot, IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import { DaytonaSnapshotAuthError } from '@truefoundry/utils-core/core';
import winston from 'winston';
import { ImageResolutionError, type IImageDigestResolver } from '../../../src/sandbox/ImageDigestResolver';
import { reconcileSnapshotSync, type SnapshotSyncMode } from '../../../src/sandbox/reconcileSnapshotSync';
import { deriveSandboxSnapshotName } from '../../../src/sandbox/snapshotName';
import {
  sandboxSnapshotStatus,
  type SandboxSnapshotRef,
  type SandboxSnapshotSpec,
  type SandboxSnapshotSyncState,
} from '../../../src/schemas/sandboxSnapshot';

const REPOSITORY = 'ghcr.io/truefoundry/trueforge-sandbox';
/** The catalog ships a moving tag; the digest underneath is what identifies content. */
const TAG = `${REPOSITORY}:latest`;
const SPEC: SandboxSnapshotSpec = { docker_image: TAG };
const NOW = new Date('2026-08-07T12:00:00.000Z');

const FIRST_DIGEST = `sha256:${'1'.repeat(64)}`;
const SECOND_DIGEST = `sha256:${'2'.repeat(64)}`;

const FIRST_NAME = deriveSandboxSnapshotName({ spec: SPEC, digest: FIRST_DIGEST });
const SECOND_NAME = deriveSandboxSnapshotName({ spec: SPEC, digest: SECOND_DIGEST });

// Both refs carry the same image, because the tag is what Daytona is told to pull;
// only the digest, and therefore the name, differs between them.
const firstRef: SandboxSnapshotRef = { snapshot_name: FIRST_NAME, image: TAG, digest: FIRST_DIGEST };
const secondRef: SandboxSnapshotRef = { snapshot_name: SECOND_NAME, image: TAG, digest: SECOND_DIGEST };

function snapshot(overrides: Partial<DaytonaSnapshot> = {}): DaytonaSnapshot {
  return {
    id: `id-${overrides.name ?? FIRST_NAME}`,
    name: FIRST_NAME,
    imageName: TAG,
    state: 'active',
    errorReason: null,
    ...overrides,
  };
}

/** Resolves the catalog tag to whatever digest the test says it points at today. */
function images(resolved: string | Error): IImageDigestResolver {
  return {
    resolve: async () => {
      if (resolved instanceof Error) throw resolved;
      return await Promise.resolve(resolved);
    },
  };
}

/**
 * Behaves like a Daytona account: snapshots are addressed by name, creation
 * registers one in a non-terminal state, and every call is recorded so tests can
 * assert what we asked Daytona to do rather than only the resulting state.
 */
class FakeSnapshots implements IDaytonaSnapshots {
  readonly created: CreateDaytonaSnapshotParams[] = [];
  readonly activated: string[] = [];
  readonly deleted: string[] = [];
  private readonly store = new Map<string, DaytonaSnapshot>();
  private readonly getError: Error | undefined;
  private readonly deleteError: Error | undefined;
  private readonly onCreate: (params: CreateDaytonaSnapshotParams) => DaytonaSnapshot;
  private readonly onActivate: ((target: DaytonaSnapshot) => DaytonaSnapshot) | undefined;

  constructor(
    options: {
      existing?: readonly DaytonaSnapshot[];
      onCreate?: (params: CreateDaytonaSnapshotParams) => DaytonaSnapshot;
      onActivate?: (target: DaytonaSnapshot) => DaytonaSnapshot;
      getError?: Error;
      deleteError?: Error;
    } = {},
  ) {
    for (const existing of options.existing ?? []) {
      this.store.set(existing.name, existing);
    }
    this.onCreate =
      options.onCreate ??
      (params =>
        snapshot({ id: `id-${params.name}`, name: params.name, imageName: params.imageName, state: 'pending' }));
    this.onActivate = options.onActivate;
    this.getError = options.getError;
    this.deleteError = options.deleteError;
  }

  async get(name: string): Promise<DaytonaSnapshot | undefined> {
    if (this.getError !== undefined) throw this.getError;
    return await Promise.resolve(this.store.get(name));
  }

  async initiateCreate(params: CreateDaytonaSnapshotParams): Promise<DaytonaSnapshot> {
    this.created.push(params);
    const created = this.onCreate(params);
    this.store.set(created.name, created);
    return await Promise.resolve(created);
  }

  async activate(target: DaytonaSnapshot): Promise<DaytonaSnapshot> {
    this.activated.push(target.id);
    const activated = this.onActivate?.(target) ?? { ...target, state: 'active' };
    this.store.set(activated.name, activated);
    return await Promise.resolve(activated);
  }

  async delete(target: DaytonaSnapshot): Promise<void> {
    if (this.deleteError !== undefined) throw this.deleteError;
    this.deleted.push(target.name);
    this.store.delete(target.name);
    await Promise.resolve();
  }

  names(): string[] {
    return [...this.store.keys()].sort();
  }
}

function reconcile({
  snapshots,
  resolved = FIRST_DIGEST,
  current,
  mode = 'read',
  spec = SPEC,
}: {
  snapshots: IDaytonaSnapshots;
  resolved?: string | Error;
  current?: SandboxSnapshotSyncState;
  mode?: SnapshotSyncMode;
  spec?: SandboxSnapshotSpec;
}): Promise<SandboxSnapshotSyncState> {
  return reconcileSnapshotSync({
    snapshots,
    images: images(resolved),
    spec,
    current,
    mode,
    now: NOW,
    logger: winston.createLogger({ silent: true }),
  });
}

function syncedState(overrides: Partial<SandboxSnapshotSyncState> = {}): SandboxSnapshotSyncState {
  return {
    desired_image: TAG,
    active: firstRef,
    pending: undefined,
    error_message: undefined,
    superseded: [],
    updated_at: '2026-08-07T11:00:00.000Z',
    ...overrides,
  };
}

describe('reconcileSnapshotSync', () => {
  it('names the snapshot after the digest but tells Daytona to pull the tag', async () => {
    const snapshots = new FakeSnapshots();

    const result = await reconcile({ snapshots });

    expect(result).toEqual({
      desired_image: TAG,
      active: undefined,
      pending: firstRef,
      error_message: undefined,
      superseded: [],
      updated_at: NOW.toISOString(),
    });
    expect(sandboxSnapshotStatus(result)).toBe('syncing');
    expect(snapshots.created).toEqual([
      { name: FIRST_NAME, imageName: TAG, entrypoint: undefined, resources: undefined },
    ]);
  });

  it('passes entrypoint and resources from the spec to Daytona', async () => {
    const spec: SandboxSnapshotSpec = {
      docker_image: TAG,
      entrypoint: ['/bin/sh', '-c', 'start-bridge'],
      resources: { cpu: 2, memory_gb: 4, disk_gb: 10 },
    };
    const snapshots = new FakeSnapshots();

    await reconcile({ snapshots, spec });

    expect(snapshots.created[0]).toEqual({
      name: deriveSandboxSnapshotName({ spec, digest: FIRST_DIGEST }),
      imageName: TAG,
      entrypoint: ['/bin/sh', '-c', 'start-bridge'],
      resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
    });
  });

  it('reports the snapshot active once Daytona holds it', async () => {
    const snapshots = new FakeSnapshots({ existing: [snapshot()] });

    const result = await reconcile({ snapshots });

    expect(result.active).toEqual(firstRef);
    expect(result.pending).toBeUndefined();
    expect(sandboxSnapshotStatus(result)).toBe('ready');
    expect(snapshots.created).toEqual([]);
  });

  it.each(['pulling', 'removing'] as const)('treats Daytona %s as preparing', async state => {
    const snapshots = new FakeSnapshots({ existing: [snapshot({ state })] });

    const result = await reconcile({ snapshots });

    expect(result.pending).toEqual(firstRef);
    expect(result.active).toBeUndefined();
  });

  it('activates a parked snapshot rather than exposing inactive', async () => {
    const inactive = snapshot({ state: 'inactive' });
    const snapshots = new FakeSnapshots({ existing: [inactive] });

    const result = await reconcile({ snapshots });

    expect(result.active).toEqual(firstRef);
    expect(snapshots.activated).toEqual([inactive.id]);
  });

  it('keeps preparing when activation has not settled yet', async () => {
    const snapshots = new FakeSnapshots({
      existing: [snapshot({ state: 'inactive' })],
      onActivate: target => ({ ...target, state: 'pulling' }),
    });

    expect((await reconcile({ snapshots })).pending).toEqual(firstRef);
  });

  it('surfaces the Daytona reason for a failed snapshot', async () => {
    const snapshots = new FakeSnapshots({ existing: [snapshot({ state: 'error', errorReason: 'manifest unknown' })] });

    const result = await reconcile({ snapshots });

    expect(result).toEqual({
      desired_image: TAG,
      active: undefined,
      pending: undefined,
      error_message: 'manifest unknown',
      superseded: [],
      updated_at: NOW.toISOString(),
    });
    expect(sandboxSnapshotStatus(result)).toBe('failed');
    expect(snapshots.deleted).toEqual([]);
  });

  it('recreates a broken snapshot on an explicit save', async () => {
    const snapshots = new FakeSnapshots({ existing: [snapshot({ state: 'error', errorReason: 'pull failed' })] });

    const result = await reconcile({ snapshots, mode: 'write' });

    expect(result.pending).toEqual(firstRef);
    expect(snapshots.deleted).toEqual([FIRST_NAME]);
    expect(snapshots.created).toHaveLength(1);
  });

  it('adopts an already-active snapshot returned by create', async () => {
    const snapshots = new FakeSnapshots({ onCreate: params => snapshot({ name: params.name, state: 'active' }) });

    expect((await reconcile({ snapshots })).active).toEqual(firstRef);
  });

  it('refuses a snapshot whose name we derived but whose image is someone else’s', async () => {
    const snapshots = new FakeSnapshots({ existing: [snapshot({ imageName: 'ghcr.io/other/image:9.9.9' })] });

    const result = await reconcile({ snapshots });

    expect(result.active).toBeUndefined();
    expect(result.error_message).toContain('ghcr.io/other/image:9.9.9');
  });

  describe('when the tag moves to a new image', () => {
    it('prepares the new snapshot while the old one keeps serving sandboxes', async () => {
      const snapshots = new FakeSnapshots({ existing: [snapshot()] });

      const result = await reconcile({ snapshots, resolved: SECOND_DIGEST, current: syncedState() });

      expect(result.active).toEqual(firstRef);
      expect(result.pending).toEqual(secondRef);
      expect(sandboxSnapshotStatus(result)).toBe('ready');
      // The same tag, pulled again: Daytona resolves it to the new content itself.
      expect(snapshots.created).toEqual([
        { name: SECOND_NAME, imageName: TAG, entrypoint: undefined, resources: undefined },
      ]);
    });

    it('promotes the new snapshot and deletes the one it replaced', async () => {
      const snapshots = new FakeSnapshots({
        existing: [snapshot(), snapshot({ name: SECOND_NAME, state: 'active' })],
      });

      const result = await reconcile({
        snapshots,
        resolved: SECOND_DIGEST,
        current: syncedState({ pending: secondRef }),
      });

      expect(result.active).toEqual(secondRef);
      expect(result.pending).toBeUndefined();
      expect(result.superseded).toEqual([]);
      expect(snapshots.deleted).toEqual([FIRST_NAME]);
      expect(snapshots.names()).toEqual([SECOND_NAME]);
    });

    it('stops serving the old snapshot once it is gone from Daytona', async () => {
      const snapshots = new FakeSnapshots();

      const result = await reconcile({ snapshots, resolved: SECOND_DIGEST, current: syncedState() });

      expect(result.active).toBeUndefined();
      expect(result.pending).toEqual(secondRef);
      expect(sandboxSnapshotStatus(result)).toBe('syncing');
    });

    /**
     * Renaming the tag in the catalog rebuilds even when the content is identical,
     * because the tag is what Daytona records: a snapshot still labelled with the old
     * tag cannot be shown to satisfy the new spec. A release rename is rare and
     * deliberate, and the old snapshot keeps serving throughout.
     */
    it('provisions a new snapshot when the catalog renames the tag', async () => {
      const retagged: SandboxSnapshotSpec = { docker_image: `${REPOSITORY}:v2` };
      const renamed = deriveSandboxSnapshotName({ spec: retagged, digest: FIRST_DIGEST });
      const snapshots = new FakeSnapshots({ existing: [snapshot()] });

      const result = await reconcile({ snapshots, spec: retagged, current: syncedState() });

      expect(result).toMatchObject({ desired_image: retagged.docker_image, active: firstRef });
      expect(result.pending).toEqual({ snapshot_name: renamed, image: retagged.docker_image, digest: FIRST_DIGEST });
      expect(snapshots.created).toEqual([
        { name: renamed, imageName: retagged.docker_image, entrypoint: undefined, resources: undefined },
      ]);
      expect(snapshots.deleted).toEqual([]);
    });
  });

  describe('cleanup of replaced snapshots', () => {
    it('retries a deletion Daytona refused, without failing the reconcile', async () => {
      const snapshots = new FakeSnapshots({
        existing: [snapshot(), snapshot({ name: SECOND_NAME })],
        deleteError: new Error('snapshot is in use'),
      });

      const result = await reconcile({
        snapshots,
        resolved: SECOND_DIGEST,
        current: syncedState({ superseded: [firstRef] }),
      });

      expect(result.active).toEqual(secondRef);
      expect(result.superseded).toEqual([firstRef]);
    });

    it('drops entries Daytona no longer has', async () => {
      const snapshots = new FakeSnapshots({ existing: [snapshot()] });

      const result = await reconcile({ snapshots, current: syncedState({ superseded: [secondRef] }) });

      expect(result.superseded).toEqual([]);
      expect(snapshots.deleted).toEqual([]);
    });

    /**
     * A reverted push, or a rebuild that reproduces an earlier image, points the tag
     * back at a snapshot already queued for deletion. Deleting it here would strand
     * every sandbox created from the state this same reconcile just published.
     */
    it('does not delete a snapshot the tag has rolled back to', async () => {
      const snapshots = new FakeSnapshots({
        existing: [snapshot(), snapshot({ name: SECOND_NAME })],
      });

      const result = await reconcile({
        snapshots,
        resolved: FIRST_DIGEST,
        current: syncedState({ active: secondRef, superseded: [firstRef] }),
      });

      expect(result.active).toEqual(firstRef);
      expect(result.superseded).toEqual([]);
      expect(snapshots.deleted).toEqual([SECOND_NAME]);
      expect(snapshots.names()).toContain(FIRST_NAME);
    });

    /**
     * The cleanup list comes out of the database, so it is not this function's to
     * trust: another replica's lost update, or a state written by a different
     * version, can name a snapshot that is serving right now.
     */
    it('refuses to delete a snapshot that is serving, whatever the stored list says', async () => {
      const snapshots = new FakeSnapshots({ existing: [snapshot()] });

      const result = await reconcile({
        snapshots,
        resolved: SECOND_DIGEST,
        current: syncedState({ superseded: [firstRef] }),
      });

      expect(result.active).toEqual(firstRef);
      expect(result.pending).toEqual(secondRef);
      expect(snapshots.deleted).toEqual([]);
      expect(result.superseded).toEqual([]);
    });

    describe('with more to clean up than one pass should attempt', () => {
      const stale: SandboxSnapshotRef[] = Array.from({ length: 6 }, (_, index) => ({
        snapshot_name: `trueforge-sandbox-stale${String(index)}`,
        image: TAG,
        digest: `sha256:${String(index).repeat(64)}`,
      }));

      function withStale(options: { deleteError?: Error } = {}): FakeSnapshots {
        return new FakeSnapshots({
          existing: [snapshot(), ...stale.map(ref => snapshot({ name: ref.snapshot_name }))],
          ...options,
        });
      }

      it('caps the deletions it waits for, because a turn start waits on this too', async () => {
        const snapshots = withStale();

        const result = await reconcile({ snapshots, current: syncedState({ superseded: stale }) });

        expect(snapshots.deleted).toHaveLength(4);
        expect(result.superseded).toEqual(stale.slice(4));
      });

      it('rotates the list so a snapshot Daytona keeps refusing cannot starve the rest', async () => {
        const snapshots = withStale({ deleteError: new Error('snapshot is in use') });

        const result = await reconcile({ snapshots, current: syncedState({ superseded: stale }) });

        expect(result.superseded.slice(0, 2)).toEqual(stale.slice(4));
        expect(result.superseded).toHaveLength(stale.length);
      });
    });
  });

  describe('when a dependency is unavailable', () => {
    it('keeps sandboxes working when the registry cannot be reached', async () => {
      const snapshots = new FakeSnapshots({ existing: [snapshot()] });

      const result = await reconcile({
        snapshots,
        resolved: new ImageResolutionError('ghcr.io answered 503'),
        current: syncedState(),
      });

      expect(result.active).toEqual(firstRef);
      expect(sandboxSnapshotStatus(result)).toBe('ready');
      expect(result.error_message).toContain('ghcr.io answered 503');
    });

    it('reports a registry failure when nothing was serving yet', async () => {
      const result = await reconcile({
        snapshots: new FakeSnapshots(),
        resolved: new ImageResolutionError('no such tag'),
      });

      expect(sandboxSnapshotStatus(result)).toBe('failed');
      expect(result.error_message).toContain('no such tag');
    });

    it('keeps sandboxes working through a transient Daytona outage', async () => {
      const snapshots = new FakeSnapshots({ getError: new Error('socket hang up') });
      const current = syncedState();

      const result = await reconcile({ snapshots, current });

      expect(result.active).toEqual(firstRef);
      expect(result.error_message).toContain('socket hang up');
    });

    it('rethrows credential rejections on a save, so the write can fail', async () => {
      const snapshots = new FakeSnapshots({ getError: new DaytonaSnapshotAuthError({ cause: 'bad key' }) });

      await expect(reconcile({ snapshots, mode: 'write' })).rejects.toBeInstanceOf(DaytonaSnapshotAuthError);
    });

    // A key revoked long after it was saved reaches a poll or a turn, neither of which
    // has a request to fail: throwing would surface as a 500 nobody can act on.
    it('records a revoked key on a read instead of throwing, and keeps serving', async () => {
      const snapshots = new FakeSnapshots({ getError: new DaytonaSnapshotAuthError({ cause: 'revoked' }) });

      const result = await reconcile({ snapshots, current: syncedState() });

      expect(result.active).toEqual(firstRef);
      expect(result.error_message).toContain('rejected the configured API key');
    });

    it('reports a key Daytona rejects while verifying the snapshot still serving', async () => {
      // Only the second lookup — the one that re-checks `active` — is rejected.
      let calls = 0;
      const snapshots: IDaytonaSnapshots = {
        get: async () => {
          calls += 1;
          if (calls > 1) throw new DaytonaSnapshotAuthError({ cause: 'revoked' });
          return await Promise.resolve(undefined);
        },
        initiateCreate: async () => await Promise.resolve(snapshot({ name: SECOND_NAME, state: 'error' })),
        activate: async () => await Promise.resolve(snapshot()),
        delete: async () => await Promise.resolve(),
      };

      const result = await reconcile({ snapshots, resolved: SECOND_DIGEST, current: syncedState() });

      expect(result.active).toEqual(firstRef);
      expect(result.error_message).toContain('rejected the configured API key');
    });
  });
});
