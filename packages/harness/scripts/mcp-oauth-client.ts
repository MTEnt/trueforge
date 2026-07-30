import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';

const REDIRECT_URL = 'http://localhost:8080/callback';

/** Minimal in-memory provider — same shape as the SDK example / default DCR client. */
class InMemoryOAuthClientProvider implements OAuthClientProvider {
  private _clientInformation: OAuthClientInformationMixed | undefined;
  private _tokens: OAuthTokens | undefined;
  private _codeVerifier: string | undefined;
  private _discoveryState: OAuthDiscoveryState | undefined;

  constructor(
    private readonly _redirectUrl: string,
    private readonly _clientMetadata: OAuthClientMetadata,
    private readonly onRedirect: (url: URL) => void,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  state(): string {
    return randomBytes(32).toString('hex');
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInformation = info;
    console.log('registered client:');
    console.log(JSON.stringify(info, null, 2));
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this._codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._discoveryState = state;
    const metadata = state.authorizationServerMetadata;
    const scopes = state.resourceMetadata?.scopes_supported ?? metadata?.scopes_supported ?? [];

    console.log('authorization_server:', state.authorizationServerUrl);
    console.log('resource_metadata_url:', state.resourceMetadataUrl ?? '(none)');
    console.log('resource:', state.resourceMetadata?.resource ?? '(none)');
    console.log('registration_endpoint:', metadata?.registration_endpoint ?? '(none)');
    console.log('authorization_endpoint:', metadata?.authorization_endpoint ?? '(none)');
    console.log('token_endpoint:', metadata?.token_endpoint ?? '(none)');
    console.log('scopes_supported:', scopes.length > 0 ? scopes.join(', ') : '(none)');
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._discoveryState;
  }
}

async function main(): Promise<void> {
  const mcpUrl = process.argv[2];
  if (!mcpUrl) {
    console.error('Usage: pnpm mcp-oauth-client <mcp-server-url>');
    process.exit(1);
  }

  const authProvider = new InMemoryOAuthClientProvider(
    REDIRECT_URL,
    {
      client_name: 'harness-oauth-sample',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    url => {
      console.log('authorization_url:', url.toString());
    },
  );

  const client = new Client({ name: 'harness-oauth-sample', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider });

  try {
    await client.connect(transport);
    console.log('already authorized');
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
    // discovery / registration / authorization_url already printed via provider hooks
  }

  console.log('client_id:', authProvider.clientInformation()?.client_id);
  try {
    console.log('code_verifier:', authProvider.codeVerifier());
  } catch {
    // verifier only exists after startAuthorization ran
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
