import {
  PutSandboxProviderRequestSchema,
  toConfiguredSandboxProvider,
  toDaytonaSandboxProviderInput,
  toSandboxProviderConfig,
  type SandboxProviderManifest,
} from '../../../src/schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../../../src/schemas/sandboxSnapshot';

const manifest: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const activeRef = {
  snapshot_name: 'trueforge-sandbox-0123456789ab',
  image: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
  digest: `sha256:${'1'.repeat(64)}`,
};

const snapshotSync: SandboxSnapshotSyncState = {
  desired_image: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
  active: activeRef,
  pending: undefined,
  error_message: undefined,
  superseded: [{ ...activeRef, snapshot_name: 'trueforge-sandbox-replaced' }],
  updated_at: '2026-08-07T10:00:00.000Z',
};

describe('toDaytonaSandboxProviderInput', () => {
  it('maps a Daytona manifest plus the synced snapshot name to provider settings', () => {
    expect(toDaytonaSandboxProviderInput({ manifest, snapshotName: 'trueforge-sandbox-0123456789ab' })).toEqual({
      apiKey: 'dtn-test',
      snapshotName: 'trueforge-sandbox-0123456789ab',
      timeoutMs: 60_000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
  });
});

describe('PutSandboxProviderRequestSchema', () => {
  it('accepts a body without any snapshot fields', () => {
    expect(PutSandboxProviderRequestSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects a client-supplied snapshot name, which the server now owns', () => {
    expect(PutSandboxProviderRequestSchema.safeParse({ ...manifest, snapshot_name: 'mine' }).success).toBe(false);
  });

  it('rejects a client-supplied snapshot_sync, which is server state', () => {
    expect(PutSandboxProviderRequestSchema.safeParse({ ...manifest, snapshot_sync: snapshotSync }).success).toBe(false);
  });
});

describe('manifest ↔ wire conversions', () => {
  it('strips server-owned state to get the writable configuration', () => {
    expect(toSandboxProviderConfig({ ...manifest, snapshot_sync: snapshotSync })).toEqual(manifest);
  });

  it('builds the read shape with sync always present, minus internal cleanup state', () => {
    expect(toConfiguredSandboxProvider({ manifest, snapshot_sync: snapshotSync })).toEqual({
      ...manifest,
      snapshot_sync: {
        desired_image: snapshotSync.desired_image,
        active: activeRef,
        pending: undefined,
        error_message: undefined,
        updated_at: snapshotSync.updated_at,
      },
    });
  });
});
