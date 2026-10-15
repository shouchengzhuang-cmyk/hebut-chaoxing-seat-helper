# HEBUT contract verification is pending

A private anonymized school response was inspected locally on 2026-10-15; no school response is committed. All repository fixtures remain synthetic. The observed index structure uses explicit current/history lists and millisecond timestamps. Structural parsing alone does not establish any numeric status meaning or eligibility rule.

Collect the userscript's opt-in anonymous index/getstatus JSON while using the official page normally. Store it locally under worker/private-diagnostics/ (gitignored). Do not put Cookie, request headers, HAR, page source or personal samples in this directory or Git; the tool consumes only its own anonymized response format.

A reviewer must establish the observed status meanings and response field paths from the official UI and rules, and prepare a local profile.json with states, optional responsePaths (current/near/detail), and policyFields if eligibility is explicit.

Run locally:

    # First inspect structure with an empty state map (no credentials needed):
    node scripts/check-contract.mjs private-diagnostics/sample.json
    # Only after independent evidence review, test explicit mappings/paths:
    node scripts/check-contract.mjs private-diagnostics/sample.json private-diagnostics/profile.json

Output only reports parsing state/reason, never input samples or identifiers. UNKNOWN is a failed contract assumption requiring adaptation, not evidence of release. Parse success is also not production compatibility or proof of school policy. Use explicit test expectations for each observed state before changing STATUS_PROFILE_VERIFIED.

Keep real samples private. If a genuinely non-identifying generalized regression fixture is later approved for sharing, clearly label its provenance and anonymization; never relabel a synthetic fixture as school evidence. String status values deliberately omitted by the whitelist need manual meaning confirmation, not collection of unrestricted text.

The checker reports every record in both configured index lists, or the explicitly configured detail path. It never guesses alternative paths. Each record has a structural-validity flag and a lifecycle result; unknown history keeps the aggregate `needsVerification` true even when the first record maps successfully. Empty lists cannot validate state meanings. Invalid profile shapes/paths are rejected; malformed bodies, failed HTTP responses, contradictory dates, conflicting records and truncated captures fail closed. The report excludes raw records, identifiers, dates, codes and configured field paths. CLI errors print no input data or private file paths.

`seatConfig` describes observed configuration only. Its timing/limit numbers do not prove status meanings, release, blacklist status, supervision status, seat availability or rebooking eligibility. This round does not derive a production profile or enable any write/monitor/rebooking switch.
