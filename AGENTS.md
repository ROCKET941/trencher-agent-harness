# Agent Instructions

Keep this harness small, provider-neutral, and credit efficient.

1. Never commit credentials.
2. Deterministic safety and capability floors outrank Jev. Confidence-qualified Jev lane and model choices are authoritative independently of effort confidence. Model uncertainty uses the cheapest capable target within an accepted lane; effort uncertainty uses a supported role default. Never force provider diversity.
3. Route by logical capability, not hard-coded model IDs.
4. Default to the cheapest capable role; escalation requires evidence.
5. Two ordinary implementation attempts are allowed. A third and final attempt requires explicit owner authorization, new causal evidence, and a recorded reason; never exceed it.
6. Tests must remain offline and deterministic.
7. Do not couple this harness to Trencher production application code.
8. Jev may advise routing/context/continuation but cannot authorize protected actions.
9. Prefer compact evidence packets over full transcripts or repository dumps.
10. Do not add provider SDKs until an adapter actually requires one.
11. Route once per meaningful phase. Parallel handoff requires strong Jev parallel confidence or explicit validated disjoint workstreams. Keep the parent model unchanged and run only independent, non-overlapping workstreams concurrently.
12. When `parallel.assignments` is present, use each assignment exactly once. Spawn native assignments as host subagents and execute external assignments by their own server-held decisionId; never collapse the set to the phase-level target or force provider diversity.
13. External workers see supplied content only; the parent applies and verifies their artifacts. Do not reroute or silently replace an external assignment with a native worker.
