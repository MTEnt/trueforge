/**
 * Shipped sandbox catalog (sandbox-catalog.yaml): the server-owned snapshot spec
 * plus the discovery list of provider presets the settings UI copies into
 * PUT /settings/sandbox-providers bodies. Presets are never consulted on writes.
 *
 * The snapshot spec, unlike the presets, *is* authoritative: snapshot sync and
 * the runtime both read it, so an invalid image ref fails catalog load at boot.
 *
 * Default: YAML inlined into `sandboxCatalog.gen.ts` at build time. Optional
 * override: `SANDBOX_CATALOG_PATH` (file on disk).
 */
import configuration from '../config';
import { SandboxCatalogFileSchema, type CatalogSandboxProvider } from '../schemas/sandboxCatalog';
import type { SandboxSnapshotSpec } from '../schemas/sandboxSnapshot';
import { loadYamlAtPath, parseYamlString } from './loadYaml';
import { shippedSandboxCatalogYaml } from './sandboxCatalog.gen';

export class SandboxCatalog {
  private readonly providers: readonly CatalogSandboxProvider[];
  private readonly snapshot: SandboxSnapshotSpec;

  constructor({
    providers,
    snapshot,
  }: {
    providers: readonly CatalogSandboxProvider[];
    snapshot: SandboxSnapshotSpec;
  }) {
    this.providers = providers;
    this.snapshot = snapshot;
  }

  /** Loads and validates the catalog. Throws on any error. */
  static load(): SandboxCatalog {
    const file =
      configuration.SANDBOX_CATALOG_PATH !== undefined
        ? loadYamlAtPath(configuration.SANDBOX_CATALOG_PATH, SandboxCatalogFileSchema)
        : parseYamlString(shippedSandboxCatalogYaml, SandboxCatalogFileSchema, 'shipped sandbox-catalog');
    return new SandboxCatalog({ providers: file.providers, snapshot: file.sandbox_snapshot });
  }

  list(): readonly CatalogSandboxProvider[] {
    return this.providers;
  }

  /** The sandbox definition snapshot sync provisions in each tenant's Daytona account. */
  snapshotSpec(): SandboxSnapshotSpec {
    return this.snapshot;
  }
}
