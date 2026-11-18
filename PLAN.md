# Repo Pulse roadmap

Repo Pulse helps testers see what changed across watched Azure DevOps repositories and open the source evidence. The app runs locally, uses the existing Azure CLI sign-in, and reads Azure activity.

Branch and push monitoring, PR merge evidence, grouped Activity, resumable history import, and local checkout status are implemented. The [coverage guide](docs/COVERAGE.md) describes what the app can establish today.

## Codebase improvement phases

Done: Pull is plain Git, Activity filters match the displayed rows, all server and browser code is type-checked against one server-to-browser contract, browser casts are replaced by runtime checks, escaping of Azure and Git text is tested, and local Activity load is measured in the [maintainer guide](docs/MAINTAINING.md).

## Product roadmap after hardening

1. **Extend repository and PR coverage.** Preserve tags and distinguish confirmed history rewrites from ordinary ref changes. Investigate outgoing and fork PRs, review votes, discussions, and policy changes. Show gaps when events or permissions are missing.
2. **Trace deployments to revisions.** Start with whichever mechanism the target organization uses, YAML Environments or classic Releases. Follow a known revision through its run and artifact into a named environment. Verify failed attempts, retries, and rollbacks before presenting deployment evidence.
3. **Add broader build and test context.** Verify how shared pipelines and secondary repositories appear in Azure. Link test results and artifacts when their relationship to the run is known.

## Constraints

- Watch whole repositories by default. Filters affect the Activity view and opening an item never marks it seen.
- Keep one budget for all Azure reads. Activity reads use REST with an Azure CLI token since 2026-11-18, decided after `scripts/measure-budget.js` showed merge evidence falling behind from about 10 repositories on the CLI-only budget. Measure with that script before changing the polling model.
- Keep status labels readable without color. Preserve keyboard focus, visibility, and scroll across refreshes.
- A successful build or merged PR does not establish deployment. Partial evidence should stay visible as partial evidence.
- Service hooks, audit ingestion, notifications, and packaging can wait for a demonstrated need.

See [Azure API research](docs/FULL-COVERAGE-RESEARCH.md) for endpoints, source references, and proof cases. See [maintainer notes](docs/MAINTAINING.md) for architecture, checks, and local measurements.
