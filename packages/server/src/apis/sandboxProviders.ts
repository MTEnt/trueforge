import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { DaytonaSnapshotAuthError } from '@truefoundry/utils-core/core';
import type { SandboxCatalog } from '../catalog/SandboxCatalog';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import {
  getSandboxProviderCatalogRoute,
  getSandboxProviderRoute,
  putSandboxProviderRoute,
} from '../routes/sandboxProviderRoutes';
import type { SandboxSnapshotSyncService } from '../sandbox/SandboxSnapshotSyncService';
import { toConfiguredSandboxProvider } from '../schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../schemas/sandboxSnapshot';
import { TENANT_ID } from './sessions';

export interface SandboxProvidersRouterDeps {
  sandboxCatalog: SandboxCatalog;
  sandboxProviderStore: ISandboxProviderStore;
  sandboxSnapshotSync: SandboxSnapshotSyncService;
}

/** Admin/settings sandbox provider surface (mounted at /api/v1/settings/sandbox-providers). */
export function createSandboxProvidersRouter(deps: SandboxProvidersRouterDeps) {
  const catalogHandler: RouteHandler<typeof getSandboxProviderCatalogRoute> = c => {
    return c.json({ data: [...deps.sandboxCatalog.list()] }, 200);
  };

  /** Reconciles on read so the settings page can poll this endpoint to watch a sync. */
  const getHandler: RouteHandler<typeof getSandboxProviderRoute> = async c => {
    const loaded = await deps.sandboxSnapshotSync.load({ tenant_id: TENANT_ID });
    if (loaded === undefined) {
      return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
    }
    return c.json(
      { data: toConfiguredSandboxProvider({ manifest: loaded.manifest, snapshot_sync: loaded.snapshot_sync }) },
      200,
    );
  };

  /**
   * Reconciles before persisting: a save is the one moment we can tell the user
   * their API key is wrong, so credentials Daytona rejects fail the write instead
   * of being stored behind a `failed` status.
   */
  const putHandler: RouteHandler<typeof putSandboxProviderRoute> = async c => {
    const config = c.req.valid('json');

    let snapshotSync: SandboxSnapshotSyncState;
    try {
      snapshotSync = await deps.sandboxSnapshotSync.reconcileForSave({ tenant_id: TENANT_ID, manifest: config });
    } catch (error) {
      if (error instanceof DaytonaSnapshotAuthError) {
        return c.json({ error: { message: 'Daytona rejected this API key.' } }, 422);
      }
      throw error;
    }

    const record = await deps.sandboxProviderStore.upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: { ...config, snapshot_sync: snapshotSync },
    });
    return c.json(
      { data: toConfiguredSandboxProvider({ manifest: record.manifest, snapshot_sync: snapshotSync }) },
      200,
    );
  };

  const router = new OpenAPIHono();
  router.openapi(getSandboxProviderCatalogRoute, catalogHandler);
  router.openapi(getSandboxProviderRoute, getHandler);
  router.openapi(putSandboxProviderRoute, putHandler);
  return router;
}
