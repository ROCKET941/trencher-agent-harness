---
name: trencher-frontier-router
description: Route bounded engineering work across verified OpenAI, xAI, DeepSeek, and Kimi API delegates with deterministic safety and server-owned accounting.
---

# Trencher Frontier Router

Use for coding or research tasks that benefit from a paid API delegate. Prefer native host subagents when the host already provides them; this skill's API delegates are separately billed remote models and may receive provider-visible task material.

## Sequence
1. Build a compact evidence packet; never bulk-read a repository.
2. Apply deterministic policy and risk classification.
3. Keep host commander mode unless the owner explicitly opts into the billed API commander.
4. Send retrieval/mechanical work to `scout`, normal implementation to `engineer`, and ambiguous high-risk diagnosis to `deep_debugger`.
5. If configured, ask Jev once for the batched plan; deterministic policy and the verified model registry remain authoritative.
7. After one failed implementation require new evidence before another attempt.
8. After two failed attempts stop and create an escalation packet.
9. Use a fresh bounded reviewer for meaningful normal/high-risk changes.
10. Inspect job/accounting status and return the compact result schema. Never report truncated output as complete.

## Context and retrieval budgets
- `tight`: <=3 source files, <=2 targeted tests and <=1 documentation excerpt; use exact/localized evidence.
- `normal`: <=6 source files, <=3 targeted tests and <=2 documentation excerpts; inspect direct dependencies only.
- `expanded`: <=8 source files, <=4 targeted tests and <=3 documentation excerpts; still finite and allowed only for a concrete evidence gap, ambiguity or mandatory high-risk investigation.

Use `exact`, `adjacent` or exceptional `exploratory` retrieval as assigned. Delegations receive compact packets, not transcripts. Individual entries are size-capped and marked when truncated. Before provider execution, conservatively estimate the serialized request and block it when it exceeds `HARNESS_MAX_ESTIMATED_INPUT_TOKENS` (falling back to `HARNESS_MAX_INPUT_TOKENS`).

## Hard boundaries
A model or Jev recommendation cannot authorize deployment, destructive Git operations, secret access, financial execution, wallet-permission changes, retry-budget expansion, or path traversal. Unknown pricing, unsupported efforts, unavailable models, uncertain billing, missing new causal evidence, and duplicate host/API commanders stop execution.
