# Repo Pulse

![Node.js 26+](https://img.shields.io/badge/Node.js-26%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Azure DevOps CLI](https://img.shields.io/badge/Azure%20DevOps-CLI-0078d4?style=flat-square)
![Local storage with SQLite](https://img.shields.io/badge/Storage-local%20SQLite-6860a8?style=flat-square&logo=sqlite&logoColor=white)

A local Azure DevOps activity feed for testers. Watch multiple repositories for branch changes, pushes, pull requests, and pipeline runs in one place.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/activity-dark.png">
  <img src="docs/screenshots/activity-light.png" alt="Repo Pulse activity feed showing new branches, a push, a failed CI run, and an open pull request across three demo repositories.">
</picture>

[Light mode](docs/screenshots/activity-light.png) · [Dark mode](docs/screenshots/activity-dark.png)

## Run locally

Requires **Node.js 26+**, Git, Azure CLI, and the `azure-devops` extension. Repo Pulse uses your existing Azure CLI sign-in. See [Set up the Azure CLI](#set-up-the-azure-cli) if you have not used it before.

```sh
npm ci
npm start
```

`npm start` opens Repo Pulse in your default browser when there is a desktop session. The link it opens, also printed in the terminal, works once and gives the browser this run's access key, which the API requires; every start makes a new one. Set `REPO_PULSE_NO_BROWSER=1` to only print the link. In **Repositories**, choose **Add repositories** and select your local checkouts. Watching a repository includes all its remote branches.

To try it without Azure, run `npm run demo` instead. Demo data is fictional and stored separately.

## Set up the Azure CLI

1. Install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).
2. Add the Azure DevOps extension: `az extension add --name azure-devops`
3. Sign in with the account that can read your repositories: `az login`
4. Optional: run `npm run doctor` to verify Node.js, Git, Azure CLI, the `azure-devops` extension, and sign-in before starting.

Then start Repo Pulse and use **Settings → Check connection**. Your checkouts need an Azure DevOps remote (`dev.azure.com` over HTTPS or SSH). **Check for updates** and **Pull** use your normal Git credentials, such as your SSH key.

## Use Repo Pulse

- **Activity.** Open **New updates** to catch up or **All activity** to browse cached history. Filter by repository, status, or search. Use **Mark shown seen** to clear the displayed updates, or **Undo** to bring them back. Opening an item never marks it seen.
- **Repositories.** See your checked-out branch, sync older activity, or use **Check for updates**. **Pull** asks for confirmation and fast-forwards when Git can preserve your local changes.
- **Sync status.** The header shows whether activity is **Synced**, **Syncing**, **Delayed**, **Paused**, or has a **Problem**, and each enabled repository shows its own sync status in **Repositories**. A disabled repository shows **Disabled** and has no sync status.
- **Settings.** Check Azure DevOps access, manage automatic checks, copy diagnostics from **Troubleshooting**, or **Start from scratch** to delete stored activity and import the last seven days again.

Watches, activity, and seen state stay in `.repo-pulse/live.sqlite`. Monitoring runs while the app is open. Repo Pulse reads Azure activity and makes no Azure writes.

See [coverage and limits](docs/COVERAGE.md), the [roadmap](PLAN.md), and the [maintainer notes](docs/MAINTAINING.md).
