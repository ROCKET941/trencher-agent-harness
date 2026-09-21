---
name: trencher-frontier-router
description: Use the enabled trencher_frontier_router MCP for Jev-directed, bounded engineering orchestration when the user requests Jev, the Trencher harness/router, or a Trencher build configured to use it. Do not activate for unrelated coding tasks.
---

# Trencher Frontier Router

Permanent commander: native GPT-6 Astra XHigh, using ChatGPT plan usage. Astra scopes, integrates, verifies and makes final decisions. The remote harness cannot switch or verify the parent model. Only Grok 4.6, DeepSeek V4 Pro and Kimi K3 use coding/review APIs; API commander mode is disabled. Luna Max is read-only research, never implementation or final review.

## Prepare once, route useful work

1. Refresh `provider_readiness` once per build session. Report unavailable providers; a configured key alone is not connectivity proof.
2. Gather the minimum relevant source, exact search results and requirements. Reuse current facts and inspected pointers; re-read when the source changes or evidence is incomplete. Never forward conversation history or giant logs.
3. Prepare bounded `excerpts:[{path,range,content}]` containing actual source/diffs, plus facts, tests, known root cause and remaining questions. Paths alone cannot support an external worker. Omit secrets and unrelated context. Do not label an evidence packet complete when it omits a relevant dependency or truncates a changed region.
4. Call `route_task` once per meaningful phase. For useful independent work, supply one to three `workstreams`, each with its own task, source excerpts, facts, owned files/tests and root cause. Do not place all source only in the parent packet: each worker receives only its own evidence. Split only when ownership is disjoint and the split reduces elapsed work.
5. Follow the effective target and explain its actual selection source. Jev may choose a provider, or policy may fall back. Confidence 1.0 among a singleton native menu does not prove superiority over external models. Never habitually supply model overrides or force provider diversity.
6. Execute external assignments once with `execute_routed_task({decisionId})` (optional budget/deadline only). Run independent assignments concurrently up to the returned limit while Astra does useful integration/test work. Native Astra assignments stay in the commander; Luna research uses one bounded Max subagent. Use every returned assignment, including a single workstream, without also executing the parent as duplicate work.

Astra need not write every change. Prefer an evidence-complete external candidate when suitable; retain native work needing interactive tools, unavailable source or difficult integration. When discovery establishes the cause, reassess whether a bounded external implementation is now possible. That material evidence change may justify one new route; minor follow-ups do not.

## Integrate and verify

External workers return candidate patches or findings; they have no repository, shell, Git, deployment or secret tools. Astra inspects, applies or rejects patches and performs real local verification. An API worker cannot truthfully claim local test execution.

Use `resume_routed_task` only for a server-recorded coding context request. Supply bounded approved excerpts without changing task or ownership. Incomplete, blocked or truncated output is not a completed build. Two ordinary implementation attempts are allowed; a third/final attempt requires new causal evidence, explicit owner authorization in the latest message and a reason. Never raise the cap.

Run checks proportional to the changed behavior and its consequences. Reuse valid results for unchanged bytes; rerun affected checks after corrections. Report concrete acceptance criteria and remaining blockers, not repeated generic review cycles.

## One independent review, Astra final signoff

Before acceptance or commit, read [references/acceptance.md](references/acceptance.md) and follow its exact artifact-bound contract.

- Astra-authored changes: `review_route` may select Kimi, Grok or DeepSeek as one independent read-only challenger when the complete bounded source/diff packet is supplied.
- External-authored, mixed-author, oversized or incomplete changes: use one fresh read-only native Astra reviewer. The commander must not certify its own independent review.
- Use the selected review slot, not an automatic external reviewer plus another full Astra review. A failed or incomplete external review is never acceptance; fallback must be explicit.
- Reviewers seek concrete defects with file/range and reproducible evidence, not cosmetic objections or invented problems. Astra adjudicates findings, corrects real defects, verifies, and owns final signoff. Changes invalidate prior acceptance.
- Existing tasks lacking the new schema must keep the legacy native review path; never fabricate new fields or claim a missing gate passed.

## Bounded context and safety

Profiles remain finite: tight <=3 sources/2 tests/1 doc; normal <=6/3/2; expanded <=8/4/3. Each source excerpt is <=6,000 characters with visible truncation. Complete review coverage is never replaced by silent truncation. Oversized reviews use the native reviewer in bounded batches.

Respect exact/adjacent/exploratory retrieval and protected boundaries. Provider request size, costs, retries and external receipts are server-enforced. Native reads, truthful source coverage, actual tests, agent identity and Git enforcement belong to the host. This MCP does not control the native conversation cache or observe every file read.

Jev cannot authorize deployments, destructive Git, secrets, financial execution, wallet permissions, retry expansion or OpenAI API spending. For explicitly authorized deployment, also read the trusted-host approval section in [references/acceptance.md](references/acceptance.md). Preserve deterministic safety and unknown-price/uncertain-billing stops. DeepSeek Flash remains restricted to the validated explicit one-file, known-cause, non-high-risk mechanical envelope; new source ownership requires rerouting.
