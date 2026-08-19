import { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

const mcpServers = await client.mcpServers.list();
const githubMcp =
  mcpServers.data.find((s) => /github/i.test(s.name)) ?? mcpServers.data[0];
console.log(
  'configured MCP servers:',
  mcpServers.data.map((s) => `${s.name} (${s.authStatus})`).join(', ') || '(none)',
);
if (githubMcp == null) {
  throw new Error('No MCP servers configured; github-bot needs a GitHub (OAuth) connector');
}
// TODO: verify mcp.auth_required + empty resume with a DCR-based MCP once.

const modelName = (await client.models.list()).data[0]?.name ?? 'openai/gpt-5-5';
const manifest = {
  model: { name: modelName },
  instructions:
    'You are a GitHub assistant. Always use the GitHub MCP tools to list the user issues. Do not answer from memory.',
  mcpServers: [{ name: githubMcp.name, enableTools: ['@all'] as const, requireApprovalForTools: [] }],
};

try {
  await client.agents.create({ name: 'github-bot', manifest });
} catch (err) {
  if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  const listed = await client.agents.list();
  const existing = listed.data.find((a) => a.name === 'github-bot');
  if (existing == null) throw err;
  await client.agents.update(existing.id, { manifest });
}
console.log('github-bot MCP:', githubMcp.name);


const { data: session } = await client.sessions.create({ agent: { name: 'github-bot' } });

let pendingAuth: TrueForgeApi.McpAuthRequiredEvent | undefined;
const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Summarize my latest GitHub issues.' }],
});
for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'mcp.auth_required') pendingAuth = event;
  if (event.type === 'turn.done') console.log('turn.done', event.state.status);
}

if (pendingAuth != null) {
  for (const server of pendingAuth.mcpServers) {
    console.log(`Authorize ${server.name}: ${server.authUrl}`);
  }
  // …wait for the user to authorize the server(s)…
}

console.log('pendingAuth:', pendingAuth != null);
// Resume with empty input; the agent continues the interrupted work.
const resume = await client.sessions.createTurnStream(session.id, {});
for await (const { data: event } of resume.withMetadata()) console.log(event.type);
