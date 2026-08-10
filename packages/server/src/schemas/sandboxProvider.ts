/**
 * Sandbox-provider domain + wire schemas: the client-writable configuration
 * (PUT body), the persisted manifest, and the read responses. Catalog file
 * schemas live in sandboxCatalog.ts, snapshot sync in sandboxSnapshot.ts.
 *
 * Singleton per tenant — no identity `name` (unlike model providers / skills).
 *
 * The snapshot is not configurable: the server derives it from the catalog and
 * reports progress through the read-only `snapshot_sync` field.
 */
import { z } from '@hono/zod-openapi';
import type { DaytonaSandboxProviderOptions } from '@truefoundry/utils-core/core';
import {
  SandboxSnapshotSyncSchema,
  SandboxSnapshotSyncStateSchema,
  toSandboxSnapshotSync,
  type SandboxSnapshotSyncState,
} from './sandboxSnapshot';

const DaytonaSandboxProviderAuthSchema = z
  .object({
    api_key: z.string().min(1).describe('Daytona API key.'),
  })
  .strict()
  .openapi('DaytonaSandboxProviderAuth');

/**
 * Daytona-backed sandbox provider: everything a client may write. The PUT body
 * and the configuration half of the persisted manifest share this shape.
 */
export const DaytonaSandboxProviderSchema = z
  .object({
    type: z.literal('daytona').describe('Daytona sandbox provider.'),
    auth: DaytonaSandboxProviderAuthSchema.describe('Daytona authentication credentials.'),
    exec_timeout_ms: z.number().int().positive().describe('Default sandbox command exec timeout in milliseconds.'),
    auto_stop_interval_in_minutes: z
      .number()
      .int()
      .nonnegative()
      .describe('Minutes of idle time before Daytona auto-stops the sandbox (0 disables).'),
    auto_archive_interval_in_minutes: z
      .number()
      .int()
      .nonnegative()
      .describe('Minutes before Daytona auto-archives the sandbox (0 disables).'),
    auto_delete_interval_in_minutes: z
      .number()
      .int()
      .nonnegative()
      .describe('Minutes before Daytona auto-deletes the sandbox (0 disables).'),
  })
  .strict()
  .openapi('DaytonaSandboxProvider');

/**
 * Wire + persisted sandbox provider. Single variant today — use this alias so
 * OpenAPI does not emit a one-member `oneOf` (Fern then invents ComponentsSchemas* types).
 * Widen to `z.discriminatedUnion('type', [...])` when a second provider ships.
 */
export const SandboxProviderSchema = DaytonaSandboxProviderSchema;

/**
 * Persisted jsonb. `snapshot_sync` is server-owned and absent until the first
 * reconcile, which is also how rows migrated off client-supplied snapshot names
 * are recognised as needing one.
 */
export const SandboxProviderManifestSchema = SandboxProviderSchema.extend({
  snapshot_sync: SandboxSnapshotSyncStateSchema.optional(),
}).strict();

/** Read shape: handlers reconcile before responding, so sync is always present. */
export const ConfiguredSandboxProviderSchema = SandboxProviderSchema.extend({
  snapshot_sync: SandboxSnapshotSyncSchema,
})
  .strict()
  .openapi('ConfiguredSandboxProvider');

export const PutSandboxProviderRequestSchema = SandboxProviderSchema;

export const PutSandboxProviderResponseSchema = z
  .object({
    data: ConfiguredSandboxProviderSchema,
  })
  .openapi('PutSandboxProviderResponse');

export const GetSandboxProviderResponseSchema = z
  .object({
    data: ConfiguredSandboxProviderSchema,
  })
  .openapi('GetSandboxProviderResponse');

export type DaytonaSandboxProvider = z.infer<typeof DaytonaSandboxProviderSchema>;
export type SandboxProvider = z.infer<typeof SandboxProviderSchema>;
export type SandboxProviderManifest = z.infer<typeof SandboxProviderManifestSchema>;
export type ConfiguredSandboxProvider = z.infer<typeof ConfiguredSandboxProviderSchema>;
export type PutSandboxProviderRequest = SandboxProvider;

/**
 * Drops the server-owned sync state to get back the client-writable configuration.
 * Field-by-field so a new manifest field is a compile error here rather than
 * silently leaking into request-shaped payloads.
 */
export function toSandboxProviderConfig(manifest: SandboxProviderManifest): SandboxProvider {
  return {
    type: manifest.type,
    auth: manifest.auth,
    exec_timeout_ms: manifest.exec_timeout_ms,
    auto_stop_interval_in_minutes: manifest.auto_stop_interval_in_minutes,
    auto_archive_interval_in_minutes: manifest.auto_archive_interval_in_minutes,
    auto_delete_interval_in_minutes: manifest.auto_delete_interval_in_minutes,
  };
}

export function toConfiguredSandboxProvider({
  manifest,
  snapshot_sync,
}: {
  manifest: SandboxProviderManifest;
  snapshot_sync: SandboxSnapshotSyncState;
}): ConfiguredSandboxProvider {
  return { ...toSandboxProviderConfig(manifest), snapshot_sync: toSandboxSnapshotSync(snapshot_sync) };
}

/**
 * Wire/persisted snake_case → Daytona client credentials + provider settings.
 * `snapshotName` comes from the synced snapshot, never from client input.
 */
export function toDaytonaSandboxProviderInput({
  manifest,
  snapshotName,
}: {
  manifest: SandboxProviderManifest;
  snapshotName: string;
}): {
  apiKey: string;
} & Pick<
  DaytonaSandboxProviderOptions,
  | 'snapshotName'
  | 'timeoutMs'
  | 'autoStopIntervalInMinutes'
  | 'autoArchiveIntervalInMinutes'
  | 'autoDeleteIntervalInMinutes'
> {
  return {
    apiKey: manifest.auth.api_key,
    snapshotName,
    timeoutMs: manifest.exec_timeout_ms,
    autoStopIntervalInMinutes: manifest.auto_stop_interval_in_minutes,
    autoArchiveIntervalInMinutes: manifest.auto_archive_interval_in_minutes,
    autoDeleteIntervalInMinutes: manifest.auto_delete_interval_in_minutes,
  };
}
