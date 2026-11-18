# Repo Pulse roadmap

Repo Pulse helps testers see what changed across watched Azure DevOps repositories and open the source evidence. The app runs locally, uses the existing Azure CLI sign-in, and reads Azure activity.

Branch and push monitoring, PR merge evidence, grouped Activity, resumable history import, and local checkout status are implemented. The [coverage guide](docs/COVERAGE.md) describes what the app can establish today.

## Codebase improvement phases

Complete these phases before adding more Azure coverage. Keep Node, SQLite, JavaScript, and one shared Azure budget. Each phase should be independently reviewable and leave the existing watches, cached events, and seen state intact.

### 1. Make Pull recoverable

Superseded on 2026-11-18: Pull now runs `git merge --ff-only`, so Git owns the update and there is no app journal to recover.

Turn the interrupted Pull reproduction into a regression test using a disposable Git repository. Record the operation before altering the checkout. On restart, compare the recorded branch, refs, index, and working files with the actual state. Report an interrupted operation before allowing another Pull. Recover automatically only when the app can prove the state belongs to that operation. Otherwise, give the user a clear manual recovery path. Keep Check for updates separate from working-tree changes.

**Done when.** Tests interrupt Pull before file changes, after files change, and after the ref commits but before the index publishes. A successful Pull leaves the files, index, and branch in sync. Recovery preserves subsequent edits and never clears a lock owned by another Git process.

### 2. Make Activity filters match the displayed rows

Use the displayed state of a grouped row for status filtering. Keep its member updates and their seen flags separate. Use the same group selection for dropdown options, results, counts, and paging. Use stable filter IDs so changing a visible label does not break saved filters.

**Done when.** A run shown as **Succeeded** with an older unseen **Running** update appears under **Succeeded**. The Seen action captures the exact unseen IDs represented by the shown results. Tests cover search, repository scope, imported history, and loading more without acknowledging hidden or newly arrived updates.

### 3. Check the JavaScript at the important boundaries

Extend checked JSDoc to the checkout adapter, Activity query, and browser refresh controller. Define the valid checkout states, Activity requests and results, and refresh outcomes. Validate external inputs where they enter the app. After phase 2 verifies the behavior, separate Activity querying from persistence and migrations.

**Done when.** The type check covers these modules and their shared contracts. Invalid state combinations fail type checking. Migration tests verify that existing event IDs and seen flags survive. Syntax, type, Node, and Chromium checks pass.

### 4. Measure before optimizing

Repeat the [local Activity measurement](scripts/measure-activity.js) on the same fixture and add a representative larger history. Measure first page, search, and a loaded history refresh on the same machine. If query time or responsiveness is a problem, use SQLite query plans to target the repeated work before adding a worker or changing databases.

**Done when.** Record the workload, results, and any measured bottleneck in the [maintainer guide](docs/MAINTAINING.md). An idle tab still skips repeat Activity queries. Leave the stack in place if the measured workload is responsive.

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
