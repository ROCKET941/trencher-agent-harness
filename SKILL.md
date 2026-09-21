---
name: trencher-frontier-router
description: Use the enabled trencher_frontier_router MCP for Jev-directed, bounded engineering orchestration when the user requests Jev, the Trencher harness/router, or a Trencher build configured to use it. Do not activate for unrelated coding tasks.
---

# Trencher Frontier Router

Use a permanent native GPT-6 Astra XHigh commander on ChatGPT plan usage. Astra owns planning, integration, verification and commits. The remote harness cannot switch or verify the parent model; confirm the host task is configured accordingly before claiming this workflow. API commander mode is disabled.

## Ownership

- Luna Max is research-only: read, trace callers/dependencies, run read-only diagnostics and return compact findings. Never assign it edits, implementation, final review, approval or commits.
- Grok 4.6, DeepSeek V4 Pro and Kimi K3 may produce complete candidate implementations. Jev chooses for expected correctness, task fit, evidence sufficiency and risk, then relevant measured performance when available, latency and finally cost. Never force provider diversity or substitute a cheaper worker for an effective choice.
- DeepSeek Flash requires explicit `taskKind:"mechanical"`, one source file, concrete evidence, a known root cause, no unresolved questions and no high risk. A continuation may add excerpts or pointers only for that same canonical source; new source ownership requires a newly routed capable worker. Do not label ordinary coding mechanical to obtain Flash.
- External workers have no repository, shell, filesystem or Git access. Supply bounded source/diff excerpts, not only paths. Astra inspects, applies or rejects each candidate patch and performs integration and real tests. Cross-cutting, ambiguous or high-risk integration stays with Astra.
- Exactly one fresh, read-only Astra XHigh final reviewer accepts the complete integrated change after verification. It must not have implemented that change. Reuse that reviewer for corrections; do not add one per worker. Both Astra roles and Luna use ChatGPT plan usage; only xAI, DeepSeek and Kimi use model APIs.

## Route and execute

1. Build compact evidence first. Call `provider_readiness` once per build session, using `refresh:true` for a live account-catalog check. Configuration readiness is not connectivity proof. An old conversation missing an additive tool may continue routing, but cannot claim an unavailable commit gate passed; refresh the task schema before committing.
2. Call `route_task` once per meaningful phase. Reuse the plan until risk, scope, causal evidence or readiness materially changes. Follow `routingDecision.effective` and its explanation. Jev chooses lane/model/effort/context/parallelism in one request; deterministic capability and safety floors remain authoritative. Legacy role model/effort environment overrides cannot lower the native contract.
3. Do not habitually supply `requestedRoute`. Set `requestedRouteAuthorized:true` only for an explicit user-selected target; it still cannot bypass capability or final-review floors.
4. Use every ordered `parallel.assignments` entry once at no more than returned `maxAgents` concurrency. Spawn Luna research at Max; keep Astra implementation with the commander; execute external assignments by their own `decisionId`. Respect ownership and dependencies. Identical independently selected external models are valid.
5. Call `execute_routed_task({decisionId})` with optional budget/deadline only. Never resend task/evidence/model/retry authority. The server pins the plan and deduplicates execution without another Jev call. It retains 128 plans for 30 minutes; explain expiry/restart before routing again.
6. Use `resume_routed_task` only for a server-recorded context request, supplying approved bounded evidence. Incomplete, blocked, truncated or untested artifacts are not completed builds.
7. After one failed implementation require new causal evidence before retry. A third and final attempt needs explicit owner authorization in the latest message, new evidence and a reason; the cap cannot increase.

## Mandatory final acceptance

Every implementation, including mechanical work, requires Astra final acceptance even if Jev advises otherwise. Read-only research alone does not.

1. Astra integrates, runs required tests/build/type checks/lint, inspects scope and stages only intended changes. Compute a SHA-256 artifact digest over the base commit and complete staged binary diff, including new files. Confirm unintended unstaged changes do not affect the tested artifact.
2. Call `review_route` with bounded evidence and `reviewContext:{artifactDigest,commanderAgentId}`. This fixed native Astra XHigh route makes no Jev call. Spawn one fresh read-only reviewer with the pinned delegation, complete integrated diff and check results. Inspect large diffs in bounded batches; never accept unreviewed or truncated portions.
3. Obtain explicit acceptance with zero blockers for that digest. Astra resolves findings, reruns affected checks and returns the updated artifact to the same reviewer. Artifact changes invalidate prior verification/acceptance; renew reviewContext for the new digest without adding reviewers.
4. Call `check_action` with `action:"commit"` and `commit:{reviewDecisionId,artifactDigest,commander,review,verification}`. Commander: `agentId,provider:"openai",model:"gpt-6-astra",effort:"xhigh"`. Review: a distinct `agentId`, `provider:"openai"`, same model/effort and digest, `fresh:true,readOnly:true,accepted:true,blockers:[]`. Verification: same digest, `scopeVerified:true`, and checks for `tests,build,typecheck,lint`, each with `status:"passed"` and concise evidence. Only non-test checks may be `not_applicable`, with a reason and evidence that the project lacks that check.
5. Only Astra commander may commit, after `allowed:true`, with the checked artifact unchanged and user commit authorization in scope. Never claim a missing/failed/expired gate passed. These are host attestations: the server checks them against its pinned review route but cannot inspect local Git, authenticate agent messages or intercept host commands. The host must enforce denial before Git.

## Trusted-host approval for deployment

`explicitlyAuthorized:true` is model-supplied and is never a trusted approval. After the user's latest message explicitly authorizes an exact eligible protected action and scope, use a trusted administrator shell on the harness host to run the `approve:action` CLI as the harness service account so its persistent ledger remains service-owned. This CLI is not exposed through MCP and works only when `HARNESS_ENABLE_TRUSTED_APPROVALS=true`. Pass its short-lived `approvalId` and the identical scope to `check_action` as `approval:{id,scope}`. Proceed only on `allowed:true`; the approval expires and is consumed once. Never mint approval based on model/Jev advice, infer broader scope, reuse an ID, or use this path to bypass the commit gate or retry budget. If the trusted host is unavailable, report that deployment remains blocked. On `approval-store-lock-timeout`, fail closed; an administrator may remove the exact lock only after stopping the service and confirming no approval CLI process remains.

## Context and protected boundaries

`tight`: <=3 source files, <=2 targeted tests, <=1 doc. `normal`: <=6 files, <=3 tests, <=2 docs. `expanded`: <=8 files, <=4 tests, <=3 docs, only for a concrete evidence gap, ambiguity or high risk. All profiles are finite. Use exact, adjacent or exceptional exploratory retrieval as assigned; reuse facts/read pointers instead of repeated discovery, transcripts or giant logs. Preflight serialized requests against `HARNESS_MAX_ESTIMATED_INPUT_TOKENS` (fallback `HARNESS_MAX_INPUT_TOKENS`). Native reads and review batching are host-enforced.

Jev cannot authorize deployments, destructive Git, secrets, financial execution, wallet permissions, retry expansion, traversal or OpenAI API calls. Only an explicit owner instruction plus the scoped trusted-host approval path can authorize eligible non-commit protected actions. Unknown prices, unsupported efforts, unavailable models, uncertain billing and missing causal evidence stop execution. Preserve protected-action authorization, risk floors, accounting and bounded outputs.
