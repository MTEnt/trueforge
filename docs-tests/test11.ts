import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

const modelName = 'openai/gpt-5-6-terra';
const manifest = {
  model: { name: modelName },
  instructions:
    'You create environments. Before creating anything, you must call ask_user_question to ask which region or cluster to use. Never proceed without asking.',
  config: { askUserQuestions: { enabled: true } },
};

try {
  await client.agents.create({ name: 'ops-bot', manifest });
} catch (err) {
  if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  const listed = await client.agents.list();
  const existing = listed.data.find((a) => a.name === 'ops-bot');
  if (existing == null) throw err;
  await client.agents.update(existing.id, { manifest });
}

const { data: session } = await client.sessions.create({ agent: { name: 'ops-bot' } });

const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
const pendingQuestions: TrueForgeApi.ToolResponseRequiredEvent[] = [];

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Create a new environment called testing-1.' }],
});
for await (const { data: event } of stream.withMetadata()) {
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
  } else {
    events.set(event.id, event);
  }
  if (event.type === 'tool.response_required') pendingQuestions.push(event);
  if (event.type === 'turn.done') console.log('turn.done', event.state.status);
}

const responses: TrueForgeApi.UserToolResponseEvent[] = [];
for (const pending of pendingQuestions) {
  for (const ref of pending.toolCalls) {
    const msg = events.get(ref.sourceEventId);
    if (msg?.type !== 'model.message') continue;
    const call = msg.toolCalls?.find((tc) => tc.id === ref.id);
    // tool.response_required covers any client-side tool; handle ask_user_question here.
    if (call?.toolInfo.type !== 'truefoundry-system' || call.toolInfo.name !== 'ask_user_question') continue;
    const { question, options } = JSON.parse(call.function.arguments || '{}') as { question?: string; options?: string[] };
    console.log(question, options);
    responses.push({
      type: 'user.tool_response',
      threadId: pending.threadId,
      toolCallId: ref.id,
      content: 'the chosen option, or any text', // free-form answer
    });
  }
}

console.log('pending questions:', pendingQuestions.length, 'resume items:', responses.length);
const resume = await client.sessions.createTurnStream(session.id, { input: responses });
for await (const { data: event } of resume.withMetadata()) console.log(event.type);
