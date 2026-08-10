import {
  SandboxSnapshotSpecSchema,
  SandboxSnapshotSyncStateSchema,
  sandboxSnapshotStatus,
  toSandboxSnapshotSync,
  type SandboxSnapshotSyncState,
} from '../../../src/schemas/sandboxSnapshot';

describe('SandboxSnapshotSpecSchema image validation', () => {
  it.each([
    'ghcr.io/truefoundry/trueforge-sandbox:0.1.0',
    // Moving tags are the point of the feature, so they must stay acceptable.
    'ghcr.io/truefoundry/trueforge-sandbox:stable',
    'releases-docker.jfrog.io/truefoundry/trueforge-sandbox:main',
    'registry.internal:5000/team/sandbox:2026-08-07',
    // Daytona accepts this spelling; only exactly `latest` is refused.
    'ghcr.io/truefoundry/trueforge-sandbox:Latest',
  ])('accepts the reference %s', image => {
    expect(SandboxSnapshotSpecSchema.safeParse({ docker_image: image }).success).toBe(true);
  });

  it.each([
    ['an empty tag', 'ghcr.io/truefoundry/trueforge-sandbox:'],
    ['an empty digest', 'ghcr.io/truefoundry/trueforge-sandbox@'],
    ['a malformed digest', 'ghcr.io/truefoundry/trueforge-sandbox@sha256:nothex'],
    // Daytona rewrites `name@sha256:…` to `name:sha256:…` before pulling, so a
    // digest-pinned catalog entry could only ever fail at snapshot creation.
    ['a digest, which Daytona cannot pull', `ghcr.io/truefoundry/trueforge-sandbox@sha256:${'0'.repeat(64)}`],
    ['a tag pinned to a digest', `ghcr.io/truefoundry/trueforge-sandbox:1.0@sha256:${'0'.repeat(64)}`],
    ['an uppercase repository', 'ghcr.io/TrueFoundry/sandbox:1.0'],
    ['a tag with a space', 'ghcr.io/truefoundry/sandbox:1.0 '],
    // Daytona answers `Images with tag ":latest" are not allowed`, and separately
    // requires a tag to be present, so both spellings of latest are dead ends.
    ['the latest tag, which Daytona refuses', 'ghcr.io/truefoundry/trueforge-sandbox:latest'],
    ['an absent tag, which means latest', 'ghcr.io/truefoundry/trueforge-sandbox'],
    ['an absent tag with a registry port', 'registry.internal:5000/team/sandbox'],
    // Docker would send these to Docker Hub; the catalog has to name its registry.
    ['a reference naming no registry', 'trueforge-sandbox:0.1.0'],
    ['an organisation mistaken for a registry', 'tfy-images/trueforge-sandbox:0.1.0'],
  ])('rejects %s', (_case, image) => {
    expect(SandboxSnapshotSpecSchema.safeParse({ docker_image: image }).success).toBe(false);
  });

  it('rejects unknown keys so a typo cannot be silently ignored', () => {
    expect(
      SandboxSnapshotSpecSchema.safeParse({ docker_image: 'sandbox:1.0', dockerImage: 'sandbox:1.0' }).success,
    ).toBe(false);
  });

  it('rejects an empty entrypoint, which would leave the image default in place unpredictably', () => {
    expect(SandboxSnapshotSpecSchema.safeParse({ docker_image: 'sandbox:1.0', entrypoint: [] }).success).toBe(false);
  });

  it('requires whole positive resource values', () => {
    expect(
      SandboxSnapshotSpecSchema.safeParse({
        docker_image: 'sandbox:1.0',
        resources: { cpu: 0, memory_gb: 2, disk_gb: 5 },
      }).success,
    ).toBe(false);
  });
});

describe('SandboxSnapshotSyncStateSchema', () => {
  const ref = {
    snapshot_name: 'trueforge-sandbox-0123456789ab',
    image: 'sandbox:1.0',
    digest: `sha256:${'0'.repeat(64)}`,
  };
  const base = {
    desired_image: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
    superseded: [],
    updated_at: '2026-08-07T10:00:00.000Z',
  };

  it('accepts a state that has never had a snapshot', () => {
    expect(SandboxSnapshotSyncStateSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an active snapshot with a replacement being prepared', () => {
    expect(SandboxSnapshotSyncStateSchema.safeParse({ ...base, active: ref, pending: ref }).success).toBe(true);
  });

  it('accepts an error alongside an active snapshot, which is a failed update', () => {
    expect(
      SandboxSnapshotSyncStateSchema.safeParse({ ...base, active: ref, error_message: 'pull failed' }).success,
    ).toBe(true);
  });

  it('requires the cleanup list, so a missing one cannot be read as nothing to clean', () => {
    expect(SandboxSnapshotSyncStateSchema.safeParse({ ...base, superseded: undefined }).success).toBe(false);
  });

  it('rejects a snapshot reference without the image it was built from', () => {
    expect(
      SandboxSnapshotSyncStateSchema.safeParse({ ...base, active: { snapshot_name: ref.snapshot_name } }).success,
    ).toBe(false);
  });

  it('rejects unknown keys so a renamed field cannot be silently dropped', () => {
    expect(SandboxSnapshotSyncStateSchema.safeParse({ ...base, status: 'ready' }).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(SandboxSnapshotSyncStateSchema.safeParse({ ...base, updated_at: 'yesterday' }).success).toBe(false);
  });
});

describe('sandboxSnapshotStatus', () => {
  const ref = {
    snapshot_name: 'trueforge-sandbox-0123456789ab',
    image: 'sandbox:1.0',
    digest: `sha256:${'0'.repeat(64)}`,
  };
  const state = (overrides: Partial<SandboxSnapshotSyncState>): SandboxSnapshotSyncState => ({
    desired_image: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
    active: undefined,
    pending: undefined,
    error_message: undefined,
    superseded: [],
    updated_at: '2026-08-07T10:00:00.000Z',
    ...overrides,
  });

  it('is ready whenever a snapshot can back sandboxes', () => {
    expect(sandboxSnapshotStatus(state({ active: ref }))).toBe('ready');
  });

  it('stays ready while a newer image is being prepared', () => {
    expect(sandboxSnapshotStatus(state({ active: ref, pending: ref }))).toBe('ready');
  });

  it('stays ready when an update failed but the current image still works', () => {
    expect(sandboxSnapshotStatus(state({ active: ref, error_message: 'pull failed' }))).toBe('ready');
  });

  it('is syncing before the first snapshot lands', () => {
    expect(sandboxSnapshotStatus(state({ pending: ref }))).toBe('syncing');
    expect(sandboxSnapshotStatus(state({}))).toBe('syncing');
  });

  it('is failed only when nothing is serving and something went wrong', () => {
    expect(sandboxSnapshotStatus(state({ error_message: 'pull failed' }))).toBe('failed');
  });
});

describe('toSandboxSnapshotSync', () => {
  it('drops cleanup bookkeeping clients have no use for', () => {
    const ref = {
      snapshot_name: 'trueforge-sandbox-0123456789ab',
      image: 'sandbox:1.0',
      digest: `sha256:${'0'.repeat(64)}`,
    };
    const sync = toSandboxSnapshotSync({
      desired_image: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
      active: ref,
      pending: undefined,
      error_message: undefined,
      superseded: [ref],
      updated_at: '2026-08-07T10:00:00.000Z',
    });

    expect('superseded' in sync).toBe(false);
    expect(sync.active).toEqual(ref);
  });
});
