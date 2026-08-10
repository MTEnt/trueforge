/**
 * Container image reference parsing, so the server can ask a registry about the image
 * the catalog names. The sandbox image is served from JFrog Artifactory.
 *
 * The registry host is required, and a host is one that looks like one: `localhost`, or
 * something carrying a dot or a port. Docker's shorthands — a hostless reference meaning
 * Docker Hub, single-segment repositories under `library/` — are deliberately absent, so
 * a mistyped reference fails the catalog instead of resolving somewhere unconfigured.
 */

/** Tag assumed when a reference carries neither tag nor digest. */
const DEFAULT_TAG = 'latest';

const REPOSITORY_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;
/** `algorithm:hex`, e.g. `sha256:` followed by 64 hex characters. */
const DIGEST_PATTERN = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-fA-F0-9]{32,}$/;

export interface ParsedImageReference {
  /** Host to send registry API requests to, always named by the reference itself. */
  registry: string;
  /** Repository path the registry expects. */
  repository: string;
  /** Tag to resolve. Absent only when the reference is already digest-pinned. */
  tag: string | undefined;
  /** Digest when the reference pins one, so no resolution is needed. */
  digest: string | undefined;
}

/**
 * Returns undefined for anything a registry could not accept, so callers can
 * turn one check into both validation and parsing.
 */
export function parseImageReference(reference: string): ParsedImageReference | undefined {
  const digestSeparator = reference.indexOf('@');
  const digest = digestSeparator === -1 ? undefined : reference.slice(digestSeparator + 1);
  if (digest !== undefined && !DIGEST_PATTERN.test(digest)) {
    return undefined;
  }
  const withoutDigest = digestSeparator === -1 ? reference : reference.slice(0, digestSeparator);

  // Only a colon after the last slash is a tag separator; earlier ones are registry ports.
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagSeparator = withoutDigest.indexOf(':', lastSlash + 1);
  const name = tagSeparator === -1 ? withoutDigest : withoutDigest.slice(0, tagSeparator);
  const explicitTag = tagSeparator === -1 ? undefined : withoutDigest.slice(tagSeparator + 1);
  if (explicitTag !== undefined && !TAG_PATTERN.test(explicitTag)) {
    return undefined;
  }

  const firstSlash = name.indexOf('/');
  const host = firstSlash === -1 ? undefined : name.slice(0, firstSlash);
  if (host === undefined || !looksLikeRegistryHost(host)) {
    return undefined;
  }
  const path = name.slice(firstSlash + 1);
  if (!REPOSITORY_PATTERN.test(path)) {
    return undefined;
  }

  return {
    registry: host,
    repository: path,
    // A digest-pinned reference needs no tag; anything else resolves `latest` by default.
    tag: explicitTag ?? (digest === undefined ? DEFAULT_TAG : undefined),
    digest,
  };
}

function looksLikeRegistryHost(segment: string): boolean {
  return segment === 'localhost' || segment.includes('.') || segment.includes(':');
}

/** True when `value` is a well-formed `algorithm:hex` digest. */
export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/**
 * True when two references name the same image. Compared field by field rather than
 * as strings because Daytona echoes back its own spelling of what we sent, and a tag
 * left alongside a digest would make an identical image look like a different one.
 */
export function isSameImageReference({ left, right }: { left: string; right: string }): boolean {
  const parsedLeft = parseImageReference(left);
  const parsedRight = parseImageReference(right);
  if (parsedLeft === undefined || parsedRight === undefined) {
    return left === right;
  }
  // A digest *is* the content identity, so when both sides pin one the digests
  // settle it outright — including when one side names a mirror of the other.
  if (parsedLeft.digest !== undefined && parsedRight.digest !== undefined) {
    return parsedLeft.digest.toLowerCase() === parsedRight.digest.toLowerCase();
  }
  return (
    parsedLeft.registry === parsedRight.registry &&
    parsedLeft.repository === parsedRight.repository &&
    parsedLeft.tag === parsedRight.tag &&
    parsedLeft.digest === parsedRight.digest
  );
}
