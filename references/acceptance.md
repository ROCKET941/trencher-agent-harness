# Acceptance and protected actions

## Prepare an exact artifact

Astra integrates, runs required tests/build/type checks/lint, inspects scope and stages only intended changes. Compute SHA-256 over the base commit plus complete staged binary diff (including new files). Ensure unrelated unstaged changes do not affect the tested artifact.

Call `review_route` with `reviewContext:{artifactDigest,commanderAgentId}`. This legacy shape still selects one fresh read-only native Astra XHigh reviewer without a Jev call.

For cross-model review, also supply:
- `implementationProviders:["openai"]` only when all implementation was native OpenAI. For external or mixed authorship, report all actual providers; never relabel a patch to obtain a reviewer.
- `changedFiles`: the complete changed-file manifest.
- `evidenceComplete:true` only after supplying every changed region, necessary surrounding code/dependencies, requirements and test evidence in bounded `excerpts`, facts and tests. This is a host attestation, not a server filesystem scan.

The server selects the smallest fitting finite profile. External review requires <=8 changed files, a source/diff excerpt for each, no screened/truncated packet fields, configured providers and valid Jev advice. Otherwise it returns an explained native fallback. `reviewMode:"native"` explicitly requests that fallback. One batched reviewer/effort request is used; there is no second execution-lane veto. Ranking confidence describes relative model preference, not the probability of a correct review. `JEV_REVIEW_MIN_CONFIDENCE` defaults to 0: a close ranking among prequalified read-only challengers is accepted. Operators may raise this cutoff (0..1); malformed/unavailable advice still falls back. This never waives complete evidence, artifact-bound acceptance, actual verification or Astra signoff.

## Execute and interpret the review

Native: spawn one fresh, read-only Astra XHigh reviewer that did not implement the change, using the pinned delegation and exact artifact. Review large diffs in bounded batches; all changed regions must be inspected. Reuse this reviewer for corrections.

External: call `execute_routed_task({decisionId})`. It receives no author transcript and cannot execute tests. Its `report_result` must include `artifact:null` and `review:{artifactDigest,accepted,coveredFiles}`, alongside findings, evidence, tests and blockers. Acceptance requires complete coverage, no blockers, no truncation/provider failure and a completed server-owned job with `job.review.accepted:true`. Check job status after an idempotent replay rather than dispatching again.

A missing-evidence review cannot be resumed into acceptance under its old packet. Prepare a new complete review route, or explicitly use native review. Resolve actionable findings; a changed artifact requires a new digest and review. Do not add reviewers for each workstream or repeatedly review unchanged accepted bytes. An external review is independent analysis, never permission to release.

## Commit contract

Call `check_action({action:"commit",commit:{reviewDecisionId,artifactDigest,commander,review,verification}})`.

- Commander: `agentId,provider:"openai",model:"gpt-6-astra",effort:"xhigh"`. External-reviewed changes additionally require `accepted:true`, recording Astra's final signoff.
- Review: distinct `agentId`, actual selected `provider,model,effort`, same artifact digest, `fresh:true,readOnly:true,accepted:true,blockers:[]`.
- External review additionally uses `jobId` from the actual server result and `agentId:"job:<jobId>"`. The server verifies that completed job against the pinned decision, provider, exact packet and artifact. A caller-written approval cannot replace it.
- Verification: same digest, `scopeVerified:true`, and checks for `tests,build,typecheck,lint`, each with `status:"passed"` and concise evidence. Only non-test checks may be `not_applicable`, with a reason and evidence that the project lacks that check.

Only Astra may commit, after `allowed:true`, with the checked artifact unchanged and user commit authorization in scope. Expired review plans require renewal, not bypass. Native identities, source coverage, actual test results and Git state remain host attestations; the MCP cannot intercept arbitrary host commands.

## Trusted-host deployment approval

`explicitlyAuthorized:true` is model-supplied and never proves owner approval. After the latest user instruction explicitly authorizes an exact eligible protected action and scope, use the installed desktop skill's `scripts/approve-action.ps1 -Action deploy -Scope "<exact environment:application:artifact>" -Reason "<owner authorization>"` when available. It calls the configured trusted administrator host. Otherwise an administrator uses the harness `approve:action` CLI on that host, as the service account so the ledger remains service-owned.

This path is not exposed through MCP and requires `HARNESS_ENABLE_TRUSTED_APPROVALS=true`. Pass its short-lived `approvalId` and identical scope to `check_action` as `approval:{id,scope}`; proceed only on `allowed:true`. Approval is single-use. Never mint from Jev advice, infer broader scope, reuse an ID, or bypass commit/retry controls. If the trusted host is unavailable, report the blocker.

On `approval-store-lock-timeout`, fail closed. An administrator may remove only the exact approval lock after stopping the service and confirming no approval CLI remains. Never remove a lock while a writer could still be active.
