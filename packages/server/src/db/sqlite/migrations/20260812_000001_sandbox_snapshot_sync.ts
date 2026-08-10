import { sql, type Kysely } from 'kysely';

/**
 * SQLite counterpart of the Postgres migration of the same name: drops the
 * client-supplied `manifest.snapshot_name` now that the sandbox image and its
 * snapshot name are derived from the shipped catalog.
 *
 * Rows are left without `snapshot_sync` so the reconciler treats them as never
 * synced and provisions the snapshot on the next read, turn, or server start.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE sandbox_provider
    SET manifest = jsonb_remove(manifest, '$.snapshot_name')
    WHERE json_type(manifest, '$.snapshot_name') IS NOT NULL
  `.execute(db);
}

/**
 * Restores a `snapshot_name` so rows validate against the pre-change schema, using
 * the synced name when one exists and the historical default otherwise. The
 * original user-supplied value is not recoverable.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE sandbox_provider
    SET manifest = jsonb_set(
      jsonb_remove(manifest, '$.snapshot_sync'),
      '$.snapshot_name',
      COALESCE(manifest ->> '$.snapshot_sync.active.snapshot_name', 'trueforge-local')
    )
  `.execute(db);
}
