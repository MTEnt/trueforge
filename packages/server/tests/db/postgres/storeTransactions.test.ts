import { sql } from 'kysely';
import { PostgresMcpServerStore } from '../../../src/db/postgres/mcp-server-store/PostgresMcpServerStore';
import { PostgresModelProviderStore } from '../../../src/db/postgres/model-provider-store/PostgresModelProviderStore';
import { runStoreTransactionsContractSuite } from '../storeTransactionsContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('store transactions (postgres)', () => {
  let env: PostgresTestDatabase;
  let modelProviderStore: PostgresModelProviderStore;
  let mcpServerStore: PostgresMcpServerStore;

  beforeAll(async () => {
    const created = await createPostgresTestDatabase();
    if (created === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
    env = created;
    modelProviderStore = new PostgresModelProviderStore(env.db);
    mcpServerStore = new PostgresMcpServerStore(env.db);
  }, 120_000);

  afterAll(async () => {
    await env.teardown();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE model_provider, mcp_server RESTART IDENTITY CASCADE`.execute(env.db);
  });

  runStoreTransactionsContractSuite({
    withTransaction: callback => env.db.transaction().execute(callback),
    getModelProviderStore: () => modelProviderStore,
    getMcpServerStore: () => mcpServerStore,
  });
});
