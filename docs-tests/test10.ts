import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

try {
  await client.agents.create({
    name: 'ops-bot',
    manifest: {
      model: { name: (await client.models.list()).data[0]?.name ?? 'openai/gpt-5-5' },
      instructions:
        'You operate production services. For any restart or ops request, you must call parallel-web to look up the current runbook before doing anything else. Do not answer from memory.',
      mcpServers: [
        {
          name: 'parallel-web',
          enableTools: ['@all'],
          requireApprovalForTools: ['@all'],
        },
      ],
    },
  });
} catch (err) {
  if ((err as { statusCode?: number }).statusCode !== 409) throw err;
}

const { data: session } = await client.sessions.create({ agent: { name: 'ops-bot' } });

const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Restart the billing service.' }],
});
for await (const { data: event } of stream.withMetadata()) {
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
  } else {
    events.set(event.id, event);
  }
  if (event.type === 'tool.approval_required') pendingApprovals.push(event);
  if (event.type === 'turn.done') console.log('turn.done', event.state.status);
}

const approvals: TrueForgeApi.UserToolApprovalEvent[] = [];
for (const pending of pendingApprovals) {
  for (const ref of pending.toolCalls) {
    const msg = events.get(ref.sourceEventId);
    if (msg?.type !== 'model.message') continue;
    const call = msg.toolCalls?.find((tc) => tc.id === ref.id);
    if (!call) continue;
    console.log(`approve ${call.toolInfo.name}? args: ${call.function.arguments}`);
    approvals.push({
      type: 'user.tool_approval',
      threadId: pending.threadId,
      toolCallId: ref.id,
      approval: { status: 'allow' }, // or { status: 'deny', reason: 'denied by user' }
    });
  }
}

console.log('pending approvals:', pendingApprovals.length, 'resume items:', approvals.length);
const resume = await client.sessions.createTurnStream(session.id, { input: approvals });
for await (const { data: event } of resume.withMetadata()) console.log(event.type);
