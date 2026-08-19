import { readFileSync } from 'node:fs';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

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

const { data: session } = await client.sessions.create({ agent: { name: 'web-research-brief' } });

const toDataUri = (path: string, mime: string) => `data:${mime};base64,${readFileSync(path).toString('base64')}`;

const stream = await client.sessions.createTurnStream(session.id, {
  input: [
    {
      type: 'user.message',
      content: [
        { type: 'text', text: 'Use this chart in the brief.' },
        { type: 'file', name: 'benchmarks.png', data: toDataUri('benchmarks.png', 'image/png') },
      ],
    },
  ],
});
for await (const { data: event } of stream.withMetadata()) console.log(event.type);
