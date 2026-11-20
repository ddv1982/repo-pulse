# Review hardening plan

Goal: land the changes from the 2026-11-20 in-depth review (made by an earlier Gemini session that stopped on a quota
error) after fixing what it left open, with proof for each change.

## Decisions

- D1 Drop the `events_repo(repo_id)` index. With it, `scripts/measure-activity.js` at 25,000 events went from
  firstPage 66 ms / search 41 ms (main) to 85 ms / 78 ms; without it the numbers match main. The three partial indexes
  stay: EXPLAIN QUERY PLAN shows each used by the query it targets.
- D2 Drop the bounded `commitResults` cache in src/web.js. It guards against growth nobody has observed (one entry per
  detail page opened in a session) and has no test; it is speculative.
- D3 Keep everything else, each with the proof below. The live database has no new index and no WAL file yet, so no
  migration is needed for D1.

## Steps

- [x] S1 Remove `events_repo` and its test expectation; benchmark matches main.
- [x] S2 Revert the `commitResults` change (D2).
- [x] S3 Each new or changed test fails on main's source and passes with the change: REST size cap, decodeParam 400 and
  CSP header, WAL mode and indexes, single config/index scan, per-repository checkout lock, `data-tree-lanes`.
- [x] S4 Proof outside tests: statement cache benchmark (3,000 inserts 405 ms vs 580 ms, acks 61 ms vs 90 ms); WAL and
  SHM files are 600 like the database and read-only opens work while open and after close; no CSP violations on every
  view; tree lanes read from `data-tree-lanes`; the 3 to 5 minute copy matches `intervalMs` 180000 and the 300000
  quiet cadence; the CLI allowlist simplification is equivalent because `command` is `args.slice(0, 3).join(' ')`.
- [x] S5 Full checks pass locally. The Windows CI job is dropped: the store test asserts POSIX file mode 0600, which
  Windows cannot report, and five test files depend on POSIX modes, chmod or symlinks. A Windows-clean suite is
  separate work.
- [x] S6 README screenshots regenerated for the 3 to 5 minute footer.
