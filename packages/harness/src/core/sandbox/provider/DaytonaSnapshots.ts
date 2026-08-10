/**
 * Daytona snapshot administration: the calls a host needs to make the sandbox
 * snapshot exist in a Daytona account before `DaytonaSandboxProvider` clones
 * sandboxes from it.
 *
 * Talks to `@daytona/api-client` rather than `@daytona/sdk` because
 * `SnapshotService.create()` polls until the snapshot reaches a terminal state,
 * which can take minutes on a cold image pull. Daytona's create endpoint itself
 * returns as soon as the snapshot is registered, so `initiateCreate` issues that
 * one request and leaves progress to be observed by later `get` calls.
 */
import {
  Configuration,
  SnapshotsApi,
  SnapshotState,
  type CreateSnapshot,
  type SnapshotState as DaytonaSnapshotState,
  type SnapshotDto,
} from '@daytona/api-client';

export type { DaytonaSnapshotState };

/**
 * What a Daytona state means to a caller deciding whether sandboxes can be
 * created. Keeps Daytona's eight-state vocabulary from leaking into hosts.
 */
export type DaytonaSnapshotLifecycle =
  /** Sandboxes can be created from it now. */
  | 'ready'
  /** Daytona is still pulling, building, or removing; poll again. */
  | 'in_progress'
  /** Parked by Daytona after prolonged disuse; needs `activate` before use. */
  | 'inactive'
  /** The pull or build failed; see `errorReason`. */
  | 'failed';

export function classifyDaytonaSnapshotState(state: DaytonaSnapshotState): DaytonaSnapshotLifecycle {
  switch (state) {
    case SnapshotState.ACTIVE:
      return 'ready';
    case SnapshotState.INACTIVE:
      return 'inactive';
    case SnapshotState.ERROR:
    case SnapshotState.BUILD_FAILED:
      return 'failed';
    case SnapshotState.PENDING:
    case SnapshotState.BUILDING:
    case SnapshotState.PULLING:
    case SnapshotState.REMOVING:
      return 'in_progress';
    default:
      // Daytona's generated enum carries an `UNKNOWN_DEFAULT_OPEN_API` member for
      // states added server-side; treat anything unrecognised as still settling.
      return 'in_progress';
  }
}

/**
 * Projection of Daytona's snapshot document. Hosts reconcile against these
 * fields only, so they never depend on the full generated DTO.
 */
export interface DaytonaSnapshot {
  id: string;
  name: string;
  /** Image reference Daytona pulled. Absent for snapshots built from a Dockerfile. */
  imageName: string | undefined;
  state: DaytonaSnapshotState;
  /** Daytona's explanation when `state` is `error` or `build_failed`. */
  errorReason: string | null;
}

export interface DaytonaSnapshotResources {
  /** CPU cores. */
  cpu: number;
  /** Memory in GB. */
  memoryGb: number;
  /** Disk in GB. */
  diskGb: number;
}

export interface CreateDaytonaSnapshotParams {
  name: string;
  /** Registry reference Daytona pulls; must be resolvable by the Daytona account. */
  imageName: string;
  /** Overrides the image's own entrypoint when set. */
  entrypoint: readonly string[] | undefined;
  /** Falls back to Daytona's per-organization defaults when absent. */
  resources: DaytonaSnapshotResources | undefined;
}

/**
 * Snapshot administration surface. Hosts depend on this interface so the
 * reconcile logic is testable without Daytona.
 */
export interface IDaytonaSnapshots {
  /** Resolves undefined when no snapshot carries that name. */
  get(name: string): Promise<DaytonaSnapshot | undefined>;
  /**
   * Registers the snapshot and returns immediately, so the returned state is
   * normally `pending` / `pulling` rather than terminal. Resolves with the
   * existing snapshot when a concurrent caller registered the same name first.
   */
  initiateCreate(params: CreateDaytonaSnapshotParams): Promise<DaytonaSnapshot>;
  /** Returns an `inactive` snapshot to service. */
  activate(snapshot: DaytonaSnapshot): Promise<DaytonaSnapshot>;
  delete(snapshot: DaytonaSnapshot): Promise<void>;
}

/** Daytona rejected the credentials; retrying with the same API key cannot succeed. */
export class DaytonaSnapshotAuthError extends Error {
  override readonly name = 'DaytonaSnapshotAuthError';

  constructor(options: { cause: unknown }) {
    super('Daytona rejected the API key', options);
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** Reads the response status off an axios-style rejection without widening its type. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const { response } = error;
  if (typeof response !== 'object' || response === null || !('status' in response)) {
    return undefined;
  }
  const { status } = response;
  return typeof status === 'number' ? status : undefined;
}

/** Reads Daytona's own explanation out of an error envelope, when it sent one. */
function daytonaMessageOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const { response } = error;
  if (typeof response !== 'object' || response === null || !('data' in response)) {
    return undefined;
  }
  const { data } = response;
  if (typeof data !== 'object' || data === null || !('message' in data)) {
    return undefined;
  }
  const { message } = data;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

function toSnapshot(dto: SnapshotDto): DaytonaSnapshot {
  return {
    id: dto.id,
    name: dto.name,
    imageName: dto.imageName,
    state: dto.state,
    errorReason: dto.errorReason,
  };
}

export interface DaytonaSnapshotsOptions {
  apiKey: string;
  /** Daytona API base URL, e.g. `https://app.daytona.io/api`. */
  apiUrl: string;
}

/**
 * Every call here is a fast metadata request — the image pull happens after
 * `initiateCreate` returns — and hosts make them while starting a turn, so a
 * connection Daytona never answers has to fail rather than hold the turn open.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export class DaytonaSnapshots implements IDaytonaSnapshots {
  private readonly snapshotsApi: SnapshotsApi;

  constructor(options: DaytonaSnapshotsOptions) {
    this.snapshotsApi = new SnapshotsApi(
      new Configuration({
        basePath: options.apiUrl,
        baseOptions: {
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'X-Daytona-Source': 'truefoundry-harness',
          },
        },
      }),
    );
  }

  async get(name: string): Promise<DaytonaSnapshot | undefined> {
    try {
      const response = await this.snapshotsApi.getSnapshot(name);
      return toSnapshot(response.data);
    } catch (error) {
      const status = httpStatusOf(error);
      if (status === HTTP_NOT_FOUND) return undefined;
      throw this.translate(error);
    }
  }

  async initiateCreate(params: CreateDaytonaSnapshotParams): Promise<DaytonaSnapshot> {
    const request: CreateSnapshot = {
      name: params.name,
      imageName: params.imageName,
      ...(params.entrypoint ? { entrypoint: [...params.entrypoint] } : {}),
      ...(params.resources
        ? { cpu: params.resources.cpu, memory: params.resources.memoryGb, disk: params.resources.diskGb }
        : {}),
    };
    try {
      const response = await this.snapshotsApi.createSnapshot(request);
      return toSnapshot(response.data);
    } catch (error) {
      if (httpStatusOf(error) === HTTP_CONFLICT) {
        // Another replica (or an earlier request) registered this name first. Its
        // snapshot is the one that matters, so adopt it instead of failing.
        const existing = await this.get(params.name);
        if (existing !== undefined) return existing;
      }
      throw this.translate(error);
    }
  }

  async activate(snapshot: DaytonaSnapshot): Promise<DaytonaSnapshot> {
    try {
      const response = await this.snapshotsApi.activateSnapshot(snapshot.id);
      return toSnapshot(response.data);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async delete(snapshot: DaytonaSnapshot): Promise<void> {
    try {
      await this.snapshotsApi.removeSnapshot(snapshot.id);
    } catch (error) {
      // Already gone is the state the caller wanted.
      if (httpStatusOf(error) === HTTP_NOT_FOUND) return;
      throw this.translate(error);
    }
  }

  private translate(error: unknown): Error {
    const status = httpStatusOf(error);
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      return new DaytonaSnapshotAuthError({ cause: error });
    }
    // Rejections name a fixable cause ("Images with tag \":latest\" are not allowed"),
    // and an axios message is only the status code, so the body has to reach the log.
    const explanation = daytonaMessageOf(error);
    if (status !== undefined && explanation !== undefined) {
      return new Error(`Daytona rejected the snapshot request (${String(status)}): ${explanation}`, { cause: error });
    }
    if (error instanceof Error) return error;
    return new Error('Daytona snapshot request failed', { cause: error });
  }
}
