# Offline contract hardening — 2026-10-15

Continued Draft PR #1 on `feat/worker-seat-lifecycle-20261013`, parent `fffab2bd8d8b331044c2d480689827e5814febd2`. The prior validation record below is historical; this section supersedes its test totals and “no response supplied” statement.

## Evidence and scope

Inspected the existing private anonymized read-only diagnostic locally. Its current/history arrays and millisecond timestamps are structurally parseable. No numeric school status meaning, detail-response contract, supervision rule, release rule or eligibility rule was established. No production mapping was added. The sample remains in gitignored `private-diagnostics/`; neither its records nor credentials are committed. Public regression fixtures are independently invented synthetic examples.

## Changes

- Offline checker now inspects every current/history record using explicit configured paths, reports per-record structural validity and state/reason, and keeps aggregate verification pending for unknown history or empty captures. Profile argument is optional and defaults to an empty state map.
- Checker and runtime share profile validation. Invalid states, path types, unsupported path keys and prototype paths fail closed. Runtime rejects a malformed verified profile rather than silently accepting default empty lists.
- Non-object envelopes, contradictory date aliases, missing status values and explicitly truncated captures cannot establish a lifecycle state. Field traversal requires own properties.
- CLI errors omit input content and private paths. Reports omit identifiers, dates, raw codes, arbitrary fields and configured paths.

## Checks actually executed

Baseline before changes: root build + 70 tests; Workers typecheck + 129 tests; offline Wrangler build + 6 workerd/SQLite integration tests. All passed.

Final: root `npm run check` (70 passed); Workers `npm run check` (typecheck, 151 unit tests, offline Wrangler build, 6 workerd/SQLite tests). Total **227 passed, 0 failed**, including **22 new regression tests**. Bundle 49.77 KiB / 13.47 KiB gzip. Generated userscript and contract CLI syntax checks and `git diff --check` passed. Private sample CLI inspection succeeded with the default empty map, retaining UNKNOWN for every record; production compatibility remains false.

No Actions workflow runs were returned for the starting head. Verification above was performed locally; no remote CI success is implied.

## Remaining blockers and safety

Official UI/rule evidence for numeric state meanings, a matching getstatus sample and explicit rebooking-policy evidence remain missing. Live browser capture integration, credential lifetime, cloud reachability and production behavior remain unverified. `WRITES_ENABLED`, `MONITOR_ENABLED`, `AUTO_REBOOK_ENABLED`, `REBOOK_RULES_VERIFIED` and `STATUS_PROFILE_VERIFIED` remain false in the unchanged deployment configuration. No real school request, reservation, check-in, cancellation, deployment or merge was performed.

---

# Validation and delivery record — follow-up review

Date: 2026-10-13. Reviewed existing Draft PR #1, branch feat/worker-seat-lifecycle-20261013, parent f1655d2c981edf6f8499d1ca27be9048eccbeebe. This is a follow-up on that branch, not a new PR.

## Independent baseline checks

Before this round's edits, reran the original userscript build and 51 tests, Workers typecheck and 81 tests, Wrangler offline build and 2 workerd integration tests. All passed. The original source nevertheless had a date gate that blocked nonterminal old SIGNED_IN/UNKNOWN snapshots.

## Final checks actually executed

| Check | Result |
| --- | --- |
| Root npm run check: userscript build + Node tests | 70 passed, 0 failed |
| Workers npm run typecheck | Passed |
| Workers npm test | 112 passed, 0 failed |
| Wrangler deploy --dry-run | Passed, 46.39KiB bundle / 12.92KiB gzip |
| workerd / Miniflare + SQLite DO integration tests | 4 passed, 0 failed |
| Node syntax checks: generated userscript and contract CLI | Passed |
| git diff --check | Passed |

This round adds 52 tests: 19 userscript/diagnostic tests, 31 Workers unit tests, 2 workerd integration tests. Final total: 186 passed, 0 failed. Previous scratch audit tests are not double counted. No known failing checks remain.

A development-only failure in the restart harness exposed Miniflare5 ignoring the V4 durableObjectsPersist setting; the harness now uses the native resourcePersistencePath. Restart assertions now test actual persisted SQLite files across disposed/new workerd runtimes, not just an in-memory replacement coordinator. All school requests in these tests are intercepted locally, never sent to the real school.

## Problems fixed

- Expired local tasks no longer block a future date merely because their snapshot is SIGNED_IN or UNKNOWN. Refresh old state, resolve pending write intentions, preserve a 30-entry archive and switch dates within the same serial queue. Archival records the old state and separately marks whether the server actually confirmed terminal state.
- A historical SUBMITTED_UNVERIFIED write is never erased or accepted from time/absence. Unconfirmed history or known supervision produces handoff reason, needsHuman, event and bounded read backoff. Pending authorized runs can resume on positive confirmation; stale Cron intent cannot run indefinitely.
- Legacy account-v1 journal fields migrate additively; unsupported versions fail closed with an explicit review error. DO ID and SQLite migration tag are unchanged. Restart/concurrent calls preserve idempotency.
- A lost rebooking response cannot be confirmed by the same previously released reservation ID. It must have a distinct matching record or explicit successful submit response.
- Backward date requests cannot poison the active task's pending run.
- Cron target date derives from scheduledTime, not delayed wall-clock date. Short delays can proceed; delays more than 15 minutes past22:30 record a missed-window event with zero school calls. Deadline and reservation start are rechecked immediately before a write.
- 08:30–22:00 stays unchanged. New independent checkin offsets default30/30; /status displays08:00–09:00, Shanghai timezone and advisory phase. Window boundaries/midnight/year changes are tested. A local AFTER_WINDOW phase never changes server state or implies release.

## Diagnostic functionality and privacy

New default-disabled userscript component observes only exact same-origin index/getstatus paths and ordinary GET/POST read requests. It never calls an endpoint itself or reads request bodies/headers. Existing appointment engine behavior is unchanged; new hall/code matches mount diagnostics only.

Whitelist projection removes names/UID/secrets/free-text statuses and arbitrary fields. Appointment/room/seat IDs are aliased, absolute dates shifted with relative offsets preserved. Necessary numerical status/time/boolean structure remains. Samples stay in memory, max10; arrays max100. Stop clears sanitized samples and pasted raw text. Export uses user-triggered preview, separate confirmation and a local JSON download; no upload or durable sample storage. Manual Response-JSON paste is the safe fallback for late-loaded hooks/inaccessible frames. Old downloadDiagnose now opens this preview rather than exporting logs directly.

Unit tests exercise fetch/XHR pass-through, both API generations, denied write paths/cross-origin/methods, callback suppression after disable, later extension hook preservation, alias consistency, date/timestamp replacement, preview/cancel/confirm and manual import controls. Actual browser/school page integration remains untested; fake DOM is used for UI behavior tests.

## School protocol remains pending

No actual HEBUT fixture has been supplied. Synthetic fixtures never become school evidence. Verified profile responsePaths allow alternative current/near/detail paths under data, including data-as-record getstatus; unmatched fields stay UNKNOWN. Numeric status meanings, response layouts, cookie lifetime, submit extras, eligibility field meanings, timestamp conventions and Worker reachability/CPU remain unverified.

Offline check-contract CLI consumes only the anonymized diagnostic format and a reviewed local profile, prints parser state/reason, and always reports productionCompatibilityConfirmed=false. Unknown states/HTTP failures/absence do not prove release. Real samples belong in gitignored private-diagnostics/, not PR or commits. See test/contracts/README.md.

## Limits intentionally retained

- Rebooking after original START_TIME still stops; the30-minute late checkin allowance does not validate remaining-time rebooking rules.
- At most one date is actively coordinated, with bounded local archives; no parallel multi-day task system.
- Known pending supervision or unresolved historical writes may still deliberately block a next-day submission, with explicit operator-facing reason. No force-reset endpoint.
- Hook capture is opt-in and may miss initial page-load or iframe responses; use the local manual paste fallback. Free-text status strings are omitted for privacy and need manual interpretation.
- The UI has been tested with fake DOM, not on the live official page.
- No sign/reset/exit/cancel behavior, school real writes, merge, Cloudflare deployment or resource provisioning occurred.

## Cost and manual follow-up

Rechecked Cloudflare's official pricing/Cron documentation. Same one SQLite DO and two Cron patterns; no KV, D1, Go, Vue or extra service. Standard monitoring at most1440 ticks/day; missing known ID can add a detail read, handoff verification adds bounded historical reads with1/2/4/8/15-minute backoff. DO network wait counts wall-clock duration. A single128MB DO continuously active24h estimates10800GB-s/day versus13000 free; this is a conservative deployment-only estimate, not actual account usage. Request/storage/CPU and other account usage still need observation after an approved deployment.

Minimum user actions: install the branch userscript, opt in on an official page and perform an ordinary read-only action; preview/download anonymized JSON and tell us which official state it displayed. If capture misses, paste only Network Response JSON into the local fallback. Keep credentials/HAR/private samples out of Git. Then configure and offline-check the reviewed status/path profile with writes off. At the library use the official scan flow normally and verify a readback SIGNED_IN snapshot after future deployment approval.
