import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields, isAuthRequired, McpConnectionError, RemoteMCP } from '@truefoundry/utils/core';
import type { Logger } from 'winston';
import type { McpCatalog } from '../catalog/McpCatalog';
import type { IMcpServerStore, McpServerRecord } from '../db/mcpServerStore';
import {
  createWriteDbTransactionMiddleware,
  type DbTransactionVariables,
  type RunTransaction,
} from '../db/transaction';
import {
  authorizeConfiguredMcpServerRoute,
  getMcpServerCatalogRoute,
  listAvailableMcpServersRoute,
  listConfiguredMcpServersRoute,
  listMcpServerToolsRoute,
  putMcpServerRoute,
} from '../routes/mcpServerRoutes';
import type { ConfiguredMcpServer, McpServerManifest } from '../schemas/mcpServer';
import { resolveConfiguredMcpRequestHeaders, toStubAuthStatus } from '../schemas/mcpServer';
import { TENANT_ID } from './sessions';

type TxEnv<TTransaction> = { Variables: DbTransactionVariables<TTransaction> };

export interface McpServersRouterDeps<TTransaction> {
  mcpCatalog: McpCatalog;
  mcpServerStore: IMcpServerStore<TTransaction>;
  runTransaction: RunTransaction<TTransaction>;
  logger: Logger;
}

/** Omits keys whose value is `undefined` so wire objects satisfy JSONValue index signatures. */
function omitUndefinedEntries(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function toConfiguredMcpServer(record: McpServerRecord): ConfiguredMcpServer {
  return {
    ...record.manifest,
    auth_status: toStubAuthStatus(record.manifest),
  };
}

/** Admin/settings MCP CRUD (mounted at /api/v1/settings/mcp-servers). */
export function createMcpServersRouter<TTransaction>(deps: McpServersRouterDeps<TTransaction>) {
  const catalogHandler: RouteHandler<typeof getMcpServerCatalogRoute, TxEnv<TTransaction>> = c => {
    return c.json({ data: [...deps.mcpCatalog.list()] }, 200);
  };

  const listConfiguredHandler: RouteHandler<typeof listConfiguredMcpServersRoute, TxEnv<TTransaction>> = async c => {
    const records = await deps.mcpServerStore.listServers(TENANT_ID);
    return c.json({ data: records.map(toConfiguredMcpServer) }, 200);
  };

  const putHandler: RouteHandler<typeof putMcpServerRoute, TxEnv<TTransaction>> = async c => {
    const manifest: McpServerManifest = c.req.valid('json');
    const record = await deps.mcpServerStore.upsertServer(
      { tenant_id: TENANT_ID, name: manifest.name, manifest },
      c.get('tx'),
    );
    return c.json({ data: toConfiguredMcpServer(record) }, 200);
  };

  const listToolsHandler: RouteHandler<typeof listMcpServerToolsRoute, TxEnv<TTransaction>> = async c => {
    const { name } = c.req.valid('param');
    const record = await deps.mcpServerStore.getServer({ tenant_id: TENANT_ID, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    const remote = new RemoteMCP({
      id: name,
      name,
      url: record.manifest.url,
      headers: resolveConfiguredMcpRequestHeaders(record.manifest),
      logger: deps.logger,
      signal: c.req.raw.signal,
    });
    try {
      const response = await remote.listTools();
      if (isAuthRequired(response)) {
        return c.json({ error: { message: `MCP server "${name}" requires authentication` } }, 401);
      }
      const data = response.result.tools.map(tool => omitUndefinedEntries({ ...tool }));
      return c.json({ data }, 200);
    } catch (error) {
      if (error instanceof McpConnectionError) {
        deps.logger.warn(`MCP tools/list failed for "${name}"`, extractErrorLogFields(error));
        if (error.statusCode === 401) {
          return c.json({ error: { message: error.message } }, 401);
        }
        return c.json({ error: { message: error.message } }, 502);
      }
      throw error;
    }
  };

  const authorizeHandler: RouteHandler<typeof authorizeConfiguredMcpServerRoute, TxEnv<TTransaction>> = async c => {
    const { name } = c.req.valid('param');
    const { redirect_url: redirectUrl } = c.req.valid('query');
    const record = await deps.mcpServerStore.getServer({ tenant_id: TENANT_ID, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    // Header auth (and no auth): credentials already on the row — no browser flow.
    if (record.manifest.auth?.type !== 'dcr') {
      return c.json({ status: 'authenticated' as const }, 200);
    }
    // STUB: real DCR + authorize URL minting lands with the OAuth follow-up.
    const stubAuthUrl = `https://example-authorization-server.invalid/authorize?client_id=stub&redirect_uri=${encodeURIComponent(redirectUrl)}`;
    return c.json({ status: 'auth_required' as const, authorization_url: stubAuthUrl }, 200);
  };

  const router = new OpenAPIHono<TxEnv<TTransaction>>();
  // Write methods only — tools/authorize are GETs (DB read + remote I/O; must not hold a write txn).
  router.use('*', createWriteDbTransactionMiddleware(deps.runTransaction));
  // Static `/catalog` before `/{name}/…` so "catalog" is not captured as a name.
  router.openapi(getMcpServerCatalogRoute, catalogHandler);
  router.openapi(listConfiguredMcpServersRoute, listConfiguredHandler);
  router.openapi(putMcpServerRoute, putHandler);
  router.openapi(listMcpServerToolsRoute, listToolsHandler);
  router.openapi(authorizeConfiguredMcpServerRoute, authorizeHandler);
  return router;
}

/** Chat slim list (mounted at /api/v1/mcp-servers) — mirrors GET /api/v1/models. */
export function createAvailableMcpServersRouter<TTransaction>(store: IMcpServerStore<TTransaction>) {
  const router = new OpenAPIHono();
  router.openapi(listAvailableMcpServersRoute, async c => {
    const records = await store.listServers(TENANT_ID);
    return c.json(
      {
        data: records.map(record => ({ name: record.name, url: record.manifest.url })),
      },
      200,
    );
  });
  return router;
}
