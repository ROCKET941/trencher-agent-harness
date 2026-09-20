# Historical V1.1 MCP overlay

This document describes the superseded V1.1 surface. See `README.md` for the current v1.0.0 multi-provider orchestrator. The original six tools remain backward compatible and the current release adds execution and status/accounting tools.

V1.1 exposes the V1 controller as six MCP tools:

- `route_task`
- `build_evidence_packet`
- `check_continue`
- `check_action`
- `create_delegation`
- `review_route`

It uses the official MCP TypeScript v2 server packages and stdio transport. Jev remains optional.

## Apply over V1

Copy this overlay into the repository root, replacing `package.json`, then:

```bash
npm install
npm test
npm run smoke
npm run mcp:smoke
```

For local MCP hosts, launch with:

```bash
npm run mcp
```

Do not put secrets in Git. `TYPESAFE_API_KEY` remains runtime-only.
