/**
 * Maps a resolved sandbox snapshot spec onto the Daytona snapshot name that holds it.
 *
 * The name hashes the spec plus the digest its tag currently resolves to, which is
 * what makes a moving tag work: the same spec and digest always give the same name,
 * and a new push gives a different one. The reconciler can then answer "is the right
 * snapshot present?" with a single `get`.
 */
import { createHash } from 'node:crypto';
import type { SandboxSnapshotSpec } from '../schemas/sandboxSnapshot';

const NAME_PREFIX = 'trueforge-sandbox';
/** 48 bits of sha256: collision-free for the handful of specs a release ever ships. */
const HASH_LENGTH = 12;

/**
 * Stable JSON for hashing: object keys sorted and absent optionals dropped, so
 * YAML key order and explicit-undefined never change the derived name.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]): [string, unknown] => [key, canonicalize(nested)]);
  return Object.fromEntries(entries);
}

/**
 * `digest` is what the spec's `docker_image` tag resolves to right now. Both are
 * hashed: the digest so new content provisions a new snapshot, and the tag because
 * it is the reference Daytona stores, so a retag has to produce a snapshot whose
 * recorded image matches the spec it was built for.
 */
export function deriveSandboxSnapshotName({ spec, digest }: { spec: SandboxSnapshotSpec; digest: string }): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({ image: spec.docker_image, digest, entrypoint: spec.entrypoint, resources: spec.resources }),
      ),
    )
    .digest('hex');
  return `${NAME_PREFIX}-${hash.slice(0, HASH_LENGTH)}`;
}
