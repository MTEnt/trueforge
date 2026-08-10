export interface ErrorLogFields {
  error: string;
  stack?: string | undefined;
}

/** Append cause frames Node-style so JSON logs keep one readable stack field. */
function formatErrorStack(error: Error, seen: Set<object>): string | undefined {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (seen.has(current)) {
      parts.push('[Circular cause]');
      break;
    }
    seen.add(current);
    parts.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (!(current instanceof Error) && current !== undefined) {
    parts.push(String(current));
  }
  return parts.length > 0 ? parts.join('\nCaused by: ') : undefined;
}

export function extractErrorLogFields(error: unknown): ErrorLogFields {
  if (error instanceof Error) {
    return { error: error.message, stack: formatErrorStack(error, new Set<object>()) };
  }
  return { error: String(error) };
}
