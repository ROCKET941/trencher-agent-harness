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
6. If configured, ask Jev for bounded routing/gating advice; policy remains authoritative.
7. After one failed implementation require new evidence before another attempt.
8. After two failed attempts stop and create an escalation packet.
9. Use a fresh bounded reviewer for meaningful normal/high-risk changes.
10. Return a compact completion report.

## Normal context budget
Start with <=6 source files, <=3 targeted tests and <=2 documentation excerpts. Expansion requires a concrete evidence-based reason.

## Hard boundaries
A model or Jev recommendation cannot authorize deployment, destructive Git operations, secret access, financial execution, wallet-permission changes, or retry-budget expansion.
