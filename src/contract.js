// @ts-check

// The JSON the server sends and the browser reads. Nothing here imports server code, so browser modules can type
// their responses without pulling Node modules into their program. Server modules alias these types, and the
// handlers in server.js check each response against its type with `@satisfies`.

/** @typedef {import('./activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('./activity.js').EventData} EventData */

// Azure

/** Raw Azure DevOps JSON. Its shape is checked by the code that reads it, not by the compiler. */
/** @typedef {any} AzureRecord */
/** The repository fields the client reads. Watched repositories carry more. */
/** @typedef {{ organization: string, project: string, projectId?: string, azureId: string, webUrl: string }} AzureRepo */
/** @typedef {'pushes'|'refs'|'prs'|'closedPrs'|'builds'|'activeBuilds'} AzureStream */
/**
 * Where the next page starts: `skip` for offset-paged reads, `token` for continuation reads.
 * Build reads also keep their coarse window in `from` and `to`.
 * @typedef {{ skip?: number, token?: string, from?: string, to?: string, allRefs?: boolean }} PageCursor
 */
/** @typedef {{ status: 'ok'|'failed', checkedAt: string, code?: string, message?: string }} AccessCheck */
/**
 * @typedef {{ available: boolean, identity: null, identityVerified: boolean, message: string, code?: string,
 *   version?: string, extension?: string, signedIn?: boolean, account?: { name: string },
 *   access?: AccessCheck, capabilities?: { organizationRead: boolean } }} ConnectionStatus
 */
/**
 * What a PR detail shows on request: counts of people's discussion threads and each policy's result.
 * Vote, reviewer and ref-update threads are Azure's own records of other events, so they are not counted.
 * @typedef {{ threads: { open: number, resolved: number }, policies: { name: string, status: string, blocking: boolean }[] }} PullRequestReview
 */
/** @typedef {{ code: string | undefined, message: string | undefined }} CliLastError */
/**
 * The Azure CLI queue's counters, read for Copy diagnostics.
 * @typedef {{ startsLastMinute: number, totalStarts: number, pending: number, running: number, limitPerMinute: number,
 *   concurrency: number, upstreamRequests: null, lastError: CliLastError | null, throttledUntil: string | null }} CliDiagnostics
 */

// Store

/** The JSON in `events.data`. Insertion always fills `time` and `observedAt`; `data` keeps provider fields beyond EventData. */
/** @typedef {ActivityEvent & { observedAt: string, data?: EventData & Record<string, unknown> }} StoredEvent */
/** An event as the store returns it: the read flags come from their columns and enrichment is merged into `data`. */
/** @typedef {StoredEvent & { seen: boolean, imported: boolean }} HydratedEvent */
/** Every watched repository was resolved through Azure (or is a demo fixture), so its Azure identity is always present. */
/** @typedef {AzureRepo & { id: string, name: string, disabled?: boolean, localPath?: string }} Repository */

// Sync

/** @typedef {{ since: string, until: string }} StreamWindow */
/** @typedef {{ code: string, message: string }} StreamError */
/**
 * Persisted per repository and stream. Optional fields are absent before the first read
 * or after a completed read, which keeps only the fields `completePage` writes. Demo seeds
 * leave `error` out entirely.
 * @typedef {{
 *   repoId: string, stream: AzureStream, initialized: boolean, nextAt: string, error?: StreamError|null,
 *   lastAttempt?: string, lastSuccess?: string, pending?: boolean, failures?: number, quietCycles?: number,
 *   window?: StreamWindow, windowGeneration?: number, refreshGeneration?: number, manual?: boolean,
 *   cursor?: PageCursor|null, pendingItems?: AzureRecord[], activeIds?: string[]
 * }} StreamState
 */
/**
 * The sync loop's counters, read for Copy diagnostics. `lastTurn` holds when each kind of turn last ran.
 * @typedef {{
 *   running: boolean, stopped: boolean, pages: number, errors: number, streams: number,
 *   lastTurn: { history?: string, live?: string, rewrite?: string },
 *   lag: { overdueStreams: number, maxDelayMs: number },
 *   inProgress: { repoId: string, stream: AzureStream }[],
 * }} SyncEngineStatus
 */
/** @typedef {{ demo: true, running: false }} DemoSyncStatus */
/** @typedef {{ scheduled: boolean, cooldown?: boolean }} RefreshStatus */
/** @typedef {'paused'|'problem'|'delayed'|'syncing'|'synced'} SyncState */
/**
 * `since` is the oldest last success across the repository's streams, absent until every stream has read once.
 * @typedef {{ state: SyncState, reason?: string, since?: string, lastCheck?: string, stream?: AzureStream | 'history' }} SyncStatus
 */
/** @typedef {(SyncStatus & { repoId: string }) | { state: 'empty' } | { state: 'problem', reason: string }} OverallSyncStatus */
/** @typedef {{ overall: OverallSyncStatus, repos: Record<string, SyncStatus> }} SyncStatusReport */

// History import

/** @typedef {'pushes'|'closedPrs'|'builds'} HistoryStream */
/** @typedef {{ since: string, until: string }} HistoryWindow */
/** @typedef {{ code: string, message: string }} JobError */
/**
 * @typedef {{ id: string, type: 'backfill', repoId: string, days: number|'all',
 *   status: 'pending'|'running'|'retrying'|'completed', startedAt: string, nextAt: string,
 *   rangeStart: string, rangeEnd: string, stream: HistoryStream, cursor: PageCursor | null,
 *   window: HistoryWindow|null, pages: number, records: number, windowsCompleted: number,
 *   failures: number, error: JobError|null, note: string, lastAttempt?: string,
 *   lastProgressAt?: string, coverageStart?: string, completedAt?: string }} HistoryJob
 */

// Saved filters

/** @typedef {{ search: string, people: string, kind: string, repoIds: string[] | null, view: 'new' | 'all' }} ActivityFilters */
/** @typedef {{ id: string, name: string, filters: ActivityFilters }} SavedActivityFilter */

// Repository discovery

/** A Git remote keeps the parsed Azure identity, but `name` is the remote's name and `repoName` the Azure repository. */
/** @typedef {{ organization: string, project: string, name: string, repoName: string, url: string }} DiscoveredRemote */
/** @typedef {{ localPath: string, remotes: DiscoveredRemote[] }} DiscoveredCheckout */
/** @typedef {{ repositories: DiscoveredCheckout[], warnings: string[] }} Discovery */
/** @typedef {{ name: string, path: string }} FolderLink */

// Checkouts

/**
 * @typedef {{ branch: string, id: number, url?: string, strategy?: string, verified: boolean, targetVerified?: boolean,
 *   receipt?: { target: string, result: string, sourceHead?: string }, destination?: 'local'|'remote-only'|'other-worktree'|'different-upstream'|'unknown' }} PullAdvice
 */
/** @typedef {{ previous: string, tip: string, verified: boolean, commits: {side: 'old'|'new', id: string, subject: string}[] }} Rewrite */
/** @typedef {{ title?: string, message?: string, suggestion: string, advice?: PullAdvice, comparison?: Rewrite }} CheckoutDiagnostic */
/** The part of a follow-up plan a checkout status shows. @typedef {{ id: string, source: string, workspace?: string }} FollowupSummary */
/**
 * @typedef {{ kind: 'included'|'local-followup'|'unknown'|'changed'|'occupied',
 *   commits?: { id: string, subject: string }[], branch?: string, canRemove?: boolean }} Review
 */
/**
 * @typedef {{ branch: string|null, head: string|null, upstream: string|null, ahead: number|null, behind: number|null, dirty: boolean }} GitStatus
 * @typedef {{ branch: string, head: string, upstream: string|null, identity: string }} CheckoutSelection
 * @typedef {CheckoutSelection & { switchIdentity: string }} SwitchIntent
 * @typedef {CheckoutSelection & { upstream: string }} CheckoutIntent
 * @typedef {GitStatus & { identity: string, switchIdentity: string|null, lastBranchCheck?: { at: string, matchesFetchedTip: boolean } }} CheckoutReading
 * @typedef {{ token: string, upstream: string, previous: string|null, tip: string, ahead: number, behind: number }} ActivitySwitchReview
 * @typedef {'in-progress'|'detached'|'unborn'|'dirty'|'no-upstream'|'different-remote'|'upstream-missing'|'upstream-rewritten'|'fetch-failed'|'unknown'|'diverged'|'ahead'|'current'} BlockedState
 * @typedef {CheckoutIntent & CheckoutReading & { state: 'behind', canCheck: true, canPull: true }} PullableCheckout
 * @typedef {CheckoutReading & { state: BlockedState, canCheck: boolean, canPull: false, diagnostic?: CheckoutDiagnostic }} BlockedCheckout
 * @typedef {PullableCheckout | BlockedCheckout} ActiveCheckout
 * @typedef {ActiveCheckout & { followup?: FollowupSummary }} DecoratedCheckout
 *   A checkout with an open branch follow-up names it, so the page can offer to review or remove the old branch.
 * @typedef {DecoratedCheckout | { state: 'unavailable'|'not-linked', diagnostic?: CheckoutDiagnostic }} CheckoutStatus
 */
/** A check or pull, with the checkout read after it. @typedef {{ checkout: CheckoutStatus, updated: boolean }} CheckoutUpdateResult */
/**
 * A branch action, with the checkout read after it: a message, a review of the branch, or a next step.
 * @typedef {{ checkout: CheckoutStatus, message: string }
 *   | { checkout: CheckoutStatus, review: Review }
 *   | { checkout: CheckoutStatus, message: string, nextStep: string }} BranchActionResult
 */
/**
 * A switch to an activity's branch: switched (with a notice), refused (with a message), or waiting for the reader to
 * confirm the review.
 * @typedef {{ checkout: DecoratedCheckout, notice: string | undefined }
 *   | { checkout: CheckoutStatus, message: string }
 *   | { checkout: CheckoutStatus, switchReview?: ActivitySwitchReview }} ActivitySwitchResult
 */

// Responses, one per route

/** @typedef {{ message: string, code?: string }} ErrorResponse */
/** @typedef {{ ok: true }} OkResponse */
/** POST /api/session: the key, given once for the launch token. @typedef {{ key: string }} SessionResponse */
/**
 * GET /api/state. The settings are only ever written by POST /api/settings.
 * @typedef {{
 *   repos: Repository[],
 *   streams: StreamState[],
 *   diagnostics: Partial<CliDiagnostics> & { sync: SyncEngineStatus | DemoSyncStatus },
 *   jobs: HistoryJob[],
 *   activityRevision: string,
 *   savedFilters: SavedActivityFilter[],
 *   settings: { refreshEnabled: boolean, refreshResumedAt: number | null },
 *   syncStatus: SyncStatusReport,
 *   demo: boolean,
 * }} StateResponse
 */
/** GET /api/activity, built by server/activity-query.js. @typedef {import('./activity.js').ActivityPage} ActivityResponse */
/** GET /api/events/:id: the event and every event grouped with it. @typedef {{ event: HydratedEvent, events: HydratedEvent[] }} EventResponse */
/** GET /api/checkouts: status per enabled repository id, empty in demo mode. */
/** @typedef {Record<string, CheckoutStatus>} CheckoutsResponse */
/** GET /api/repos/:id/checkout/status. @typedef {CheckoutStatus} CheckoutStatusResponse */
/** GET /api/repos/:id/checkout/branches. @typedef {{ branches: { name: string, local: boolean }[] }} CheckoutBranchesResponse */
/** POST /api/repos/:id/checkout. */
/** @typedef {CheckoutUpdateResult | BranchActionResult | ActivitySwitchResult} CheckoutUpdateResponse */
/** GET /api/connection. @typedef {ConnectionStatus} ConnectionResponse */
/** @typedef {{ commitId: string, comment?: string }} PushCommit */
/** GET /api/push/:repo/:id/commits. @typedef {{ items: PushCommit[], nextCursor: unknown, message?: string }} PushCommitsResponse */
/** GET /api/pr/:repo/:id/review. @typedef {PullRequestReview & { message?: string }} PrReviewResponse */
/** POST /api/backfill. @typedef {HistoryJob} BackfillResponse */
/** POST /api/refresh. @typedef {{ ok: true, status: RefreshStatus | { demo: true } }} RefreshResponse */
/** POST /api/reset. @typedef {{ started: true }} ResetResponse */
/** POST /api/discover. @typedef {Discovery} DiscoverResponse */
/**
 * POST /api/folders: one folder's subfolders and the checkouts found in it.
 * @typedef {{ path: string, parent: string | null, breadcrumbs: FolderLink[], folders: FolderLink[],
 *   repositories: DiscoveredCheckout[], warnings: string[] }} FoldersResponse
 */
/** POST /api/demo/event. @typedef {ActivityEvent} DemoEventResponse */

export {};
