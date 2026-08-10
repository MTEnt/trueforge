import { sql, type Kysely } from 'kysely';

/**
 * Sandbox snapshots became server-owned: the image comes from the shipped catalog
 * and the snapshot name is derived from it, so `manifest.snapshot_name` (a value
 * users typed) is no longer part of the schema.
 *
 * Rows are left without `snapshot_sync`. Absence is what the reconciler reads as
 * "never synced", so the next settings read, turn, or server start provisions the
 * snapshot — no operator action, and no misleading failure state in the UI.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE sandbox_provider
    SET manifest = manifest - 'snapshot_name'
    WHERE manifest ? 'snapshot_name'
  `.execute(db);
}

/**
 * Restores a `snapshot_name` so rows validate against the pre-change schema, using
 * the synced name when one exists and the historical default otherwise. The
 * original user-supplied value is not recoverable.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE sandbox_provider
    SET manifest = jsonb_set(
      manifest - 'snapshot_sync',
      '{snapshot_name}',
      COALESCE(manifest -> 'snapshot_sync' -> 'active' -> 'snapshot_name', '"trueforge-local"'::jsonb)
    )
  `.execute(db);
}
