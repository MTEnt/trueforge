/** Domain errors matching packages/harness/src/core/sandbox/SandboxErrors.ts. */

export abstract class SandboxError extends Error {
  abstract readonly statusCode: 400 | 403 | 404 | 410 | 413;
}

export class SandboxFileNotFoundError extends SandboxError {
  readonly statusCode = 404;

  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = 'SandboxFileNotFoundError';
  }
}

export class SandboxNotAvailableError extends SandboxError {
  readonly statusCode = 410;

  constructor(sandboxId: string) {
    super(`Sandbox '${sandboxId}' no longer exists — it may have been auto-deleted`);
    this.name = 'SandboxNotAvailableError';
  }
}

export class SandboxPathIsDirectoryError extends SandboxError {
  readonly statusCode = 400;

  constructor(path: string) {
    super(`Path is a directory, not a file: ${path}`);
    this.name = 'SandboxPathIsDirectoryError';
  }
}

export class SandboxFileTooLargeError extends SandboxError {
  readonly statusCode = 413;
  readonly fileSize: number;
  readonly maxSize: number;

  constructor(path: string, fileSize: number, maxSize: number) {
    super(`File too large: ${path} (${String(fileSize)} bytes, max ${String(maxSize)})`);
    this.name = 'SandboxFileTooLargeError';
    this.fileSize = fileSize;
    this.maxSize = maxSize;
  }
}

const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

export function validateNoPathTraversal(path: string): void {
  if (PATH_TRAVERSAL_RE.test(path)) {
    throw new Error(`Path must not contain ".." segments: ${path}`);
  }
}
