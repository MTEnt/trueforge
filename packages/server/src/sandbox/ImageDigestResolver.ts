/**
 * Resolves a container image reference to the digest it currently points at, which is
 * what lets the sandbox image track a moving tag: a Daytona snapshot is built once and
 * then frozen, so resolving the tag ourselves turns "the tag moved" into "the digest
 * changed", and the snapshot name is derived from that.
 *
 * Speaks the OCI distribution API directly rather than adding a registry client: the
 * protocol needed is one manifest request plus a bearer-token challenge.
 */
import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { isDigest, parseImageReference, type ParsedImageReference } from './imageReference';

/**
 * Manifest types we accept, index types first so multi-arch tags resolve to the index
 * digest. The `vnd.docker.*` types are the registry protocol rather than anything to do
 * with Docker Hub, and Artifactory answers with them for images pushed in that format.
 */
const MANIFEST_MEDIA_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
] as const;

const ACCEPT_MANIFESTS = MANIFEST_MEDIA_TYPES.join(', ');
const MANIFEST_MEDIA_TYPE_SET: ReadonlySet<string> = new Set(MANIFEST_MEDIA_TYPES);

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface IImageDigestResolver {
  /**
   * Resolves a reference to the manifest digest it points at right now.
   * Throws `ImageResolutionError` when it cannot be resolved.
   */
  resolve(reference: string): Promise<string>;
}

export class ImageResolutionError extends Error {
  override readonly name = 'ImageResolutionError';
}

/** Basic-auth credentials for a private registry. */
export interface RegistryCredentials {
  username: string;
  password: string;
}

/** Injected so tests can drive the protocol without a network. */
export type FetchLike = typeof globalThis.fetch;

/** Registries answer the token request with either spelling. */
const TokenResponseSchema = z.object({
  token: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
});

export class RegistryImageDigestResolver implements IImageDigestResolver {
  private readonly credentials: RegistryCredentials | undefined;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    options: {
      credentials?: RegistryCredentials | undefined;
      fetch?: FetchLike | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ) {
    this.credentials = options.credentials;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async resolve(reference: string): Promise<string> {
    const parsed = parseImageReference(reference);
    if (parsed === undefined) {
      throw new ImageResolutionError(`"${reference}" is not a valid container image reference`);
    }
    if (parsed.digest !== undefined) {
      // Already pinned: the caller told us exactly which image it wants.
      return parsed.digest;
    }
    if (parsed.tag === undefined) {
      throw new ImageResolutionError(`"${reference}" carries neither a tag nor a digest`);
    }

    // Always HTTPS: a plaintext registry would put both the credentials and the
    // digest the sandbox is built from on the wire for anyone to rewrite.
    const url = `https://${parsed.registry}/v2/${parsed.repository}/manifests/${parsed.tag}`;
    const unauthenticated = await this.send({ url, headers: manifestHeaders() });
    const response =
      unauthenticated.status === HTTP_UNAUTHORIZED
        ? await this.retryAuthenticated({ url, parsed, challenged: unauthenticated })
        : unauthenticated;

    if (!response.ok) {
      const detail = response.status === HTTP_NOT_FOUND ? ': no image is published under that tag' : '';
      throw new ImageResolutionError(
        `${parsed.registry} answered ${String(response.status)} for ${parsed.repository}:${parsed.tag}${detail}`,
      );
    }

    return readManifestDigest({ response, parsed });
  }

  /**
   * Reads the whole response before returning it. Even bodies we never look at have to
   * be drained: an unread one holds its connection open until the collector gets to it.
   */
  private async send({ url, headers }: { url: string; headers: Record<string, string> }): Promise<RegistryResponse> {
    try {
      const response = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      throw new ImageResolutionError(`could not reach ${url}: ${messageOf(error)}`, { cause: error });
    }
  }

  /**
   * Answers a `WWW-Authenticate` challenge and asks again. Anonymous pulls come through
   * here too: a public Artifactory repository still answers 401 first, then hands a
   * scoped token to anyone who asks.
   */
  private async retryAuthenticated({
    url,
    parsed,
    challenged,
  }: {
    url: string;
    parsed: ParsedImageReference;
    challenged: RegistryResponse;
  }): Promise<RegistryResponse> {
    const challenge = challenged.headers.get('www-authenticate');
    if (challenge === null) {
      throw new ImageResolutionError(`${parsed.registry} requires authentication but sent no challenge`);
    }
    // Self-hosted registries often sit behind plain Basic auth with no token endpoint.
    const authorization = challenge.toLowerCase().startsWith('basic ')
      ? this.basicAuthorization(parsed)
      : `Bearer ${await this.fetchPullToken({ challenge, parsed })}`;
    return await this.send({ url, headers: { ...manifestHeaders(), Authorization: authorization } });
  }

  private async fetchPullToken({
    challenge,
    parsed,
  }: {
    challenge: string;
    parsed: ParsedImageReference;
  }): Promise<string> {
    const params = parseBearerChallenge(challenge);
    const realm = params.realm;
    if (realm === undefined) {
      throw new ImageResolutionError(`${parsed.registry} sent an authentication challenge without a realm`);
    }
    let tokenUrl: URL;
    try {
      tokenUrl = new URL(realm);
    } catch (error) {
      throw new ImageResolutionError(`${parsed.registry} sent an unusable token realm "${realm}"`, { cause: error });
    }
    if (params.service !== undefined) {
      tokenUrl.searchParams.set('service', params.service);
    }
    tokenUrl.searchParams.set('scope', params.scope ?? `repository:${parsed.repository}:pull`);

    // The realm is the registry's choice of host, and need not be the one holding the
    // image, so credentials only travel to it over TLS.
    const authenticate = this.credentials !== undefined && tokenUrl.protocol === 'https:';
    const tokenResponse = await this.send({
      url: tokenUrl.toString(),
      headers: authenticate ? { Authorization: this.basicAuthorization(parsed) } : {},
    });
    if (!tokenResponse.ok) {
      throw new ImageResolutionError(refusedTokenMessage({ parsed, status: tokenResponse.status, authenticate }));
    }

    const parsedBody = TokenResponseSchema.safeParse(readJson(tokenResponse));
    const token = parsedBody.success ? (parsedBody.data.token ?? parsedBody.data.access_token) : undefined;
    if (token === undefined) {
      throw new ImageResolutionError(`${parsed.registry} returned no pull token for ${parsed.repository}`);
    }
    return token;
  }

  private basicAuthorization(parsed: ParsedImageReference): string {
    const credentials = this.credentials;
    if (credentials === undefined) {
      throw new ImageResolutionError(
        `${parsed.registry} requires credentials to read ${parsed.repository}; set SANDBOX_IMAGE_REGISTRY_USERNAME and SANDBOX_IMAGE_REGISTRY_PASSWORD`,
      );
    }
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }
}

/**
 * A registry refusing to talk about an image will not say whether it is private or
 * simply absent, so the message names both and what to do about the fixable one.
 */
function refusedTokenMessage({
  parsed,
  status,
  authenticate,
}: {
  parsed: ParsedImageReference;
  status: number;
  authenticate: boolean;
}): string {
  if (status !== HTTP_UNAUTHORIZED && status !== HTTP_FORBIDDEN) {
    return `${parsed.registry} refused a pull token for ${parsed.repository} (${String(status)})`;
  }
  return authenticate
    ? `${parsed.registry} rejected the configured registry credentials for ${parsed.repository}`
    : `${parsed.registry} would not issue a pull token for ${parsed.repository}: the image is private or does not exist. Set SANDBOX_IMAGE_REGISTRY_USERNAME and SANDBOX_IMAGE_REGISTRY_PASSWORD if it is private.`;
}

/** A registry response, read into memory so no connection is left dangling. */
interface RegistryResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
}

function manifestHeaders(): Record<string, string> {
  return { Accept: ACCEPT_MANIFESTS };
}

/**
 * Caches resolutions for `ttlMs` and collapses concurrent lookups, so any number of
 * tenants costs one registry request per interval. Failures are not cached.
 */
export class CachedImageDigestResolver implements IImageDigestResolver {
  private readonly resolver: IImageDigestResolver;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { digest: string; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(deps: { resolver: IImageDigestResolver; ttlMs: number; now?: () => number }) {
    this.resolver = deps.resolver;
    this.ttlMs = deps.ttlMs;
    this.now = deps.now ?? Date.now;
  }

  async resolve(reference: string): Promise<string> {
    const cached = this.cache.get(reference);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.digest;
    }
    const pending = this.inFlight.get(reference);
    if (pending !== undefined) {
      return await pending;
    }
    const lookup = this.resolver
      .resolve(reference)
      .then(digest => {
        this.cache.set(reference, { digest, expiresAt: this.now() + this.ttlMs });
        return digest;
      })
      .finally(() => {
        this.inFlight.delete(reference);
      });
    this.inFlight.set(reference, lookup);
    return await lookup;
  }
}

/**
 * Prefers the registry's digest header, falling back to hashing the manifest bytes, which
 * is how the digest is defined when a registry omits it. The media type is checked either
 * way: a proxy answering 200 with a sign-in page must not name a snapshot after HTML.
 */
function readManifestDigest({
  response,
  parsed,
}: {
  response: RegistryResponse;
  parsed: ParsedImageReference;
}): string {
  const advertised = response.headers.get('docker-content-digest');
  if (advertised !== null && isDigest(advertised)) {
    return advertised;
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!MANIFEST_MEDIA_TYPE_SET.has(mediaType)) {
    throw new ImageResolutionError(
      `${parsed.registry} answered for ${parsed.repository} with "${mediaType}" instead of an image manifest`,
    );
  }
  return `sha256:${createHash('sha256').update(response.body).digest('hex')}`;
}

function readJson(response: RegistryResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch (error) {
    throw new ImageResolutionError(`registry returned a malformed token response: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"`. */
interface BearerChallenge {
  realm: string | undefined;
  service: string | undefined;
  scope: string | undefined;
}

function parseBearerChallenge(challenge: string): BearerChallenge {
  const params: BearerChallenge = { realm: undefined, service: undefined, scope: undefined };
  for (const [, key, value] of challenge.matchAll(/(\w+)="([^"]*)"/g)) {
    if (key === 'realm') params.realm = value;
    if (key === 'service') params.service = value;
    if (key === 'scope') params.scope = value;
  }
  return params;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
