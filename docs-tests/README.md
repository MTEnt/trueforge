# docs-tests

Smoke scripts for TrueForge TypeScript SDK snippets from the docs. Each `testN.ts` is a docs example plus a small prefix (create agent, real session id, etc.) so it can run against a local server.

## Manual quick setup (before any test)

1. **Node.js 22+**
2. **Start TrueForge** (default UI/API: `http://localhost:8790`):

   ```bash
   npx @truefoundry/trueforge
   ```

3. **Model provider** — Settings → Models → configure a provider and paste an API key. Tests use the first listed model (this workspace used `openai/gpt-5-5`). Docs that hardcode `anthropic/claude-sonnet-4-6` fail unless that provider is configured.
4. **MCP connector** — Settings → Connectors → connect **parallel-web** (no auth). Tests that save `web-research-brief` / `ops-bot` attach this server.
5. **Optional for test12** — a GitHub (or other OAuth/DCR) MCP. `mcp.auth_required` only appears if that server is not already authorized. See the TODO in `test12.ts`.
6. **Install deps** (from this folder):

   ```bash
   cd docs-tests
   npm install
   ```

OIDC login on: set `TRUEFORGE_TOKEN`. Non-default URL: set `TRUEFORGE_BASE_URL`.

## How to test

From `docs-tests`, with the server already running:

```bash
node --import tsx test1.ts
```

Same pattern for `test2.ts` … `test15.ts`. Long research turns can take minutes (`timeoutInSeconds: 600`).

| File | What it checks |
| --- | --- |
| `test1.ts` | Client + inline session + stream |
| `test2.ts` | Named `web-research-brief` stream |
| `test3.ts` | Session by name + inline spec |
| `test4.ts` | `sessions.list` |
| `test5.ts` | Stream + `isEventDelta` / `mergeEventDelta` |
| `test6.ts` | Non-streaming `createTurn` + poll |
| `test7.ts` | `listTurns` after a seed turn |
| `test8.ts` | File part (`benchmarks.png` in this folder) |
| `test9.ts` | `sessions.cancel` mid-stream |
| `test10.ts` | `ops-bot` tool approval + resume |
| `test11.ts` | `ask_user_question` + resume |
| `test12.ts` | `mcp.auth_required` (needs DCR/OAuth MCP) |
| `test13.ts` | Disconnect + `subscribeToTurn` |
| `test14.ts` | Thread buckets / subagents |
| `test15.ts` | `listTurnEvents` after a finished turn |
