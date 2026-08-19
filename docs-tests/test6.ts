import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' });

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

const { data: created } = await client.sessions.createTurn(session.id, {
  input: [{ type: 'user.message', content: 'Give me a one-paragraph summary of the Qdrant licensing model.' }],
});

let turn = created;
while (turn.state.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 500));
  ({ data: turn } = await client.sessions.getTurn(session.id, created.id));
}
console.log(turn.state); // done → state.output / required_actions; else reason / message
