import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

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

const { data: session } = await client.sessions.create({ agent: { name: 'web-research-brief' } });

const threads = new Map<string, Map<string, TrueForgeApi.TurnStreamingEvent>>();

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Compare Qdrant, Weaviate, and Milvus in parallel.' }],
});
for await (const { data: event } of stream.withMetadata()) {
  if (event.threadId == null) {
    console.log('turn-level event:', event.type);
    continue;
  }
  let bucket = threads.get(event.threadId);
  if (!bucket) threads.set(event.threadId, (bucket = new Map()));

  if (isEventDelta(event)) {
    const base = bucket.get(event.id);
    if (base) mergeEventDelta(base, event);
  } else {
    bucket.set(event.id, event);
  }
  if (event.type === 'thread.done') {
    console.log(`${event.threadId} done: ${event.title} (${bucket.size} events)`);
    threads.delete(event.threadId);
  }
}
