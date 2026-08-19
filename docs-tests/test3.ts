import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' });

try {
  await client.agents.create({
    name: 'web-research-brief',
    manifest: {
      model: { name: 'openai/gpt-5-6-terra' },
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

// By saved agent name:
const { data: session } = await client.sessions.create({ agent: { name: 'web-research-brief' } });

// …or with an inline spec (no saved agent needed):
const { data: inlineSession } = await client.sessions.create({
  agent: {
    spec: {
      model: { name: 'openai/gpt-5-6-terra' },
      instructions: 'You are a concise research assistant.',
    },
  },
});

console.log('session:', session.id);
console.log('inlineSession:', inlineSession.id);
