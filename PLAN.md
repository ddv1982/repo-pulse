# Repo Pulse roadmap

Repo Pulse helps testers see what changed across watched Azure DevOps repositories and open the source evidence. The app runs locally, uses the existing Azure CLI sign-in, and reads Azure activity.

Branch and push monitoring, PR merge evidence, grouped Activity, saved filters, resumable history import, and verified switching to Activity branches in linked checkouts are implemented. The [coverage guide](docs/COVERAGE.md) describes what the app can establish today.

## Shipped coverage

Repo Pulse records tag changes, checks live branch moves for history rewrites, keeps fork source details and reviewer votes, loads discussion counts and policy evaluations on demand, and shows gaps when reads fail. See the [dated Azure probe results](docs/probe-results.md) for the payload evidence behind this work.

## Product roadmap

1. **Trace deployments to revisions.** Start with whichever mechanism the target organization uses, YAML Environments or classic Releases. Follow a known revision through its run and artifact into a named environment. Verify failed attempts, retries, and rollbacks before presenting deployment evidence.
2. **Add broader build and test context.** Verify how shared pipelines and secondary repositories appear in Azure. Link test results and artifacts when their relationship to the run is known.
3. **Revisit outgoing PR coverage when there is a representative repository.** The project-scoped source filter returned no PRs in either sampled repository. Verify scope with a known fork or cross-project outgoing PR before adding a polling stream. Record which repository and project scopes were tested, denied, or unsupported.

## Deferred follow-ups

- **Database retention.** Measure database growth over two weeks before deciding whether to expire old activity. Any retention rule should preserve unread activity, open PR and build state, and branch baselines.
- **Packaging and shared setup.** Gather feedback from two weeks of daily use and a few testers trying demo and live mode before deciding whether to package Repo Pulse for others.
- **Fork origin for snapshot-discovered branches (optional).** Use PR iterations `commonRefCommit` or merge bases, shown as text only ("shares history with P from `abc1234`"), never a fork line.
- **Local clones as an ancestry accelerator (optional).** Use local objects for zero-call ancestry checks only when they are present, with the existing `checkout-git.js` guards. Never fetch.
- **Fork re-check when a late pull request arrives.** Skipped after measuring on 2026-11-20: in 81 of 81 push creations with a PR, its target was already the repository's most common target, which the check tries. Revisit when a repository's PRs often target another branch.
- **Read the repository's default branch for the fork check.** Skipped after measuring on 2026-11-20: the most common PR target was `main` in 4 of 4 repositories. Revisit for a repository with no stored PRs.

## Constraints

- Watch whole repositories by default. Filters affect the Activity view and opening an item never marks it seen.
- Keep one Azure request queue with a budget of 60 calls/min and four calls in flight. The queue also handles CLI-backed prerequisite checks. Reads expressed as `devops invoke` use REST with an Azure CLI token. Measure with `scripts/measure-budget.js` before changing the polling model.
- Keep zero runtime npm dependencies and no build step: plain Node 26 ES modules, `node:sqlite`, strict JSDoc type checking, `SafeHtml` templates, and native `@import` CSS modules.
- Keep status labels readable without color. Preserve keyboard focus, visibility, and scroll across refreshes.
- A successful build or merged PR does not establish deployment. Partial evidence should stay visible as partial evidence.
- Service hooks, audit ingestion, notifications, and packaging can wait for a demonstrated need.

See [Azure API research](docs/FULL-COVERAGE-RESEARCH.md) for endpoints, source references, and proof cases. See [maintainer notes](docs/MAINTAINING.md) for architecture, checks, and local measurements.

The [completed phase checklist and validation notes](https://github.com/ddv1982/repo-pulse/blob/b8fb8561854d472bcc17543326df5c4644c53cd8/PLAN.md#repository-and-pr-coverage-item-1--complete) are available in Git history.
