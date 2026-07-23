import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'agentSession/index': 'src/agentSession/index.ts',
  },
  // CJS output exists for consumers whose test toolchains transpile to CommonJS
  // (e.g. the gateway's Jest); ESM remains the primary format.
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  // TODO(oss): revisit sourcemaps at the public release — with sourcesContent
  // they embed the full TS source in the published tarball.
  sourcemap: false,
  clean: true,
  target: 'esnext',
  outDir: 'dist',
  external: [
    '@daytona/sdk',
    '@hono/zod-openapi',
    '@modelcontextprotocol/sdk',
    '@nats-io/nats-core',
    '@opentelemetry/api',
    '@opentelemetry/core',
    'dedent',
    'openai',
    'ulid',
    'winston',
    'ws',
    'zod',
    'zod-to-json-schema',
  ],
});
