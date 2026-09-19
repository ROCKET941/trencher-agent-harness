# Consolidated release candidate (v0.4.0)

Apply this overlay directly over current `main`. It supersedes the older unpushed V1.2/Jev overlays.

Adds real Jev routing, execution budgets, OpenAI Responses provider adapter, `execute_routed_task`, and a remote Streamable HTTP MCP entrypoint.

## Verify
1. `npm install`
2. `npm test`
3. `npm run smoke`
4. `npm run mcp:smoke` — update expected tool list to include `execute_routed_task`.
5. `npm run provider:smoke`
6. With `TYPESAFE_API_KEY` in runtime secrets only: `npm run jev:smoke`
7. Start `npm run mcp:http`; verify `/health`, unauthorized `/mcp` when `HARNESS_MCP_TOKEN` is set, and a real Streamable HTTP tools/list handshake.

Do not commit `.env` or any key. Configure actual OpenAI model IDs through the `HARNESS_*_MODEL` environment variables. Do not invent model IDs.
