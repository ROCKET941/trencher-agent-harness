# Trencher Multi-Provider Orchestrator

A bounded, BYOK control plane for routing engineering tasks to verified OpenAI, xAI, DeepSeek, or Kimi models. Deterministic safety, server-owned accounting, and compact context always outrank Jev or model advice.

## Safety and execution model

- Host commander is the default. All paid generation requires `HARNESS_ENABLE_PAID_EXECUTION=true`. An API commander additionally requires its owner environment gate and per-call opt-in, is mutually exclusive with an active host commander, and is fixed to `openai/gpt-5.6-sol` at `xhigh`.
- One batched Jev request may recommend task type, complexity, risk, target, context, parallelism, verification, and review. Jev requires the paid-execution owner gate plus a positive operator-supplied `HARNESS_JEV_CALL_COST_USD` conservative bound. The server reserves that bound as an auxiliary call against the same derived task/day ledger, keeps retries inside the reservation, and charges the bound; missing gates or prices produce explicit unavailable advice and deterministic routing.
- Every plan exposes requested, recommended, effective routing, and any deterministic overrides.
- Delegates receive finite evidence packets and only the `request_context` and `report_result` continuation tools. They receive no shell, filesystem, deploy, secret, or financial tools.
- `resume_routed_task` continues only a server-recorded job that ended with `bounded-context-requested`. It accepts newly approved bounded evidence, preserves the original task, target, attempt and aggregate token/cost budgets, links accounting history, uses Responses `previous_response_id` where supported, and creates a bounded follow-up for chat adapters. Unsafe paths, secret-like evidence, arbitrary overrides, replayed continuations, and non-resumable jobs fail closed.
- Provider output uses `status`, `findings`, `artifact`, `evidence`, `tests`, `blockers`, and `usage`. Output or patches over the finite limit remain visible but are marked incomplete.
- The server atomically reserves concurrency and estimated cost before dispatch. It owns task/day ledgers, job IDs, starts, dedupe, deadlines, cancellation, and final reconciliation. Caller-supplied state and budgets cannot increase policy limits.
- Defaults are one concurrent job (hard maximum three), two starts per task, $1/task, and $5/day. A second start requires new causal evidence; a third is blocked. Unknown price or uncertain billing fails closed.

## Verified registry

Catalog and pricing metadata were verified on 2026-09-20. Prices are USD per million input/output tokens: OpenAI Luna 0.20/1.20, Terra 2/12, Sol 4/20, Astra 10/50; xAI Grok 4.6 2/6; DeepSeek Flash 0.30/1.20 and V4 Pro 1.32/3.96 using peak cache-miss input; Kimi K3 3/15 cache-miss input/output. Sources: [OpenAI models](https://developers.openai.com/api/docs/models), [xAI models](https://docs.x.ai/developers/models), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), and [Kimi API overview](https://www.kimi.ai/help/kimi-api/api-overview).

The `provider_status` tool can intersect this bounded registry with the model catalog visible to the configured account. There is no silent substitution. Kimi Open Platform is distinct from Kimi Code; use `KIMI_API_KEY` (or the optional `MOONSHOT_API_KEY` alias).

## Run and verify

```bash
npm install
npm test
npm run smoke
npm run provider:smoke
npm run mcp:smoke
npm run mcp:http:smoke
```

All checks above are offline and make no provider calls. Configure keys only at runtime using `.env.example`; keys and full request bodies are never written to the ledger or errors.

Start stdio with `npm run mcp`, or authenticated Streamable HTTP with `HARNESS_MCP_TOKEN` set and `npm run mcp:http`. Existing tools remain available: `route_task`, `build_evidence_packet`, `check_continue`, `check_action`, `create_delegation`, `review_route`, and `execute_routed_task`. Additive operations expose `resume_routed_task`, provider status, model catalog, job status, task usage, and cancellation.
