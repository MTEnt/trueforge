import { OpenAPIHono } from '@hono/zod-openapi';
import type { IDaytonaSnapshots } from '@truefoundry/utils-core/core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Configuration } from 'openid-client';
import { createCapabilitiesRouter } from '../../../src/apis/capabilities';
import { authMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth, enableOidcAuth, initOidc } from '../../../src/auth/oidc';
import type { OIDCConfig } from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import type { SandboxProviderManifest } from '../../../src/schemas/sandboxProvider';
import type { SandboxSnapshotSyncState } from '../../../src/schemas/sandboxSnapshot';
import {
  createTestSandboxSnapshotSync,
  readySandboxSnapshotSync,
  testSandboxDigest,
  testSandboxImage,
  testSandboxSnapshotName,
  testSandboxSnapshotSpec,
} from '../support/sandboxSnapshotSync';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'harness-client';

const OIDC_CONFIG: OIDCConfig = {
  OIDC_ISSUER_URL: `${ISSUER}/`,
  OIDC_CLIENT_ID: AUDIENCE,
  OIDC_CLIENT_SECRET: 'harness-secret',
  OIDC_USER_REFERENCE_CLAIM: 'sub',
  OIDC_USER_ROLE_CLAIM: 'groups',
  OIDC_ADMIN_ROLE_VALUE: 'admin',
  OIDC_SCOPES: ['openid', 'profile', 'email', 'groups'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withAuth(router: OpenAPIHono): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', authMiddleware);
  shell.route('/', router);
  return shell;
}

const config: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const syncBase = {
  desired_image: testSandboxSnapshotSpec.docker_image,
  active: undefined,
  pending: undefined,
  error_message: undefined,
  superseded: [],
  updated_at: new Date().toISOString(),
};
const syncingSync: SandboxSnapshotSyncState = {
  ...syncBase,
  pending: { snapshot_name: testSandboxSnapshotName, image: testSandboxImage, digest: testSandboxDigest },
};
const failedSync: SandboxSnapshotSyncState = { ...syncBase, error_message: 'manifest unknown' };

/** Capabilities must answer from persisted state, so this double fails loudly if used. */
const unusableSnapshots: IDaytonaSnapshots = {
  get: () => Promise.reject(new Error('capabilities must not call Daytona')),
  initiateCreate: () => Promise.reject(new Error('capabilities must not call Daytona')),
  activate: () => Promise.reject(new Error('capabilities must not call Daytona')),
  delete: () => Promise.reject(new Error('capabilities must not call Daytona')),
};

describe('capabilities router', () => {
  let store: ISandboxProviderStore;
  let router: ReturnType<typeof withAuth>;
  let db: ReturnType<typeof createSqliteDb>;

  beforeEach(async () => {
    disableOidcAuth();
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    store = new SqliteSandboxProviderStore(db);
    router = withAuth(
      createCapabilitiesRouter({
        sandboxProviderStore: store,
        sandboxSnapshotSync: createTestSandboxSnapshotSync({ store, snapshots: unusableSnapshots }),
        withTransaction: callback => db.transaction().execute(callback),
      }),
    );
  });

  it('disables sandbox and skills when no provider is configured', async () => {
    const response = await router.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'No sandbox provider is configured.' },
        skill: {
          enabled: false,
          reason: 'Skills run in a sandbox, which is unavailable. No sandbox provider is configured.',
        },
        settings: { enabled: true },
      },
    });
  });

  it('enables sandbox and skills once the snapshot is ready', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: readySandboxSnapshotSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
      },
    });
  });

  it('keeps sandbox disabled while the first image is still being prepared', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: syncingSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'The sandbox image is still being prepared in Daytona.' },
        skill: {
          enabled: false,
          reason:
            'Skills run in a sandbox, which is unavailable. The sandbox image is still being prepared in Daytona.',
        },
        settings: { enabled: true },
      },
    });
  });

  it('reports the sync failure as the reason sandbox is unavailable', async () => {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: { ...config, snapshot_sync: failedSync },
    });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'manifest unknown' },
        skill: { enabled: false, reason: 'Skills run in a sandbox, which is unavailable. manifest unknown' },
        settings: { enabled: true },
      },
    });
  });

  it('disables sandbox for a configured provider that has never synced', async () => {
    await store.upsertSandboxProvider({ tenant_id: 'default', manifest: config });

    const response = await router.request('/');

    expect(await response.json()).toEqual({
      data: {
        sandbox: { enabled: false, reason: 'The sandbox image has not been synced to Daytona yet.' },
        skill: {
          enabled: false,
          reason:
            'Skills run in a sandbox, which is unavailable. The sandbox image has not been synced to Daytona yet.',
        },
        settings: { enabled: true },
      },
    });
  });

  describe('when auth is enabled', () => {
    const realFetch = globalThis.fetch;
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    let oidcClient: Configuration;

    beforeAll(async () => {
      const keyPair = await generateKeyPair('RS256');
      privateKey = keyPair.privateKey;
      const publicJwk = await exportJWK(keyPair.publicKey);
      publicJwk.kid = 'test-kid';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';

      globalThis.fetch = async input => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          });
        }
        if (url === `${ISSUER}/jwks`) {
          return json({ keys: [publicJwk] });
        }
        return new Response(`unexpected url: ${url}`, { status: 404 });
      };

      const client = await initOidc(OIDC_CONFIG);
      if (!client) {
        throw new Error('OIDC client was not initialized');
      }
      oidcClient = client;
    });

    afterAll(() => {
      globalThis.fetch = realFetch;
      disableOidcAuth();
    });

    beforeEach(() => {
      enableOidcAuth({ client: oidcClient, oidcConfig: OIDC_CONFIG });
    });

    async function createIdToken(groups: string[]): Promise<string> {
      return new SignJWT({ groups })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    it('marks settings enabled for admin callers and disabled for non-admin callers', async () => {
      const authDb = createSqliteDb(':memory:');
      await migrateSqliteToLatest(authDb);
      const authStore = new SqliteSandboxProviderStore(authDb);
      const authRouter = withAuth(
        createCapabilitiesRouter({
          sandboxProviderStore: authStore,
          sandboxSnapshotSync: createTestSandboxSnapshotSync({ store: authStore, snapshots: unusableSnapshots }),
          withTransaction: callback => authDb.transaction().execute(callback),
        }),
      );

      const adminRes = await authRouter.request('/', {
        headers: { Cookie: `id_token=${await createIdToken(['admin'])}` },
      });
      expect(adminRes.status).toBe(200);
      expect(await adminRes.json()).toEqual({
        data: {
          sandbox: { enabled: false, reason: 'No sandbox provider is configured.' },
          skill: {
            enabled: false,
            reason: 'Skills run in a sandbox, which is unavailable. No sandbox provider is configured.',
          },
          settings: { enabled: true },
        },
      });

      const userRes = await authRouter.request('/', {
        headers: { Cookie: `id_token=${await createIdToken(['everyone'])}` },
      });
      expect(userRes.status).toBe(200);
      expect(await userRes.json()).toEqual({
        data: {
          sandbox: { enabled: false, reason: 'No sandbox provider is configured.' },
          skill: {
            enabled: false,
            reason: 'Skills run in a sandbox, which is unavailable. No sandbox provider is configured.',
          },
          settings: { enabled: false },
        },
      });
    });
  });
});
