# Multi-provider orchestrator (v1.0.0)

This release adds the verified four-provider registry, batched Jev planning, persistent server-owned accounting, bounded delegate tools, and stdio plus authenticated Streamable HTTP MCP entrypoints.

## Verify
1. `npm install`
2. `npm test`
3. `npm run smoke`
4. `npm run mcp:smoke` — update expected tool list to include `execute_routed_task`.
5. `npm run provider:smoke`
6. `npm run mcp:http:smoke`
7. Optionally, with `TYPESAFE_API_KEY` in runtime secrets only: `npm run jev:smoke`

Do not commit `.env` or any key. Model overrides must be present in the verified registry with an allowed reasoning effort. Provider status refreshes require the corresponding server-side key and make only a catalog request.
