import { isSameImageReference, parseImageReference } from '../../../src/sandbox/imageReference';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('parseImageReference', () => {
  it('splits a registry, repository and tag', () => {
    expect(parseImageReference('ghcr.io/truefoundry/sandbox:1.2.3')).toEqual({
      registry: 'ghcr.io',
      repository: 'truefoundry/sandbox',
      tag: '1.2.3',
      digest: undefined,
    });
  });

  it('defaults the tag to latest, matching what a pull would do', () => {
    expect(parseImageReference('ghcr.io/truefoundry/sandbox')?.tag).toBe('latest');
  });

  it('needs no tag once a digest pins the reference', () => {
    expect(parseImageReference(`ghcr.io/truefoundry/sandbox@${DIGEST}`)).toEqual({
      registry: 'ghcr.io',
      repository: 'truefoundry/sandbox',
      tag: undefined,
      digest: DIGEST,
    });
  });

  it('reads a JFrog reference, repository path and all', () => {
    expect(parseImageReference('tfy.jfrog.io/tfy-images/truefoundry-utils-core-sandbox:stable')).toEqual({
      registry: 'tfy.jfrog.io',
      repository: 'tfy-images/truefoundry-utils-core-sandbox',
      tag: 'stable',
      digest: undefined,
    });
  });

  it('keeps a repository path deeper than two segments', () => {
    expect(parseImageReference('tfy.jfrog.io/tfy-images/team/sandbox:1.0')).toMatchObject({
      registry: 'tfy.jfrog.io',
      repository: 'tfy-images/team/sandbox',
    });
  });

  it('treats a first segment with a port as a registry, not a tag', () => {
    expect(parseImageReference('registry.internal:5000/team/sandbox')).toMatchObject({
      registry: 'registry.internal:5000',
      repository: 'team/sandbox',
      tag: 'latest',
    });
  });

  it('recognises localhost as a registry', () => {
    expect(parseImageReference('localhost:5000/sandbox:dev')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'sandbox',
      tag: 'dev',
    });
  });

  it('lets a digest win over a tag on the same reference', () => {
    expect(parseImageReference(`ghcr.io/org/app:1.0@${DIGEST}`)).toMatchObject({
      tag: '1.0',
      digest: DIGEST,
    });
  });

  it.each([
    ['an empty tag', 'ghcr.io/org/app:'],
    ['an empty digest', 'ghcr.io/org/app@'],
    ['a non-hex digest', 'ghcr.io/org/app@sha256:zzzz'],
    ['a digest with no algorithm', `ghcr.io/org/app@${'a'.repeat(64)}`],
    ['an uppercase repository', 'ghcr.io/Org/app:1.0'],
    ['a repository with a space', 'ghcr.io/org/my app:1.0'],
    ['an empty reference', ''],
    // Docker would read these as Docker Hub. Resolving them against a registry the
    // catalog never named is worse than refusing them.
    ['a bare name', 'ubuntu:24.04'],
    ['an organisation with no registry', 'truefoundry/sandbox:1.0'],
    ['a first segment that is not a host', 'tfy-images/sandbox:1.0'],
  ])('rejects %s', (_case, reference) => {
    expect(parseImageReference(reference)).toBeUndefined();
  });
});

describe('isSameImageReference', () => {
  it('is true for identical references', () => {
    expect(isSameImageReference({ left: 'ghcr.io/org/app:1.0', right: 'ghcr.io/org/app:1.0' })).toBe(true);
  });

  // Daytona echoes back its own spelling of the reference it was given, and a
  // mismatch here would condemn a perfectly good snapshot as someone else's.
  it('matches a pinned reference however the other side spells it', () => {
    const pinned = `tfy.jfrog.io/tfy-images/app@${DIGEST}`;
    expect(isSameImageReference({ left: `tfy.jfrog.io/tfy-images/app:1.0@${DIGEST}`, right: pinned })).toBe(true);
  });

  it('is true across mirrors of one digest, since a digest is the content itself', () => {
    expect(
      isSameImageReference({ left: `tfy.jfrog.io/tfy-images/app@${DIGEST}`, right: `ghcr.io/org/app@${DIGEST}` }),
    ).toBe(true);
  });

  it('is false across different digests of the same repository', () => {
    expect(
      isSameImageReference({
        left: `tfy.jfrog.io/tfy-images/app@${DIGEST}`,
        right: `tfy.jfrog.io/tfy-images/app@sha256:${'b'.repeat(64)}`,
      }),
    ).toBe(false);
  });

  it('is false when only one side pins a digest, since that proves nothing', () => {
    expect(isSameImageReference({ left: `ghcr.io/org/app@${DIGEST}`, right: 'ghcr.io/org/app:1.0' })).toBe(false);
  });

  it('falls back to an exact comparison when a reference cannot be parsed', () => {
    expect(isSameImageReference({ left: 'Not/A/Ref', right: 'Not/A/Ref' })).toBe(true);
    expect(isSameImageReference({ left: 'Not/A/Ref', right: 'other' })).toBe(false);
  });
});
