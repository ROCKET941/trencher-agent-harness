# Agent Instructions

Keep this harness small, provider-neutral, and credit efficient.

1. Never commit credentials.
2. Deterministic policy outranks Jev/model recommendations.
3. Route by logical capability, not hard-coded model IDs.
4. Default to the cheapest capable role; escalation requires evidence.
5. Never exceed two implementation attempts for one failure without stopping/escalating.
6. Tests must remain offline and deterministic.
7. Do not couple this harness to Trencher production application code.
8. Jev may advise routing/context/continuation but cannot authorize protected actions.
9. Prefer compact evidence packets over full transcripts or repository dumps.
10. Do not add provider SDKs until an adapter actually requires one.
