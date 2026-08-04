import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ModelCatalog } from '../catalog/ModelCatalog';
import type { IModelProviderStore, ModelProviderRecord } from '../db/modelProviderStore';
import { createWriteDbTransactionMiddleware, type DbTransactionEnv, type RunTransaction } from '../db/transaction';
import {
  getModelProviderCatalogRoute,
  listModelProvidersRoute,
  putModelProviderRoute,
} from '../routes/modelProviderRoutes';
import { toModelProviderManifest, type ModelProvider } from '../schemas/modelProvider';
import { TENANT_ID } from './sessions';

export interface ModelProvidersRouterDeps<TTransaction> {
  modelCatalog: ModelCatalog;
  modelProviderStore: IModelProviderStore<TTransaction>;
  runTransaction: RunTransaction<TTransaction>;
}

/** Wire view of a stored provider: identity `name` plus persisted manifest. */
function toModelProvider(record: ModelProviderRecord): ModelProvider {
  return {
    ...record.manifest,
    name: record.name,
  };
}

export function createModelProvidersRouter<TTransaction>(deps: ModelProvidersRouterDeps<TTransaction>) {
  const catalogHandler: RouteHandler<typeof getModelProviderCatalogRoute, DbTransactionEnv<TTransaction>> = c => {
    return c.json({ data: [...deps.modelCatalog.list()] }, 200);
  };

  const listHandler: RouteHandler<typeof listModelProvidersRoute, DbTransactionEnv<TTransaction>> = async c => {
    const records = await deps.modelProviderStore.listProviders(TENANT_ID);
    return c.json({ data: records.map(toModelProvider) }, 200);
  };

  const putHandler: RouteHandler<typeof putModelProviderRoute, DbTransactionEnv<TTransaction>> = async c => {
    const body = c.req.valid('json');
    const record = await deps.modelProviderStore.upsertProvider(
      {
        tenant_id: TENANT_ID,
        name: body.name,
        manifest: toModelProviderManifest(body),
      },
      c.get('tx'),
    );
    return c.json({ data: toModelProvider(record) }, 200);
  };

  const router = new OpenAPIHono<DbTransactionEnv<TTransaction>>();
  // Write methods only — catalog/list are single reads and do not need a route txn.
  router.use('*', createWriteDbTransactionMiddleware(deps.runTransaction));
  router.openapi(getModelProviderCatalogRoute, catalogHandler);
  router.openapi(listModelProvidersRoute, listHandler);
  router.openapi(putModelProviderRoute, putHandler);
  return router;
}
