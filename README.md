# Trencher Multi-Provider Orchestrator

A bounded control plane for routing engineering tasks to native ChatGPT/Codex agents or verified xAI, DeepSeek, and Kimi API delegates. Jev selects the validated worker and target; deterministic safety/capability floors, server-owned accounting, and finite context remain authoritative.

## Safety and execution model

- The ChatGPT/Codex host commander is authoritative. OpenAI Astra, Sol, Terra, and Luna routes are returned as `native_host` handoffs using ChatGPT plan usage; the harness never dispatches them through the OpenAI API adapter. API commander mode fails closed.
- Only xAI/Grok, DeepSeek, and Kimi are executable API providers. Their generation plus Jev requires `HARNESS_ENABLE_PAID_EXECUTION=true`; server-owned accounting and budgets still apply.
- One batched Jev request independently assesses execution lane, hypothetical native/external model choices, task effort, worker, context, parallelism and review. For two or three explicitly owned, non-overlapping workstreams, that same request also selects each workstream's lane, model and effort. Questions do not depend on other answers in the batch. `JEV_LANE_MIN_CONFIDENCE` defaults to 0.70; `JEV_MIN_CONFIDENCE` remains the independent model/effort floor. A confident external lane with uncertain model advice uses the cheapest capable configured external candidate, not a native fallback. Uncertain effort uses the role default mapped to a supported level without rejecting the model; role floors still apply. Without a qualified lane, use the configured capable role fallback. No provider quotas or extra agents are introduced. Jev requires the paid-execution gate plus a positive `HARNESS_JEV_CALL_COST_USD` bound.
- Every plan exposes requested, recommended, effective routing, selection source/rejection reasons, overrides, parallel limits, a stable `decisionId`, SHA-256 payload/evidence digests, and a route-once-per-phase reuse contract.
- Execute an external plan with `execute_routed_task({decisionId})` and optional budget/deadline. A bounded process cache pins the task, evidence, target and retry authority; execution does not ask Jev again. Caller overrides are rejected, duplicate execution is idempotent, and paid/key/budget gates are checked at execution. The cache holds 128 plans for 30 minutes; expiry or restart returns an explicit unknown-decision error without silently rerouting. Legacy route-and-execute calls without an ID remain supported.
- A caller-supplied `requestedRoute` does not replace a valid Jev target unless `requestedRouteAuthorized` confirms that the user explicitly selected it; deterministic capability floors still apply.
- Native OpenAI handoffs are explicitly `subagent-only` and `parentModelUnchanged`. Three-agent fan-out requires strong Jev parallel confidence (minimum 0.80) or three explicit validated workstreams; explicit two-way disjoint work may run as two. Each workstream is limited to three owned source paths and two test paths so validated ownership always fits its tight assignment packet. Ownership collisions, dependencies, ambiguous paths, oversized ownership, and missing file/test ownership reduce execution to one worker. Valid workstreams return ordered `routingDecision.parallel.assignments`, each with its own pinned `decisionId`, effective target, bounded delegation and execution instructions. A native assignment becomes a host subagent; an external assignment is executed by its own decision ID. Diversity is never forced, and the parent integrates and verifies every result.
- API delegates receive finite supplied-content packets and only `request_context` and `report_result` tools, with no shell, filesystem, deploy, secret, or financial tools. Paths are not file contents: supply bounded source/diff excerpts for external analysis and patch generation. The parent applies and tests their artifacts. Native delegates may use host workspace tools within the assigned scope; the harness cannot observe or enforce every native read.
- `review_route` produces a consistent reviewer role, target, packet and execution decision; Jev may choose a capable external reviewer, but never weaken the reviewer floor.
- `resume_routed_task` continues only a server-recorded job that ended with `bounded-context-requested`. It accepts newly approved bounded evidence, preserves the original task, target, attempt and aggregate token/cost budgets, links accounting history, uses Responses `previous_response_id` where supported, and creates a bounded follow-up for chat adapters. Unsafe paths, secret-like evidence, arbitrary overrides, replayed continuations, and non-resumable jobs fail closed.
- Provider output uses `status`, `findings`, `artifact`, `evidence`, `tests`, `blockers`, and `usage`. Output or patches over the finite limit remain visible but are marked incomplete.
- The server atomically reserves concurrency and estimated cost before dispatch. It owns task/day ledgers, job IDs, starts, dedupe, deadlines, cancellation, and final reconciliation. Successful Jev calls reconcile the conservative reservation to reported input usage at `HARNESS_JEV_INPUT_USD_PER_MILLION` (default `0.042`; output free); missing usage or ambiguous transport retains the conservative charge. Caller-supplied state and budgets cannot increase policy limits.
- Defaults are three concurrent jobs (also the hard maximum), three starts per task, $1/task, and $5/day. A second start requires new causal evidence. A third and final start additionally requires explicit owner authorization and a reason; a fourth is blocked. Unknown price or uncertain billing fails closed.

## Verified registry

Catalog metadata was verified on 2026-09-20. OpenAI models are native-host targets and therefore have no API price in the execution registry. External API prices are USD per million input/output tokens: xAI Grok 4.6 2/6; DeepSeek Flash 0.30/1.20 and V4 Pro 1.32/3.96 using peak cache-miss input; Kimi K3 3/15 cache-miss input/output. Sources: [OpenAI models](https://developers.openai.com/api/docs/models), [xAI models](https://docs.x.ai/developers/models), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), and [Kimi API overview](https://www.kimi.ai/help/kimi-api/api-overview).

Call `provider_readiness` once per build session. `refresh:false` indicates configuration, not live connectivity (`reachable:null`). `refresh:true` checks account-visible models; failed/empty catalogs are not ready. Routing candidates exclude missing keys and a disabled paid gate; a later API failure is reported rather than silently switching providers. For OpenAI, readiness is host-managed without reading a key or contacting the API. Kimi Open Platform is distinct from Kimi Code; use `KIMI_API_KEY` (or the optional `MOONSHOT_API_KEY` alias).

## Run and verify

After releasing, update the desktop's installed router skill from this repository and start a fresh thread so the MCP schema includes per-workstream evidence and pinned assignment execution. Existing conversations keep the schema captured when they began. No new credential or gate is required; `JEV_LANE_MIN_CONFIDENCE` defaults to 0.70 when unset. Keep API commander disabled.

```bash
npm install
npm test
npm run smoke
npm run provider:smoke
npm run mcp:smoke
npm run mcp:http:smoke
npm run benchmark
```

All checks above are offline and make no provider calls. Configure only the external provider keys you intend to use at runtime using `.env.example`; keys and full request bodies are never written to the ledger or errors.

For a scored end-to-end comparison against a running MCP endpoint, use `npm run benchmark:live`. This opt-in command makes paid Jev, xAI, DeepSeek, and Kimi calls; see `benchmark/README.md` for endpoint and output settings. It grades native-plan handoffs separately from external API execution.

Start stdio with `npm run mcp`, or authenticated Streamable HTTP with `HARNESS_MCP_TOKEN` set and `npm run mcp:http`. Existing tools remain available: `route_task`, `build_evidence_packet`, `check_continue`, `check_action`, `create_delegation`, `review_route`, and `execute_routed_task`. Additive operations expose `resume_routed_task`, provider readiness/status, model catalog, job status, task usage, and cancellation.
