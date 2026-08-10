import { createHash } from 'node:crypto';
import {
  CachedImageDigestResolver,
  ImageResolutionError,
  RegistryImageDigestResolver,
  registryApiHost,
  type FetchLike,
  type IImageDigestResolver,
} from '../../../src/sandbox/ImageDigestResolver';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TAG = 'ghcr.io/truefoundry/trueforge-sandbox:latest';
const MANIFEST_URL = 'https://ghcr.io/v2/truefoundry/trueforge-sandbox/manifests/latest';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Answers requests in order, recording what was asked. */
function recordingFetch(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), headers: headersOf(init?.headers) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
    if (next instanceof Error) throw next;
    return await Promise.resolve(next);
  };
  return { fetch, calls };
}

function headersOf(headers: RequestInit['headers']): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers).entries());
}

const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';

function manifest({ digest, body = '{"schemaVersion":2}' }: { digest?: string; body?: string }): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': MANIFEST_MEDIA_TYPE,
      ...(digest === undefined ? {} : { 'docker-content-digest': digest }),
    },
  });
}

function challenge(realm = 'https://ghcr.io/token'): Response {
  return new Response('', {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="${realm}",service="ghcr.io",scope="repository:truefoundry/trueforge-sandbox:pull"`,
    },
  });
}

describe('registryApiHost', () => {
  it('sends Docker Hub catalog refs to registry-1.docker.io', () => {
    expect(registryApiHost('docker.io')).toBe('registry-1.docker.io');
    expect(registryApiHost('index.docker.io')).toBe('registry-1.docker.io');
    expect(registryApiHost('registry.docker.io')).toBe('registry-1.docker.io');
    expect(registryApiHost('ghcr.io')).toBe('ghcr.io');
    expect(registryApiHost('tfy.jfrog.io')).toBe('tfy.jfrog.io');
  });
});

describe('RegistryImageDigestResolver', () => {
  it('resolves a tag to the digest the registry advertises', async () => {
    const { fetch, calls } = recordingFetch([manifest({ digest: DIGEST })]);

    const resolved = await new RegistryImageDigestResolver({ fetch }).resolve(TAG);

    expect(resolved).toBe(DIGEST);
    expect(calls[0]?.url).toBe(MANIFEST_URL);
  });

  it('queries registry-1.docker.io for a docker.io catalog reference', async () => {
    const { fetch, calls } = recordingFetch([
      new Response('', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:truefoundrycloud/truefoundry-utils-core-sandbox:pull"',
        },
      }),
      new Response(JSON.stringify({ token: 'hub-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      manifest({ digest: DIGEST }),
    ]);

    const resolved = await new RegistryImageDigestResolver({ fetch }).resolve(
      'docker.io/truefoundrycloud/truefoundry-utils-core-sandbox:029ea5ff6438cf86b79282e087bfc17528067946',
    );

    expect(resolved).toBe(DIGEST);
    expect(calls[0]?.url).toBe(
      'https://registry-1.docker.io/v2/truefoundrycloud/truefoundry-utils-core-sandbox/manifests/029ea5ff6438cf86b79282e087bfc17528067946',
    );
    expect(calls[1]?.url).toContain('auth.docker.io/token');
    expect(calls[2]?.headers['authorization']).toBe('Bearer hub-token');
  });

  it('asks for index manifests first, so multi-arch tags resolve to the index digest', async () => {
    const { fetch, calls } = recordingFetch([manifest({ digest: DIGEST })]);

    await new RegistryImageDigestResolver({ fetch }).resolve(TAG);

    const accept = calls[0]?.headers['accept'] ?? '';
    expect(accept.indexOf('image.index')).toBeLessThan(accept.indexOf('image.manifest'));
    expect(accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
  });

  it('follows the bearer challenge that even public registries answer with', async () => {
    const { fetch, calls } = recordingFetch([
      challenge(),
      new Response(JSON.stringify({ token: 'anon-token' }), { status: 200 }),
      manifest({ digest: DIGEST }),
    ]);

    const resolved = await new RegistryImageDigestResolver({ fetch }).resolve(TAG);

    expect(resolved).toBe(DIGEST);
    expect(calls[1]?.url).toBe(
      'https://ghcr.io/token?service=ghcr.io&scope=repository%3Atruefoundry%2Ftrueforge-sandbox%3Apull',
    );
    expect(calls[1]?.headers['authorization']).toBeUndefined();
    expect(calls[2]?.headers['authorization']).toBe('Bearer anon-token');
  });

  it('sends configured credentials to the token endpoint for a private image', async () => {
    const { fetch, calls } = recordingFetch([
      challenge(),
      new Response(JSON.stringify({ token: 'private-token' }), { status: 200 }),
      manifest({ digest: DIGEST }),
    ]);

    await new RegistryImageDigestResolver({
      fetch,
      credentials: { username: 'ci', password: 'secret' },
    }).resolve(TAG);

    expect(calls[1]?.headers['authorization']).toBe(`Basic ${Buffer.from('ci:secret').toString('base64')}`);
  });

  it('accepts the access_token spelling some registries use', async () => {
    const { fetch } = recordingFetch([
      challenge(),
      new Response(JSON.stringify({ access_token: 'other-token' }), { status: 200 }),
      manifest({ digest: DIGEST }),
    ]);

    expect(await new RegistryImageDigestResolver({ fetch }).resolve(TAG)).toBe(DIGEST);
  });

  it('hashes the manifest itself when the registry omits the digest header', async () => {
    const body = '{"schemaVersion":2,"manifests":[]}';
    const { fetch } = recordingFetch([manifest({ body })]);

    const resolved = await new RegistryImageDigestResolver({ fetch }).resolve(TAG);

    expect(resolved).toBe(`sha256:${createHash('sha256').update(body).digest('hex')}`);
  });

  it('ignores a digest header that is not a digest and hashes the manifest instead', async () => {
    const body = '{"schemaVersion":2}';
    const { fetch } = recordingFetch([
      new Response(body, {
        status: 200,
        headers: { 'content-type': MANIFEST_MEDIA_TYPE, 'docker-content-digest': '?' },
      }),
    ]);

    expect(await new RegistryImageDigestResolver({ fetch }).resolve(TAG)).toBe(
      `sha256:${createHash('sha256').update(body).digest('hex')}`,
    );
  });

  it('refuses a 200 that is not a manifest, rather than pinning the sandbox to a hash of it', async () => {
    const { fetch } = recordingFetch([
      new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(
      /instead of an image manifest/,
    );
  });

  it('answers a basic challenge with credentials, for a registry with no token endpoint', async () => {
    const { fetch, calls } = recordingFetch([
      new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="registry"' } }),
      manifest({ digest: DIGEST }),
    ]);

    const resolved = await new RegistryImageDigestResolver({
      fetch,
      credentials: { username: 'ci', password: 'secret' },
    }).resolve(TAG);

    expect(resolved).toBe(DIGEST);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['authorization']).toBe(`Basic ${Buffer.from('ci:secret').toString('base64')}`);
  });

  it('says which settings are missing when a registry wants credentials we do not have', async () => {
    const { fetch } = recordingFetch([
      new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="registry"' } }),
    ]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(
      /SANDBOX_IMAGE_REGISTRY_USERNAME/,
    );
  });

  it('withholds credentials from a plaintext token realm', async () => {
    const { fetch, calls } = recordingFetch([
      challenge('http://registry.internal/token'),
      new Response(JSON.stringify({ token: 'anon' }), { status: 200 }),
      manifest({ digest: DIGEST }),
    ]);

    await new RegistryImageDigestResolver({ fetch, credentials: { username: 'ci', password: 'secret' } }).resolve(TAG);

    expect(calls[1]?.headers['authorization']).toBeUndefined();
  });

  it('reports a token realm that is not a URL', async () => {
    const { fetch } = recordingFetch([challenge('not a url')]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(/unusable token realm/);
  });

  it('does not call the registry for a reference that is already pinned', async () => {
    const { fetch, calls } = recordingFetch([]);
    const pinned = `ghcr.io/truefoundry/trueforge-sandbox@${DIGEST}`;

    expect(await new RegistryImageDigestResolver({ fetch }).resolve(pinned)).toBe(DIGEST);
    expect(calls).toEqual([]);
  });

  it('rejects a reference no registry could serve', async () => {
    const { fetch } = recordingFetch([]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve('ghcr.io/Org/app:1.0')).rejects.toBeInstanceOf(
      ImageResolutionError,
    );
  });

  it.each([
    [500, /answered 500/],
    // A 404 is the common operator mistake, so it says what is actually wrong.
    [404, /no image is published/],
  ])('reports a %s from the registry', async (status, expected) => {
    const { fetch } = recordingFetch([new Response('', { status })]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(expected);
  });

  it('reports an unreachable registry, keeping the cause', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND');
    const { fetch } = recordingFetch([cause]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toMatchObject({
      name: 'ImageResolutionError',
      cause,
    });
  });

  it('reports a 401 that comes with no challenge to follow', async () => {
    const { fetch } = recordingFetch([new Response('', { status: 401 })]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(/no challenge/);
  });

  /** GHCR answers 403 for a private image and for one that was never pushed. */
  it('names both causes when a registry will not issue an anonymous pull token', async () => {
    const { fetch } = recordingFetch([challenge(), new Response('', { status: 403 })]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(
      /private or does not exist.*SANDBOX_IMAGE_REGISTRY_USERNAME/s,
    );
  });

  it('blames the credentials instead once some are configured', async () => {
    const { fetch } = recordingFetch([challenge(), new Response('', { status: 401 })]);

    await expect(
      new RegistryImageDigestResolver({ fetch, credentials: { username: 'ci', password: 'secret' } }).resolve(TAG),
    ).rejects.toThrow(/rejected the configured registry credentials/);
  });

  it('reports a token response with no token in it', async () => {
    const { fetch } = recordingFetch([challenge(), new Response(JSON.stringify({ expires_in: 300 }), { status: 200 })]);

    await expect(new RegistryImageDigestResolver({ fetch }).resolve(TAG)).rejects.toThrow(/no pull token/);
  });
});

describe('CachedImageDigestResolver', () => {
  class CountingResolver implements IImageDigestResolver {
    calls = 0;
    constructor(private readonly result: string | Error) {}
    async resolve(): Promise<string> {
      this.calls += 1;
      if (this.result instanceof Error) throw this.result;
      return await Promise.resolve(this.result);
    }
  }

  const resolved = DIGEST;

  it('serves repeat lookups from the cache, so tenants share one registry call', async () => {
    const inner = new CountingResolver(resolved);
    const cached = new CachedImageDigestResolver({ resolver: inner, ttlMs: 1000, now: () => 0 });

    expect(await cached.resolve(TAG)).toBe(resolved);
    expect(await cached.resolve(TAG)).toBe(resolved);
    expect(inner.calls).toBe(1);
  });

  it('looks again once the entry expires, which is how a new push is picked up', async () => {
    const inner = new CountingResolver(resolved);
    let clock = 0;
    const cached = new CachedImageDigestResolver({ resolver: inner, ttlMs: 1000, now: () => clock });

    await cached.resolve(TAG);
    clock = 1000;
    await cached.resolve(TAG);

    expect(inner.calls).toBe(2);
  });

  it('collapses concurrent lookups into one request', async () => {
    const inner = new CountingResolver(resolved);
    const cached = new CachedImageDigestResolver({ resolver: inner, ttlMs: 1000, now: () => 0 });

    await Promise.all([cached.resolve(TAG), cached.resolve(TAG), cached.resolve(TAG)]);

    expect(inner.calls).toBe(1);
  });

  it('caches a different reference separately', async () => {
    const inner = new CountingResolver(resolved);
    const cached = new CachedImageDigestResolver({ resolver: inner, ttlMs: 1000, now: () => 0 });

    await cached.resolve(TAG);
    await cached.resolve('ghcr.io/truefoundry/other:latest');

    expect(inner.calls).toBe(2);
  });

  it('does not cache a failure, so a recovered registry is used at once', async () => {
    const inner = new CountingResolver(new ImageResolutionError('registry down'));
    const cached = new CachedImageDigestResolver({ resolver: inner, ttlMs: 1000, now: () => 0 });

    await expect(cached.resolve(TAG)).rejects.toBeInstanceOf(ImageResolutionError);
    await expect(cached.resolve(TAG)).rejects.toBeInstanceOf(ImageResolutionError);
    expect(inner.calls).toBe(2);
  });
});
