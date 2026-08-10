import { AgentSpecSchema } from '@truefoundry/utils-core/agent-session';
import type { DaytonaSnapshot, IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import { HTTPException } from 'hono/http-exception';
import winston from 'winston';
import { TENANT_ID } from '../../../src/apis/sessions';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { resolveSandboxProvider, validateAgentSpec } from '../../../src/runtime/sessionResources';
import { SandboxSnapshotSyncService } from '../../../src/sandbox/SandboxSnapshotSyncService';
import { deriveSandboxSnapshotName } from '../../../src/sandbox/snapshotName';
import type { ReasoningEffort } from '../../../src/schemas/modelProvider';
import type { SandboxProviderManifest } from '../../../src/schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../../../src/schemas/sandboxSnapshot';
import { imagesResolvingTo, testSandboxDigest, testSandboxImage } from '../support/sandboxSnapshotSync';

const catalog = SandboxCatalog.load();
const SPEC = catalog.snapshotSpec();
const SNAPSHOT_NAME = deriveSandboxSnapshotName({ spec: SPEC, digest: testSandboxDigest });

const sandboxConfig: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const snapshotRef = { snapshot_name: SNAPSHOT_NAME, image: testSandboxImage, digest: testSandboxDigest };
const syncBase = {
  desired_image: SPEC.docker_image,
  active: undefined,
  pending: undefined,
  error_message: undefined,
  superseded: [],
  updated_at: new Date().toISOString(),
};
const readySync: SandboxSnapshotSyncState = { ...syncBase, active: snapshotRef };
const syncingSync: SandboxSnapshotSyncState = { ...syncBase, pending: snapshotRef };
const failedSync: SandboxSnapshotSyncState = { ...syncBase, error_message: 'manifest unknown' };

function activeSnapshot(): DaytonaSnapshot {
  return { id: 'snap-1', name: SNAPSHOT_NAME, imageName: testSandboxImage, state: 'active', errorReason: null };
}

/** Answers `get` with a fixed snapshot; the reconciler needs nothing else here. */
function snapshotsReturning(result: DaytonaSnapshot | undefined): IDaytonaSnapshots {
  return {
    get: () => Promise.resolve(result),
    initiateCreate: () => Promise.resolve({ ...activeSnapshot(), state: 'pending' }),
    activate: () => Promise.resolve(activeSnapshot()),
    delete: () => Promise.resolve(),
  };
}

describe('validateAgentSpec', () => {
  async function setup(options?: { reasoningEfforts?: ReasoningEffort[] | undefined }) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      manifest: {
        // Caller-named, so `custom` is the only type it can be.
        type: 'custom',
        name: 'test-provider',
        base_url: 'https://llm.test.example.com/v1',
        auth: { api_key: 'sk-test' },
        models: [
          {
            model_id: 'test-model',
            name: 'test-model',
            properties: {
              context_length: 128000,
              max_output_tokens: 4096,
              ...(options?.reasoningEfforts !== undefined ? { reasoning_efforts: options.reasoningEfforts } : {}),
            },
          },
        ],
      },
    });
    const sandboxProviderStore = new SqliteSandboxProviderStore(db);
    return {
      modelProviderStore,
      mcpServerStore: new SqliteMcpServerStore(db),
      skillStore: new SqliteSkillStore(db),
      sandboxProviderStore,
      snapshotSync: new SandboxSnapshotSyncService({
        store: sandboxProviderStore,
        catalog,
        createSnapshots: () => snapshotsReturning(activeSnapshot()),
        images: imagesResolvingTo(),
        logger: winston.createLogger({ silent: true }),
      }),
    };
  }

  it('rejects malformed model FQN with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'not-a-fqn' },
          instructions: 'test',
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('fully qualified "provider/model"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'missing-provider/test-model' },
          instructions: 'test',
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('provider not configured'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model on provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/missing-model' },
          instructions: 'test',
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('not configured on provider'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unsupported reasoning effort with 422', async () => {
    const stores = await setup({ reasoningEfforts: ['low', 'high'] });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model', params: { reasoning_effort: 'medium' } },
          instructions: 'test',
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Reasoning effort "medium"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown MCP server with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          mcp_servers: [{ name: 'missing-mcp' }],
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown MCP server "missing-mcp"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown skill with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'missing-skill' }],
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown skill "missing-skill"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects sandbox.enabled when no sandbox provider is configured', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('PUT /settings/sandbox-providers'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects skills when no sandbox provider is configured', async () => {
    const stores = await setup();
    await stores.skillStore.upsertSkill({
      tenant_id: TENANT_ID,
      name: 'demo',
      manifest: {
        type: 'git',
        name: 'demo',
        url: 'https://github.com/example/skills',
        ref: 'main',
        description: 'demo skill',
      },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require a sandbox provider'),
    } satisfies Partial<HTTPException>);
  });

  it('admits sandbox.enabled once the snapshot is synced', async () => {
    const stores = await setup();
    await stores.sandboxProviderStore.upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: { ...sandboxConfig, snapshot_sync: readySync },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['the first snapshot is still being prepared', syncingSync, 'not ready in Daytona yet'],
    ['the snapshot sync failed', failedSync, 'could not be prepared'],
    ['the provider has never synced', undefined, 'not ready in Daytona yet'],
  ])('rejects sandbox.enabled with 422 when %s', async (_case, snapshotSync, expectedMessage) => {
    const stores = await setup();
    await stores.sandboxProviderStore.upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: { ...sandboxConfig, snapshot_sync: snapshotSync },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: TENANT_ID,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(expectedMessage),
    } satisfies Partial<HTTPException>);
  });
});

describe('resolveSandboxProvider', () => {
  async function setup(snapshots: IDaytonaSnapshots) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteSandboxProviderStore(db);
    const snapshotSync = new SandboxSnapshotSyncService({
      store,
      catalog,
      createSnapshots: () => snapshots,
      images: imagesResolvingTo(),
      logger: winston.createLogger({ silent: true }),
    });
    return { store, snapshotSync, logger: winston.createLogger({ silent: true }) };
  }

  it('returns undefined when no provider is configured', async () => {
    const { snapshotSync, logger } = await setup(snapshotsReturning(activeSnapshot()));

    await expect(resolveSandboxProvider({ tenant_id: TENANT_ID, snapshotSync, logger })).resolves.toBeUndefined();
  });

  it('builds a provider once Daytona holds the snapshot', async () => {
    const { store, snapshotSync, logger } = await setup(snapshotsReturning(activeSnapshot()));
    await store.upsertSandboxProvider({ tenant_id: TENANT_ID, manifest: sandboxConfig });

    await expect(resolveSandboxProvider({ tenant_id: TENANT_ID, snapshotSync, logger })).resolves.toBeDefined();
  });

  it('reconciles at turn start, so a sync nobody polled still reaches ready', async () => {
    const { store, snapshotSync, logger } = await setup(snapshotsReturning(activeSnapshot()));
    await store.upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: { ...sandboxConfig, snapshot_sync: { ...syncingSync, updated_at: '2020-01-01T00:00:00.000Z' } },
    });

    await expect(resolveSandboxProvider({ tenant_id: TENANT_ID, snapshotSync, logger })).resolves.toBeDefined();
    expect((await store.getSandboxProvider(TENANT_ID))?.manifest.snapshot_sync?.active).toEqual(snapshotRef);
  });

  it('refuses to start a turn while the snapshot is still being pulled', async () => {
    const pulling: DaytonaSnapshot = { ...activeSnapshot(), state: 'pulling' };
    const { store, snapshotSync, logger } = await setup(snapshotsReturning(pulling));
    await store.upsertSandboxProvider({ tenant_id: TENANT_ID, manifest: sandboxConfig });

    await expect(resolveSandboxProvider({ tenant_id: TENANT_ID, snapshotSync, logger })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Retry once it is ready'),
    } satisfies Partial<HTTPException>);
  });

  it('reports the Daytona failure reason instead of failing inside the turn', async () => {
    const broken: DaytonaSnapshot = { ...activeSnapshot(), state: 'error', errorReason: 'manifest unknown' };
    const { store, snapshotSync, logger } = await setup(snapshotsReturning(broken));
    await store.upsertSandboxProvider({ tenant_id: TENANT_ID, manifest: sandboxConfig });

    await expect(resolveSandboxProvider({ tenant_id: TENANT_ID, snapshotSync, logger })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('manifest unknown'),
    } satisfies Partial<HTTPException>);
  });
});
