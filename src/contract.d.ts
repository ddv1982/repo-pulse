// The JSON the server sends and the browser reads. Nothing here imports server code, so browser modules can type
// their responses without pulling Node modules into their program. Server modules alias these types, and the
// handlers in server.ts check each response against its type with `satisfies`.

import type { ActivityEvent, EventData } from './activity.ts';

export type { ActivityEvent, EventData };

// Azure

/** The repository fields the client reads. Watched repositories carry more. */
export type AzureRepo = {
  organization: string;
  project: string;
  projectId?: string | null;
  azureId: string;
  webUrl: string;
  defaultBranch?: string | null;
};
export type AzureStream = 'pushes' | 'refs' | 'prs' | 'closedPrs' | 'builds' | 'activeBuilds';

// Azure DevOps records as Repo Pulse reads them. Each type names only the fields the code reads; the checks in
// server/azure-records.ts check those fields when a page is read. A display field the code shows with a fallback is
// `unknown`: it is passed on as Azure sent it. Records keep every other field Azure sends, and the code stores some of
// them whole.

/** An optional Azure field: absent, null, or of its type. */
type Maybe<T> = T | null | undefined;

export type AzureCommitRef = { commitId?: Maybe<string> };
export type AzureRefUpdate = { name?: Maybe<string>; oldObjectId?: Maybe<string>; newObjectId?: Maybe<string> };
export type AzurePush = {
  pushId: number;
  date?: Maybe<string>;
  pushedBy?: unknown;
  refUpdates?: Maybe<AzureRefUpdate[]>;
  commits?: Maybe<unknown[]>;
  _links?: unknown;
};
export type AzureRef = { name: string; objectId: string; peeledObjectId?: Maybe<string> };
export type AzureReviewer = { id?: Maybe<string>; displayName?: unknown; vote?: Maybe<number>; isRequired?: Maybe<boolean> };
export type AzureForkSource = {
  repository?: Maybe<{ id?: Maybe<string>; name?: Maybe<string>; project?: Maybe<{ name?: Maybe<string> }> }>;
};
export type AzurePullRequest = {
  pullRequestId: number;
  repository?: Maybe<{ id?: Maybe<string> }>;
  forkSource?: Maybe<AzureForkSource>;
  title?: unknown;
  status?: Maybe<string>;
  isDraft?: Maybe<boolean>;
  sourceRefName?: Maybe<string>;
  targetRefName?: Maybe<string>;
  creationDate?: Maybe<string>;
  closedDate?: Maybe<string>;
  createdBy?: unknown;
  closedBy?: unknown;
  lastMergeSourceCommit?: Maybe<AzureCommitRef>;
  lastMergeTargetCommit?: Maybe<AzureCommitRef>;
  lastMergeCommit?: Maybe<AzureCommitRef>;
  mergeStatus?: Maybe<string>;
  completionOptions?: Maybe<{ mergeStrategy?: Maybe<string> }>;
  reviewers?: Maybe<AzureReviewer[]>;
  _links?: unknown;
};
export type AzureBuild = {
  id: number;
  repository: { id: string };
  status?: Maybe<string>;
  result?: Maybe<string>;
  reason?: unknown;
  queueTime?: Maybe<string>;
  startTime?: Maybe<string>;
  finishTime?: Maybe<string>;
  sourceVersion?: Maybe<string>;
  sourceBranch?: Maybe<string>;
  definition?: unknown;
  requestedFor?: unknown;
  requestedBy?: unknown;
  _links?: unknown;
};
/** The record each stream reads. */
export type AzureStreamRecords = {
  pushes: AzurePush;
  refs: AzureRef;
  prs: AzurePullRequest;
  closedPrs: AzurePullRequest;
  builds: AzureBuild;
  activeBuilds: AzureBuild;
};
export type AzureStreamRecord = AzureStreamRecords[AzureStream];
/** Records a page left out because a field they need is missing or malformed, and the fields that were. */
export type UnreadableRecords = { count: number; fields: string[] };
/** Of some records left out, the IDs (a ref's name) that could still be read, and how many had none. */
export type UnreadableIds = { ids: string[]; anonymous: number };
/**
 * Where the next page starts: `skip` for offset-paged reads, `token` for continuation reads.
 * Build reads also keep their coarse window in `from` and `to`.
 */
export type PageCursor = { skip?: number; token?: string; from?: string; to?: string; allRefs?: boolean };
export type AccessCheck = { status: 'ok' | 'failed'; checkedAt: string; code?: string; message?: string };
export type ConnectionStatus = {
  available: boolean;
  identity: null;
  identityVerified: boolean;
  message: string;
  code?: string;
  version?: string | undefined;
  extension?: string | undefined;
  signedIn?: boolean;
  account?: { name: string };
  access?: AccessCheck;
  capabilities?: { organizationRead: boolean };
};
/**
 * What a PR detail shows on request: counts of people's discussion threads and each policy's result.
 * Vote, reviewer and ref-update threads are Azure's own records of other events, so they are not counted.
 */
export type PullRequestReview = {
  threads: { open: number; resolved: number };
  policies: { name: string; status: string; blocking: boolean }[];
};
export type CliLastError = { code: string | undefined; message: string | undefined };
/**
 * The Azure CLI queue's counters, read for Copy diagnostics.
 */
export type CliDiagnostics = {
  startsLastMinute: number;
  totalStarts: number;
  pending: number;
  running: number;
  limitPerMinute: number;
  concurrency: number;
  upstreamRequests: null;
  lastError: CliLastError | null;
  throttledUntil: string | null;
};

// Store

/** The JSON in `events.data`. Insertion always fills `time` and `observedAt`; `data` keeps provider fields beyond EventData. */
export type StoredEvent = ActivityEvent & { observedAt: string; data?: EventData & Record<string, unknown> };
/** An event as the store returns it: the read flags come from their columns and enrichment is merged into `data`. */
export type HydratedEvent = StoredEvent & { seen: boolean; imported: boolean };
/** Every watched repository was resolved through Azure (or is a demo fixture), so its Azure identity is always present. */
export type Repository = AzureRepo & { id: string; name: string; disabled?: boolean; localPath?: string | undefined };

// Sync

export type StreamWindow = { since: string; until: string };
export type StreamError = { code: string; message: string };
/**
 * What the last completed read skipped because it could not read the records, summed across its pages. Only a
 * completed read replaces it, or clears it when it skipped none; pages in progress, failed reads and restarted reads
 * leave it as it was. A retry cannot repair a changed response shape, so the read still succeeds; sync status shows
 * this as a problem.
 */
export type StreamWarning = StreamError & UnreadableRecords & { code: 'UNREADABLE_RECORDS' };
/**
 * Persisted per repository and stream. Optional fields are absent before the first read
 * or after a completed read, which keeps only the fields `completePage` writes. Demo seeds
 * leave `error` out entirely.
 */
export type StreamState = {
  repoId: string;
  stream: AzureStream;
  initialized: boolean;
  nextAt: string;
  error?: StreamError | null;
  warning?: StreamWarning | null | undefined;
  lastAttempt?: string;
  lastSuccess?: string | undefined;
  pending?: boolean;
  failures?: number;
  quietCycles?: number;
  window?: StreamWindow;
  windowGeneration?: number;
  refreshGeneration?: number | undefined;
  manual?: boolean | undefined;
  cursor?: PageCursor | null | undefined;
  /** Legacy refs checkpoints can contain provider records that still need checking. */
  pendingItems?: unknown[] | undefined;
  activeIds?: string[] | undefined;
  /** The records the read in progress has left out so far, summed across its pages. */
  unreadable?: UnreadableRecords | undefined;
  /**
   * Of the records the read in progress has left out so far, the IDs that could still be read (a ref's name) and how
   * many had none.
   */
  unreadableIds?: UnreadableIds | undefined;
  /**
   * Cached active PRs or in-progress builds whose lookup by ID came back unreadable, with the field, so every read
   * counts them until one reads, its lookup finds it gone, or the active list holds it again, not only the reads whose
   * lookups reach it.
   */
  unreadableLookups?: { id: string; field: string }[] | undefined;
};
/**
 * The sync loop's counters, read for Copy diagnostics. `lastTurn` holds when each kind of turn last ran.
 */
export type SyncEngineStatus = {
  running: boolean;
  stopped: boolean;
  pages: number;
  errors: number;
  streams: number;
  lastTurn: { history?: string; live?: string; rewrite?: string };
  backgroundProblems: { history?: string; rewrite?: string };
  lag: { overdueStreams: number; maxDelayMs: number };
  inProgress: { repoId: string; stream: AzureStream }[];
};
export type DemoSyncStatus = { demo: true; running: false };
export type RefreshStatus = { scheduled: boolean; cooldown?: boolean };
export type SyncState = 'paused' | 'problem' | 'delayed' | 'syncing' | 'synced';
/**
 * `since` is the oldest last success across the repository's streams, absent until every stream has read once.
 */
export type SyncStatus = {
  state: SyncState;
  reason?: string;
  since?: string;
  lastCheck?: string;
  stream?: AzureStream | 'history';
  signInRequired?: true;
};
export type OverallSyncStatus = (SyncStatus & { repoId: string }) | { state: 'empty' } | { state: 'problem'; reason: string };
export type SyncStatusReport = { overall: OverallSyncStatus; repos: Record<string, SyncStatus> };

// History import

export type HistoryStream = 'pushes' | 'closedPrs' | 'builds';
export type HistoryWindow = { since: string; until: string };
export type JobError = { code: string; message: string };
/** The records of one stream that a history import skipped because Azure returned them unreadable, summed across its pages. */
export type HistoryWarning = StreamWarning & { stream: HistoryStream };
export type HistoryJob = {
  id: string;
  type: 'backfill';
  repoId: string;
  days: number | 'all';
  status: 'pending' | 'running' | 'retrying' | 'completed';
  startedAt: string;
  nextAt: string;
  rangeStart: string;
  rangeEnd: string;
  stream: HistoryStream;
  cursor: PageCursor | null;
  window: HistoryWindow | null;
  pages: number;
  records: number;
  windowsCompleted: number;
  failures: number;
  error: JobError | null;
  /** One per stream that had unreadable records, in the order the import first met them. */
  warnings?: HistoryWarning[];
  note: string;
  lastAttempt?: string;
  lastProgressAt?: string;
  coverageStart?: string;
  completedAt?: string;
};

// Saved filters

export type ActivityFilters = { search: string; people: string; kind: string; repoIds: string[] | null; view: 'new' | 'all' };
export type SavedActivityFilter = { id: string; name: string; filters: ActivityFilters };

// Repository discovery

/** A Git remote keeps the parsed Azure identity, but `name` is the remote's name and `repoName` the Azure repository. */
export type DiscoveredRemote = { organization: string; project: string; name: string; repoName: string; url: string };
export type DiscoveredCheckout = { localPath: string; remotes: DiscoveredRemote[] };
export type Discovery = { repositories: DiscoveredCheckout[]; warnings: string[] };
export type FolderLink = { name: string; path: string };

// Checkouts

export type PullAdvice = {
  branch: string;
  id: number;
  url?: string;
  strategy?: unknown;
  verified: boolean;
  targetVerified?: boolean;
  receipt?: { target: string; result: string; sourceHead?: string | undefined };
  destination?: 'local' | 'remote-only' | 'other-worktree' | 'different-upstream' | 'unknown' | undefined;
};
export type Rewrite = { previous: string; tip: string; verified: boolean; commits: { side: 'old' | 'new'; id: string; subject: string }[] };
export type CheckoutDiagnostic = {
  title?: string;
  message?: string | undefined;
  suggestion: string;
  advice?: PullAdvice | undefined;
  comparison?: Rewrite;
};
/** The part of a follow-up plan a checkout status shows. */
export type FollowupSummary = { id: string; source: string; workspace?: string | undefined };
export type Review = {
  kind: 'included' | 'local-followup' | 'unknown' | 'changed' | 'occupied';
  commits?: { id: string; subject: string }[];
  branch?: string;
  canRemove?: boolean;
};
export type GitStatus = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
};

export type CheckoutSelection = { branch: string; head: string; upstream: string | null; identity: string };

export type SwitchIntent = CheckoutSelection & { switchIdentity: string };

export type CheckoutIntent = CheckoutSelection & { upstream: string };

export type CheckoutReading = GitStatus & {
  identity: string;
  switchIdentity: string | null;
  lastBranchCheck?: { at: string; matchesFetchedTip: boolean } | undefined;
};

export type ActivitySwitchReview = { token: string; upstream: string; previous: string | null; tip: string; ahead: number; behind: number };

export type BlockedState =
  | 'in-progress'
  | 'detached'
  | 'unborn'
  | 'dirty'
  | 'no-upstream'
  | 'different-remote'
  | 'upstream-missing'
  | 'upstream-rewritten'
  | 'fetch-failed'
  | 'unknown'
  | 'diverged'
  | 'ahead'
  | 'current';

export type PullableCheckout = CheckoutIntent & CheckoutReading & { state: 'behind'; canCheck: true; canPull: true };

export type BlockedCheckout = CheckoutReading & {
  state: BlockedState;
  canCheck: boolean;
  canPull: false;
  diagnostic?: CheckoutDiagnostic | undefined;
};

export type ActiveCheckout = PullableCheckout | BlockedCheckout;

/** A checkout with an open branch follow-up names it, so the page can offer to review or remove the old branch. */
export type DecoratedCheckout = ActiveCheckout & { followup?: FollowupSummary };

export type CheckoutStatus = DecoratedCheckout | { state: 'unavailable' | 'not-linked'; diagnostic?: CheckoutDiagnostic };
/** A check or pull, with the checkout read after it. */
export type CheckoutUpdateResult = { checkout: CheckoutStatus; updated: boolean };
/**
 * A branch action, with the checkout read after it: a message, a review of the branch, or a next step.
 */
export type BranchActionResult =
  | { checkout: CheckoutStatus; message: string }
  | { checkout: CheckoutStatus; review: Review; message?: undefined; nextStep?: undefined }
  | { checkout: CheckoutStatus; message: string; nextStep: string; review?: undefined };
/**
 * A switch to an activity's branch: switched (with a notice), refused (with a message), or waiting for the reader to
 * confirm the review.
 */
export type ActivitySwitchResult =
  | { checkout: DecoratedCheckout; notice: string | undefined; message?: undefined }
  | { checkout: CheckoutStatus; message: string; notice?: undefined }
  | { checkout: CheckoutStatus; switchReview?: undefined }
  | { checkout: CheckoutStatus; switchReview: ActivitySwitchReview };

// Responses, one per route

export type ErrorResponse = { message: string; code?: string | undefined };
export type OkResponse = { ok: true };
/** POST /api/session: the key, given once for the launch token. */
export type SessionResponse = { key: string };
/**
 * GET /api/state. The settings are only ever written by POST /api/settings.
 */
export type StateResponse = {
  repos: Repository[];
  streams: StreamState[];
  diagnostics: Partial<CliDiagnostics> & { sync: SyncEngineStatus | DemoSyncStatus };
  jobs: HistoryJob[];
  activityRevision: string;
  savedFilters: SavedActivityFilter[];
  settings: { refreshEnabled: boolean; refreshResumedAt: number | null };
  syncStatus: SyncStatusReport;
  demo: boolean;
};
/** GET /api/activity, built by server/activity-query.ts. */
export type { ActivityPage as ActivityResponse } from './activity.ts';
/** GET /api/events/:id: the event and every event grouped with it. */
export type EventResponse = { event: HydratedEvent; events: HydratedEvent[]; related?: HydratedEvent[] };
/** GET /api/checkouts: status per enabled repository id, empty in demo mode. */
export type CheckoutsResponse = Record<string, CheckoutStatus>;
/** GET /api/repos/:id/checkout/status. */
export type CheckoutStatusResponse = CheckoutStatus;
/** GET /api/repos/:id/checkout/branches. */
export type CheckoutBranchesResponse = { branches: { name: string; local: boolean }[] };
/** POST /api/repos/:id/checkout. */
export type CheckoutUpdateResponse = CheckoutUpdateResult | BranchActionResult | ActivitySwitchResult;
/** GET /api/connection. */
export type ConnectionResponse = ConnectionStatus;
export type PushCommit = { commitId: string; comment?: string };
/** GET /api/push/:repo/:id/commits. */
export type PushCommitsResponse = { items: PushCommit[]; nextCursor: unknown; message?: string };
/** GET /api/pr/:repo/:id/review. */
export type PrReviewResponse = PullRequestReview & { message?: string };
/** POST /api/backfill. */
export type BackfillResponse = HistoryJob;
/** POST /api/refresh. */
export type RefreshResponse = { ok: true; status: RefreshStatus | { demo: true } };
/** POST /api/reset. */
export type ResetResponse = { started: true };
/** POST /api/discover. */
export type DiscoverResponse = Discovery;
/**
 * POST /api/folders: one folder's subfolders and the checkouts found in it.
 */
export type FoldersResponse = {
  path: string;
  parent: string | null;
  breadcrumbs: FolderLink[];
  folders: FolderLink[];
  repositories: DiscoveredCheckout[];
  warnings: string[];
};
/** POST /api/demo/event. */
export type DemoEventResponse = ActivityEvent;

export type GitHistoryActivity = {
  id: string;
  kind: 'build' | 'pr';
  title: string;
  status: string;
};

export type GitHistoryPage = {
  head: string;
  branch: string | null;
  upstream: string | null;
  shallow: boolean;
  commits: {
    id: string;
    parents: string[];
    author: string;
    subject: string;
    refs: string[];
    activity: GitHistoryActivity[];
  }[];
  nextCursor: string | null;
};
