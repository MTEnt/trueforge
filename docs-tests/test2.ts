import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

try {
  await client.agents.create({
    name: 'web-research-brief',
    manifest: {
      model: { name: (await client.models.list()).data[0]?.name ?? 'openai/gpt-5-5' },
      instructions:
        'You are a web research assistant. Given a topic or question, use parallel-web to search the web and pull content from the most relevant, recent sources. When the request compares several items, research each one in parallel, then synthesize the findings into a clear one-page brief.',
      mcpServers: [
        {
          name: 'parallel-web',
          enableTools: ['@all'],
          requireApprovalForTools: [],
        },
      ],
    },
  });
} catch (err) {
  if ((err as { statusCode?: number }).statusCode !== 409) throw err;
}

// The agent you saved in the Quickstart.
const { data: session } = await client.sessions.create({ agent: { name: 'web-research-brief' } });

const stream = await client.sessions.createTurnStream(session.id, {
  input: [
    {
      type: 'user.message',
      content:
        'Compare Qdrant, Weaviate, and Milvus on performance, features, and licensing, then write a one-page brief with sources.',
    },
  ],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'thread.created') console.log(`\n↳ subagent: ${event.title}`);
  if (event.type === 'model.message.delta' && event.threadId === 'main') {
    process.stdout.write(event.content ?? ''); // the root agent's reply, streaming in
  }
  if (event.type === 'turn.done' && event.state.status === 'done') {
    console.log('\n\n--- brief ---\n', event.state.output?.content ?? '');
  }
}
