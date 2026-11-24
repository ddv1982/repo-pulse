// Hand-written checks for the Azure DevOps records Repo Pulse reads (types in src/contract.ts). A check returns null
// when a value can be read, or the path of the first field that is missing or has the wrong type. A field the code
// needs for a record's identity or meaning makes the record unreadable when it is malformed. A display field the code
// shows with a fallback (a web link, a person, a title, a build's definition or trigger) reads whatever its value, and
// is passed on as Azure sent it, so the fallback, the fingerprint and the IDs see what main saw. Each type guard accepts
// exactly the records its check passes, so the checks and the types must name the same fields.
import type { AzureStream, AzureStreamRecords } from '../src/contract.ts';

/** Null when the value can be read; otherwise the path below it that cannot, '' for the value itself. */
export type Check = (value: unknown) => string | null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const is =
  (test: (value: unknown) => boolean): Check =>
  value =>
    test(value) ? null : '';
const optional =
  (check: Check): Check =>
  value =>
    value === undefined || value === null ? null : check(value);
export const fields =
  (shape: Record<string, Check>): Check =>
  value => {
    if (!isRecord(value)) return '';
    for (const [key, check] of Object.entries(shape)) {
      const fault = check(value[key]);
      if (fault !== null) return fault ? `${key}.${fault}` : key;
    }
    return null;
  };
export const list =
  (check: Check): Check =>
  value => {
    if (!Array.isArray(value)) return '';
    for (const item of value) {
      const fault = check(item);
      if (fault !== null) return fault;
    }
    return null;
  };

const text = optional(is(value => typeof value === 'string'));
/** A string with more than white space in it. */
const filled = is(value => typeof value === 'string' && value.trim() !== '');
const flag = optional(is(value => typeof value === 'boolean'));
/** A finite number: NaN or an infinity is no count or vote. */
const number = optional(is(value => Number.isFinite(value)));
/** Azure numbers pushes, pull requests and builds from 1. */
const id = is(value => Number.isSafeInteger(value) && Number(value) > 0);
/** A display field: the code shows it with a fallback, so any value reads. */
const display: Check = () => null;
const commitRef = optional(fields({ commitId: text }));
const repository = optional(fields({ id: text }));
/** Fields of a value that must be an object; when it is absent or not one, its first field is the one missing. */
const within =
  (shape: Record<string, Check>): Check =>
  value =>
    fields(shape)(isRecord(value) ? value : {});

const push = fields({
  pushId: id,
  date: text,
  pushedBy: display,
  refUpdates: optional(list(fields({ name: text, oldObjectId: text, newObjectId: text }))),
  commits: optional(list(() => null)),
  _links: display,
});
const ref = fields({
  name: filled,
  objectId: filled,
  peeledObjectId: text,
});
const pullRequest = fields({
  pullRequestId: id,
  repository,
  forkSource: optional(fields({ repository: optional(fields({ id: text, name: text, project: optional(fields({ name: text })) })) })),
  title: display,
  status: text,
  isDraft: flag,
  sourceRefName: text,
  targetRefName: text,
  creationDate: text,
  closedDate: text,
  createdBy: display,
  closedBy: display,
  lastMergeSourceCommit: commitRef,
  lastMergeTargetCommit: commitRef,
  lastMergeCommit: commitRef,
  mergeStatus: text,
  completionOptions: optional(fields({ mergeStrategy: text })),
  reviewers: optional(list(fields({ id: text, displayName: display, vote: number, isRequired: flag }))),
  _links: display,
});
const build = fields({
  id,
  // A build is matched to the watched repository by this ID, so a build without one cannot be placed.
  repository: within({ id: filled }),
  status: text,
  result: text,
  reason: display,
  queueTime: text,
  startTime: text,
  finishTime: text,
  sourceVersion: text,
  sourceBranch: text,
  definition: display,
  requestedFor: display,
  requestedBy: display,
  _links: display,
});
const checks: { [S in AzureStream]: Check } = {
  pushes: push,
  refs: ref,
  prs: pullRequest,
  closedPrs: pullRequest,
  builds: build,
  activeBuilds: build,
};

/** The field that names a record of the streams sync follows up by ID, or a ref by its name, and how it reads. */
const identityFields: Partial<Record<AzureStream, [string, Check]>> = {
  refs: ['name', filled],
  prs: ['pullRequestId', id],
  closedPrs: ['pullRequestId', id],
  builds: ['id', id],
  activeBuilds: ['id', id],
};
/** The ID of a pull request or build, or the name of a ref, that can be read even when another of its fields cannot. */
export function recordId(stream: AzureStream, value: unknown): string | undefined {
  const identity = identityFields[stream];
  if (!identity || !isRecord(value)) return undefined;
  const [key, check] = identity;
  return check(value[key]) === null ? String(value[key]) : undefined;
}

/** The first field a stream record cannot be read without, or null when it can be read. */
export function unreadableField(stream: AzureStream, value: unknown): string | null {
  const fault = checks[stream](value);
  return fault === null ? null : fault || 'record';
}

const readsAs =
  <S extends AzureStream>(stream: S) =>
  (value: unknown): value is AzureStreamRecords[S] =>
    checks[stream](value) === null;
const streamGuards: { [S in AzureStream]: (value: unknown) => value is AzureStreamRecords[S] } = {
  pushes: readsAs('pushes'),
  refs: readsAs('refs'),
  prs: readsAs('prs'),
  closedPrs: readsAs('closedPrs'),
  builds: readsAs('builds'),
  activeBuilds: readsAs('activeBuilds'),
};

/** The record as Azure sent it when its stream can read it, or undefined when it cannot. */
export const readRecord = <S extends AzureStream>(stream: S, value: unknown): AzureStreamRecords[S] | undefined =>
  streamGuards[stream](value) ? value : undefined;

/**
 * The records of a page read for this stream. Callers that hold a page of any stream use it to type the records; the
 * client has already left out any that cannot be read.
 */
export const recordsOf = <S extends AzureStream>(stream: S, items: readonly unknown[]): AzureStreamRecords[S][] =>
  items.flatMap(item => {
    const record = readRecord(stream, item);
    return record === undefined ? [] : [record];
  });
