# Enable or disable a watched repository

Goal: a toggle per repository on the Repositories page. A disabled repository makes no Azure calls and
nothing of it appears anywhere else in the app (Activity, event details, scope menu, header, summary,
health banners, Settings connection list). It stays listed on the Repositories page so it can be re-enabled.

Decision: the existing Pause/Resume button (stop checks, keep showing cached activity) becomes this toggle.
The stored flag is renamed from `paused` to `disabled` with a database migration, so existing paused
repositories become disabled.

## Phase 1: server
- [x] Store: migrate `paused` to `disabled` (user_version 8); saveRepo bumps the activity revision when `disabled` changes
- [x] Sync, backfill, enrichment use `disabled`
- [x] PATCH /api/repos/:id takes `{ disabled }`; enabling queues a refresh
- [x] /api/activity excludes disabled repositories, also when requested explicitly
- [x] /api/events/:id returns 404 for an event of a disabled repository
- [x] /api/checkouts skips disabled repositories
- [x] Server and store tests (seen failing first), full `npm test` passes

## Phase 2: client state and views
- [x] Refresh state splits `watched` (all) from `repos` (enabled) and drops streams of disabled repositories
- [x] Header scope menu, counts and freshness ignore disabled repositories; paused banner and chip copy removed
- [x] Presentation tests updated, `npm test` passes

## Phase 3: Repositories page toggle
- [x] Each row has an Enabled switch; a disabled row shows only name, project, Disabled chip, switch and Remove
- [x] e2e test: disable hides the repo from Activity and scope menu, enable brings it back
- [x] `npm run check`, `check:types`, `lint`, `test`, `test:ui` pass

## Phase 4: proof and delivery
- [x] Run the app in demo mode, disable a repo, screenshot Repositories and Activity
- [x] Docs mentioning Pause updated (none found: README and docs/*.md never mention it)
