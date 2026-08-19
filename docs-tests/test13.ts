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
  input: [{ type: 'user.message', content: 'Compare Qdrant, Weaviate, and Milvus.' }],
});
let eventCount = 0;
for await (const { data: event, id } of stream.withMetadata()) {
  if (id != null) lastSequenceNumber = Number(id);
  if (event.type === 'turn.created') turnId = event.turnId;
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
  } else {
    events.set(event.id, event);
  }
  eventCount += 1;
  if (turnId != null && eventCount >= 8) {
    console.log('disconnecting after', eventCount, 'events, lastSeq:', lastSequenceNumber);
    break;
  }
}

// …after a disconnect, with session.id / turnId / lastSequenceNumber restored:
const { data: turn } = await client.sessions.getTurn(session.id, turnId!);
console.log('getTurn status:', turn.state.status);
if (turn.state.status === 'running') {
  console.log('resuming stream via subscribeToTurn afterSequenceNumber:', lastSequenceNumber);
  const resume = await client.sessions.subscribeToTurn(
    session.id,
    turnId!,
    { afterSequenceNumber: lastSequenceNumber },
    { timeoutInSeconds: 600 },
  );
  for await (const { data: event, id } of resume.withMetadata()) {
    if (id != null) lastSequenceNumber = Number(id);
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
    } else {
      events.set(event.id, event);
    }
    if (event.type === 'turn.done') console.log('resume turn.done', event.state.status);
  }
} else {
  console.log('turn already finished; listTurnEvents (not subscribeToTurn)');
  for await (const event of await client.sessions.listTurnEvents(session.id, turnId!)) {
    events.set(event.id, event);
  }
}

console.log('turn:', turnId, turn.state.status, 'events:', events.size, 'lastSeq:', lastSequenceNumber);
