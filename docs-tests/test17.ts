import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

// Open a session with an inline agent (no saved agent needed).
const { data: session } = await client.sessions.create({
  agent: {
    spec: {
      model: { name: 'openai/gpt-5-5' }, // a model you configured in Settings
      instructions: 'You are a concise, helpful assistant.',
    },
  },
});

// Stream one turn and print the reply token by token.
const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'In two sentences, what is TrueForge?' }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message.delta') process.stdout.write(event.content ?? '');
  if (event.type === 'turn.done') console.log('\n\nstatus:', event.state.status);
}
