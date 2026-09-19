# Trencher Agent Harness V1

A small control plane for routing engineering work to the cheapest capable frontier agent while enforcing deterministic safety, bounded context, targeted verification, and anti-loop limits.

## What V1 contains
- deterministic risk classification and fallback routing
- optional Jev/TypeSafe decision adapter boundary
- logical agent roles: scout, engineer, deep debugger, reviewer, exceptional escalation
- compact evidence packets/task ledgers
- two-strike anti-loop controller
- deterministic protected-action policy
- provider-neutral delegation requests
- ChatGPT/Codex-facing `SKILL.md`

Jev is a **decision layer**, not an authority. Hard safety rules always win.

## Quick start
```bash
npm test
npm run smoke
```
No API key is required.

## Jev later
When TypeSafe access arrives, set `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and if required `TYPESAFE_MODEL`. The exact Jev response normalization is intentionally isolated so V1 does not guess an unconfirmed API contract.

## Flow
```text
request
  -> deterministic policy/risk gate
  -> compact evidence packet
  -> Jev advice (when configured) OR deterministic router
  -> scout / engineer / deep debugger
  -> targeted verification
  -> independent reviewer
  -> complete / stop / escalate
```

## Next milestone
V2 can add real provider adapters/MCP exposure once the desired provider APIs and TypeSafe contract are confirmed.
