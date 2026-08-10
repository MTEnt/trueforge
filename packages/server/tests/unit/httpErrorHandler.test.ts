import { OpenAPIHono, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import { handleHttpError } from '../../src/httpErrorHandler';

describe('handleHttpError', () => {
  it('logs HTTPException with cause once and returns the status body', async () => {
    const warn = jest.fn();
    const error = jest.fn();
    const logger = createLogger({ silent: true });
    logger.warn = warn;
    logger.error = error;

    const app = new OpenAPIHono();
    app.onError((err, c) => handleHttpError({ error: err, c, logger }));
    app.get('/boom', () => {
      throw new HTTPException(412, {
        message: 'stream gone',
        cause: new Error('inner failure'),
      });
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: { message: 'stream gone' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toBe('HTTP exception');
    const fields = warn.mock.calls[0]?.[1] as { error: string; stack?: string };
    expect(fields.error).toBe('stream gone');
    expect(fields.stack).toContain('Caused by:');
    expect(fields.stack).toContain('inner failure');
  });

  it('logs unhandled errors at error level with stack', async () => {
    const warn = jest.fn();
    const errorLog = jest.fn();
    const logger = createLogger({ silent: true });
    logger.warn = warn;
    logger.error = errorLog;

    const app = new OpenAPIHono();
    app.onError((err, c) => handleHttpError({ error: err, c, logger }));
    app.get('/boom', () => {
      throw new Error('sql failed', { cause: new Error('syntax error') });
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    const fields = errorLog.mock.calls[0]?.[1] as { error: string; stack?: string };
    expect(fields.error).toBe('sql failed');
    expect(fields.stack).toContain('Caused by:');
    expect(fields.stack).toContain('syntax error');
  });

  it('logs ZodError at warn and returns 400', async () => {
    const warn = jest.fn();
    const errorLog = jest.fn();
    const logger = createLogger({ silent: true });
    logger.warn = warn;
    logger.error = errorLog;

    const app = new OpenAPIHono();
    // Probe context without relying on Hono to route a thrown ZodError through onError.
    app.get('/probe', c =>
      handleHttpError({
        error: new z.ZodError([
          {
            code: 'invalid_type',
            expected: 'string',
            path: ['name'],
            message: 'Required',
          },
        ]),
        c,
        logger,
      }),
    );

    const res = await app.request('/probe');
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toBe('Request validation error');
  });
});
