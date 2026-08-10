import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  configFromHarness,
  imageSyncFromHarness,
  toHarnessManifest,
  toUiCatalogEntry,
  toUiSandboxProvider,
} from '../src/sandboxProviderCatalog';

describe('sandboxProviderCatalog mappers', () => {
  const harnessCatalog = {
    type: 'daytona' as const,
    execTimeoutMs: 60000,
    autoStopIntervalInMinutes: 5,
    autoArchiveIntervalInMinutes: 60,
    autoDeleteIntervalInMinutes: 7200,
  };

  const activeRef = {
    snapshotName: 'trueforge-sandbox-0123456789ab',
    image: `ghcr.io/truefoundry/trueforge-sandbox@sha256:${'1'.repeat(64)}`,
  };

  const readySync = {
    desiredImage: 'ghcr.io/truefoundry/trueforge-sandbox:latest',
    active: activeRef,
    updatedAt: new Date('2026-08-07T10:00:00.000Z'),
  };

  const harnessConfigured = {
    ...harnessCatalog,
    auth: { apiKey: 'dtn_secret' },
    snapshotSync: readySync,
  };

  it('stamps catalog identity from type', () => {
    assert.deepEqual(toUiCatalogEntry(harnessCatalog), {
      id: 'daytona',
      name: 'Daytona',
      type: 'daytona',
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
  });

  it('maps configured provider without embedding apiKey', () => {
    assert.deepEqual(toUiSandboxProvider(harnessConfigured), {
      id: 'daytona',
      name: 'Daytona',
      catalogId: 'daytona',
      isConnected: true,
      imageSync: { status: 'ready', errorMessage: undefined, isUpdating: false },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
    assert.equal('auth' in toUiSandboxProvider(harnessConfigured), false);
    assert.equal('apiKey' in toUiSandboxProvider(harnessConfigured), false);
  });

  it('round-trips config fields into harness upsert body', () => {
    assert.deepEqual(
      toHarnessManifest({
        type: 'daytona',
        apiKey: 'dtn_secret',
        ...configFromHarness(harnessCatalog),
      }),
      {
        execTimeoutMs: 60000,
        autoStopIntervalInMinutes: 5,
        autoArchiveIntervalInMinutes: 60,
        autoDeleteIntervalInMinutes: 7200,
        auth: { apiKey: 'dtn_secret' },
      },
    );
  });

  it('never sends server-owned snapshot state on upsert', () => {
    const manifest = toHarnessManifest({
      type: 'daytona',
      apiKey: 'dtn_secret',
      ...configFromHarness(harnessConfigured),
    });
    assert.equal('snapshotSync' in manifest, false);
    assert.equal('snapshotName' in manifest, false);
  });

  it('rejects unsupported sandbox provider types', () => {
    assert.throws(
      () =>
        toHarnessManifest({
          type: 'other',
          apiKey: 'x',
          execTimeoutMs: 1,
          autoStopIntervalInMinutes: 1,
          autoArchiveIntervalInMinutes: 1,
          autoDeleteIntervalInMinutes: 1,
        }),
      /Unsupported sandbox provider type/i,
    );
  });

  describe('imageSyncFromHarness', () => {
    it('is ready whenever an active snapshot can back sandboxes', () => {
      assert.deepEqual(imageSyncFromHarness(readySync), {
        status: 'ready',
        errorMessage: undefined,
        isUpdating: false,
      });
    });

    it('stays ready while a newer image is being prepared', () => {
      assert.deepEqual(imageSyncFromHarness({ ...readySync, pending: activeRef }), {
        status: 'ready',
        errorMessage: undefined,
        isUpdating: true,
      });
    });

    it('stays ready but reports an update that failed, since sandboxes still work', () => {
      assert.deepEqual(imageSyncFromHarness({ ...readySync, errorMessage: 'manifest unknown' }), {
        status: 'ready',
        errorMessage: 'manifest unknown',
        isUpdating: false,
      });
    });

    it('is syncing before the first snapshot lands', () => {
      assert.deepEqual(imageSyncFromHarness({ ...readySync, active: undefined, pending: activeRef }), {
        status: 'syncing',
        errorMessage: undefined,
        isUpdating: false,
      });
    });

    it('is failed only when nothing is serving and something went wrong', () => {
      assert.deepEqual(imageSyncFromHarness({ ...readySync, active: undefined, errorMessage: 'manifest unknown' }), {
        status: 'failed',
        errorMessage: 'manifest unknown',
        isUpdating: false,
      });
    });
  });
});
