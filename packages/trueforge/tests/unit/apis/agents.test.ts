import { createAgentsRouter } from '../../../src/apis/agents';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';

const modelProvider = {
  type: 'anthropic' as const,
  base_url: 'https://api.anthropic.com/v1',
  auth: { api_key: 'sk-ant-secret' },
  models: [
    {
      model_id: 'claude-sonnet-4-6',
      name: 'claude-sonnet-4-6',
      properties: { context_length: 200000, max_output_tokens: 32768 },
    },
  ],
};

const manifest = {
  model: { name: 'anthropic/claude-sonnet-4-6' },
  instructions: 'Be helpful.',
};

const writeBody = {
  name: 'research',
  manifest,
};

const updateBody = {
  manifest: {
    model: { name: 'anthropic/claude-sonnet-4-6' },
    instructions: 'Updated instructions.',
  },
};

type WireAgent = {
  id: string;
  name: string;
  manifest: { model: { name: string }; instructions?: string };
};

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('agents router', () => {
  let router: ReturnType<typeof createAgentsRouter>;

  beforeAll(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({ tenant_id: 'default', name: 'anthropic', manifest: modelProvider });
    router = createAgentsRouter({
      agentStore: new SqliteAgentStore(db),
      modelProviderStore,
      mcpServerStore: new SqliteMcpServerStore(db),
      skillStore: new SqliteSkillStore(db),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      withTransaction: callback => db.transaction().execute(callback),
    });
  });

  it('POST returns a wrapped Agent; PUT by name keeps the same id', async () => {
    const created = await router.request('/', jsonInit('POST', writeBody));
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { data: WireAgent };
    expect(createdJson.data.id.length).toBeGreaterThan(0);
    expect(createdJson.data).toMatchObject({
      name: 'research',
      manifest: {
        model: { name: 'anthropic/claude-sonnet-4-6' },
        instructions: 'Be helpful.',
      },
    });

    const updated = await router.request('/', jsonInit('PUT', { name: 'research', ...updateBody }));
    expect(updated.status).toBe(200);
    const updatedJson = (await updated.json()) as { data: WireAgent };
    expect(updatedJson.data.id).toBe(createdJson.data.id);
    expect(updatedJson.data.name).toBe('research');
    expect(updatedJson.data.manifest.instructions).toBe('Updated instructions.');
  });

  it('GET returns 404 for unknown names; PUT creates when missing', async () => {
    const get = await router.request('/missing-agent');
    expect(get.status).toBe(404);

    const put = await router.request('/', jsonInit('PUT', { name: 'created-by-put', manifest }));
    expect(put.status).toBe(200);
    const putJson = (await put.json()) as { data: WireAgent };
    expect(putJson.data.name).toBe('created-by-put');
    expect(putJson.data.id.length).toBeGreaterThan(0);

    const fetched = await router.request('/created-by-put');
    expect(fetched.status).toBe(200);
    const fetchedJson = (await fetched.json()) as { data: WireAgent };
    expect(fetchedJson.data.id).toBe(putJson.data.id);
  });

  it('DELETE removes an agent by name and is idempotent', async () => {
    const created = await router.request('/', jsonInit('POST', { ...writeBody, name: 'deletable' }));
    expect(created.status).toBe(201);

    const deleted = await router.request('/deletable', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});

    expect((await router.request('/deletable')).status).toBe(404);
    const deletedAgain = await router.request('/deletable', { method: 'DELETE' });
    expect(deletedAgain.status).toBe(200);
    expect(await deletedAgain.json()).toEqual({});
  });

  it('POST rejects invalid bodies, unknown models, and duplicate names', async () => {
    const badName = await router.request('/', jsonInit('POST', { ...writeBody, name: 'Not A Name' }));
    expect(badName.status).toBe(400);

    const unknownModel = await router.request(
      '/',
      jsonInit('POST', {
        name: 'other',
        manifest: { ...manifest, model: { name: 'missing/model' } },
      }),
    );
    expect(unknownModel.status).toBe(422);

    const first = await router.request('/', jsonInit('POST', { ...writeBody, name: 'alpha' }));
    expect(first.status).toBe(201);

    const clash = await router.request('/', jsonInit('POST', { ...writeBody, name: 'alpha' }));
    expect(clash.status).toBe(409);
  });
});
