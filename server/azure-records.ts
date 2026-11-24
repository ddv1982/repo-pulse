// Hand-written readers for the Azure DevOps records Repo Pulse reads (types in src/contract.ts). A reader returns the
// value as it can be read, or the path of the first field that is missing or has the wrong type. A field the code
// needs for a record's identity or meaning makes the record unreadable when it is malformed. A display field the code
// has a fallback for (a web link, a person's name, a title, a build's definition name or trigger) is left out instead,
// as main read it as absent, so the record is kept without it. Each type guard accepts exactly the records its reader
// reads unchanged, so the readers and the types must name the same fields.
import type { AzureStream, AzureStreamRecords } from '../src/contract.ts';

/** The value, or a copy without its malformed display fields; `fault` is the path below it that cannot be read. */
type Read = { value: unknown } | { fault: string };
type Reader = (value: unknown) => Read;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const is =
  (test: (value: unknown) => boolean): Reader =>
  value =>
    test(value) ? { value } : { fault: '' };
const optional =
  (reader: Reader): Reader =>
  value =>
    value === undefined || value === null ? { value } : reader(value);
/** A display field: malformed, it reads as absent rather than making the record unreadable. */
const display =
  (reader: Reader): Reader =>
  value => {
    const read = optional(reader)(value);
    return 'fault' in read ? { value: undefined } : read;
  };
const fields =
  (shape: Record<string, Reader>): Reader =>
  value => {
    if (!isRecord(value)) return { fault: '' };
    const changed: Map<string, unknown> = new Map();
    for (const [key, reader] of Object.entries(shape)) {
      const read = reader(value[key]);
      if ('fault' in read) return { fault: read.fault ? `${key}.${read.fault}` : key };
      if (read.value !== value[key]) changed.set(key, read.value);
    }
    if (!changed.size) return { value };
    // A display field that reads as absent is left out of the copy; every field the shape does not name is kept.
    const copy = Object.entries(value).flatMap(([key, item]): [string, unknown][] => {
      if (!changed.has(key)) return [[key, item]];
      const read = changed.get(key);
      return read === undefined ? [] : [[key, read]];
    });
    return { value: Object.fromEntries(copy) };
  };
const list =
  (reader: Reader): Reader =>
  value => {
    if (!Array.isArray(value)) return { fault: '' };
    const items: unknown[] = [];
    for (const item of value) {
      const read = reader(item);
      if ('fault' in read) return read;
      items.push(read.value);
    }
    return { value: items.every((item, index) => item === value[index]) ? value : items };
  };

const string = is(value => typeof value === 'string');
const text = optional(string);
/** A string with more than white space in it. */
const filled = is(value => typeof value === 'string' && value.trim() !== '');
const flag = optional(is(value => typeof value === 'boolean'));
const number = optional(is(value => typeof value === 'number'));
/** Azure numbers pushes, pull requests and builds from 1. */
const id = is(value => Number.isSafeInteger(value) && Number(value) > 0);
/** Text the code shows with a fallback for when it is absent. */
const label = display(string);
/** A person the code names, or calls Unknown. */
const person = display(fields({ displayName: label, name: label }));
/** Links the code checks with safeAzureUrl, falling back to a link it builds. */
const links = display(fields({ web: display(fields({})) }));
const commitRef = optional(fields({ commitId: text }));
const repository = optional(fields({ id: text }));
/** Fields of a value that must be an object; when it is absent or not one, its first field is the one missing. */
const within =
  (shape: Record<string, Reader>): Reader =>
  value =>
    fields(shape)(isRecord(value) ? value : {});

const push = fields({
  pushId: id,
  date: text,
  pushedBy: person,
  refUpdates: optional(list(fields({ name: text, oldObjectId: text, newObjectId: text }))),
  commits: optional(list(value => ({ value }))),
  _links: links,
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
  title: label,
  status: text,
  isDraft: flag,
  sourceRefName: text,
  targetRefName: text,
  creationDate: text,
  closedDate: text,
  createdBy: person,
  closedBy: person,
  lastMergeSourceCommit: commitRef,
  lastMergeTargetCommit: commitRef,
  lastMergeCommit: commitRef,
  mergeStatus: text,
  completionOptions: optional(fields({ mergeStrategy: text })),
  reviewers: optional(list(fields({ id: text, displayName: label, vote: number, isRequired: flag }))),
  _links: links,
});
const build = fields({
  id,
  // A build is matched to the watched repository by this ID, so a build without one cannot be placed.
  repository: within({ id: filled }),
  status: text,
  result: text,
  reason: label,
  queueTime: text,
  startTime: text,
  finishTime: text,
  sourceVersion: text,
  sourceBranch: text,
  definition: display(fields({ name: label })),
  requestedFor: person,
  requestedBy: person,
  _links: links,
});
const readers: { [S in AzureStream]: Reader } = {
  pushes: push,
  refs: ref,
  prs: pullRequest,
  closedPrs: pullRequest,
  builds: build,
  activeBuilds: build,
};

/** The field that names a record of the streams sync follows up by ID, or a ref by its name, and how it reads. */
const identityFields: Partial<Record<AzureStream, [string, Reader]>> = {
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
  const [key, reader] = identity;
  return 'fault' in reader(value[key]) ? undefined : String(value[key]);
}

/** The first field a stream record cannot be read without, or null when it can be read. */
export function unreadableField(stream: AzureStream, value: unknown): string | null {
  const read = readers[stream](value);
  return 'fault' in read ? read.fault || 'record' : null;
}

/** A record its stream reads with nothing left out. */
const readsWhole =
  <S extends AzureStream>(stream: S) =>
  (value: unknown): value is AzureStreamRecords[S] => {
    const read = readers[stream](value);
    return !('fault' in read) && read.value === value;
  };
const streamGuards: { [S in AzureStream]: (value: unknown) => value is AzureStreamRecords[S] } = {
  pushes: readsWhole('pushes'),
  refs: readsWhole('refs'),
  prs: readsWhole('prs'),
  closedPrs: readsWhole('closedPrs'),
  builds: readsWhole('builds'),
  activeBuilds: readsWhole('activeBuilds'),
};

/** The record as its stream reads it, without its malformed display fields, or undefined when it cannot be read. */
export function readRecord<S extends AzureStream>(stream: S, value: unknown): AzureStreamRecords[S] | undefined {
  const read = readers[stream](value);
  if ('fault' in read) return undefined;
  const record = read.value;
  // A copy without its malformed display fields reads unchanged, so the guard accepts it.
  return streamGuards[stream](record) ? record : undefined;
}

/**
 * The records of a page read for this stream. Callers that hold a page of any stream use it to type the records; the
 * client has already left out any that cannot be read.
 */
export const recordsOf = <S extends AzureStream>(stream: S, items: readonly unknown[]): AzureStreamRecords[S][] =>
  items.flatMap(item => {
    const record = readRecord(stream, item);
    return record === undefined ? [] : [record];
  });
