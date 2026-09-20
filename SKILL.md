---
name: trencher-frontier-router
description: Route bounded engineering work to native ChatGPT/Codex agents or verified xAI, DeepSeek, and Kimi API delegates with deterministic safety and server-owned accounting.
---

# Trencher Frontier Router

Use for coding or research tasks that benefit from bounded routing. Astra, Sol, Terra, and Luna must run as native ChatGPT/Codex host agents using plan usage. Only Grok/xAI, DeepSeek, and Kimi run as separately billed API delegates and may receive provider-visible task material.

## Sequence
1. Build a compact evidence packet; never bulk-read a repository.
2. Apply deterministic policy and risk classification.
3. Keep native host commander mode. API commander mode is disabled and fails closed.
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
A model or Jev recommendation cannot authorize deployment, destructive Git operations, secret access, financial execution, wallet-permission changes, retry-budget expansion, path traversal, or OpenAI API execution. Unknown pricing, unsupported efforts, unavailable models, uncertain billing, and missing new causal evidence stop execution. A native OpenAI route returns a host handoff; it is never silently converted into an API call.
