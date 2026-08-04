/**
 * Commit and rollback coverage for store writes that join a withTransaction handle.
 */
import type { IModelProviderStore } from '../../src/db/modelProviderStore';
import type { WithTransaction } from '../../src/db/transaction';
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

export function runStoreTransactionsContractSuite<TTransaction>(options: {
  withTransaction: WithTransaction<TTransaction>;
  getModelProviderStore: () => IModelProviderStore<TTransaction>;
}): void {
  it('commits an upsert when the transaction succeeds', async () => {
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

  it('rolls back an upsert when the transaction fails', async () => {
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
}
