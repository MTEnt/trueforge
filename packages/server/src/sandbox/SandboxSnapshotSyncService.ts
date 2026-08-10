/**
 * Owns the tenant's sandbox snapshot lifecycle: when to ask Daytona, how to persist
 * the answer, and whether sandboxes may be created right now.
 *
 * There is no background worker, so every caller that cares about the snapshot also
 * advances it: settings writes, settings polls, boot, and turn start. Turn start is
 * what heals a sync the user walked away from mid-flight.
 */
import { DaytonaSnapshots, type IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import type { Logger } from 'winston';
import type { SandboxCatalog } from '../catalog/SandboxCatalog';
import configuration from '../config';
import type { ISandboxProviderStore, SandboxProviderRecord } from '../db/sandboxProviderStore';
import type { SandboxProviderManifest } from '../schemas/sandboxProvider';
import { sandboxSnapshotStatus, type SandboxSnapshotSyncState } from '../schemas/sandboxSnapshot';
import {
  CachedImageDigestResolver,
  RegistryImageDigestResolver,
  type IImageDigestResolver,
  type RegistryCredentials,
} from './ImageDigestResolver';
import { reconcileSnapshotSync, type SnapshotSyncMode } from './reconcileSnapshotSync';

/** How long a fully synced state is trusted before Daytona is consulted again. */
const SYNCED_REFRESH_INTERVAL_MS = 60_000;
/** Upper bound on how long a fresh image push goes unnoticed, process-wide. */
const IMAGE_DIGEST_TTL_MS = 300_000;

/** Whether sandboxes can be created, decided from persisted state alone. */
export type SandboxSnapshotReadiness =
  { ready: true; snapshotName: string } | { ready: false; syncing: boolean; reason: string };

/** A configured provider and the sync state the caller should read readiness from. */
export interface LoadedSandboxProvider {
  manifest: SandboxProviderManifest;
  snapshot_sync: SandboxSnapshotSyncState;
}

function withSnapshotSync({
  record,
  snapshot_sync,
}: {
  record: SandboxProviderRecord;
  snapshot_sync: SandboxSnapshotSyncState;
}): LoadedSandboxProvider {
  return { manifest: { ...record.manifest, snapshot_sync }, snapshot_sync };
}

export interface SandboxSnapshotSyncServiceDeps {
  store: ISandboxProviderStore;
  catalog: SandboxCatalog;
  /** Builds a Daytona snapshot client for a tenant's API key. */
  createSnapshots: (options: { apiKey: string }) => IDaytonaSnapshots;
  /** Resolves the catalog image reference to a digest. Shared across tenants. */
  images: IImageDigestResolver;
  logger: Logger;
}

/** Production wiring: a real Daytona client per tenant, one cached registry resolver. */
export function createSandboxSnapshotSyncService({
  store,
  catalog,
  logger,
}: {
  store: ISandboxProviderStore;
  catalog: SandboxCatalog;
  logger: Logger;
}): SandboxSnapshotSyncService {
  return new SandboxSnapshotSyncService({
    store,
    catalog,
    createSnapshots: ({ apiKey }) => new DaytonaSnapshots({ apiKey, apiUrl: configuration.DAYTONA_API_URL }),
    images: new CachedImageDigestResolver({
      resolver: new RegistryImageDigestResolver({ credentials: registryCredentials() }),
      ttlMs: IMAGE_DIGEST_TTL_MS,
    }),
    logger,
  });
}

/** Only needed for a private sandbox image; anonymous pull tokens cover public ones. */
function registryCredentials(): RegistryCredentials | undefined {
  const { SANDBOX_IMAGE_REGISTRY_USERNAME: username, SANDBOX_IMAGE_REGISTRY_PASSWORD: password } = configuration;
  if (username === undefined || password === undefined) {
    return undefined;
  }
  return { username, password };
}

export class SandboxSnapshotSyncService {
  private readonly store: ISandboxProviderStore;
  private readonly catalog: SandboxCatalog;
  private readonly createSnapshots: (options: { apiKey: string }) => IDaytonaSnapshots;
  private readonly images: IImageDigestResolver;
  private readonly logger: Logger;
  /** Collapses concurrent refreshes per tenant so polls and turns cannot double-create. */
  private readonly inFlight = new Map<string, Promise<SandboxSnapshotSyncState>>();
  /** Tail of each tenant's reconcile queue; see `serialize`. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(deps: SandboxSnapshotSyncServiceDeps) {
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.createSnapshots = deps.createSnapshots;
    this.images = deps.images;
    this.logger = deps.logger.child({ module: 'SandboxSnapshotSync' });
  }

  /**
   * Readiness from a manifest alone, touching neither Daytona nor the registry. An
   * active snapshot is enough: a newer one being prepared is not a reason to refuse.
   */
  readiness(manifest: SandboxProviderManifest): SandboxSnapshotReadiness {
    const sync = manifest.snapshot_sync;
    if (sync === undefined) {
      return { ready: false, syncing: true, reason: 'The sandbox image has not been synced to Daytona yet.' };
    }
    if (sync.active !== undefined) {
      return { ready: true, snapshotName: sync.active.snapshot_name };
    }
    return sync.error_message === undefined
      ? { ready: false, syncing: true, reason: 'The sandbox image is still being prepared in Daytona.' }
      : { ready: false, syncing: false, reason: sync.error_message };
  }

  /**
   * Reconciles against the credentials in a pending save without persisting, so a
   * rejected key fails the write instead of being stored. State is read here rather
   * than passed in: a save waiting in the queue may hold a copy two reconciles old.
   *
   * Throws `DaytonaSnapshotAuthError` when Daytona rejects the key.
   */
  async reconcileForSave({
    tenant_id,
    manifest,
  }: {
    tenant_id: string;
    manifest: SandboxProviderManifest;
  }): Promise<SandboxSnapshotSyncState> {
    return await this.serialize({
      tenant_id,
      work: async () => {
        const stored = await this.store.getSandboxProvider(tenant_id);
        return await this.reconcile({ manifest, current: stored?.manifest.snapshot_sync, mode: 'write' });
      },
    });
  }

  /**
   * Advances and persists the stored state. A synced state is trusted for
   * `SYNCED_REFRESH_INTERVAL_MS`; anything unsettled is re-checked on every call.
   */
  async refresh({ record }: { record: SandboxProviderRecord }): Promise<SandboxSnapshotSyncState> {
    const { tenant_id: tenantId, manifest } = record;
    const sync = manifest.snapshot_sync;
    if (sync !== undefined && !this.needsReconcile(sync)) {
      return sync;
    }

    const pending = this.inFlight.get(tenantId);
    if (pending !== undefined) {
      return await pending;
    }

    const reconciled = this.serialize({
      tenant_id: tenantId,
      work: async () => await this.advance({ record }),
    }).finally(() => {
      this.inFlight.delete(tenantId);
    });

    this.inFlight.set(tenantId, reconciled);
    return await reconciled;
  }

  /**
   * One read-mode reconcile from whatever is stored when it runs. Waiting in the queue
   * is where state goes stale, and a stale baseline can republish slots a save has moved
   * past, so the record is re-read and the work skipped if the wait made it moot.
   */
  private async advance({ record }: { record: SandboxProviderRecord }): Promise<SandboxSnapshotSyncState> {
    const tenantId = record.tenant_id;
    const manifest = (await this.store.getSandboxProvider(tenantId))?.manifest ?? record.manifest;
    const current = manifest.snapshot_sync;
    if (current !== undefined && !this.needsReconcile(current)) {
      return current;
    }
    const next = await this.reconcile({ manifest, current, mode: 'read' });
    return await this.persist({ tenant_id: tenantId, api_key: manifest.auth.api_key, next });
  }

  /**
   * One reconcile at a time per tenant. Otherwise a save and a poll interleave their
   * Daytona commands — one deleting a snapshot the other is inspecting — then race to
   * write the state each of them saw.
   */
  private async serialize<T>({ tenant_id, work }: { tenant_id: string; work: () => Promise<T> }): Promise<T> {
    const queued = (this.queue.get(tenant_id) ?? Promise.resolve()).then(work, work);
    // Swallowed only for the successor's benefit: `queued` still carries the failure.
    this.queue.set(
      tenant_id,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await queued;
  }

  /**
   * Loads the provider and brings its snapshot state up to date.
   * Resolves undefined when no provider is configured for the tenant.
   */
  async load({ tenant_id }: { tenant_id: string }): Promise<LoadedSandboxProvider | undefined> {
    const record = await this.store.getSandboxProvider(tenant_id);
    if (record === undefined) {
      return undefined;
    }
    return withSnapshotSync({ record, snapshot_sync: await this.refresh({ record }) });
  }

  /**
   * Turn-start variant of `load`. With a snapshot already serving, the reconcile runs in
   * the background so a slow registry or Daytona is not latency on every message. With
   * nothing active there is nothing to serve, so the caller waits.
   */
  async loadForTurn({ tenant_id }: { tenant_id: string }): Promise<LoadedSandboxProvider | undefined> {
    const record = await this.store.getSandboxProvider(tenant_id);
    if (record === undefined) {
      return undefined;
    }
    const sync = record.manifest.snapshot_sync;
    if (sync?.active !== undefined) {
      void this.refreshInBackground({ record });
      return withSnapshotSync({ record, snapshot_sync: sync });
    }
    return withSnapshotSync({ record, snapshot_sync: await this.refresh({ record }) });
  }

  private async refreshInBackground({ record }: { record: SandboxProviderRecord }): Promise<void> {
    try {
      await this.refresh({ record });
    } catch (error) {
      this.logger.warn('Sandbox snapshot sync could not be advanced in the background', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Records a reconcile result. Written even when nothing changed, because `updated_at`
   * is what the refresh window is measured from.
   *
   * Skipped when a save has since pointed the tenant at a different Daytona account:
   * that state describes snapshots in the old account, and storing it would advertise
   * one as ready until a sandbox was created from it.
   */
  private async persist({
    tenant_id,
    api_key,
    next,
  }: {
    tenant_id: string;
    api_key: string;
    next: SandboxSnapshotSyncState;
  }): Promise<SandboxSnapshotSyncState> {
    const latest = await this.store.getSandboxProvider(tenant_id);
    if (latest !== undefined && latest.manifest.auth.api_key !== api_key) {
      return latest.manifest.snapshot_sync ?? next;
    }
    await this.store.patchSandboxProviderSnapshotSync({ tenant_id, snapshot_sync: next });
    return next;
  }

  /**
   * One reconcile per process start, so a release that changes the sandbox image
   * converges without anyone opening the settings page. Never throws: a
   * misconfigured or unreachable Daytona must not stop the server from booting.
   */
  async reconcileAtBoot({ tenant_id }: { tenant_id: string }): Promise<void> {
    try {
      const record = await this.store.getSandboxProvider(tenant_id);
      if (record === undefined) {
        return;
      }
      const sync = await this.refresh({ record });
      this.logger.info('Sandbox snapshot sync reconciled at startup', {
        status: sandboxSnapshotStatus(sync),
        active_snapshot: sync.active?.snapshot_name,
        pending_snapshot: sync.pending?.snapshot_name,
      });
    } catch (error) {
      this.logger.warn('Sandbox snapshot sync could not be reconciled at startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async reconcile({
    manifest,
    current,
    mode,
  }: {
    manifest: SandboxProviderManifest;
    current: SandboxSnapshotSyncState | undefined;
    mode: SnapshotSyncMode;
  }): Promise<SandboxSnapshotSyncState> {
    return await reconcileSnapshotSync({
      snapshots: this.createSnapshots({ apiKey: manifest.auth.api_key }),
      images: this.images,
      spec: this.catalog.snapshotSpec(),
      current,
      mode,
      now: new Date(),
      logger: this.logger,
    });
  }

  /**
   * Work in progress is re-checked on every call; anything settled, including a settled
   * failure, waits for the refresh interval rather than paying for a round-trip that
   * cannot say anything new. Settled is not the same as current — a moving tag can point
   * somewhere new at any time — so the interval is what bounds staleness.
   *
   * A snapshot queued for deletion is deliberately not unsettled: one Daytona keeps
   * refusing would otherwise make every poll and turn start pay for a full reconcile.
   */
  private needsReconcile(sync: SandboxSnapshotSyncState): boolean {
    const settled =
      sync.pending === undefined &&
      // Neither serving nor failed means this tenant has never been reconciled.
      (sync.active !== undefined || sync.error_message !== undefined) &&
      sync.desired_image === this.catalog.snapshotSpec().docker_image;
    if (!settled) {
      return true;
    }
    const age = Date.now() - new Date(sync.updated_at).getTime();
    return !Number.isFinite(age) || age >= SYNCED_REFRESH_INTERVAL_MS;
  }
}
