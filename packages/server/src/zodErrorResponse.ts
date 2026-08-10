/** Shared Zod → HTTP 400 formatting for OpenAPI validation and thrown ZodError. */
import type { Hook } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/utils-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';

export function zodErrorResponse(c: Context, error: z.ZodError) {
  return c.json({ error: { message: z.prettifyError(error) } }, 400);
}

/** OpenAPI defaultHook: validation failures are a return edge — log once, then 400. */
export function createZodValidationHook(logger: Logger): Hook<unknown, object, string, Response | undefined> {
  return (result, c) => {
    if (!result.success) {
      logger.warn('Request validation error', extractErrorLogFields(result.error));
      return zodErrorResponse(c, result.error);
    }
    return undefined;
  };
}
