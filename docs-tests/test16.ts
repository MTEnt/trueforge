import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600, // raise for long-running SSE turns (default 60s)
});

console.log('auth.me:', await client.auth.me());
