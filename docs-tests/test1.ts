import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600, // raise for long-running SSE turns (default 60s)
  // token: process.env.TRUEFORGE_TOKEN, // ID token when OIDC login is enabled
});

async function main() {
  const me = await client.auth.me();
  console.log('auth.me:', me);

  const models = await client.models.list();
  const modelName = models.data[0]?.name;
  if (modelName == null) {
    throw new Error('No models configured on the server');
  }
  console.log('using model:', modelName);

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: modelName },
        instructions: 'You are a concise, helpful assistant.',
      },
    },
  });
  console.log('session:', session.id);

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'In one sentence, what is TrueForge?' }],
  });

  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === 'model.message.delta') process.stdout.write(event.content ?? '');
    if (event.type === 'turn.done') console.log('\n\nturn.done status:', event.state.status);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

