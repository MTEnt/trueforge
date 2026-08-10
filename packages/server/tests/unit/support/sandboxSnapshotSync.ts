/**
 * Test doubles for sandbox snapshot sync, so suites that merely need a router
 * dependency do not have to reason about Daytona or a container registry.
 */
import type { DaytonaSnapshot, IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import winston from 'winston';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import type { IImageDigestResolver } from '../../../src/sandbox/ImageDigestResolver';
import { SandboxSnapshotSyncService } from '../../../src/sandbox/SandboxSnapshotSyncService';
import { deriveSandboxSnapshotName } from '../../../src/sandbox/snapshotName';
import type { SandboxSnapshotSyncState } from '../../../src/schemas/sandboxSnapshot';

export const testSandboxCatalog = SandboxCatalog.load();
export const testSandboxSnapshotSpec = testSandboxCatalog.snapshotSpec();

/** Image Daytona is told to pull, which is the catalog tag verbatim. */
export const testSandboxImage = testSandboxSnapshotSpec.docker_image;
/** Digest the shipped catalog tag resolves to in tests. */
export const testSandboxDigest = `sha256:${'1'.repeat(64)}`;
export const testSandboxSnapshotName = deriveSandboxSnapshotName({
  spec: testSandboxSnapshotSpec,
  digest: testSandboxDigest,
});

/** Resolver that always reports the same digest, with no network involved. */
export function imagesResolvingTo(digest: string = testSandboxDigest): IImageDigestResolver {
  return { resolve: () => Promise.resolve(digest) };
}

/** Persisted state for a tenant whose sandbox image is already in place. */
export const readySandboxSnapshotSync: SandboxSnapshotSyncState = {
  desired_image: testSandboxSnapshotSpec.docker_image,
  active: { snapshot_name: testSandboxSnapshotName, image: testSandboxImage, digest: testSandboxDigest },
  pending: undefined,
  error_message: undefined,
  superseded: [],
  updated_at: new Date().toISOString(),
};

/** A Daytona snapshot that satisfies the reconciler for the shipped catalog spec. */
export function activeTestSnapshot(overrides: Partial<DaytonaSnapshot> = {}): DaytonaSnapshot {
  return {
    id: 'snap-test',
    name: testSandboxSnapshotName,
    imageName: testSandboxImage,
    state: 'active',
    errorReason: null,
    ...overrides,
  };
}

export function snapshotsReturning(result: DaytonaSnapshot | undefined): IDaytonaSnapshots {
  return {
    get: () => Promise.resolve(result),
    initiateCreate: () => Promise.resolve(activeTestSnapshot({ state: 'pending' })),
    activate: () => Promise.resolve(activeTestSnapshot()),
    delete: () => Promise.resolve(),
  };
}

/** Sync service backed by a real store but a Daytona that always reports ready. */
export function createTestSandboxSnapshotSync({
  store,
  snapshots = snapshotsReturning(activeTestSnapshot()),
  images = imagesResolvingTo(),
}: {
  store: ISandboxProviderStore;
  snapshots?: IDaytonaSnapshots;
  images?: IImageDigestResolver;
}): SandboxSnapshotSyncService {
  return new SandboxSnapshotSyncService({
    store,
    catalog: testSandboxCatalog,
    createSnapshots: () => snapshots,
    images,
    logger: winston.createLogger({ silent: true }),
  });
}
