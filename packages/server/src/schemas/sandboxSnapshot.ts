/**
 * The sandbox snapshot the server keeps synced in each tenant's Daytona account:
 * the desired spec (shipped in sandbox-catalog.yaml) and the sync state persisted
 * on the provider manifest.
 *
 * The spec is server-owned — never a request field — because the sandbox image is
 * a property of the release, not of the customer's configuration.
 */
import { z } from '@hono/zod-openapi';
import { parseImageReference } from '../sandbox/imageReference';

/**
 * An explicit tag other than `latest`, naming its registry. The tag may be a moving one
 * (`:stable`, `:main`); the server resolves it to a digest on every reconcile.
 *
 * Digests and `latest` are rejected because Daytona refuses both — it mangles
 * `name@sha256:…` into an invalid reference before pulling, and answers
 * `Images with tag ":latest" are not allowed` — so this fails at startup instead of
 * during a sync that could never succeed.
 */
const DockerImageRefSchema = z.string().min(1).refine(isSyncableTagReference, {
  message:
    'must be a container image reference naming its registry, with an explicit tag other than "latest" and no digest, e.g. "tfy.jfrog.io/tfy-images/app:1.2.3" or "tfy.jfrog.io/tfy-images/app:stable" (Daytona rejects ":latest", an absent tag, and digest-pinned references)',
});

function isSyncableTagReference(reference: string): boolean {
  const parsed = parseImageReference(reference);
  if (parsed === undefined || parsed.digest !== undefined) {
    return false;
  }
  // An absent tag parses as `latest`, so one comparison covers both forms Daytona
  // refuses. Case-sensitive: Daytona accepts `:Latest`.
  return parsed.tag !== 'latest';
}

/** Sandbox resource request. Omitted fields fall back to Daytona's org defaults. */
export const SandboxSnapshotResourcesSchema = z
  .object({
    cpu: z.number().int().positive(),
    memory_gb: z.number().int().positive(),
    disk_gb: z.number().int().positive(),
  })
  .strict();

/**
 * Everything that decides what a sandbox is. The snapshot name hashes the resolved form
 * of this document, so editing any field provisions a new snapshot.
 */
export const SandboxSnapshotSpecSchema = z
  .object({
    docker_image: DockerImageRefSchema,
    /** Overrides the image entrypoint; the sandbox must keep the NATS bridge alive. */
    entrypoint: z.array(z.string().min(1)).nonempty().optional(),
    resources: SandboxSnapshotResourcesSchema.optional(),
  })
  .strict();

export type SandboxSnapshotResources = z.infer<typeof SandboxSnapshotResourcesSchema>;
export type SandboxSnapshotSpec = z.infer<typeof SandboxSnapshotSpecSchema>;

/** A snapshot that exists in Daytona, and the image it was built from. */
const SandboxSnapshotRefSchema = z
  .object({
    snapshot_name: z.string().min(1),
    /** Reference Daytona was told to pull, i.e. the catalog tag. */
    image: z.string().min(1),
    /** Digest that tag resolved to when this snapshot was requested. */
    digest: z.string().min(1),
  })
  .strict()
  .openapi('SandboxSnapshotRef');

/**
 * Sync state as clients see it. `active` and `pending` are separate so a new push never
 * takes sandboxes offline: creation keeps using `active` while `pending` is pulled. An
 * `error_message` alongside an `active` means the last attempt to move forward failed.
 */
export const SandboxSnapshotSyncSchema = z
  .object({
    /** Catalog reference this state was computed from; may be a moving tag. */
    desired_image: z.string().min(1),
    /** Snapshot sandboxes are created from right now. Absent until the first one lands. */
    active: SandboxSnapshotRefSchema.optional(),
    /** Snapshot being prepared to take over from `active`. */
    pending: SandboxSnapshotRefSchema.optional(),
    /** Why the last reconcile did not reach a fully synced state. */
    error_message: z.string().min(1).optional(),
    /** ISO-8601 UTC instant of the last reconcile. */
    updated_at: z.iso.datetime(),
  })
  .strict()
  .openapi('SandboxSnapshotSync');

/**
 * Persisted form. `superseded` is bookkeeping, not status: replaced snapshots kept until
 * Daytona confirms deletion, so a failed cleanup is retried instead of leaking storage.
 */
export const SandboxSnapshotSyncStateSchema = SandboxSnapshotSyncSchema.extend({
  superseded: z.array(SandboxSnapshotRefSchema),
}).strict();

export type SandboxSnapshotRef = z.infer<typeof SandboxSnapshotRefSchema>;
export type SandboxSnapshotSync = z.infer<typeof SandboxSnapshotSyncSchema>;
export type SandboxSnapshotSyncState = z.infer<typeof SandboxSnapshotSyncStateSchema>;

/** Whether sandboxes can be created, reduced from the two snapshot slots. */
export type SandboxSnapshotStatus = 'ready' | 'syncing' | 'failed';

export function sandboxSnapshotStatus(sync: SandboxSnapshotSync): SandboxSnapshotStatus {
  if (sync.active !== undefined) {
    return 'ready';
  }
  return sync.error_message === undefined ? 'syncing' : 'failed';
}

/** Drops internal cleanup bookkeeping to get the client-visible state. */
export function toSandboxSnapshotSync(state: SandboxSnapshotSyncState): SandboxSnapshotSync {
  return {
    desired_image: state.desired_image,
    active: state.active,
    pending: state.pending,
    error_message: state.error_message,
    updated_at: state.updated_at,
  };
}
