/** Length-prefixed framing: 4-byte little-endian length + UTF-8 JSON. */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`frame exceeds ${String(MAX_FRAME_BYTES)} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameParser {
  #buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > this.#maxFrameBytes) {
        throw new Error(`frame length ${String(length)} exceeds max ${String(this.#maxFrameBytes)}`);
      }
      if (this.#buffer.length < 4 + length) {
        break;
      }
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      let value: unknown;
      try {
        value = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        throw new Error('invalid JSON frame', { cause: error });
      }
      frames.push(value);
    }
    return frames;
  }
}
