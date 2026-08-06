import { sql } from 'kysely';

import { runStoreContractSuite } from '../../../../../harness/tests/agent-session/store/storeContractSuite';
import { makeAgentSpec, makeCreateTurnInput } from '../../../../../harness/tests/agent-session/testHelpers';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSessionStore (ISessionStore contract)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  // One database per file; truncate between tests because CREATE DATABASE is slow.
  beforeEach(async () => {
    if (env !== undefined) {
      await sql`
        TRUNCATE TABLE
          thread_capability_state,
          session_event,
          thread_context_log,
          turn_thread,
          turn,
          session
        RESTART IDENTITY CASCADE
      `.execute(env.db);
    }
  });

  runStoreContractSuite(
    () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresSessionStore(env.db);
    },
    callback => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return env.db.transaction().execute(callback);
    },
  );

  it('joins a caller-owned transaction for createTurn', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const store = new PostgresSessionStore(env.db);
    await store.createSession({
      tenant_id: 't1',
      session_id: 's1',
      agent_spec: makeAgentSpec(),
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
