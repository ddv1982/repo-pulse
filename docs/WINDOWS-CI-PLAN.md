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
- [ ] W2 Read the Windows job's failures and fix each (D3, D4), listing every fix and whether it was a test assumption
  or an app bug.
- [ ] W3 Both jobs pass on the PR.
