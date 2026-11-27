// Hand-written checks for the JSON rows Repo Pulse keeps in SQLite, in the style of server/azure-records.ts. A row
// whose JSON cannot be parsed, or whose value fails its check, is reported by table, row and field with a
// CORRUPT_ROW error instead of being passed on. Each type guard accepts exactly the values its check passes, so a check
// and its type must name the same fields.
//
// Older versions wrote these rows too, and each check accepts every shape they wrote: a field added later is optional,
// a refs snapshot's saved refs were not checked before they were saved (sync checks them again), and a field the code
// shows with a fallback reads whatever its value. Events and enrichment are the exception: their provider data and
// display fields held whatever Azure sent before the Azure records were checked, so only the fields that identify an
// event are checked, and `data` and the enrichment overlay are checked to be objects (see the EventData item in
// docs/BACKLOG.md).
import { fields, is, isRecord, list, type Check } from './azure-records.ts';

import type { Repository, StoredEvent, StreamState, AzureStream, HistoryJob, SavedActivityFilter } from '../src/contract.d.ts';
import type { ActivityKind } from '../src/activity.ts';
import type { RewriteJob } from './rewrite-check.ts';
import type { ForkJob } from './fork-origin.ts';
import type { Followup } from './checkout-branches.ts';
import type { Observation } from './checkout-observations.ts';
import type { EntityData, EntityType } from './normalize.ts';
import { AppError, isAppError } from './errors.ts';

/** A row as node:sqlite returns it. */
export type SqlRow = Record<string, import('node:sqlite').SQLOutputValue>;

/** Jobs by type. Merge jobs were dropped by store migration 11. */
export type Job = HistoryJob | RewriteJob | ForkJob;
export type JobType = Job['type'];
export type JobOf<T extends JobType> = Extract<Job, { type: T }>;

/**
 * Versions before per-identity observations used a `checkout:${id}` key. Both keys store the same shape.
 */
export type Settings = {
  compactPending: boolean;
  refreshEnabled: boolean;
  refreshResumedAt: number;
  searchIndexVersion: number;
  demoSeeded: boolean;
  demoCounter: number;
  savedActivityFilters: SavedActivityFilter[];
  [key: `baseline:${string}`]: string;
  [key: `checkout-followup:${string}`]: Followup;
  [key: `checkout:${string}`]: Observation;
};
export type SettingKey = keyof Settings;

type Guard<T> = (value: unknown) => value is T;
const readsAs =
  <T>(check: Check): Guard<T> =>
  (value): value is T =>
    check(value) === null;

/** A field that is absent or passes `check`. Unlike azure-records' optional, null is not absent here. */
const maybe =
  (check: Check): Check =>
  value =>
    value === undefined ? null : check(value);
const nullable =
  (check: Check): Check =>
  value =>
    value === null ? null : check(value);
const oneOf = (...values: unknown[]) => is(value => values.includes(value));
const string = is(value => typeof value === 'string');
const boolean = is(value => typeof value === 'boolean');
const finite = is(value => Number.isFinite(value));
const object = is(isRecord);
/** Any value: a field the code shows with a fallback, or one saved unchecked that its reader checks again. */
const anything: Check = () => null;
const strings = list(string);

const STREAMS: AzureStream[] = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const KINDS: ActivityKind[] = ['branch-created', 'branch-deleted', 'tag', 'push', 'pr', 'build'];

// The store saves a repository with an ID and a name (createStore saveRepo). Every repository the app watches was
// resolved through Azure or is a demo fixture, so it also has its Azure identity; tests save repositories without one,
// so those fields are checked when present.
const repository = fields({
  id: string,
  name: string,
  organization: maybe(string),
  project: maybe(string),
  projectId: maybe(nullable(string)),
  azureId: maybe(string),
  webUrl: maybe(string),
  defaultBranch: maybe(nullable(string)),
  disabled: maybe(boolean),
  localPath: maybe(string),
});

// Older Azure dates could be numbers, which SQLite accepted while the JSON retained them.
const eventTime = is(value => typeof value === 'string' || Number.isFinite(value));
const event = fields({
  id: string,
  repoId: string,
  kind: oneOf(...KINDS),
  time: eventTime,
  observedAt: string,
  data: maybe(object),
});

const cursor = fields({
  skip: maybe(finite),
  token: maybe(string),
  from: maybe(string),
  to: maybe(string),
  allRefs: maybe(boolean),
});
const window = fields({ since: string, until: string });
const failure = fields({ code: string, message: string });
const unreadable = fields({ count: finite, fields: strings });
const warningShape = { code: oneOf('UNREADABLE_RECORDS'), message: string, count: finite, fields: strings };
const warning = fields(warningShape);
const stream = fields({
  repoId: string,
  stream: oneOf(...STREAMS),
  initialized: boolean,
  nextAt: string,
  error: maybe(nullable(failure)),
  warning: maybe(nullable(warning)),
  lastAttempt: maybe(string),
  lastSuccess: maybe(string),
  pending: maybe(boolean),
  failures: maybe(finite),
  quietCycles: maybe(finite),
  window: maybe(window),
  windowGeneration: maybe(finite),
  refreshGeneration: maybe(finite),
  manual: maybe(boolean),
  cursor: maybe(nullable(cursor)),
  // Refs saved by a version that did not check them; sync checks each one again (server/sync.ts snapshotRefs).
  pendingItems: maybe(list(anything)),
  activeIds: maybe(strings),
  unreadable: maybe(unreadable),
  unreadableIds: maybe(fields({ ids: strings, anonymous: finite })),
  unreadableLookups: maybe(list(fields({ id: string, field: string }))),
});

const historyJob = fields({
  id: string,
  type: oneOf('backfill'),
  repoId: string,
  days: is(value => value === 'all' || Number.isFinite(value)),
  status: oneOf('pending', 'running', 'retrying', 'completed'),
  startedAt: string,
  nextAt: string,
  rangeStart: string,
  rangeEnd: string,
  stream: oneOf('pushes', 'closedPrs', 'builds'),
  cursor: nullable(cursor),
  window: nullable(window),
  pages: finite,
  records: finite,
  windowsCompleted: finite,
  failures: finite,
  error: nullable(failure),
  warnings: maybe(list(fields({ ...warningShape, stream: oneOf('pushes', 'closedPrs', 'builds') }))),
  note: string,
  lastAttempt: maybe(string),
  lastProgressAt: maybe(string),
  coverageStart: maybe(string),
  completedAt: maybe(string),
});
const rewriteJob = fields({
  id: string,
  type: oneOf('rewrite'),
  repoId: string,
  eventId: string,
  ref: string,
  oldObjectId: string,
  newObjectId: string,
  attempts: finite,
  nextAt: string,
});
const forkJob = fields({
  id: string,
  type: oneOf('fork'),
  repoId: string,
  eventId: string,
  ref: string,
  pushId: finite,
  at: string,
  reads: finite,
  attempts: finite,
  nextAt: string,
  base: maybe(string),
  checks: maybe(list(fields({ ref: string, tip: string }))),
  on: maybe(strings),
  notOn: maybe(strings),
  unanswered: maybe(strings),
});
const jobGuards: { [T in JobType]: [Check, Guard<JobOf<T>>] } = {
  backfill: [historyJob, readsAs(historyJob)],
  rewrite: [rewriteJob, readsAs(rewriteJob)],
  fork: [forkJob, readsAs(forkJob)],
};
const isJobType = (value: unknown): value is JobType => typeof value === 'string' && Object.hasOwn(jobGuards, value);

// Entities. A push is recorded only to be found again, so its date reads whatever Azure sent. A ref's object IDs are
// what Azure sent too; they go into fingerprints and event data as stored.
// Older writers converted votes with Number(), so an infinite vote could serialize as null.
const vote = is(
  value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && (value[1] === null || Number.isFinite(value[1])),
);
// The normalizer reads a snapshot without a fingerprint or revision as changed, at revision 0.
const snapshot = { status: anything, revision: maybe(finite) };
const buildEntity = fields({ ...snapshot, fingerprint: maybe(object) });
const prEntity = fields({
  ...snapshot,
  // Votes joined the PR fingerprint later; a snapshot without them adopts the current votes (server/normalize.ts).
  fingerprint: maybe(fields({ votes: maybe(list(vote)) })),
});
const pushEntity = fields({ date: anything });
// Refs are found by their entity ID; the name in the data is written but not read.
const refEntity = fields({
  name: maybe(string),
  objectId: anything,
  peeledObjectId: anything,
  active: maybe(boolean),
  evidence: maybe(string),
  // Older writers used Number(pushId), which serializes a non-finite value as null.
  lastPushId: maybe(nullable(finite)),
  lastPushObservedAt: maybe(string),
});
const refBaseline = fields({ at: string, all: maybe(boolean), names: maybe(strings) });
const entityGuards: { [T in EntityType]: [Check, Guard<EntityData[T]>] } = {
  push: [pushEntity, readsAs(pushEntity)],
  ref: [refEntity, readsAs(refEntity)],
  pr: [prEntity, readsAs(prEntity)],
  build: [buildEntity, readsAs(buildEntity)],
  'ref-baseline': [refBaseline, readsAs(refBaseline)],
};

const advice = fields({
  branch: string,
  id: finite,
  url: maybe(string),
  // Older advice saved the Azure merge strategy verbatim. The display code looks up its label.
  strategy: anything,
  verified: boolean,
  targetVerified: maybe(boolean),
  receipt: maybe(fields({ target: string, result: string, sourceHead: maybe(string) })),
  destination: maybe(oneOf('local', 'remote-only', 'other-worktree', 'different-upstream', 'unknown')),
});
const rewrite = fields({
  previous: string,
  tip: string,
  verified: boolean,
  commits: list(fields({ side: oneOf('old', 'new'), id: string, subject: string })),
});
const observation = fields({
  identity: string,
  tracking: maybe(string),
  lastCheck: maybe(fields({ branch: string, at: string, tip: string, gitDirectory: string })),
  pending: maybe(strings),
  missing: maybe(fields({ head: string, advice: maybe(advice) })),
  rewrite: maybe(rewrite),
  failure: maybe(fields({ title: string, suggestion: string })),
});
const followup = fields({
  id: string,
  source: string,
  workspace: maybe(string),
  path: string,
  sourceHead: string,
  targetRef: string,
  result: string,
  recordedSource: maybe(string),
  targetIdentity: maybe(string),
  archive: maybe(string),
});
const savedFilter = fields({
  id: string,
  name: string,
  filters: fields({
    search: string,
    people: string,
    kind: string,
    repoIds: nullable(strings),
    view: oneOf('new', 'all'),
  }),
});
/** Automatic checks run unless a person turned them off; a database without the setting has them on. */
export function refreshEnabled(store: { getSetting: <K extends SettingKey, F>(key: K, fallback: F) => Settings[K] | F }) {
  return store.getSetting('refreshEnabled', true) !== false;
}
type FixedSettingKey = Exclude<SettingKey, `${string}:${string}`>;
const settingChecks: Record<FixedSettingKey, Check> = {
  compactPending: boolean,
  refreshEnabled: boolean,
  refreshResumedAt: finite,
  searchIndexVersion: finite,
  demoSeeded: boolean,
  demoCounter: finite,
  savedActivityFilters: list(savedFilter),
};
/** The check for a setting's value, by its key or the pattern its key matches. */
const isFixedSettingKey = (key: string): key is FixedSettingKey => Object.hasOwn(settingChecks, key);
function settingCheck(key: SettingKey): Check {
  if (isFixedSettingKey(key)) return settingChecks[key];
  if (key.startsWith('baseline:')) return string;
  if (key.startsWith('checkout-followup:')) return followup;
  if (key.startsWith('checkout:')) return observation;
  throw new TypeError(`Unknown setting key "${key}".`);
}

/** A stored row that cannot be read, by table, row and the first field that is missing or malformed. */
export function corruptRow(table: string, id: string, field: string, reason = 'is missing or malformed') {
  return Object.assign(new AppError('corrupt', `The stored ${table} row "${id}" cannot be read: ${field} ${reason}.`, 'CORRUPT_ROW'), {
    table,
    id,
    field,
  });
}

export function isCorruptRow(error: unknown): error is AppError {
  return isAppError(error, 'corrupt');
}

/** The value of a JSON column, or a CORRUPT_ROW error when it is not text holding JSON. */
function parsed(table: string, id: string, column: unknown): unknown {
  try {
    if (typeof column !== 'string') throw new TypeError('not text');
    return JSON.parse(column);
  } catch {
    throw corruptRow(table, id, 'data', 'is not valid JSON');
  }
}

/** The checked value of a JSON column. */
function checked<T>(table: string, id: string, column: unknown, check: Check, guard: Guard<T>): T {
  const value = parsed(table, id, column);
  if (guard(value)) return value;
  throw corruptRow(table, id, check(value) || 'data');
}

const text = (value: SqlRow[string] | undefined) => String(value ?? '');
const isRepository = readsAs<Repository>(repository);
const isEvent = readsAs<StoredEvent>(event);
const isStream = readsAs<StreamState>(stream);
const isOverlay: Guard<Record<string, unknown>> = isRecord;

/** A `repositories` row with its `id` and `data` columns. */
export function readRepository(row: SqlRow): Repository {
  const id = text(row.id);
  const value = checked('repositories', id, row.data, repository, isRepository);
  if (value.id !== id) throw corruptRow('repositories', id, 'id', 'does not match its column');
  return value;
}
/** An `events` row with its `id` and `data` columns. */
export function readEvent(row: SqlRow): StoredEvent {
  const id = text(row.id);
  const value = checked('events', id, row.data, event, isEvent);
  if (value.id !== id) throw corruptRow('events', id, 'id', 'does not match its column');
  return value;
}
/** The enrichment overlay of event `id`. */
export const readOverlay = (id: string, column: unknown) => checked('enrichment', id, column, object, isOverlay);
/** A `streams` row with its `repo_id`, `stream` and `data` columns. */
export function readStream(row: SqlRow): StreamState {
  const id = `${text(row.repo_id)}/${text(row.stream)}`;
  const value = checked('streams', id, row.data, stream, isStream);
  if (value.repoId !== row.repo_id) throw corruptRow('streams', id, 'repoId', 'does not match its column');
  if (value.stream !== row.stream) throw corruptRow('streams', id, 'stream', 'does not match its column');
  return value;
}
/** A `jobs` row of type `type`, with its `id`, `repo_id` and `data` columns. */
export function readJob<T extends JobType>(type: T, row: SqlRow): JobOf<T> {
  const [check, guard] = jobGuards[type];
  const id = text(row.id);
  const value = checked('jobs', id, row.data, check, guard);
  if (value.id !== id) throw corruptRow('jobs', id, 'id', 'does not match its column');
  if (value.repoId !== row.repo_id) throw corruptRow('jobs', id, 'repoId', 'does not match its column');
  return value;
}
/** A `jobs` row of any type, with its `id`, `type` and `data` columns. A type no version writes any more is corrupt. */
export function readAnyJob(row: SqlRow): Job {
  if (!isJobType(row.type)) throw corruptRow('jobs', text(row.id), 'type');
  return readJob(row.type, row);
}
/** An `entities` row of type `type`, with its `repo_id`, `id` and `data` columns. */
export function readEntity<T extends EntityType>(type: T, row: SqlRow): EntityData[T] {
  const [check, guard] = entityGuards[type];
  return checked('entities', `${text(row.repo_id)}/${type}/${text(row.id)}`, row.data, check, guard);
}
/**
 * The value of setting `key` in its `data` column. TypeScript cannot relate a key to the type its pattern holds in
 * Settings, so the check settingCheck chooses for the key stands for that relation, as each check does for its type.
 */
export function readSetting<K extends SettingKey>(key: K, column: unknown): Settings[K] {
  const check = settingCheck(key);
  return checked('settings', key, column, check, readsAs<Settings[K]>(check));
}

/** SQL increments this decimal counter. Keep its text so cache keys preserve every digit. */
export function readActivityRevision(column: unknown): string {
  if (typeof column === 'string' && /^\d+$/.test(column)) return column;
  throw corruptRow('settings', 'activityRevision', 'data');
}
