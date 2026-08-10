import { OpenAPIHono } from '@hono/zod-openapi';
import { isAdmin, resolveUserContext } from '../auth/identity';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import { getCapabilitiesRoute } from '../routes/capabilityRoutes';
import type { SandboxSnapshotSyncService } from '../sandbox/SandboxSnapshotSyncService';
import { TENANT_ID } from './sessions';

export function createCapabilitiesRouter<TTransaction>(deps: {
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  sandboxSnapshotSync: SandboxSnapshotSyncService;
  withTransaction: WithTransaction<TTransaction>;
}) {
  /**
   * A configured provider is not enough: sandboxes can only be created once the
   * provider holds the synced sandbox image, so an unfinished sync disables the
   * capability instead of letting the UI offer a sandbox that fails at turn start.
   * Persisted state only — the settings poll and turn start own the refresh.
   */
  const sandboxUnavailableReason = async (): Promise<string | undefined> => {
    const record = await deps.sandboxProviderStore.getSandboxProvider(TENANT_ID);
    if (record === undefined) {
      return 'No sandbox provider is configured.';
    }
    const readiness = deps.sandboxSnapshotSync.readiness(record.manifest);
    return readiness.ready ? undefined : readiness.reason;
  };

  const router = new OpenAPIHono();
  router.openapi(getCapabilitiesRoute, async c => {
    const unavailableReason = await sandboxUnavailableReason();
    const settingsEnabled = isAdmin(resolveUserContext(c));

    return c.json(
      {
        data: {
          sandbox: unavailableReason === undefined ? { enabled: true } : { enabled: false, reason: unavailableReason },
          skill:
            unavailableReason === undefined
              ? { enabled: true }
              : { enabled: false, reason: `Skills run in a sandbox, which is unavailable. ${unavailableReason}` },
          settings: { enabled: settingsEnabled },
        },
      },
      200,
    );
  });
  return router;
}
