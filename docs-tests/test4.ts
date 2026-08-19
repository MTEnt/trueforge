import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' });

for await (const session of await client.sessions.list()) {
  console.log(session.id, session.createdAt);
}
