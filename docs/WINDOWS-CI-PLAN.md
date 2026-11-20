# Windows CI plan

Goal: CI proves the unit suite on Windows, so Windows support stays tested. Follow-up to PR #78, where the review's
Windows job was dropped because the suite assumed POSIX. Chosen by the user on 2026-11-20.

## Decisions

- D1 A `checks-windows` job runs `npm ci`, `check`, `check:types`, `lint` and `npm test` on `windows-latest`. The
  Playwright suite stays on Linux only.
- D2 `.gitattributes` pins LF (`* text=auto eol=lf`), so a Windows checkout matches Prettier's LF and Git fixtures.
- D3 A test that checks a POSIX-only property (file mode bits, symlinks that need privileges) skips that assertion on
  Windows, as test/open-browser.test.js already does. A failure that shows a real app bug on Windows is fixed in the app
  with a test, not skipped.
- D4 Each fix is driven by a failure seen in the Windows job log; no speculative changes.

## Steps

- [x] W1 Add the job and `.gitattributes`; Linux checks still pass.
- [x] W2 Read the Windows job's failures and fix each (D3, D4), listing every fix and whether it was a test assumption
  or an app bug. The first run found six failures, all test assumptions and no app bug: a POSIX mode assertion
  (store), cleanup that removed the data folder before closing the app (server; the open server then hung the file),
  a fixed 60 ms wait for two poll turns (sync), a `PATH` lookup that Windows spells `Path` (doctor), and a checkout
  fixture path with 8.3 short names that the app's realpath expands (two checkout-branches tests).
- [x] W3 Both jobs pass on the PR: Windows ran 443 unit tests, 442 passed and 1 skipped (the getuid-only test).
