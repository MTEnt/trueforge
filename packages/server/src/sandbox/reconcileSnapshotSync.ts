/**
 * Snapshot sync state machine: given the desired spec and what Daytona holds, decide
 * the tenant's snapshot state and start whatever work moves it forward.
 *
 * Daytona cannot pull a digest-pinned reference, so the resolved digest never reaches
 * it and only names the snapshot; Daytona is told to pull the tag. A new push
 * therefore changes the name, which is what makes Daytona pull again.
 *
 * A snapshot already serving sandboxes is never given up for one that is not ready.
 * Persistence is the caller's job, so every transition is testable against fakes.
 */
import {
  DaytonaSnapshotAuthError,
  classifyDaytonaSnapshotState,
  type DaytonaSnapshot,
  type IDaytonaSnapshots,
} from '@truefoundry/utils-core/core';
import type { Logger } from 'winston';
import type { SandboxSnapshotRef, SandboxSnapshotSpec, SandboxSnapshotSyncState } from '../schemas/sandboxSnapshot';
import type { IImageDigestResolver } from './ImageDigestResolver';
import { isSameImageReference } from './imageReference';
import { deriveSandboxSnapshotName } from './snapshotName';

/** `write` (an explicit save) may delete and rebuild a failed snapshot; `read` only observes. */
export type SnapshotSyncMode = 'write' | 'read';

/** Deletions attempted per reconcile; the rest wait for the next one. */
const MAX_DELETIONS_PER_RECONCILE = 4;

export interface ReconcileSnapshotSyncInput {
  snapshots: IDaytonaSnapshots;
  images: IImageDigestResolver;
  spec: SandboxSnapshotSpec;
  /** Previous state, absent when this tenant has never been reconciled. */
  current: SandboxSnapshotSyncState | undefined;
  mode: SnapshotSyncMode;
  now: Date;
  logger: Logger;
}

type SnapshotSyncPlan = Pick<SandboxSnapshotSyncState, 'active' | 'pending' | 'error_message' | 'superseded'>;

type Inspection = { status: 'usable' } | { status: 'building' } | { status: 'unusable'; reason: string };

/**
 * Reconciles once. Throws only `DaytonaSnapshotAuthError` in `write` mode, where there
 * is a request to fail; every other failure is reported through `error_message` so
 * reads and turns keep working off whatever is already serving.
 */
export async function reconcileSnapshotSync(input: ReconcileSnapshotSyncInput): Promise<SandboxSnapshotSyncState> {
  const planned = await plan(input);
  return {
    desired_image: input.spec.docker_image,
    active: planned.active,
    pending: planned.pending,
    error_message: planned.error_message,
    updated_at: input.now.toISOString(),
    // A snapshot we failed to delete stays on the list, to retry rather than leak.
    superseded: await collectGarbage({
      snapshots: input.snapshots,
      superseded: planned.superseded,
      inUse: [planned.active?.snapshot_name, planned.pending?.snapshot_name].filter(name => name !== undefined),
      logger: input.logger,
    }),
  };
}

async function plan(input: ReconcileSnapshotSyncInput): Promise<SnapshotSyncPlan> {
  const { images, spec, current, mode } = input;
  const carried = current?.superseded ?? [];

  let target: SandboxSnapshotRef;
  try {
    const digest = await images.resolve(spec.docker_image);
    target = {
      snapshot_name: deriveSandboxSnapshotName({ spec, digest }),
      image: spec.docker_image,
      digest,
    };
  } catch (error) {
    // No digest means no target, so hold the current state: an active snapshot keeps
    // serving while the registry is unreachable.
    return {
      active: current?.active,
      pending: current?.pending,
      error_message: `Could not resolve the sandbox image ${spec.docker_image}: ${messageOf(error)}`,
      superseded: carried,
    };
  }

  // A tag rolled back to an earlier digest makes a snapshot queued for deletion the one
  // we are about to serve from, so take it off the list first.
  const queued = carried.filter(ref => ref.snapshot_name !== target.snapshot_name);

  try {
    return await planAgainstDaytona({ ...input, target, queued });
  } catch (error) {
    // Credentials are the one thing the user can act on, so a save fails rather than
    // storing a state. Everything else keeps the current state: a transient outage
    // must not take sandboxes offline.
    if (error instanceof DaytonaSnapshotAuthError && mode === 'write') {
      throw error;
    }
    return {
      active: current?.active,
      pending: current?.pending,
      error_message: daytonaFailureMessage(error),
      superseded: queued,
    };
  }
}

async function planAgainstDaytona({
  snapshots,
  spec,
  current,
  mode,
  target,
  queued,
}: ReconcileSnapshotSyncInput & {
  target: SandboxSnapshotRef;
  queued: readonly SandboxSnapshotRef[];
}): Promise<SnapshotSyncPlan> {
  const inspection = await inspectTarget({ snapshots, target, spec, mode });

  // A snapshot we were preparing for a since-superseded digest will never be used.
  const orphaned = supersede({ superseded: queued, replaced: current?.pending, target });

  if (inspection.status === 'usable') {
    return {
      active: target,
      pending: undefined,
      error_message: undefined,
      superseded: supersede({ superseded: orphaned, replaced: current?.active, target }),
    };
  }

  // The target cannot back sandboxes yet, so fall back to whatever already can.
  const active = await keepServing({ snapshots, active: current?.active, target });
  return {
    active,
    pending: inspection.status === 'building' ? target : undefined,
    error_message: inspection.status === 'building' ? undefined : inspection.reason,
    superseded: orphaned,
  };
}

function daytonaFailureMessage(error: unknown): string {
  return error instanceof DaytonaSnapshotAuthError
    ? 'Daytona rejected the configured API key, so the sandbox image cannot be synced. Save a valid key to continue.'
    : // Covers an unreachable Daytona and one that refused, so it asserts neither.
      `Could not sync the sandbox snapshot with Daytona: ${messageOf(error)}`;
}

/** Adds a replaced snapshot to the cleanup list, never the target and never twice. */
function supersede({
  superseded,
  replaced,
  target,
}: {
  superseded: readonly SandboxSnapshotRef[];
  replaced: SandboxSnapshotRef | undefined;
  target: SandboxSnapshotRef;
}): SandboxSnapshotRef[] {
  if (replaced === undefined || replaced.snapshot_name === target.snapshot_name) {
    return [...superseded];
  }
  if (superseded.some(ref => ref.snapshot_name === replaced.snapshot_name)) {
    return [...superseded];
  }
  return [...superseded, replaced];
}

/**
 * Makes the target snapshot exist and reports whether sandboxes can come from it.
 * Creation is fire-and-forget: Daytona registers the name and pulls in the background.
 */
async function inspectTarget({
  snapshots,
  target,
  spec,
  mode,
}: {
  snapshots: IDaytonaSnapshots;
  target: SandboxSnapshotRef;
  spec: SandboxSnapshotSpec;
  mode: SnapshotSyncMode;
}): Promise<Inspection> {
  const create = async (): Promise<DaytonaSnapshot> =>
    await snapshots.initiateCreate({
      name: target.snapshot_name,
      imageName: target.image,
      entrypoint: spec.entrypoint,
      resources:
        spec.resources === undefined
          ? undefined
          : { cpu: spec.resources.cpu, memoryGb: spec.resources.memory_gb, diskGb: spec.resources.disk_gb },
    });

  const existing = await snapshots.get(target.snapshot_name);
  const snapshot = existing ?? (await create());
  const inspection = await inspect({ snapshots, snapshot, expectedImage: target.image });
  if (inspection.status !== 'unusable' || mode === 'read') {
    return inspection;
  }
  // The unusable snapshot occupies the name we need, so a save drops it and starts over.
  // If Daytona will not let it go, the original failure is the more useful one to report.
  try {
    await snapshots.delete(snapshot);
  } catch {
    return inspection;
  }
  return await inspect({ snapshots, snapshot: await create(), expectedImage: target.image });
}

/**
 * Classifies a snapshot, reactivating it if Daytona has parked it. `imageName` is
 * checked because the snapshot name is ours by convention only: a mismatch means
 * something else owns the name, and its contents are unaccounted for.
 */
async function inspect({
  snapshots,
  snapshot,
  expectedImage,
}: {
  snapshots: IDaytonaSnapshots;
  snapshot: DaytonaSnapshot;
  expectedImage: string;
}): Promise<Inspection> {
  if (snapshot.imageName === undefined || !isSameImageReference({ left: snapshot.imageName, right: expectedImage })) {
    return {
      status: 'unusable',
      reason: `Daytona snapshot "${snapshot.name}" holds image "${snapshot.imageName ?? 'unknown'}" but this release expects "${expectedImage}". Delete that snapshot in Daytona to let the server recreate it.`,
    };
  }

  switch (classifyDaytonaSnapshotState(snapshot.state)) {
    case 'ready':
      return { status: 'usable' };
    case 'in_progress':
      return { status: 'building' };
    case 'inactive': {
      // Daytona parks unused snapshots; reactivate rather than surfacing that state.
      const activated = await snapshots.activate(snapshot);
      return classifyDaytonaSnapshotState(activated.state) === 'ready' ? { status: 'usable' } : { status: 'building' };
    }
    case 'failed':
      return {
        status: 'unusable',
        reason: snapshot.errorReason ?? `Daytona reported snapshot state "${snapshot.state}"`,
      };
  }
}

/**
 * Confirms the previously active snapshot can still back sandboxes while the target is
 * prepared. Only runs mid-transition, and claiming readiness for a snapshot that has
 * since been deleted would turn "still preparing" into a failure at turn start.
 */
async function keepServing({
  snapshots,
  active,
  target,
}: {
  snapshots: IDaytonaSnapshots;
  active: SandboxSnapshotRef | undefined;
  target: SandboxSnapshotRef;
}): Promise<SandboxSnapshotRef | undefined> {
  // Nothing to fall back to, or the one we were serving is the one that just failed.
  if (active === undefined || active.snapshot_name === target.snapshot_name) {
    return undefined;
  }
  try {
    const snapshot = await snapshots.get(active.snapshot_name);
    if (snapshot === undefined) {
      return undefined;
    }
    const inspection = await inspect({ snapshots, snapshot, expectedImage: active.image });
    return inspection.status === 'usable' ? active : undefined;
  } catch (error) {
    if (error instanceof DaytonaSnapshotAuthError) {
      throw error;
    }
    // Unverifiable is not gone: keep serving rather than declaring an outage.
    return active;
  }
}

/**
 * Deletes replaced snapshots, returning the ones still to clean up. Deletion is the one
 * irreversible thing a reconcile does, and doing it to the wrong snapshot strands every
 * sandbox that would have come from it, so `inUse` is re-checked here.
 */
async function collectGarbage({
  snapshots,
  superseded,
  inUse,
  logger,
}: {
  snapshots: IDaytonaSnapshots;
  superseded: readonly SandboxSnapshotRef[];
  inUse: readonly string[];
  logger: Logger;
}): Promise<SandboxSnapshotRef[]> {
  // Bounded because this runs while a turn is starting, and snapshots Daytona keeps
  // refusing to delete must not become a pile of requests every caller waits behind.
  const attempted = superseded.slice(0, MAX_DELETIONS_PER_RECONCILE);
  const deferred = superseded.slice(MAX_DELETIONS_PER_RECONCILE);

  const remaining: SandboxSnapshotRef[] = [];
  for (const ref of attempted) {
    // Back in service, so not garbage.
    if (inUse.includes(ref.snapshot_name)) {
      continue;
    }
    try {
      const snapshot = await snapshots.get(ref.snapshot_name);
      if (snapshot !== undefined) {
        await snapshots.delete(snapshot);
      }
    } catch (error) {
      // Never worth failing a reconcile over, but logged: a snapshot Daytona keeps
      // refusing — a key without the delete permission — is storage nobody sees.
      logger.warn('Could not delete a replaced sandbox snapshot', {
        snapshot_name: ref.snapshot_name,
        error: messageOf(error),
      });
      remaining.push(ref);
    }
  }
  // Deferred entries go first next time so one stubborn snapshot cannot starve the rest.
  return [...deferred, ...remaining];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
