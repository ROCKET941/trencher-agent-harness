# Harness benchmark

The benchmark is a reproducible acceptance eval, not a universal model leaderboard.

- `npm run benchmark` runs free deterministic routing, safety, context, and native-boundary checks.
- `npm run benchmark:live` runs those checks plus live Jev routing and three bounded tasks on each configured external provider. It makes paid Jev/xAI/DeepSeek/Kimi calls.
- Set `HARNESS_BENCHMARK_URL` to override `http://127.0.0.1:18788/mcp`. Set `HARNESS_BENCHMARK_TOKEN` when the endpoint requires bearer authentication.
- Set `HARNESS_BENCHMARK_OUTPUT` to save the JSON result. Generated results belong in `benchmark-results/`, which is ignored by Git.
- Set `HARNESS_BENCHMARK_RUN_ID` to a stable unique label when comparing repeat runs; otherwise a timestamp-derived identifier prevents accounting/idempotency collisions.

The deterministic score includes the historical regression: a valid low-confidence Jev native target must remain effective, and a parallel recommendation must produce a three-agent, non-overlapping, subagent-only handoff without changing the parent model. The live score covers policy enforcement, MCP/native-host boundaries, Jev routing quality, provider readiness/contract compliance, task accuracy, input bounds, latency, token usage, and recorded cost. The code-patch case must also apply cleanly to an isolated temporary Git fixture and pass three executable checks. Native Astra/Sol/Terra/Luna targets are intentionally graded as ChatGPT-plan handoffs rather than API executions.
