import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { randomBytes } from 'node:crypto';

const REDIRECT_URL = 'http://localhost:8080/callback';

/** Probe the MCP endpoint unauthenticated to get WWW-Authenticate (resource_metadata, scope). */
async function probeMcpChallenge(mcpUrl: string): Promise<{
  resourceMetadataUrl: URL | undefined;
  scope: string | undefined;
}> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'harness-dcr-sample', version: '0.0.0' },
      },
    }),
  });

  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  console.log('challenge_status:', response.status);
  console.log('challenge_resource_metadata:', resourceMetadataUrl?.toString() ?? '(none)');
  console.log('challenge_scope:', scope ?? '(none)');
  return { resourceMetadataUrl, scope };
}

async function main(): Promise<void> {
  const mcpUrl = process.argv[2];
  if (!mcpUrl) {
    console.error('Usage: pnpm get-dcr-registration-url <mcp-server-url>');
    process.exit(1);
  }

  const { resourceMetadataUrl, scope: challengeScope } = await probeMcpChallenge(mcpUrl);

  const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } = await discoverOAuthServerInfo(
    mcpUrl,
    { resourceMetadataUrl },
  );
  const registrationEndpoint = authorizationServerMetadata?.registration_endpoint;
  if (!registrationEndpoint) {
    console.error('No registration_endpoint found for', mcpUrl);
    process.exit(1);
  }

  // SEP-835: WWW-Authenticate scope → PRM scopes_supported → AS scopes_supported
  const scopesSupported = resourceMetadata?.scopes_supported ?? authorizationServerMetadata?.scopes_supported ?? [];
  const scope = challengeScope ?? (scopesSupported.length > 0 ? scopesSupported.join(' ') : undefined);
  const state = randomBytes(32).toString('hex');
  const resource = resourceMetadata?.resource ? new URL(resourceMetadata.resource) : new URL(mcpUrl);

  console.log('registration_endpoint:', registrationEndpoint);
  console.log('scopes_supported:', scopesSupported.length > 0 ? scopesSupported.join(', ') : '(none)');
  console.log('resolved_scope:', scope ?? '(none)');

  const client = await registerClient(authorizationServerUrl, {
    metadata: authorizationServerMetadata,
    clientMetadata: {
      client_name: 'harness-dcr-sample',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope !== undefined ? { scope } : {}),
    },
  });

  console.log('registered client:');
  console.log(JSON.stringify(client, null, 2));

  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    metadata: authorizationServerMetadata,
    clientInformation: client,
    redirectUrl: REDIRECT_URL,
    resource,
    scope,
    state,
  });

  console.log('authorization_url:', authorizationUrl.toString());
  console.log('code_verifier:', codeVerifier);
  console.log('state:', state);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
