import type { MiddlewareHandler } from 'hono';

/** Opens a DB transaction and runs the callback with the handle (commit on resolve, rollback on throw). */
export type RunTransaction<TTransaction> = <T>(callback: (transaction: TTransaction) => Promise<T>) => Promise<T>;

export type DbTransactionVariables<TTransaction> = {
  tx: TTransaction;
};

/** Methods that may mutate state; GETs stay out so reads and remote I/O do not hold a write txn. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Opens a txn and `c.set('tx', …)` for write methods only, then `next()`.
 * Skips GET/HEAD/OPTIONS: no atomic write boundary, and handlers like MCP tools/list
 * must not hold a DB txn across outbound HTTP.
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
    });
  };
}
