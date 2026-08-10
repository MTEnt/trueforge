/**
 * DB-backed configured sandbox provider: at most one row per tenant,
 * Zod-validated `SandboxProviderManifest` jsonb document.
 * Implementations: PostgresSandboxProviderStore and SqliteSandboxProviderStore.
 */
import type { SandboxProviderManifest } from '../schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../schemas/sandboxSnapshot';

export interface SandboxProviderRecord {
  tenant_id: string;
  manifest: SandboxProviderManifest;
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface UpsertSandboxProviderInput {
  tenant_id: string;
  manifest: SandboxProviderManifest;
}

export interface PatchSandboxProviderSnapshotSyncInput {
  tenant_id: string;
  snapshot_sync: SandboxSnapshotSyncState;
}

export interface ISandboxProviderStore {
  getSandboxProvider(tenantId: string): Promise<SandboxProviderRecord | undefined>;
  /** Single-row write: creates the provider or replaces the whole manifest. */
  upsertSandboxProvider(input: UpsertSandboxProviderInput): Promise<SandboxProviderRecord>;
  /**
   * Replaces only the server-owned `snapshot_sync` key inside the manifest.
   * Narrow on purpose: snapshot sync runs on reads, and a read-modify-write of the
   * whole document would let a poll clobber a concurrent credential rotation.
   * No-ops when the tenant has no provider configured.
   */
  patchSandboxProviderSnapshotSync(input: PatchSandboxProviderSnapshotSyncInput): Promise<void>;
}
