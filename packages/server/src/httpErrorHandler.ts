/** Hono request-edge error logging and HTTP response mapping. */
import { z } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/utils-core/core';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import { zodErrorResponse } from './zodErrorResponse';

/**
 * Logs once at the request edge, then maps the error to a client response.
 * Callers that catch and rethrow must not log — this (or a return-edge catch) owns the single log line.
 */
export function handleHttpError(params: { error: Error; c: Context; logger: Logger }): Response | Promise<Response> {
  const { error, c, logger } = params;
  const fields = extractErrorLogFields(error);

  if (error instanceof z.ZodError) {
    logger.warn('Request validation error', fields);
    return zodErrorResponse(c, error);
  }

  if (error instanceof HTTPException) {
    if (error.status < 500) {
      logger.warn('HTTP exception', fields);
    } else {
      logger.error('HTTP exception', fields);
    }
    return c.json({ error: { message: error.message } }, error.status);
  }

  logger.error('Unhandled error', fields);
  return c.json({ error: { message: 'Internal server error' } }, 500);
}
