---
name: trencher-frontier-router
description: Route coding work across frontier agents with bounded context, deterministic safety, anti-loop controls, and optional Jev decisions.
---

# Trencher Frontier Router

Use for coding/research tasks that benefit from delegation across different agent capabilities.

## Sequence
1. Build a compact evidence packet; never bulk-read a repository.
2. Apply deterministic policy and risk classification.
3. Send retrieval/mechanical work to `scout`.
4. Send normal implementation to `engineer`.
5. Send ambiguous high-risk diagnosis to `deep_debugger`.
6. If configured, ask Jev once for worker, context profile, retrieval mode, expansion and review advice; policy remains authoritative.
7. After one failed implementation require new evidence before another attempt.
8. After two failed attempts stop and create an escalation packet.
9. Use a fresh bounded reviewer for meaningful normal/high-risk changes.
10. Return a compact completion report.

## Context and retrieval budgets
- `tight`: <=3 source files, <=2 targeted tests and <=1 documentation excerpt; use exact/localized evidence.
- `normal`: <=6 source files, <=3 targeted tests and <=2 documentation excerpts; inspect direct dependencies only.
- `expanded`: <=10 source files, <=5 targeted tests and <=4 documentation excerpts; still finite and allowed only for a concrete evidence gap, ambiguity or mandatory high-risk investigation.

Use `exact`, `adjacent` or exceptional `exploratory` retrieval as assigned. Delegations receive compact packets, not transcripts. Individual entries are size-capped and marked when truncated. Before provider execution, conservatively estimate the serialized request and block it when it exceeds `HARNESS_MAX_ESTIMATED_INPUT_TOKENS` (falling back to `HARNESS_MAX_INPUT_TOKENS`).

## Hard boundaries
A model or Jev recommendation cannot authorize deployment, destructive Git operations, secret access, financial execution, wallet-permission changes, or retry-budget expansion.
