# Validation and delivery record

Base: 71401d3998d404f96dd4bf21b22ba1949253f2e9 (main observed 2026-10-13).
Reference: qvoo/iSeatcx 0e91538b46b523b3e1d859b9baf9615d42c41d5f.
Environment: Node24.19.0, TypeScript5.9.3, Wrangler4.135.0, Miniflare5.20260918.0-alpha.

## Checks actually executed

| Check | Result |
| --- | --- |
| Root npm run check (userscript build + tests) | 51 passed, 0 failed |
| Worker npm run typecheck | Passed |
| Worker npm test | 81 passed, 0 failed |
| Wrangler deploy --dry-run | Passed, 36.92KiB bundle / 10.87KiB gzip |
| workerd / Miniflare runtime tests | 2 passed, 0 failed |
| git diff --check | Passed |

Worker baseline was 11 tests. This change adds 70 Node unit tests and 2 runtime tests: 72 new tests, all passed. Total across both existing projects and new runtime tests: 134 passed, 0 failed. The previous 9 scratch audit tests were not part of the repository baseline and are not added to this total; their risk cases are incorporated in the new suite.

Earlier development failures (Node strip-only parameter properties, mismatched generation in a synthetic test configuration, and Miniflare5 mock API differences) were corrected. No known failing tests remain. Integration tests run real workerd and SQLite DO but intercept all school requests, including the single synthetic submit.

## Implemented and verified scope

- Persistent submission intent before transport, strict confirmation, no resend after uncertain write, recovery after restart/result-save failure, explicit rejection retry bounds.
- Serial queue shared by HTTP and Cron. Eight concurrent unit calls and four real runtime HTTP calls each produced one mock submit.
- Read-only index/getstatus compatibility layers, strict identity/time matching, unverified codes stay UNKNOWN, known-id absence does not imply release.
- Bounded transition events, review latch, verified clearance only, signed-in result observation, completed polling stop, interval/error backoff.
- Finite normal rebooking after explicit release plus positive server eligibility, free-seat and no-supervision evidence. Fresh read before write, per-event attempt limit and two-event daily budget.
- Official on-site entry URL, authenticated cached status and monitoring/track routes. No sign/signback/cancel/reset endpoints.
- One SQLite DO, no KV or D1, feature gates disabled by default, no passwords or tokens stored in journal.

## Only mock-validated / still unconfirmed

All school behavior is synthetic. No HEBUT response fixture exists. School code meanings, index/getstatus response shape (especially data.seatReserve in getstatus), permission field paths, timestamp/date conventions, precise seat formatting, additional submit fields, cookie lifetime, site-specific request requirements, Worker-to-school reachability and platform CPU consumption remain unverified.

No school submit/sign/release action, Cloudflare deployment, merge, or online resource provisioning occurred. Signing algorithm is preserved from the original Worker; only endpoint and school index parameters were adapted from iSeatcx. Automatic captcha, remote sign/reset and password login are excluded.

Conservative limitations: single tracked date/target; current lifecycle cannot be overwritten by another date; rebooking stops once the original start time has passed rather than inventing remaining-time rules; absent verified permission fields keeps rebooking disabled; unresolved submissions have no force-reset endpoint. Do not erase the DO journal to bypass uncertainty.

## Minimal next manual checks

1. Use the official school page normally; provide the current hall/reservation URL and redacted index/getstatus responses for available states. Remove Cookie/token/enc/UID/personal data. Do not manufacture supervision events.
2. Configure verified code/field profiles from that evidence; keep writes off while checking track/status/monitor. Confirm school rebooking and time-slot rules; if there is no affirmative server eligibility evidence, keep automatic rebooking off.
3. At the library, open the official arrival URL, complete the normal physical scan and verification, then check the next snapshot becomes SIGNED_IN.

Deployment and live writes require later explicit confirmation. README documents configuration, routes, free-tier assumptions and source attribution.
