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

const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
let turnId: string | undefined;
let lastSequenceNumber = 0;

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Summarize the current state of open-source vector databases.' }],
});
for await (const { data: event, id } of stream.withMetadata()) {
  if (id != null) lastSequenceNumber = Number(id);
  if (event.type === 'turn.created') turnId = event.turnId;
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
  } else {
    events.set(event.id, event);
  }
  if (event.type === 'turn.done') console.log('status:', event.state.status);
}
