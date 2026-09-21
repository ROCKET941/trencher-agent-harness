# Trencher Multi-Provider Orchestrator

A bounded control plane for routing engineering tasks to native ChatGPT/Codex agents or verified xAI, DeepSeek, and Kimi API delegates. Jev selects the validated worker and target; deterministic safety/capability floors, server-owned accounting, and finite context remain authoritative.

## Safety and execution model

- The permanent native commander is GPT-6 Astra XHigh on ChatGPT plan usage. Luna Max is the only research subagent and may read, trace and report, never edit, review final work or commit. Native coding stays with Astra; Sol/Terra are outside the routing pool. One independent read-only reviewer checks the complete integrated diff before commit; Astra retains final signoff. Complete Astra-authored packets may use a Jev-selected external reviewer; legacy, external-authored or incomplete packets use fresh native Astra. API commander mode fails closed.
- Only xAI/Grok, DeepSeek, and Kimi are executable API providers. Their generation plus Jev requires `HARNESS_ENABLE_PAID_EXECUTION=true`; server-owned accounting and budgets still apply.
- One batched Jev request independently assesses execution lane, hypothetical native/external model choices, task effort, worker, context, parallelism and review. For one to three explicitly owned, non-overlapping workstreams, that same request also selects each workstream's lane, model and effort. Questions do not depend on other answers in the batch. `JEV_LANE_MIN_CONFIDENCE` defaults to 0.70; `JEV_MIN_CONFIDENCE` remains the independent model/effort floor. Jev selects for expected correctness, task fit, evidence sufficiency and risk, then measured performance when available, latency and finally cost. A confident external lane with uncertain model advice uses the highest-capability configured candidate, with price only breaking equal-capability ties. Uncertain external effort defaults to high without rejecting the model. Native efforts are fixed at Luna Max / Astra XHigh. Without a qualified lane, Astra owns implementation and Luna owns research. No provider quotas or extra agents are introduced. Jev requires the paid-execution gate plus a positive `HARNESS_JEV_CALL_COST_USD` bound.
- Every plan exposes requested, recommended, effective routing, selection source/rejection reasons, overrides, parallel limits, a stable `decisionId`, SHA-256 payload/evidence digests, and a route-once-per-phase reuse contract.
- Execute an external plan with `execute_routed_task({decisionId})` and optional budget/deadline. A bounded process cache pins the task, evidence, target and retry authority; execution does not ask Jev again. Caller overrides are rejected, duplicate execution is idempotent, and paid/key/budget gates are checked at execution. The cache holds 128 plans for 30 minutes; expiry or restart returns an explicit unknown-decision error without silently rerouting. Legacy route-and-execute calls without an ID remain supported.
- A caller-supplied `requestedRoute` does not replace a valid Jev target unless `requestedRouteAuthorized` confirms that the user explicitly selected it; deterministic capability floors still apply.
- Native handoffs keep `parentModelUnchanged`: Luna research uses `subagent-only`, Astra implementation uses `commander`, and final acceptance uses `fresh-final-reviewer`. Three-agent fan-out requires strong Jev parallel confidence (minimum 0.80) or three explicit validated workstreams; explicit two-way disjoint work may run as two. Each workstream is limited to three owned source paths and two test paths so validated ownership always fits its tight assignment packet. Ownership collisions, dependencies, ambiguous paths, oversized ownership, and missing file/test ownership reduce execution to one worker. Valid workstreams return ordered `routingDecision.parallel.assignments`, each with its own pinned `decisionId`, effective target, bounded delegation and execution instructions. A Luna assignment becomes a read-only host subagent; an Astra implementation assignment stays with the commander; an external assignment is executed by its own decision ID. Diversity is never forced, and the parent integrates and verifies every result.
- API delegates receive finite supplied-content packets and only `request_context` and `report_result` tools, with no shell, filesystem, deploy, secret, or financial tools. Paths are not file contents: supply bounded source/diff excerpts for external analysis and patch generation. External workers may return complete candidate implementations. Astra inspects, applies or rejects each patch, integrates and tests the result. High-risk or ambiguous integration stays with Astra. The harness cannot observe or enforce every native host read, edit or Git command.
- `review_route` retains the legacy native Astra route without a Jev call unless complete Astra-authored review evidence is supplied. In that case one batched Jev request chooses a capable independent external reviewer and effort. `JEV_REVIEW_MIN_CONFIDENCE=0` accepts a valid preference among prequalified read-only challengers even when their ranking is close; this confidence is not review accuracy or release approval. Operators may raise the cutoff (0..1); malformed advice still falls back. Other selection/safety floors, exact-artifact acceptance and Astra final signoff are unchanged. No reviewer-per-worker fan-out.
- `resume_routed_task` continues only a server-recorded job that ended with `bounded-context-requested`. It accepts newly approved bounded evidence, preserves the original task, target, attempt and aggregate token/cost budgets, links accounting history, uses Responses `previous_response_id` where supported, and creates a bounded follow-up for chat adapters. Unsafe paths, secret-like evidence, arbitrary overrides, replayed continuations, and non-resumable jobs fail closed.
- Provider output uses `status`, `findings`, `artifact`, `evidence`, `tests`, `blockers`, and `usage`. Output or patches over the finite limit remain visible but are marked incomplete.
- The server atomically reserves concurrency and estimated cost before dispatch. It owns task/day ledgers, job IDs, starts, dedupe, deadlines, cancellation, and final reconciliation. Successful Jev calls reconcile the conservative reservation to reported input usage at `HARNESS_JEV_INPUT_USD_PER_MILLION` (default `0.042`; output free); missing usage or ambiguous transport retains the conservative charge. Caller-supplied state and budgets cannot increase policy limits.
- Defaults are three concurrent jobs (also the hard maximum), three starts per task, $1/task, and $5/day. A second start requires new causal evidence. A third and final start additionally requires explicit owner authorization and a reason; a fourth is blocked. Unknown price or uncertain billing fails closed.

## Task selection

Ordinary external coding candidates are Grok 4.6, DeepSeek V4 Pro and Kimi K3. DeepSeek Flash is eligible only when the host explicitly supplies `taskKind:"mechanical"`, one relevant source file, concrete evidence, an established root cause, no unresolved questions and no high risk. These checks apply to each workstream and again at API execution. A Flash continuation may add bounded evidence for that same canonical source, but any new source-file or inspected-path ownership is denied and requires a newly routed capable worker. Labels cannot weaken risk classification. Provider diversity is optional; correctness takes priority over price.

## Final acceptance and commit gate

Follow [the acceptance contract](references/acceptance.md) for exact artifact hashing, review input, server-owned external receipts and the commit gate. Native review remains backward compatible. External review requires complete source/diff coverage of at most eight changed files, explicit Astra-only authorship, no truncation, a completed matching provider job, and Astra's final signoff. Missing coverage, malformed output, incomplete jobs, stale artifacts or forged receipts cannot authorize commit.

Verification, authorship, completeness of supplied source and native-review identities remain host attestations. The server cannot inspect local Git, authenticate native agent messages or intercept arbitrary host commands. External review results are recorded in the existing accounting ledger; no additional service or database is needed.

## Compact source handoffs

Supply `excerpts:[{path,range,content}]` at phase or workstream scope; each excerpt is capped at 6,000 characters and the source count follows the finite context profile. Truncation is explicit. Workstreams receive their own excerpts/facts/inspection pointers, never an unrelated parent packet. Even a single workstream returns a pinned executable assignment. The route exposes `modelSelectionSource` separately from the worker-role reason and reports native/external candidate counts: a singleton native confidence score is not a cross-provider benchmark.

Prepare source once, reuse compact facts, and reroute only when material causal evidence makes a new bounded assignment possible. API workers cannot retrieve files themselves. Native file reads, cache behavior and context assembly remain outside this MCP's enforcement.

## Trusted-host protected-action approval

MCP arguments are model-supplied, so `explicitlyAuthorized:true` never proves owner approval. For deployment or another eligible non-commit protected action, the user's latest message must explicitly approve the exact action and scope. An administrator then uses the trusted server shell—not MCP—to mint a short-lived, one-time approval:

```bash
set -a; . /etc/trencher-agent-harness.env; set +a
runuser -u trencher-harness --preserve-environment -- /opt/nodejs/node-v22.22.1-linux-x64/bin/node scripts/approve-action.mjs --action deploy --scope "production:trade-page:<artifact-or-release>" --reason "Owner approved this exact production release"
```

The CLI is disabled unless `HARNESS_ENABLE_TRUSTED_APPROVALS=true`. It writes only to the server-owned approval ledger, defaults to a 10-minute lifetime, and returns an `approvalId`. The commander calls `check_action({action:"deploy",approval:{id:approvalId,scope:"production:trade-page:<artifact-or-release>"}})` and may proceed only when it returns `allowed:true`. Action or scope mismatches, expiration, reuse, disabled configuration and MCP-only authorization are denied. Commit continues to require the separate final-acceptance gate; trusted approvals cannot bypass commit or retry-budget policy. The harness authorizes the named boundary but still cannot intercept commands run outside it.

Approval-ledger locking fails closed. If `approval-store-lock-timeout` occurs, never delete the `.lock` directory while the service or an approval CLI may still be writing. Stop the service, confirm no approval CLI process remains, remove only the approval ledger's exact `.lock` directory, then restart the service. This prevents delayed writers from overlapping operator recovery.

## Verified registry

Catalog metadata was verified on 2026-09-20. OpenAI models are native-host targets and therefore have no API price in the execution registry. External API prices are USD per million input/output tokens: xAI Grok 4.6 2/6; DeepSeek Flash 0.30/1.20 and V4 Pro 1.32/3.96 using peak cache-miss input; Kimi K3 3/15 cache-miss input/output. Sources: [OpenAI models](https://developers.openai.com/api/docs/models), [xAI models](https://docs.x.ai/developers/models), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), and [Kimi API overview](https://www.kimi.ai/help/kimi-api/api-overview).

Call `provider_readiness` once per build session. `refresh:false` indicates configuration, not live connectivity (`reachable:null`). `refresh:true` checks account-visible models; failed/empty catalogs are not ready. Routing candidates exclude missing keys and a disabled paid gate; a later API failure is reported rather than silently switching providers. For OpenAI, readiness is host-managed without reading a key or contacting the API. Kimi Open Platform is distinct from Kimi Code; use `KIMI_API_KEY` (or the optional `MOONSHOT_API_KEY` alias).

## Run and verify

After releasing, install both SKILL.md and references/acceptance.md and refresh the task's MCP connection (a new task is the reliable option when its schema is stale). A task without excerpts/reviewContext support must keep the legacy native review path. No new credential is required; `JEV_LANE_MIN_CONFIDENCE` defaults to 0.70. Keep API commander disabled. Legacy `HARNESS_*_MODEL/PROVIDER/EFFORT` role overrides are ignored so they cannot weaken the fixed native contract.

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
