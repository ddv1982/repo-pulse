// The JSON the server sends and the browser reads. Nothing here imports server code, so browser modules can type
// their responses without pulling Node modules into their program. Server modules alias these types, and the
// handlers in server.ts check each response against its type with `satisfies`. Besides types, this module holds only
// constant lists that a union is derived from, so the server and the browser can both import it.

import type { ActivityEvent, ActivityPage, EventData } from './activity.ts';
import type { ActivityStatusId } from './activity-text.ts';

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
/** Every stream sync reads for a watched repository. */
export const AZURE_STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'] as const;
export type AzureStream = (typeof AZURE_STREAMS)[number];

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

/** The time range one read covers. It stays fixed across the pages of that read. */
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
 * The sync loop's counters, read for Copy diagnostics. `lastTurn` holds when each kind of turn last ran. GET /api/state
 * reports this as `diagnostics.sync`.
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
export type RefreshStatus = { scheduled: boolean; cooldown?: boolean };
export type SyncState = 'paused' | 'problem' | 'delayed' | 'syncing' | 'synced';
/**
 * `since` is the oldest last success across the repository's streams, absent until every stream has read once.
 */
export type SyncStatus = {
  state: SyncState;
  firstSync?: { completed: number; total: number };
  reason?: string;
  since?: string;
  lastCheck?: string;
  stream?: AzureStream | 'history';
  signInRequired?: true;
};
/** The status of one repository, which names it, or of the app as a whole, which names none. */
export type OverallSyncStatus =
  (SyncStatus & { repoId: string }) | { state: 'empty'; repoId?: undefined } | { state: 'problem'; reason: string; repoId?: undefined };
export type SyncStatusReport = { overall: OverallSyncStatus; repos: Record<string, SyncStatus> };

// History import

/** The streams a history import reads, in the order it reads them. */
export const HISTORY_IMPORT_STREAMS = ['pushes', 'closedPrs', 'builds'] as const;
export type HistoryImportStream = (typeof HISTORY_IMPORT_STREAMS)[number];
export type HistoryImportWindow = { since: string; until: string };
export type JobError = { code: string; message: string };
/** The records of one stream that a history import skipped because Azure returned them unreadable, summed across its pages. */
export type HistoryImportWarning = StreamWarning & { stream: HistoryImportStream };
export type HistoryImportJob = {
  id: string;
  type: 'backfill';
  repoId: string;
  days: number | 'all';
  status: 'pending' | 'running' | 'retrying' | 'completed';
  startedAt: string;
  nextAt: string;
  rangeStart: string;
  rangeEnd: string;
  stream: HistoryImportStream;
  cursor: PageCursor | null;
  window: HistoryImportWindow | null;
  pages: number;
  records: number;
  windowsCompleted: number;
  failures: number;
  error: JobError | null;
  /** One per stream that had unreadable records, in the order the import first met them. */
  warnings?: HistoryImportWarning[];
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
  | { checkout: CheckoutStatus; message: string; review?: undefined; nextStep?: undefined }
  | { checkout: CheckoutStatus; review: Review; message?: undefined; nextStep?: undefined }
  | { checkout: CheckoutStatus; message: string; nextStep: string; review?: undefined };
/**
 * A switch to an activity's branch: switched (with a notice), refused (with a message), or waiting for the reader to
 * confirm the review.
 */
export type ActivitySwitchResult =
  | { checkout: DecoratedCheckout; notice: string | undefined; message?: undefined; switchReview?: undefined }
  | { checkout: CheckoutStatus; message: string; notice?: undefined; switchReview?: undefined }
  | { checkout: CheckoutStatus; switchReview?: undefined; message?: undefined; notice?: undefined }
  | { checkout: CheckoutStatus; switchReview: ActivitySwitchReview; message?: undefined; notice?: undefined };

// Responses, one per route

export type ErrorResponse = { message: string; code?: string | undefined };
export type OkResponse = { ok: true };
/** POST /api/session: the key, given once for the launch token. */
export type SessionResponse = { key: string };
/**
 * GET /api/state. The settings are only ever written by PATCH /api/settings.
 */
export type StateResponse = {
  repos: Repository[];
  streams: Pick<StreamState, 'repoId' | 'stream' | 'initialized' | 'lastSuccess' | 'error' | 'warning'>[];
  diagnostics: Partial<CliDiagnostics> & { sync: SyncEngineStatus };
  jobs: HistoryImportJob[];
  activityRevision: string;
  savedFilters: SavedActivityFilter[];
  settings: { refreshEnabled: boolean; refreshResumedAt: number | null };
  syncStatus: SyncStatusReport;
  demo: boolean;
};
/** GET /api/activity/:id: the event and every event grouped with it. */
export type EventResponse = { event: HydratedEvent; events: HydratedEvent[]; related?: HydratedEvent[] };
/** GET /api/checkouts: status per enabled repository id, empty in demo mode. */
export type CheckoutsResponse = Record<string, CheckoutStatus>;
/** GET /api/repos/:id/checkout/status. */
export type CheckoutStatusResponse = CheckoutStatus;
/** GET /api/repos/:id/checkout/branches. */
export type CheckoutBranchesResponse = { branches: { name: string; local: boolean }[] };
/** A step of a branch follow-up: switch to the PR target and update it, review or remove the old branch, or carry commits. */
export type BranchAction =
  | { operation: 'switch-update'; prId: number; result: string }
  | { operation: 'review' | 'remove'; planId: string }
  | { operation: 'carry'; planId: string; commits: string[] };
/**
 * A Git action on a linked checkout, as the server acts on it once the route has read the request. Each names the
 * checkout the page showed in `expected`; the server checks it against the checkout before it changes anything.
 */
export type CheckoutCommand =
  | { operation: 'check' | 'pull'; expected: CheckoutIntent }
  | { operation: 'switch-activity'; expected: SwitchIntent; eventId: string; confirmation: string | undefined }
  | { operation: 'switch-branch'; expected: SwitchIntent; branch: string; confirmation: string | undefined }
  | (BranchAction & { expected: CheckoutIntent });
export type CheckoutOperation = CheckoutCommand['operation'];
type WithoutExpected<C> = C extends unknown ? Omit<C, 'expected'> : never;
/**
 * POST /api/repos/:id/checkout as the page sends it: one command, with `expected` copied from the checkout the page
 * shows, whose fields may be missing. The route reads the command again and refuses one whose checkout is incomplete.
 */
export type CheckoutRequest = WithoutExpected<CheckoutCommand> & {
  expected: { [K in 'branch' | 'head' | 'upstream' | 'identity' | 'switchIdentity']?: string | null | undefined };
};
/** POST /api/repos/:id/checkout: the result of the command, with the operation it answers. */
export type CheckoutUpdateResponse =
  | ({ operation: 'check' | 'pull' } & CheckoutUpdateResult)
  | ({ operation: 'switch-activity' | 'switch-branch' } & ActivitySwitchResult)
  | ({ operation: BranchAction['operation'] } & BranchActionResult);
/** GET /api/connection and GET /api/repos/:id/connection: a connection check's answer. */
export type ConnectionResponse = ConnectionStatus;
export type PushCommit = { commitId: string; comment?: string };
/** GET /api/repos/:id/pushes/:pushId/commits. */
export type PushCommitsResponse = { items: PushCommit[]; nextCursor: PageCursor | null; message?: string };
/** GET /api/repos/:id/prs/:prId/review. */
export type PrReviewResponse = PullRequestReview & { message?: string };
/** POST /api/repos/:id/backfill. */
export type HistoryImportResponse = HistoryImportJob;
/** POST /api/refresh. */
export type RefreshResponse = { ok: true; status: RefreshStatus };
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
  time: ActivityEvent['time'];
  title: string;
  /** The browser names and colours it from src/activity-text.ts. */
  status: ActivityStatusId;
};

export type GitHistorySnapshot = { snapshot: string };

export type GitHistoryPage = GitHistorySnapshot & {
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

// Routes

/** The names of the query parameters the Activity page and its unread lookup share. */
type ActivityScopeQuery = 'repoIds' | 'kind' | 'search' | 'people';

/**
 * What a route takes and answers: `query` names the parameters it reads, all optional text; `body` is the JSON object a
 * POST or PATCH sends. The types ride on `types`, which is never set, so the route map below is their only source.
 */
type Route<Response, Body = undefined, Query extends string = never> = { response: Response; body: Body; query: Query };
const route = <Response, Body = undefined, Query extends string = never>(
  status: 200 | 201 | 202,
): { status: 200 | 201 | 202; types?: Route<Response, Body, Query> } => ({ status });

/**
 * Every API route by method and path, with the status a success answers with and its types. `:name` marks a path
 * parameter. The server registers exactly these keys (server/http.ts) and the browser requests them through
 * `request()` in src/api.ts. POST /api/session is answered before the access key check and is not part of this map.
 */
export const ROUTES = {
  'GET /api/state': route<StateResponse>(200),
  'GET /api/activity': route<ActivityPage, undefined, ActivityScopeQuery | 'view' | 'limit' | 'cursor'>(200),
  'GET /api/activity/unseen': route<{ ids: string[] }, undefined, ActivityScopeQuery | 'through'>(200),
  'GET /api/activity/:id': route<EventResponse, undefined, 'ci'>(200),
  'POST /api/activity-filters': route<SavedActivityFilter, { name: string; filters: ActivityFilters }>(201),
  'PATCH /api/activity-filters/:id': route<SavedActivityFilter, { name: string } | { filters: ActivityFilters }>(200),
  'DELETE /api/activity-filters/:id': route<OkResponse>(200),
  'POST /api/ack': route<OkResponse & { changedIds: string[] }, { ids: string[]; seen?: boolean }>(200),
  'POST /api/refresh': route<RefreshResponse, { repoIds?: string[]; retrySignIn?: boolean }>(202),
  'POST /api/reset': route<ResetResponse, Record<string, never>>(202),
  'PATCH /api/settings': route<OkResponse, { refreshEnabled: boolean }>(200),
  'GET /api/connection': route<ConnectionResponse, undefined, 'organization'>(200),
  'POST /api/discover': route<DiscoverResponse, { path: string }>(200),
  'POST /api/folders': route<FoldersResponse, { path?: string }>(200),
  'GET /api/checkouts': route<CheckoutsResponse>(200),
  'POST /api/repos': route<Repository, { url: string } | { path: string; remote?: string }>(201),
  'PATCH /api/repos/:id': route<OkResponse, { disabled: boolean }>(200),
  'DELETE /api/repos/:id': route<OkResponse>(200),
  'GET /api/repos/:id/connection': route<ConnectionResponse>(200),
  'POST /api/repos/:id/backfill': route<HistoryImportResponse, { days: HistoryImportJob['days'] }>(202),
  'GET /api/repos/:id/checkout/status': route<CheckoutStatusResponse, undefined, 'fresh'>(200),
  'GET /api/repos/:id/checkout/branches': route<CheckoutBranchesResponse>(200),
  'POST /api/repos/:id/checkout': route<CheckoutUpdateResponse, CheckoutRequest>(200),
  'GET /api/repos/:id/graph': route<GitHistoryPage, undefined, 'cursor'>(200),
  'GET /api/repos/:id/graph/snapshot': route<GitHistorySnapshot>(200),
  'GET /api/repos/:id/pushes/:pushId/commits': route<PushCommitsResponse, undefined, 'skip'>(200),
  'GET /api/repos/:id/prs/:prId/review': route<PrReviewResponse>(200),
  'POST /api/demo/event': route<DemoEventResponse, Record<string, never>>(201),
};
export type RouteKey = keyof typeof ROUTES;
type RouteTypes = { [K in RouteKey]: NonNullable<(typeof ROUTES)[K]['types']> };

/** The names of a path's `:name` parameters. */
type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;
export type RouteParams<K extends RouteKey> = { [Name in ParamNames<K>]: string };
export type RouteQuery<K extends RouteKey> = { [Name in RouteTypes[K]['query']]?: string | undefined };
export type RouteBody<K extends RouteKey> = RouteTypes[K]['body'];
export type RouteResponse<K extends RouteKey> = RouteTypes[K]['response'];
