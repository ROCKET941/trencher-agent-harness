# Agent Instructions

Keep this harness small, provider-neutral, and credit efficient.

1. Never commit credentials.
2. Deterministic safety and capability floors outrank Jev; otherwise a validated Jev worker/provider/model/effort choice is authoritative regardless of confidence.
3. Route by logical capability, not hard-coded model IDs.
4. Default to the cheapest capable role; escalation requires evidence.
5. Two ordinary implementation attempts are allowed. A third and final attempt requires explicit owner authorization, new causal evidence, and a recorded reason; never exceed it.
6. Tests must remain offline and deterministic.
7. Do not couple this harness to Trencher production application code.
8. Jev may advise routing/context/continuation but cannot authorize protected actions.
9. Prefer compact evidence packets over full transcripts or repository dumps.
10. Do not add provider SDKs until an adapter actually requires one.
11. Route once per meaningful phase. For a native parallel handoff, keep the parent model unchanged and run only independent, non-overlapping subagent workstreams concurrently.
