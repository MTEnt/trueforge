import { runStoreContractSuite } from '../../../../../harness/tests/agent-session/store/storeContractSuite';
import { makeAgentSpec, makeCreateTurnInput } from '../../../../../harness/tests/agent-session/testHelpers';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSessionStore (ISessionStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runStoreContractSuite(
    () => new SqliteSessionStore(env.db),
    callback => env.db.transaction().execute(callback),
  );

  it('joins a caller-owned transaction for createTurn', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.createSession({
      tenant_id: 't1',
      session_id: 's1',
      agent: { type: 'value', agent_spec: makeAgentSpec() },
      custom: null,
    });

    await expect(
      env.db.transaction().execute(async transaction => {
        await store.createTurn(makeCreateTurnInput({ sessionId: 's1', turnId: 'turn-1' }), transaction);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    await expect(store.getTurn({ session_id: 's1', turn_id: 'turn-1' })).resolves.toBeUndefined();
  });
});
