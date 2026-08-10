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
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
} from '@truefoundry/trueforge-ui';
import { TrueForgeApi } from 'trueforge-sdk';
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

export function configFromHarness(provider: SandboxProviderConfig): SandboxProviderConfig {
  return {
    execTimeoutMs: provider.execTimeoutMs,
    autoStopIntervalInMinutes: provider.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: provider.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: provider.autoDeleteIntervalInMinutes,
  };
}

export function toUiCatalogEntry(
  provider: SandboxProviderConfig & Pick<TrueForgeApi.CatalogDaytonaSandboxProvider, 'type'>,
): UiSandboxProviderCatalogEntry {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    type: provider.type,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProvider(
  provider: SandboxProviderConfig & Pick<TrueForgeApi.DaytonaSandboxProvider, 'auth' | 'type'>,
): UiSandboxProvider {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    catalogId: provider.type,
    isConnected: true,
    imageSync: {
      status: 'ready',
      errorMessage: undefined,
      isUpdating: false,
    },
    ...configFromHarness(provider),
  };
}

export function toHarnessManifest(
  req: {
    type: string;
    apiKey: string;
  } & SandboxProviderConfig,
) {
  if (req.type !== DAYTONA_TYPE) {
    throw new Error(`Unsupported sandbox provider type: ${req.type}`);
  }
  return {
    type: DAYTONA_TYPE,
    execTimeoutMs: req.execTimeoutMs,
    autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
    auth: { apiKey: req.apiKey },
  };
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
        if (err instanceof TrueForgeApi.NotFoundError) {
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
      const trimmedApiKey = req.apiKey?.trim();
      let apiKey: string;
      if (trimmedApiKey !== undefined && trimmedApiKey !== '') {
        apiKey = trimmedApiKey;
      } else {
        const existing = await client.settings.sandboxProviders.get();
        apiKey = existing.data.auth.apiKey;
      }
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
