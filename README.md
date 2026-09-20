# Trencher Multi-Provider Orchestrator

A bounded control plane for routing engineering tasks to native ChatGPT/Codex agents or verified xAI, DeepSeek, and Kimi API delegates. Jev selects the validated worker and target; deterministic safety/capability floors, server-owned accounting, and finite context remain authoritative.

## Safety and execution model

- The ChatGPT/Codex host commander is authoritative. OpenAI Astra, Sol, Terra, and Luna routes are returned as `native_host` handoffs using ChatGPT plan usage; the harness never dispatches them through the OpenAI API adapter. API commander mode fails closed.
- Only xAI/Grok, DeepSeek, and Kimi are executable API providers. Their generation plus Jev requires `HARNESS_ENABLE_PAID_EXECUTION=true`; server-owned accounting and budgets still apply.
- One batched Jev request recommends task type, complexity, risk, worker, target, context, parallelism, verification, and review. A structurally valid registered worker/provider/model/effort is accepted regardless of confidence unless a deterministic safety or capability floor rejects it. Confidence still cannot justify unsafe context expansion. Jev requires the paid-execution owner gate plus a positive operator-supplied `HARNESS_JEV_CALL_COST_USD` conservative bound.
- Every plan exposes requested, recommended, effective routing, selection source/rejection reasons, overrides, parallel limits, and a route-once-per-phase reuse contract.
- A caller-supplied `requestedRoute` does not replace a valid Jev target unless `requestedRouteAuthorized` confirms that the user explicitly selected it; deterministic capability floors still apply.
- Native OpenAI handoffs are explicitly `subagent-only` and `parentModelUnchanged`. Up to three independent, non-overlapping workstreams can run in parallel; the host performs the actual Codex subagent spawn, integration, and verification.
- Delegates receive finite evidence packets and only the `request_context` and `report_result` continuation tools. They receive no shell, filesystem, deploy, secret, or financial tools.
- `resume_routed_task` continues only a server-recorded job that ended with `bounded-context-requested`. It accepts newly approved bounded evidence, preserves the original task, target, attempt and aggregate token/cost budgets, links accounting history, uses Responses `previous_response_id` where supported, and creates a bounded follow-up for chat adapters. Unsafe paths, secret-like evidence, arbitrary overrides, replayed continuations, and non-resumable jobs fail closed.
- Provider output uses `status`, `findings`, `artifact`, `evidence`, `tests`, `blockers`, and `usage`. Output or patches over the finite limit remain visible but are marked incomplete.
- The server atomically reserves concurrency and estimated cost before dispatch. It owns task/day ledgers, job IDs, starts, dedupe, deadlines, cancellation, and final reconciliation. Caller-supplied state and budgets cannot increase policy limits.
- Defaults are three concurrent jobs (also the hard maximum), three starts per task, $1/task, and $5/day. A second start requires new causal evidence. A third and final start additionally requires explicit owner authorization and a reason; a fourth is blocked. Unknown price or uncertain billing fails closed.

## Verified registry

Catalog metadata was verified on 2026-09-20. OpenAI models are native-host targets and therefore have no API price in the execution registry. External API prices are USD per million input/output tokens: xAI Grok 4.6 2/6; DeepSeek Flash 0.30/1.20 and V4 Pro 1.32/3.96 using peak cache-miss input; Kimi K3 3/15 cache-miss input/output. Sources: [OpenAI models](https://developers.openai.com/api/docs/models), [xAI models](https://docs.x.ai/developers/models), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), and [Kimi API overview](https://www.kimi.ai/help/kimi-api/api-overview).

Call `provider_readiness` once per build session to see all native/external readiness in one response. `provider_status` can inspect or refresh one provider and intersect the external-provider registry with the account-visible catalog. For OpenAI both report `native_host` ready without reading a key or contacting the API. There is no silent substitution. Kimi Open Platform is distinct from Kimi Code; use `KIMI_API_KEY` (or the optional `MOONSHOT_API_KEY` alias).

## Run and verify

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
