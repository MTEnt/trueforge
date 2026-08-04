/**
 * Backend-agnostic commit/rollback coverage for transaction handles on
 * non-session stores (model-provider + mcp-server, including multi-store).
 */
import type { IMcpServerStore } from '../../src/db/mcpServerStore';
import type { IModelProviderStore } from '../../src/db/modelProviderStore';
import type { WithTransaction } from '../../src/db/transaction';
import type { McpServerManifest } from '../../src/schemas/mcpServer';
import type { ProviderManifest } from '../../src/schemas/modelProvider';

const TENANT_ID = 'default';

const providerManifest: ProviderManifest = {
  type: 'anthropic',
  base_url: 'https://api.anthropic.com/v1',
  auth: { api_key: 'sk-ant-secret' },
  models: [
    {
      model_id: 'claude-sonnet-4-6',
      name: 'claude-sonnet-4-6',
      properties: { context_length: 200000, max_output_tokens: 32768, reasoning_efforts: ['low', 'high'] },
    },
  ],
};

const mcpManifest: McpServerManifest = {
  type: 'remote',
  name: 'deepwiki',
  url: 'https://mcp.deepwiki.com/mcp',
};

export function runStoreTransactionsContractSuite<TTransaction>(options: {
  withTransaction: WithTransaction<TTransaction>;
  getModelProviderStore: () => IModelProviderStore<TTransaction>;
  getMcpServerStore: () => IMcpServerStore<TTransaction>;
}): void {
  it('commits a model-provider upsert when the transaction succeeds', async () => {
    const modelProviderStore = options.getModelProviderStore();
    await options.withTransaction(transaction =>
      modelProviderStore.upsertProvider(
        { tenant_id: TENANT_ID, name: 'anthropic', manifest: providerManifest },
        transaction,
      ),
    );

    await expect(modelProviderStore.getProvider({ tenant_id: TENANT_ID, name: 'anthropic' })).resolves.toMatchObject({
      manifest: { base_url: providerManifest.base_url },
    });
  });

  it('rolls back a model-provider upsert when the transaction fails', async () => {
    const modelProviderStore = options.getModelProviderStore();
    await expect(
      options.withTransaction(async transaction => {
        await modelProviderStore.upsertProvider(
          { tenant_id: TENANT_ID, name: 'anthropic', manifest: providerManifest },
          transaction,
        );
        throw new Error('fail after upsert');
      }),
    ).rejects.toThrow('fail after upsert');

    await expect(modelProviderStore.getProvider({ tenant_id: TENANT_ID, name: 'anthropic' })).resolves.toBeUndefined();
  });

  it('commits an mcp-server upsert when the transaction succeeds', async () => {
    const mcpServerStore = options.getMcpServerStore();
    await options.withTransaction(transaction =>
      mcpServerStore.upsertServer({ tenant_id: TENANT_ID, name: mcpManifest.name, manifest: mcpManifest }, transaction),
    );

    await expect(mcpServerStore.getServer({ tenant_id: TENANT_ID, name: mcpManifest.name })).resolves.toMatchObject({
      manifest: { url: mcpManifest.url },
    });
  });

  it('rolls back an mcp-server upsert when the transaction fails', async () => {
    const mcpServerStore = options.getMcpServerStore();
    await expect(
      options.withTransaction(async transaction => {
        await mcpServerStore.upsertServer(
          { tenant_id: TENANT_ID, name: mcpManifest.name, manifest: mcpManifest },
          transaction,
        );
        throw new Error('fail after upsert');
      }),
    ).rejects.toThrow('fail after upsert');

    await expect(mcpServerStore.getServer({ tenant_id: TENANT_ID, name: mcpManifest.name })).resolves.toBeUndefined();
  });

  it('commits writes to both stores when the transaction succeeds', async () => {
    const modelProviderStore = options.getModelProviderStore();
    const mcpServerStore = options.getMcpServerStore();
    await options.withTransaction(async transaction => {
      await modelProviderStore.upsertProvider(
        { tenant_id: TENANT_ID, name: 'anthropic', manifest: providerManifest },
        transaction,
      );
      await mcpServerStore.upsertServer(
        { tenant_id: TENANT_ID, name: mcpManifest.name, manifest: mcpManifest },
        transaction,
      );
    });

    await expect(modelProviderStore.getProvider({ tenant_id: TENANT_ID, name: 'anthropic' })).resolves.toMatchObject({
      manifest: { base_url: providerManifest.base_url },
    });
    await expect(mcpServerStore.getServer({ tenant_id: TENANT_ID, name: mcpManifest.name })).resolves.toMatchObject({
      manifest: { url: mcpManifest.url },
    });
  });

  it('rolls back both stores when the transaction fails after both writes', async () => {
    const modelProviderStore = options.getModelProviderStore();
    const mcpServerStore = options.getMcpServerStore();
    await expect(
      options.withTransaction(async transaction => {
        await modelProviderStore.upsertProvider(
          { tenant_id: TENANT_ID, name: 'anthropic', manifest: providerManifest },
          transaction,
        );
        await mcpServerStore.upsertServer(
          { tenant_id: TENANT_ID, name: mcpManifest.name, manifest: mcpManifest },
          transaction,
        );
        throw new Error('fail after multi-store writes');
      }),
    ).rejects.toThrow('fail after multi-store writes');

    await expect(modelProviderStore.getProvider({ tenant_id: TENANT_ID, name: 'anthropic' })).resolves.toBeUndefined();
    await expect(mcpServerStore.getServer({ tenant_id: TENANT_ID, name: mcpManifest.name })).resolves.toBeUndefined();
  });
}
