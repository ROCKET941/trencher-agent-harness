---
name: trencher-frontier-router
description: Use the enabled trencher_frontier_router MCP for Jev-directed, bounded engineering orchestration when the user requests Jev, the Trencher harness/router, or a Trencher build configured to use it. Do not activate for unrelated coding tasks.
---

# Trencher Frontier Router

Use when the user requests this harness. Astra, Sol, Terra, and Luna must run as native ChatGPT/Codex host agents using plan usage. Only Grok/xAI, DeepSeek, and Kimi run as separately billed API delegates and may receive provider-visible task material.

## Sequence
1. Build a compact evidence packet; never bulk-read a repository.
2. Apply deterministic policy and risk classification.
3. Keep native host commander mode. API commander mode is disabled and fails closed.
4. Call `provider_readiness` once at the start of a build session, not before every small step. `refresh:false` reports configuration, not verified connectivity; use `refresh:true` when a fresh account-catalog check is needed. If an older conversation lacks the additive tool, continue without repeatedly probing it.
5. Call `route_task` once per meaningful build phase. Reuse that plan until risk, scope, causal evidence, or provider readiness materially changes.
6. Follow `routingDecision.effective`, not the raw recommendation. In one batch Jev independently assesses execution lane (`native_host`/`external_api`), conditional model choices, and task effort. A confident lane survives uncertain model advice using the cheapest capable candidate within that lane; uncertain effort uses a supported role default without discarding the model. Inspect selection reasons; do not force provider diversity or silently substitute a native worker for an external route. Deterministic safety and capability floors remain authoritative.
   Do not pass `requestedRoute` by habit. Set `requestedRouteAuthorized: true` only when the user's latest instruction explicitly chooses that provider/model; otherwise an available valid Jev target remains effective.
7. A native handoff is subagent-only: keep the parent model unchanged. Parallel work requires strong Jev confidence or explicit validated disjoint workstreams with concrete file/test ownership and no dependencies. Spawn only the returned `maxAgents`; the parent integrates and verifies.
   For `external_api`, call `execute_routed_task` with the returned `routingDecision.decisionId` and optional budget/deadline only. Do not resend task, evidence, model overrides or retry authorization: the server pins those to the stored decision, avoids another Jev call, and deduplicates execution. The server retains at most 128 plans for 30 minutes; expired/restarted plans require an explicit new route. Do not fall back to legacy route-and-execute after an unknown decision without explaining the new route.
   External workers cannot browse the repository, edit files or run tests. Supply the relevant bounded code/diff excerpts before routing, not only paths. The parent applies and tests returned patches, or uses `resume_routed_task` with approved evidence for a specific context request. A job marked incomplete or blocked is not a completed build.
8. After one failed implementation require new causal evidence before another attempt. A third and final attempt requires explicit authorization in the latest owner message, new causal evidence, and `retryReason`; it cannot expand the fixed retry cap.
9. Use `review_route` once after integrated implementation and tests when deterministic policy requires review or Jev recommends it. Do not route each review step separately.
10. Reuse `routingDecision.decisionId` and its payload/evidence digests when explaining or auditing a route. Inspect job/accounting status and return the compact result schema. Native tool use is governed by the host; API delegates are limited to `request_context` and `report_result`. Never report truncated output as complete.

## Context and retrieval budgets
- `tight`: <=3 source files, <=2 targeted tests and <=1 documentation excerpt; use exact/localized evidence.
- `normal`: <=6 source files, <=3 targeted tests and <=2 documentation excerpts; inspect direct dependencies only.
- `expanded`: <=8 source files, <=4 targeted tests and <=3 documentation excerpts; still finite and allowed only for a concrete evidence gap, ambiguity or mandatory high-risk investigation.

Use `exact`, `adjacent` or exceptional `exploratory` retrieval as assigned. Delegations receive compact packets, not transcripts. Individual entries are size-capped and marked when truncated. Before provider execution, conservatively estimate the serialized request and block it when it exceeds `HARNESS_MAX_ESTIMATED_INPUT_TOKENS` (falling back to `HARNESS_MAX_INPUT_TOKENS`).

## Hard boundaries
A model or Jev recommendation cannot authorize deployment, destructive Git operations, secret access, financial execution, wallet-permission changes, retry-budget expansion, path traversal, or OpenAI API execution. Unknown pricing, unsupported efforts, unavailable models, uncertain billing, and missing new causal evidence stop execution. A native OpenAI route returns a plan-usage host subagent handoff; it is never silently converted into an API call or applied to the parent model.
