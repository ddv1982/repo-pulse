import { createHash } from 'node:crypto';
import { actorName, branchName, safeAzureUrl } from '../src/events.ts';
import { mergeUpdates } from './merge-evidence.ts';
import { forkJob } from './fork-origin.ts';
import { isRecord, recordsOf } from './azure-records.ts';
import type { ActivityKind } from '../src/activity.ts';
import type {
  AzureStreamRecords,
  AzureStreamRecord,
  AzurePush,
  AzureRefUpdate,
  AzureRef,
  AzurePullRequest,
  AzureBuild,
  UnreadableIds,
  AzureStream as StreamName,
  AzureRepo,
} from '../src/contract.d.ts';
import type { RewriteJob } from './rewrite-check.ts';
import type { ForkJob } from './fork-origin.ts';

export type WatchedRepo = AzureRepo & { id: string; disabled?: boolean };
/** What `normalize` reads from a stream state; backfill passes `historical: true`. */
export type NormalizeState = { initialized: boolean; historical?: boolean };
/** What `reconcileRefs` reads from a stream state. */
export type RefReconcileState = { initialized: boolean; window: { until: string } };
export type SyncEvent = {
  id: string;
  repoId: string;
  kind: ActivityKind;
  observedAt: string;
  time: string;
  actor: string;
  branch: string;
  summary: string;
  url: string;
  title?: string;
  data?: Record<string, unknown>;
  imported: boolean;
  seen: boolean;
};
export type EventDetail = Partial<Omit<SyncEvent, 'id' | 'repoId' | 'kind' | 'observedAt' | 'imported' | 'seen'>>;
/** A push recorded so a later page or snapshot skips it. Its date is what Azure sent. */
export type PushEntity = { date?: unknown };
/**
 * A branch or tag as the last push or refs snapshot left it. The object IDs are what Azure sent; a ref put away keeps
 * its last ones with `active: false`.
 */
export type RefEntity = {
  name?: string;
  objectId?: unknown;
  peeledObjectId?: unknown;
  active?: boolean;
  evidence?: string;
  lastPushId?: number | null | undefined;
  lastPushObservedAt?: string | undefined;
};
type ReviewerVote = [string, number | null];
type PrFingerprint = Record<string, unknown> & { votes?: ReviewerVote[] };
/**
 * A PR or build snapshot: an event is made only when its fingerprint changes. A PR fingerprint saved before votes were
 * recorded has none. A snapshot without a fingerprint or revision reads as changed, at revision 0.
 */
export type SnapshotEntity<Fingerprint = Record<string, unknown>> = {
  fingerprint?: Fingerprint;
  status?: unknown;
  revision?: number;
};
/** A refs stream's tag baseline (`tags`), or the tags an incomplete snapshot could not rule out (`tags-uncertain`). */
export type RefBaseline = { at: string; all?: boolean; names?: string[] };
/** Entity data by entity type. */
export type EntityData = {
  push: PushEntity;
  ref: RefEntity;
  pr: SnapshotEntity<PrFingerprint>;
  build: SnapshotEntity;
  'ref-baseline': RefBaseline;
};
export type EntityType = keyof EntityData;
export type Entity = { [T in EntityType]: { type: T; id: string; data: EntityData[T] } }[EntityType];

export type SyncBatch = { events: SyncEvent[]; entities: Entity[]; jobs?: (RewriteJob | ForkJob)[] };
export type NormalizeStore = {
  getSetting: (key: `baseline:${string}`, fallback: string) => string;
  getEntity: <T extends EntityType>(repoId: string, type: T, id: string) => EntityData[T] | undefined;
  listEntities: <T extends EntityType>(repoId: string, type: T) => { id: string; data: EntityData[T] }[];
};

const ZERO = /^0+$/;
const PULL_REF = /^refs\/pull\//;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const tagName = (name: string) => name.replace(/^refs\/tags\//, '');
const tagTitles: Record<'created' | 'moved' | 'deleted', string> = { created: 'New tag', moved: 'Tag moved', deleted: 'Tag deleted' };
const iso = (ms: number) => new Date(ms).toISOString();
// Display fields reach the normalizers as Azure sent them, so their fallbacks see what main saw.
/** A field of a value that is not an object reads as absent, as optional chaining read it on main. */
const fieldOf = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
/** The web link Azure gives a record; safeAzureUrl checks it. */
const webLink = (links: unknown) => fieldOf(fieldOf(links, 'web'), 'href');
/**
 * An event's text field. Main stored whatever value Azure sent, and its page showed it through String(). A value
 * String() cannot convert stopped that page, so it reads as `fallback`, the text main shows for a missing value.
 */
const text = (value: unknown, fallback: string) => {
  if (typeof value === 'string') return value;
  try {
    const rendered = String(value);
    return rendered === '[object Object]' ? fallback : rendered;
  } catch {
    return fallback;
  }
};
const reviewers = (pr: AzurePullRequest): { id: string; name: unknown; vote: number; required: boolean }[] =>
  (pr.reviewers || []).map(reviewer => ({
    id: String(reviewer.id),
    name: reviewer.displayName || 'Unknown reviewer',
    vote: Number(reviewer.vote) || 0,
    required: Boolean(reviewer.isRequired),
  }));
/** Reviewers without a vote are left out, so adding or removing one is not a vote change. */
const reviewerVotes = (pr: AzurePullRequest): [string, number][] =>
  // The default tuple string order contributes to persisted PR fingerprints and event IDs.
  // oxlint-disable-next-line typescript/require-array-sort-compare
  reviewers(pr)
    .filter(({ vote }) => vote)
    .map(({ id, vote }) => [id, vote] as [string, number])
    .sort();
/**
 * Reviewers whose vote differs from the previous snapshot. A snapshot without votes, or a first sighting, has no changes.
 */
const voteChanges = (before: ReviewerVote[] | undefined, pr: AzurePullRequest) => {
  if (!before) return [];
  const previous = new Map(before);
  return reviewers(pr)
    .filter(reviewer => (previous.get(reviewer.id) ?? 0) !== reviewer.vote)
    .map(({ name, vote }) => ({ name, vote }));
};
const prState = (pr: AzurePullRequest) => ({
  status: pr.status,
  isDraft: Boolean(pr.isDraft),
  title: pr.title,
  source: pr.lastMergeSourceCommit?.commitId,
  target: pr.targetRefName,
  ...(pr.status === 'active' ? { previewCommit: pr.lastMergeCommit?.commitId?.toLowerCase() || null } : {}),
  votes: reviewerVotes(pr),
});
// Active PRs can expose a successful preview merge. Only completion establishes
// the actual merge result; retain its metadata from this existing response.
const prCompletion = (item: AzurePullRequest) =>
  item.status === 'completed'
    ? {
        mergeCommit: item.lastMergeCommit?.commitId,
        targetCommit: item.lastMergeTargetCommit?.commitId,
        mergeStatus: item.mergeStatus,
        mergeStrategy: item.completionOptions?.mergeStrategy,
        closedBy: actorName(item.closedBy),
      }
    : {};
const buildState = (build: AzureBuild) => ({
  status: build.status,
  result: build.result,
  finishTime: build.finishTime,
  sourceVersion: build.sourceVersion,
  sourceBranch: build.sourceBranch,
});

/** The tags an incomplete refs snapshot could not rule out (see tagBaseline): those named, or every tag. */
type UncertainTags = { all: boolean; names: string[] };

/** A ref update the push names, which every branch and tag update does. */
const named = (ref: AzureRefUpdate): ref is AzureRefUpdate & { name: string } => typeof ref.name === 'string';

/**
 * Turns Azure DevOps stream payloads and complete ref snapshots into stored events, entities, and rewrite jobs.
 */
export function createNormalizer({ store, now = Date.now }: { store: NormalizeStore; now?: () => number }) {
  function makeEvent(
    repo: WatchedRepo,
    kind: ActivityKind,
    sourceId: string,
    detail: EventDetail & { time: string },
    imported: boolean,
  ): SyncEvent {
    const observedAt = iso(now());
    return {
      id: `${repo.id}:${kind}:${sourceId}`,
      repoId: repo.id,
      kind,
      observedAt,
      actor: 'Unknown',
      branch: '',
      summary: '',
      url: repo.webUrl,
      ...detail,
      imported,
      seen: imported,
    };
  }
  // PRs and builds are snapshots: an event is emitted only when their fingerprint changes.
  function snapshot<T extends 'pr' | 'build'>(
    repo: WatchedRepo,
    type: T,
    key: string,
    value: PrFingerprint & { status?: string | null | undefined },
    historical: boolean,
  ) {
    const previous = store.getEntity(repo.id, type, key);
    // Older snapshots adopt newly tracked fields without emitting a change.
    // A null preview on a new active snapshot still lets its first actual preview register later.
    const saved = previous?.fingerprint;
    const comparable = saved
      ? {
          ...value,
          ...(!('votes' in saved) ? { votes: undefined } : {}),
          ...(!('previewCommit' in saved) ? { previewCommit: undefined } : {}),
        }
      : value;
    const changed = !previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(comparable);
    const revision = (previous?.revision || 0) + Number(changed);
    return {
      previous,
      changed,
      // Preserve legacy IDs for re-imports and for live events without an actual preview.
      sourceId: historical
        ? `history:${key}:${fingerprint({ ...value, votes: undefined, previewCommit: undefined })}`
        : `${key}:${(previous?.revision || 0) + 1}:${fingerprint({ ...value, previewCommit: value.previewCommit ?? undefined })}`,
      entity: historical ? null : ({ type, id: key, data: { fingerprint: value, status: value.status, revision } } satisfies Entity),
    };
  }
  /**
   * A non-status change to a live PR is dated when observed; otherwise the event takes the
   * closure time Azure reports, or the creation time for a PR seen for the first time.
   */
  function prEventTime(item: AzurePullRequest, previous: SnapshotEntity | undefined, historical: boolean) {
    const unchangedStatus = previous?.fingerprint?.status === item.status;
    if (previous && !historical && unchangedStatus) return iso(now());
    return (item.status !== 'active' ? item.closedDate : null) || (!previous ? item.creationDate : null) || iso(now());
  }
  type NormalizeContext = {
    repo: WatchedRepo;
    add: (kind: ActivityKind, sourceId: string, detail: EventDetail) => void;
    entities: Entity[];
    refs: Map<string, RefEntity> | null;
    historical: boolean;
  };

  type Normalizer<T> = (item: T, context: NormalizeContext) => void;
  const byStream: { pushes: Normalizer<AzurePush>; prs: Normalizer<AzurePullRequest>; builds: Normalizer<AzureBuild> } = {
    pushes(item, { repo, add, entities, refs, historical }) {
      const source = String(item.pushId);
      if (!item.pushId || store.getEntity(repo.id, 'push', source)) return;
      const updates = item.refUpdates || [];
      const branches = updates.filter(named).filter(ref => ref.name.startsWith('refs/heads/'));
      const tags = updates.filter(named).filter(ref => ref.name.startsWith('refs/tags/'));
      const time = item.date || iso(now());
      const actor = text(actorName(item.pushedBy), 'Unknown');
      const data = { pushId: item.pushId, refUpdates: branches, commits: item.commits || [] };
      const url = safeAzureUrl(webLink(item._links), `${repo.webUrl}/pushes?pushId=${encodeURIComponent(source)}`);
      entities.push({ type: 'push', id: source, data: { date: time } });
      // Azure lists pushes newest first. Keep a source watermark across pages/snapshots,
      // while retaining every historical event independently of the current ref state.
      const recordRef = (ref: AzureRefUpdate & { name: string }) => {
        const previous = refs?.get(ref.name);
        if (historical || (previous?.lastPushId && Number(item.pushId) <= previous.lastPushId)) return;
        const current = {
          name: ref.name,
          objectId: ref.newObjectId,
          active: !ZERO.test(ref.newObjectId || ''),
          evidence: 'push',
          lastPushId: Number(item.pushId),
          lastPushObservedAt: iso(now()),
        };
        refs?.set(ref.name, current);
        entities.push({ type: 'ref', id: ref.name, data: current });
      };
      for (const ref of tags) {
        const change = ZERO.test(ref.oldObjectId || '') ? 'created' : ZERO.test(ref.newObjectId || '') ? 'deleted' : 'moved';
        add('tag', `${source}:${ref.name}`, {
          title: `${tagTitles[change]} · ${tagName(ref.name)}`,
          branch: tagName(ref.name),
          actor,
          time,
          url,
          summary: `${change === 'deleted' ? 'Deleted' : change === 'created' ? 'Created' : 'Moved'} in push ${source}`,
          data: {
            pushId: item.pushId,
            evidence: 'push',
            change,
            name: ref.name,
            oldObjectId: ref.oldObjectId,
            newObjectId: ref.newObjectId,
          },
        });
        recordRef(ref);
      }
      // A tag-only push has no branch work to show; its tag rows carry it.
      if (tags.length && !branches.length) return;
      // Azure records each refresh of a pull request's merge preview as a push of refs/pull/N/merge. It is not repository work.
      if (updates.length && updates.every(ref => PULL_REF.test(ref.name || ''))) return;
      add('push', source, {
        title: `${actor} pushed${branches.length ? ` to ${branches.map(r => branchName(r.name)).join(', ')}` : ''}`,
        branch: branchName(branches[0]?.name),
        actor,
        time,
        url,
        summary: branches.length
          ? branches.map(ref => `${ref.oldObjectId?.slice(0, 7) || '?'} → ${ref.newObjectId?.slice(0, 7) || '?'}`).join(' · ')
          : 'Repository push',
        data,
      });
      for (const ref of branches) {
        const created = ref.oldObjectId && ZERO.test(ref.oldObjectId);
        const deleted = ref.newObjectId && ZERO.test(ref.newObjectId);
        if (created || deleted)
          add(created ? 'branch-created' : 'branch-deleted', `${source}:${ref.name}`, {
            title: `${created ? 'New branch' : 'Branch deleted'} · ${branchName(ref.name)}`,
            branch: branchName(ref.name),
            actor,
            time,
            url,
            summary: `${created ? 'Created' : 'Deleted'} in push ${source}`,
            data: { ...data, evidence: 'push', ...ref },
          });
        recordRef(ref);
      }
    },
    prs(item, { repo, add, entities, historical }) {
      if (!item.pullRequestId || (item.repository?.id && item.repository.id.toLowerCase() !== repo.azureId?.toLowerCase())) return;
      const key = String(item.pullRequestId);
      const state = prState(item);
      const { previous, changed, sourceId, entity } = snapshot(repo, 'pr', key, state, historical);
      if (changed) {
        add('pr', sourceId, {
          title: `PR ${key} · ${text(item.title || 'Untitled', 'Untitled')}`,
          branch: branchName(item.sourceRefName),
          actor: text(actorName(item.createdBy), 'Unknown'),
          time: prEventTime(item, previous, historical),
          summary: `${item.isDraft ? 'Draft · ' : ''}${item.status || 'unknown'} → ${branchName(item.targetRefName)}`,
          url: safeAzureUrl(webLink(item._links), `${repo.webUrl}/pullrequest/${encodeURIComponent(key)}`),
          data: {
            pullRequestId: item.pullRequestId,
            ...(item.creationDate ? { pullRequestCreatedAt: item.creationDate } : {}),
            status: item.status,
            isDraft: item.isDraft,
            sourceRefName: item.sourceRefName,
            targetRefName: item.targetRefName,
            sourceCommit: item.lastMergeSourceCommit?.commitId,
            previewCommit: state.previewCommit ?? undefined,
            sourceRepositoryId: item.forkSource ? item.forkSource.repository?.id : item.repository?.id,
            targetRepositoryId: item.repository?.id,
            reviewers: reviewers(item),
            voteChanges: voteChanges(previous?.fingerprint?.votes, item),
            // Azure names a source repository only for a PR from a fork. It stays out of the fingerprint,
            // so recording it creates no update for PRs seen before.
            ...(item.forkSource
              ? { fork: { repository: item.forkSource.repository?.name, project: item.forkSource.repository?.project?.name } }
              : {}),
            ...prCompletion(item),
          },
        });
      }
      if (entity) entities.push(entity);
    },
    builds(item, { repo, add, entities, historical }) {
      if (!item.id || item.repository.id.toLowerCase() !== repo.azureId?.toLowerCase()) return;
      const key = String(item.id);
      const { changed, sourceId, entity } = snapshot(repo, 'build', key, buildState(item), historical);
      if (changed) {
        add('build', sourceId, {
          title: text(fieldOf(item.definition, 'name') || 'Pipeline', 'Pipeline'),
          branch: branchName(item.sourceBranch),
          actor: text(actorName(item.requestedFor || item.requestedBy), 'Unknown'),
          time: item.finishTime || item.startTime || item.queueTime || iso(now()),
          summary: `${item.status || 'unknown'}${item.result ? ` · ${item.result}` : ''} · ${(item.sourceVersion || '').slice(0, 7)}`,
          url: safeAzureUrl(
            webLink(item._links),
            `${repo.organization}/${encodeURIComponent(repo.project)}/_build/results?buildId=${encodeURIComponent(key)}`,
          ),
          data: {
            id: item.id,
            buildId: item.id,
            status: item.status,
            result: item.result,
            sourceVersion: item.sourceVersion,
            buildStartedAt: item.queueTime || item.startTime,
            sourceBranch: item.sourceBranch,
            definition: item.definition,
            reason: item.reason,
          },
        });
      }
      if (entity) entities.push(entity);
    },
  };
  // Keyed by stream, so normalize() can pass each stream's records to its own normalizer without a cast.
  const normalizers: { [S in StreamName]?: Normalizer<AzureStreamRecords[S]> } = {
    ...byStream,
    closedPrs: byStream.prs,
    activeBuilds: byStream.builds,
  };

  /** The records come from a page of `stream`; any that are not that stream's records are left out. */
  function normalize(repo: WatchedRepo, stream: StreamName, records: readonly AzureStreamRecord[], state: NormalizeState): SyncBatch {
    const events: SyncEvent[] = [];
    const entities: Entity[] = [];
    const historical = Boolean(state.historical);
    const refs = stream === 'pushes' ? new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data])) : null;
    const baseline = store.getSetting(`baseline:${repo.id}`, iso(now()));
    const add: NormalizeContext['add'] = (kind, sourceId, detail) => {
      const time = detail.time || iso(now());
      const imported = !state.initialized && Date.parse(time) <= Date.parse(baseline);
      events.push(makeEvent(repo, kind, sourceId, { ...detail, time }, historical || imported));
    };
    // Generic over the stream, so the guard and the normalizer agree on the record type.
    const normalizeAll = <S extends StreamName>(of: S) => {
      const normalizeItem = normalizers[of];
      if (normalizeItem) for (const item of recordsOf(of, records)) normalizeItem(item, { repo, add, entities, refs, historical });
    };
    normalizeAll(stream);
    // Only a live push that moved an existing branch is checked for a rewrite; history is not news.
    const jobs: RewriteJob[] = events
      .filter(event => event.kind === 'push' && !event.imported)
      .flatMap(event =>
        mergeUpdates(event as import('./merge-evidence.ts').PushEvent).map(ref => ({
          id: `rewrite:${event.id}:${ref.name}`,
          type: 'rewrite' as const,
          repoId: repo.id,
          eventId: event.id,
          ref: ref.name,
          oldObjectId: ref.oldObjectId,
          newObjectId: ref.newObjectId,
          attempts: 0,
          nextAt: event.observedAt,
        })),
      );
    // A branch creation is checked for the commit and branch it started from, except during a history import, whose
    // older pushes are stored only after it.
    const forks = historical ? [] : events.flatMap(event => forkJob(event) ?? []);
    return { events, entities, jobs: [...jobs, ...forks] };
  }

  /**
   * The tag baseline of a refs stream. Tags joined the snapshot after branches. Until one snapshot has recorded them,
   * every existing tag would look new, so a tag is announced as first seen, or reported as no longer listed, only after
   * that baseline (`known`). Main took the first snapshot of a stream initialized before then for the baseline, even one
   * that left out unreadable refs, so such an incomplete snapshot (`establishes`) is the baseline here too, for its
   * readable tags. A tag it cannot rule out is `uncertain`: one its unreadable refs name, or every tag once one has no
   * readable name. The set is kept (`ref-baseline:tags-uncertain`), joined by the incomplete snapshots that follow, and
   * cleared by the next complete snapshot. An incomplete snapshot neither creates nor puts away a tag it `holds`; a
   * tag first listed is `announced` after the baseline unless uncertain; `retires` says whether this snapshot puts
   * away the refs it omits. `write` is what this snapshot records.
   */
  function tagBaseline(repo: WatchedRepo, initialized: boolean, incomplete: boolean, unreadable: UnreadableIds | undefined) {
    const known = initialized && Boolean(store.getEntity(repo.id, 'ref-baseline', 'tags'));
    const establishes = initialized && incomplete && !known;
    const kept = initialized ? store.getEntity(repo.id, 'ref-baseline', 'tags-uncertain') : undefined;
    const pending = Boolean(kept?.all || kept?.names?.length);
    const found = incomplete && (establishes || pending);
    const all = Boolean(kept?.all) || (found && (!unreadable || unreadable.anonymous > 0));
    const named = found ? (unreadable?.ids ?? []).filter(name => name.startsWith('refs/tags/')) : [];
    const names = [...new Set([...(kept?.names ?? []), ...named])];
    const at = iso(now());
    const uncertain: UncertainTags = incomplete ? { all, names } : { all: false, names: [] };
    const write: Entity[] = [
      ...(!incomplete || establishes ? [{ type: 'ref-baseline', id: 'tags', data: { at } } satisfies Entity] : []),
      ...(pending || uncertain.all || uncertain.names.length
        ? [{ type: 'ref-baseline', id: 'tags-uncertain', data: { at, ...uncertain } } satisfies Entity]
        : []),
    ];
    const isUncertain = (name: string) => all || names.includes(name);
    return {
      known,
      retires: initialized && (!incomplete || establishes),
      holds: (name: string) => incomplete && isUncertain(name),
      announced: (name: string) => known && !isUncertain(name),
      write,
    };
  }

  /**
   * Compares a complete refs snapshot with the stored refs. A snapshot with records Azure returned unreadable is
   * `incomplete`: its readable refs are added and updated, but a ref it does not list may be one of the unreadable
   * ones, so nothing is reported as no longer listed. Sync holds the stream's `initialized` back for it, and before
   * that baseline it creates no ref and only updates the refs that exist, so the first complete snapshot finds only
   * refs a push recorded and treats them as on main. On a stream initialized before the tag baseline, it is that
   * baseline as main took it (see tagBaseline): it records its readable tags and puts away, without an event, the
   * tags it omits, except an uncertain one, which it neither creates nor puts away. The next complete snapshot creates
   * an uncertain tag it lists without a first-seen event, and reports one it omits as no longer listed.
   */
  function reconcileRefs(
    repo: WatchedRepo,
    records: AzureRef[],
    state: RefReconcileState,
    { incomplete = false, unreadableIds }: { incomplete?: boolean; unreadableIds?: UnreadableIds | undefined } = {},
  ): SyncBatch {
    const before = new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data]));
    const current = new Map(records.filter(item => /^refs\/(heads|tags)\//.test(item.name)).map(item => [item.name, item]));
    const tags = tagBaseline(repo, state.initialized, incomplete, unreadableIds);
    const tagEvent = (name: string, change: 'created' | 'deleted', data: Record<string, unknown>) =>
      makeEvent(
        repo,
        'tag',
        `ref:${name}:${fingerprint([data.objectId, state.window.until])}`,
        {
          title: `${change === 'created' ? 'Tag first seen' : 'Tag no longer listed'} · ${tagName(name)}`,
          branch: tagName(name),
          time: iso(now()),
          summary:
            change === 'created'
              ? 'Discovered in remote tags; creation time and actor unknown'
              : 'Missing from complete refs snapshot; deletion time and actor unknown',
          data: { ...data, name, change, evidence: 'snapshot' },
        },
        false,
      );
    // A push saved since the scan opened can be newer than any of its pages.
    const scanStartedAt = Date.parse(state.window.until);
    const observedDuringScan = (ref: RefEntity | undefined) => Date.parse(ref?.lastPushObservedAt ?? '') >= scanStartedAt;
    const events: SyncEvent[] = [];
    const entities: Entity[] = [];
    for (const [name, item] of current) {
      const previous = before.get(name);
      if (observedDuringScan(previous)) continue;
      if (incomplete && !state.initialized && !previous) continue;
      const peeled = item.peeledObjectId ? { peeledObjectId: item.peeledObjectId } : {};
      if (name.startsWith('refs/tags/')) {
        const unlisted = !previous || previous.active === false;
        if (unlisted && tags.holds(name)) continue;
        if (unlisted && tags.announced(name)) events.push(tagEvent(name, 'created', { objectId: item.objectId, ...peeled }));
        entities.push({
          type: 'ref',
          id: name,
          data: {
            name,
            objectId: item.objectId,
            ...peeled,
            active: true,
            lastPushId: previous?.lastPushId,
            lastPushObservedAt: previous?.lastPushObservedAt,
          },
        });
        continue;
      }
      if (state.initialized && (!previous || previous.active === false)) {
        events.push(
          makeEvent(
            repo,
            'branch-created',
            `ref:${name}:${fingerprint([item.objectId, state.window.until])}`,
            {
              title: `Branch first seen · ${branchName(name)}`,
              branch: branchName(name),
              time: iso(now()),
              summary: 'Discovered in remote refs; creation time and actor unknown',
              data: { name, objectId: item.objectId, evidence: 'snapshot' },
              actor: 'Unknown',
            },
            false,
          ),
        );
      }
      entities.push({
        type: 'ref',
        id: name,
        data: {
          name,
          objectId: item.objectId,
          active: true,
          lastPushId: previous?.lastPushId,
          lastPushObservedAt: previous?.lastPushObservedAt,
        },
      });
    }
    // An incomplete snapshot puts away only the tags it is the baseline for and can rule out.
    const putsAway = (name: string) => !incomplete || (name.startsWith('refs/tags/') && !tags.holds(name));
    if (tags.retires)
      for (const [name, old] of before) {
        if (old.active === false || current.has(name) || !putsAway(name) || observedDuringScan(old)) continue;
        const tag = name.startsWith('refs/tags/');
        entities.push({ type: 'ref', id: name, data: { ...old, active: false } });
        if (tag) {
          if (tags.known) events.push(tagEvent(name, 'deleted', { objectId: old.objectId }));
          continue;
        }
        events.push(
          makeEvent(
            repo,
            'branch-deleted',
            `ref:${name}:${fingerprint([old.objectId, state.window.until])}`,
            {
              title: `Branch no longer listed · ${branchName(name)}`,
              branch: branchName(name),
              time: iso(now()),
              summary: 'Missing from complete refs snapshot; deletion time and actor unknown',
              data: { name, objectId: old.objectId, evidence: 'snapshot' },
            },
            false,
          ),
        );
      }
    entities.push(...tags.write);
    return { events, entities };
  }

  return { normalize, reconcileRefs };
}
