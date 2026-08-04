import type { MiddlewareHandler } from 'hono';

/** Opens a DB transaction and runs the callback with the handle (commit on resolve, rollback on throw). */
export type RunTransaction<TTransaction> = <T>(callback: (transaction: TTransaction) => Promise<T>) => Promise<T>;

export interface DbTransactionVariables<TTransaction> {
  tx: TTransaction;
}

/**
 * HTTP methods that may mutate state.
 * GET/HEAD/OPTIONS stay out so read handlers do not hold a write transaction.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Opens a DB transaction for write methods, sets `c.set('tx', …)`, then runs `next()`.
 *
 * After `next()`, rethrow `c.error` when set. Hono's `onError` catches handler throws,
 * assigns `c.error`, and resolves `next()` instead of rejecting it — without this
 * rethrow Kysely would commit the transaction even though the client got an error.
 */
export function createWriteDbTransactionMiddleware<TTransaction>(
  runTransaction: RunTransaction<TTransaction>,
): MiddlewareHandler<{ Variables: DbTransactionVariables<TTransaction> }> {
  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    await runTransaction(async transaction => {
      c.set('tx', transaction);
      await next();
      if (c.error) {
        throw c.error;
      }
    });
  };
}
