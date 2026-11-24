// Hand-written checks for the Azure DevOps records Repo Pulse reads (types in src/contract.ts). A check returns null
// when a value can be read, or the path of the first field that is missing or has the wrong type. Each type guard
// accepts exactly the records its check passes, so the checks and the types must name the same fields.
import type { AzureBuild, AzurePullRequest, AzurePush, AzureRef, AzureStream, AzureStreamRecords } from '../src/contract.ts';

/** Null when the value can be read; otherwise the path below it that cannot, '' for the value itself. */
type Check = (value: unknown) => string | null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const is =
  (test: (value: unknown) => boolean): Check =>
  value =>
    test(value) ? null : '';
const optional =
  (check: Check): Check =>
  value =>
    value === undefined || value === null ? null : check(value);
const fields =
  (shape: Record<string, Check>): Check =>
  value => {
    if (!isRecord(value)) return '';
    for (const [key, check] of Object.entries(shape)) {
      const fault = check(value[key]);
      if (fault !== null) return fault ? `${key}.${fault}` : key;
    }
    return null;
  };
const list =
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
const flag = optional(is(value => typeof value === 'boolean'));
const number = optional(is(value => typeof value === 'number'));
/** Azure numbers pushes, pull requests and builds from 1. */
const id = is(value => Number.isSafeInteger(value) && Number(value) > 0);
const identity = optional(fields({ displayName: text, name: text }));
const links = optional(fields({ web: optional(fields({})) }));
const commitRef = optional(fields({ commitId: text }));
const repository = optional(fields({ id: text }));

const push = fields({
  pushId: id,
  date: text,
  pushedBy: identity,
  refUpdates: optional(list(fields({ name: text, oldObjectId: text, newObjectId: text }))),
  commits: optional(list(() => null)),
  _links: links,
});
const ref = fields({
  name: is(value => typeof value === 'string'),
  objectId: is(value => typeof value === 'string'),
  peeledObjectId: text,
});
const pullRequest = fields({
  pullRequestId: id,
  repository,
  forkSource: optional(fields({ repository: optional(fields({ id: text, name: text, project: optional(fields({ name: text })) })) })),
  title: text,
  status: text,
  isDraft: flag,
  sourceRefName: text,
  targetRefName: text,
  creationDate: text,
  closedDate: text,
  createdBy: identity,
  closedBy: identity,
  lastMergeSourceCommit: commitRef,
  lastMergeTargetCommit: commitRef,
  lastMergeCommit: commitRef,
  mergeStatus: text,
  completionOptions: optional(fields({ mergeStrategy: text })),
  reviewers: optional(list(fields({ id: text, displayName: text, vote: number, isRequired: flag }))),
  _links: links,
});
const build = fields({
  id,
  repository,
  status: text,
  result: text,
  reason: text,
  queueTime: text,
  startTime: text,
  finishTime: text,
  sourceVersion: text,
  sourceBranch: text,
  definition: optional(fields({ name: text })),
  requestedFor: identity,
  requestedBy: identity,
  _links: links,
});
const checks: { [S in AzureStream]: Check } = {
  pushes: push,
  refs: ref,
  prs: pullRequest,
  closedPrs: pullRequest,
  builds: build,
  activeBuilds: build,
};

/** The field that names a record of the streams sync follows up by ID. */
const identityFields: Partial<Record<AzureStream, string>> = {
  prs: 'pullRequestId',
  closedPrs: 'pullRequestId',
  builds: 'id',
  activeBuilds: 'id',
};
/** The ID of a pull request or build whose ID can be read, even when another of its fields cannot. */
export function recordId(stream: AzureStream, value: unknown): string | undefined {
  const key = identityFields[stream];
  if (!key || !isRecord(value) || id(value[key]) !== null) return undefined;
  return String(value[key]);
}

/** The first field a stream record cannot be read without, or null when it can be read. */
export function unreadableField(stream: AzureStream, value: unknown): string | null {
  const fault = checks[stream](value);
  return fault === null ? null : fault || 'record';
}

export const isAzurePush = (value: unknown): value is AzurePush => push(value) === null;
export const isAzureRef = (value: unknown): value is AzureRef => ref(value) === null;
export const isAzurePullRequest = (value: unknown): value is AzurePullRequest => pullRequest(value) === null;
export const isAzureBuild = (value: unknown): value is AzureBuild => build(value) === null;

/** The guard for each stream's records. */
export const streamGuards: { [S in AzureStream]: (value: unknown) => value is AzureStreamRecords[S] } = {
  pushes: isAzurePush,
  refs: isAzureRef,
  prs: isAzurePullRequest,
  closedPrs: isAzurePullRequest,
  builds: isAzureBuild,
  activeBuilds: isAzureBuild,
};

/**
 * The records of a page read for this stream. Callers that hold a page of any stream use it to type the records; the
 * client has already left out any that fail the guard.
 */
export const recordsOf = <S extends AzureStream>(stream: S, items: readonly unknown[]): AzureStreamRecords[S][] =>
  items.filter(streamGuards[stream]);
