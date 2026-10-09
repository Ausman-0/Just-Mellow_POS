# JUST MELLOW POS — Round 1 Test Report

## Result summary

- Automated tests: **11 passed / 0 failed** (domain calculations plus mocked Supabase API requests).
- JavaScript syntax checks: **5 files passed**.
- HTML static checks: **60 element IDs; no duplicates**.
- HTML local-resource checks: all referenced local CSS/JS/manifest/icon paths exist.
- PWA app-shell references: all referenced local files exist.

## Domain behaviors covered by automated tests

1. Thai-baht monetary parsing into integer satang.
2. Correct net sales and payment breakdown when a bill is cancelled.
3. Incomplete cost data does not silently produce a profit estimate.
4. Date filtering and date preset behavior.
5. CSV quoting, Thai UTF-8 BOM and formula-like text escaping.
6. Product input validation.
7. Backup payload schema and duplicate-ID checks.
8. Synthetic backup totals for completed and cancelled sales.
9. Mocked Supabase password login, expired-session refresh and signup confirmation handling.
10. Mocked Supabase backup read and upsert request headers/body.

## Not verified yet

- Interactive UI through a real browser.
- Install-to-home-screen behavior on real Android/iOS devices.
- Offline sale creation, service worker cache behavior and recovery after reconnect.
- Actual Supabase Auth, RLS policies, snapshot upload/download and conflict resolution.
- Opening CSV in desktop Excel or mobile spreadsheet software.

Browser automation was attempted, but the available Chromium installation has a system-managed URL blocklist and rejected localhost and file navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`. Cloud integration also requires a Supabase project owned/configured by the user. No results for these unrun tests are claimed as passing.

## Recommended manual smoke test before real use

1. Run a local server or deploy to HTTPS and open the app.
2. Add one pudding and one fruit tea; verify totals and quantities.
3. Record separate bills using cash, QR Code and transfer.
4. Cancel one bill with a reason and verify the net report excludes it.
5. Enter actual product costs and verify gross-profit calculations.
6. Export all five report types and open them in Excel.
7. Export a JSON backup, import it in a test profile, and verify products and bills.
8. While online, wait for the service worker to cache the app shell; switch offline and create a test sale.
9. If using Supabase, test both conflict options with a non-production dataset.
10. Repeat on the actual phone before storing real sales data.
