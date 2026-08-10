/**
 * Maps trueforge-ui sandbox-settings calls onto Harness
 * `/api/v1/settings/sandbox-providers` (singleton upsert, no delete).
 *
 * UI: multi-row providers with `id` / `catalogId` / `name` / flat `apiKey`.
 * Harness: one Daytona provider per tenant; catalog YAML has no name — synthetic
 * identity uses `type` (`daytona`) as id/catalogId and display name `Daytona`.
 */
import type {
  SandboxCatalogServer,
  SandboxImageSync,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
} from '@truefoundry/trueforge-ui';
import { TrueForgeApi as Harness } from 'trueforge';
import { harnessClient as client } from './harnessClient';

export type UiSandboxProvider = SandboxProviderBase;
export type UiSandboxProviderCatalogEntry = SandboxProviderCatalogEntry;

const DAYTONA_TYPE = 'daytona';
const DAYTONA_DISPLAY_NAME = 'Daytona';

function displayNameForType(type: string): string {
  if (type === DAYTONA_TYPE) {
    return DAYTONA_DISPLAY_NAME;
  }
  return type;
}

export function configFromHarness(
  provider: Harness.CatalogDaytonaSandboxProvider | Harness.ConfiguredSandboxProvider,
): SandboxProviderConfig {
  return {
    execTimeoutMs: provider.execTimeoutMs,
    autoStopIntervalInMinutes: provider.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: provider.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: provider.autoDeleteIntervalInMinutes,
  };
}

export function toUiCatalogEntry(provider: Harness.CatalogDaytonaSandboxProvider): UiSandboxProviderCatalogEntry {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    type: provider.type,
    ...configFromHarness(provider),
  };
}

/**
 * The Harness snapshot state, reduced to what the settings UI shows. Snapshot names
 * and image digests are deliberately dropped: they are server-derived identifiers,
 * not something a user can act on.
 *
 * An `active` snapshot means sandboxes work, even when a newer image is still being
 * prepared or its preparation failed — Harness keeps serving the one it has.
 */
export function imageSyncFromHarness(snapshotSync: Harness.SandboxSnapshotSync): SandboxImageSync {
  const { active, pending, errorMessage } = snapshotSync;
  if (active !== undefined) {
    return { status: 'ready', errorMessage, isUpdating: pending !== undefined };
  }
  return errorMessage === undefined
    ? { status: 'syncing', errorMessage: undefined, isUpdating: false }
    : { status: 'failed', errorMessage, isUpdating: false };
}

export function toUiSandboxProvider(provider: Harness.ConfiguredSandboxProvider): UiSandboxProvider {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    catalogId: provider.type,
    isConnected: true,
    imageSync: imageSyncFromHarness(provider.snapshotSync),
    ...configFromHarness(provider),
  };
}

export function toHarnessManifest(
  req: {
    type: string;
    apiKey: string;
  } & SandboxProviderConfig,
): Harness.settings.sandboxProviders.DaytonaSandboxProvider {
  if (req.type !== DAYTONA_TYPE) {
    throw new Error(`Unsupported sandbox provider type: ${req.type}`);
  }
  return {
    execTimeoutMs: req.execTimeoutMs,
    autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
    auth: { apiKey: req.apiKey },
  };
}

async function resolveApiKey(apiKey: string | undefined): Promise<string> {
  const trimmed = apiKey?.trim();
  if (trimmed !== undefined && trimmed !== '') {
    return trimmed;
  }
  const existing = await client.settings.sandboxProviders.get();
  return existing.data.auth.apiKey;
}

/** Settings sandbox-catalog port for `createTrueFoundryServer`. Delete omitted (no BE route). */
export function createSandboxProviderCatalog(): SandboxCatalogServer {
  return {
    getSandboxProviderCatalog: async () => {
      const body = await client.settings.sandboxProviders.catalog();
      return body.data.map(toUiCatalogEntry);
    },
    listSandboxProviders: async req => {
      let providers: UiSandboxProvider[];
      try {
        const body = await client.settings.sandboxProviders.get();
        providers = [toUiSandboxProvider(body.data)];
      } catch (err) {
        if (err instanceof Harness.NotFoundError) {
          providers = [];
        } else {
          throw err;
        }
      }
      const query = req?.query?.trim().toLowerCase();
      if (query === undefined || query === '') {
        return providers;
      }
      return providers.filter(
        provider => provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query),
      );
    },
    createSandboxProvider: async req => {
      const body = await client.settings.sandboxProviders.upsert(
        toHarnessManifest({
          type: req.type,
          apiKey: req.apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      );
      return toUiSandboxProvider(body.data);
    },
    updateSandboxProvider: async req => {
      const apiKey = await resolveApiKey(req.apiKey);
      const body = await client.settings.sandboxProviders.upsert(
        toHarnessManifest({
          type: DAYTONA_TYPE,
          apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      );
      return toUiSandboxProvider(body.data);
    },
  };
}
