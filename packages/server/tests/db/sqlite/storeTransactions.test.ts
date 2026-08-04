import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { runStoreTransactionsContractSuite } from '../storeTransactionsContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from './testDatabase';

describe('store transactions (sqlite)', () => {
  let env: SqliteTestDatabase;
  let modelProviderStore: SqliteModelProviderStore;
  let mcpServerStore: SqliteMcpServerStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    modelProviderStore = new SqliteModelProviderStore(env.db);
    mcpServerStore = new SqliteMcpServerStore(env.db);
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  runStoreTransactionsContractSuite({
    withTransaction: callback => env.db.transaction().execute(callback),
    getModelProviderStore: () => modelProviderStore,
    getMcpServerStore: () => mcpServerStore,
  });
});
