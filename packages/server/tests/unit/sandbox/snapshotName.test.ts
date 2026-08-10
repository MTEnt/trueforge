import { deriveSandboxSnapshotName } from '../../../src/sandbox/snapshotName';
import type { SandboxSnapshotSpec } from '../../../src/schemas/sandboxSnapshot';

const TAG = 'ghcr.io/truefoundry/trueforge-sandbox:latest';
const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;
const SPEC: SandboxSnapshotSpec = { docker_image: TAG };

const nameFor = (spec: SandboxSnapshotSpec, digest = DIGEST) => deriveSandboxSnapshotName({ spec, digest });

describe('deriveSandboxSnapshotName', () => {
  it('produces a Daytona-safe name', () => {
    expect(nameFor(SPEC)).toMatch(/^trueforge-sandbox-[0-9a-f]{12}$/);
  });

  it('is stable across calls, so an unchanged image keeps its snapshot', () => {
    expect(nameFor(SPEC)).toBe(nameFor({ ...SPEC }));
  });

  it('changes when the resolved digest changes, which is how a new push is noticed', () => {
    expect(nameFor(SPEC)).not.toBe(nameFor(SPEC, OTHER_DIGEST));
  });

  /**
   * The tag is the reference Daytona records against the snapshot, so it belongs to
   * the snapshot's identity even when the content behind it is unchanged.
   */
  it('changes when the tag changes, since the snapshot records the tag it pulled', () => {
    expect(nameFor({ docker_image: 'ghcr.io/truefoundry/trueforge-sandbox:v2' })).not.toBe(nameFor(SPEC));
  });

  it('changes when the entrypoint or resources change, since the sandbox differs', () => {
    expect(nameFor({ ...SPEC, entrypoint: ['/bin/sh'] })).not.toBe(nameFor(SPEC));
    expect(nameFor({ ...SPEC, resources: { cpu: 1, memory_gb: 2, disk_gb: 5 } })).not.toBe(nameFor(SPEC));
  });

  it('ignores key order, so YAML formatting cannot orphan a snapshot', () => {
    const resources = { cpu: 1, memory_gb: 2, disk_gb: 5 };
    expect(nameFor({ ...SPEC, resources })).toBe(nameFor({ ...SPEC, resources: { disk_gb: 5, cpu: 1, memory_gb: 2 } }));
  });

  it('ignores explicitly-undefined optionals', () => {
    expect(nameFor({ ...SPEC, entrypoint: undefined, resources: undefined })).toBe(nameFor(SPEC));
  });

  it('distinguishes entrypoint ordering, which changes the command', () => {
    expect(nameFor({ ...SPEC, entrypoint: ['a', 'b'] })).not.toBe(nameFor({ ...SPEC, entrypoint: ['b', 'a'] }));
  });
});
