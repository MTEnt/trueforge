import { PostgresModelProviderStore } from '../../../src/db/postgres/model-provider-store/PostgresModelProviderStore';
import { runStoreTransactionsContractSuite } from '../storeTransactionsContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('store transactions (postgres)', () => {
  let env: PostgresTestDatabase;

  beforeEach(async () => {
    const created = await createPostgresTestDatabase();
    if (created === undefined) {
      throw new Error('Postgres test database unavailable');
    }
    env = created;
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  runStoreTransactionsContractSuite({
    runTransaction: callback => env.db.transaction().execute(callback),
    getModelProviderStore: () => new PostgresModelProviderStore(env.db),
  });
});
