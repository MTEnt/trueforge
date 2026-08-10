import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ISandboxProviderStore,
  type PatchSandboxProviderSnapshotSyncInput,
  type SandboxProviderRecord,
  type UpsertSandboxProviderInput,
} from '../../sandboxProviderStore';
import { json, jsonbSet, now } from '../sqlExpressions';
import type { Database, SandboxProviderTable } from '../types';

function toRecord(row: Selectable<SandboxProviderTable>): SandboxProviderRecord {
  return {
    tenant_id: row.tenant_id,
    manifest: row.manifest,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresSandboxProviderStore implements ISandboxProviderStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getSandboxProvider(tenantId: string): Promise<SandboxProviderRecord | undefined> {
    const row = await this.#db
      .selectFrom('sandbox_provider')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async upsertSandboxProvider(input: UpsertSandboxProviderInput): Promise<SandboxProviderRecord> {
    const row = await this.#db
      .insertInto('sandbox_provider')
      .values({
        tenant_id: input.tenant_id,
        manifest: json(input.manifest),
        created_at: now(),
        updated_at: now(),
      })
      .onConflict(oc =>
        oc.columns(['tenant_id']).doUpdateSet({
          manifest: json(input.manifest),
          updated_at: now(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async patchSandboxProviderSnapshotSync(input: PatchSandboxProviderSnapshotSyncInput): Promise<void> {
    await this.#db
      .updateTable('sandbox_provider')
      .set({
        manifest: jsonbSet(sql.ref('manifest'), sql`'{snapshot_sync}'`, json(input.snapshot_sync)),
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .execute();
  }
}
