# HEBUT contract verification is pending

No real school response has been supplied or committed. All existing fixtures are synthetic.

Collect the userscript's opt-in anonymous index/getstatus JSON while using the official page normally. Store it locally under worker/private-diagnostics/ (gitignored). Do not put Cookie, request headers, HAR, page source or personal samples in this directory or Git; the tool consumes only its own anonymized response format.

A reviewer must establish the observed status meanings and response field paths from the official UI and rules, and prepare a local profile.json with states, optional responsePaths (current/near/detail), and policyFields if eligibility is explicit.

Run locally:

    node scripts/check-contract.mjs private-diagnostics/sample.json private-diagnostics/profile.json

Output only reports parsing state/reason, never input samples or identifiers. UNKNOWN is a failed contract assumption requiring adaptation, not evidence of release. Parse success is also not production compatibility or proof of school policy. Use explicit test expectations for each observed state before changing STATUS_PROFILE_VERIFIED.

Keep real samples private. If a genuinely non-identifying generalized regression fixture is later approved for sharing, clearly label its provenance and anonymization; never relabel a synthetic fixture as school evidence. String status values deliberately omitted by the whitelist need manual meaning confirmation, not collection of unrestricted text.
