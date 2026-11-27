import { branchName } from '../src/events.ts';
import { readEvent } from './store-records.ts';
import { SELECT_EVENTS } from './store-events.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { Repository } from '../src/contract.ts';
import type { StoreDb } from './store-db.ts';
import type { StoreEvents } from './store-events.ts';
import type { StoreState } from './store-state.ts';

/**
 * Read models over stored events that answer one feature's question each: the branch picker, related activity for a
 * detail, the commits the Git graph annotates, the completed pull requests a checkout can pull, and the inputs of the
 * fork origin check. They only read.
 */
export function createStoreQueries({ q }: StoreDb, events: Pick<StoreEvents, 'hydrate'>, state: Pick<StoreState, 'listEntities'>) {
  const { hydrate } = events;
  /**
   * The branch names the repository lists, in the order the branch picker shows them: the default branch, main and
   * master first, then the most recently pushed, then by name.
   */
  function listBranches(repo: Pick<Repository, 'id' | 'defaultBranch'>) {
    const pinned = [branchName(repo.defaultBranch), 'main', 'master'];
    return state
      .listEntities(repo.id, 'ref')
      .filter(({ id, data }) => id.startsWith('refs/heads/') && id.length > 11 && data.active !== false)
      .map(({ id, data }) => ({ name: branchName(id), pushId: Number(data.lastPushId) || 0 }))
      .sort(
        (a, b) =>
          Number(pinned.includes(b.name)) - Number(pinned.includes(a.name)) ||
          pinned.indexOf(a.name) - pinned.indexOf(b.name) ||
          b.pushId - a.pushId ||
          a.name.localeCompare(b.name),
      )
      .map(({ name }) => name);
  }
  /** The latest stored build and completed PR for each commit, for the Git graph. */
  function commitActivity(repoId: string, commits: string[]) {
    if (!commits.length) return [];
    const ids = commits.map(() => '?').join(',');
    return q(`WITH matching AS (
      SELECT e.id,e.data,m.kind,m.observed,m.time,
        CASE m.kind WHEN 'build' THEN lower(json_extract(e.data,'$.data.sourceVersion'))
          ELSE lower(json_extract(e.data,'$.data.mergeCommit')) END AS sha
      FROM events e JOIN activity_members m ON m.event_id=e.id
      WHERE e.repo_id=? AND ((m.kind='build' AND lower(json_extract(e.data,'$.data.sourceVersion')) IN (${ids}))
        OR (m.kind='pr' AND json_extract(e.data,'$.data.status')='completed'
          AND lower(json_extract(e.data,'$.data.mergeCommit')) IN (${ids})))
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY sha,kind,
        COALESCE(json_extract(data,'$.data.buildId'),json_extract(data,'$.data.pullRequestId'),id)
        ORDER BY observed DESC,time DESC,id DESC) AS position
      FROM matching
    )
    SELECT id,data,sha FROM ranked WHERE position=1 ORDER BY time DESC,observed DESC,id DESC`)
      .all(repoId, ...commits, ...commits)
      .map(row => ({ sha: String(row.sha), event: readEvent(row) }));
  }
  /** The pull request, its CI and its pushes, for an event of a pull request or a CI run on its merge ref. */
  function relatedActivity(event: ActivityEvent, { ciOnly = false } = {}) {
    const { repoId, data } = event;
    const pr = event.kind === 'pr' ? data?.pullRequestId : /^refs\/pull\/(\d+)\/merge$/.exec(data?.sourceBranch ?? '')?.[1];
    if (!pr) return [];
    const ref = `refs/pull/${pr}/merge`;
    const rows = q(`WITH pr AS MATERIALIZED (
      SELECT id,data,time FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND CAST(json_extract(data,'$.data.pullRequestId') AS TEXT)=?
    ), related AS (
      SELECT id FROM pr
      UNION
      SELECT e.id FROM events e JOIN activity_members m ON m.event_id=e.id
      WHERE e.repo_id=? AND m.kind='build' AND json_extract(e.data,'$.data.sourceBranch')=?
      UNION
      SELECT e.id FROM pr JOIN events e ON e.repo_id=? AND json_extract(e.data,'$.kind')='build'
        AND json_extract(e.data,'$.data.sourceBranch')=json_extract(pr.data,'$.data.targetRefName')
        AND lower(json_extract(e.data,'$.data.sourceVersion'))=lower(json_extract(pr.data,'$.data.mergeCommit'))
      WHERE ? AND json_extract(pr.data,'$.data.status')='completed'
      UNION
      SELECT e.id FROM pr JOIN events e ON e.repo_id=? AND json_extract(e.data,'$.kind')='push'
        AND json_extract(pr.data,'$.data.fork') IS NULL
        AND (json_extract(pr.data,'$.data.sourceRepositoryId') IS NULL OR json_extract(pr.data,'$.data.targetRepositoryId') IS NULL
          OR lower(json_extract(pr.data,'$.data.sourceRepositoryId'))=lower(json_extract(pr.data,'$.data.targetRepositoryId')))
        JOIN json_each(e.data,'$.data.refUpdates') ref
      WHERE ? AND json_extract(ref.value,'$.name')=json_extract(pr.data,'$.data.sourceRefName')
        AND lower(json_extract(ref.value,'$.newObjectId'))=lower(json_extract(pr.data,'$.data.sourceCommit'))
        AND ltrim(json_extract(ref.value,'$.oldObjectId'),'0')=''
      UNION
      SELECT tip.event_id FROM pr JOIN push_tips tip ON tip.repo_id=?
        AND ((tip.ref=json_extract(pr.data,'$.data.sourceRefName') AND json_extract(pr.data,'$.data.fork') IS NULL
            AND (json_extract(pr.data,'$.data.sourceRepositoryId') IS NULL OR json_extract(pr.data,'$.data.targetRepositoryId') IS NULL
              OR lower(json_extract(pr.data,'$.data.sourceRepositoryId'))=lower(json_extract(pr.data,'$.data.targetRepositoryId')))
            AND tip.tip=lower(json_extract(pr.data,'$.data.sourceCommit')))
          OR (tip.ref=json_extract(pr.data,'$.data.targetRefName') AND tip.tip=lower(json_extract(pr.data,'$.data.mergeCommit'))
            AND json_extract(pr.data,'$.data.status')='completed'
            AND EXISTS (SELECT 1 FROM events push WHERE push.id=tip.event_id
              AND ABS((julianday(push.time)-julianday(pr.time))*86400)<=600)))
      WHERE ?
    )${SELECT_EVENTS} JOIN activity_members m ON m.event_id=e.id
    WHERE e.id IN (SELECT id FROM related) AND e.id<>?
      ${ciOnly ? "AND m.kind='build'" : ''}
      AND (m.kind<>'build' OR e.id=(SELECT candidate.event_id FROM activity_members candidate
        WHERE candidate.group_key=m.group_key ORDER BY candidate.observed DESC,candidate.time DESC,candidate.event_id DESC LIMIT 1))
    ORDER BY m.time DESC,m.observed DESC,e.id DESC ${ciOnly ? '' : 'LIMIT 100'}`).all(
      repoId,
      String(pr),
      repoId,
      ref,
      repoId,
      Number(event.kind === 'pr'),
      repoId,
      Number(event.kind === 'pr'),
      repoId,
      Number(event.kind === 'pr'),
      event.id,
    );
    return rows.map(hydrate);
  }
  /** The latest 40 stored completed pull requests from branch `source`, one per pull request. */
  function completedCheckoutPulls(repoId: string, source: string) {
    const rows = q(`SELECT id,data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
      AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.sourceRefName')=?
      ORDER BY time DESC LIMIT 40`).all(repoId, source);
    const candidates = new Map();
    for (const row of rows) {
      const event = readEvent(row),
        // The query matched `data.status`, so `data` is present.
        data = event.data ?? {};
      if (candidates.has(data.pullRequestId)) continue;
      candidates.set(data.pullRequestId, {
        id: data.pullRequestId,
        source,
        target: data.targetRefName,
        sourceId: data.sourceRepositoryId,
        targetId: data.targetRepositoryId,
        head: data.sourceCommit,
        result: data.mergeCommit,
        strategy: data.mergeStrategy,
        url: event.url,
      });
    }
    return [...candidates.values()];
  }
  /**
   * The latest tip each branch had in the stored pushes before push `pushId`, by full ref name. A branch whose latest
   * update deleted it is left out. Pushes missing from the store leave older tips in place.
   */
  function branchTipsBefore(repoId: string, pushId: number): Map<string, string> {
    const tips: Map<string, string> = new Map();
    const rows = q(`SELECT json_extract(u.value,'$.name') AS ref,lower(json_extract(u.value,'$.newObjectId')) AS tip
      FROM events e, json_each(e.data,'$.data.refUpdates') u
      WHERE e.repo_id=? AND json_extract(e.data,'$.kind')='push' AND json_extract(e.data,'$.data.pushId')<?
      ORDER BY json_extract(e.data,'$.data.pushId')`).all(repoId, pushId);
    for (const row of rows) {
      const ref = String(row.ref ?? ''),
        tip = String(row.tip ?? '');
      if (!ref.startsWith('refs/heads/')) continue;
      if (/^[0-9a-f]{40}$/.test(tip) && !/^0+$/.test(tip)) tips.set(ref, tip);
      else tips.delete(ref);
    }
    return tips;
  }
  /**
   * Branches worth checking as the origin of `ref`: the targets of its stored pull requests, oldest first, then the
   * repository's most common pull request target. Pull requests from forks are left out.
   */
  function forkCandidates(repoId: string, ref: string): string[] {
    const rows = q(`SELECT json_extract(data,'$.data.sourceRefName') AS source,json_extract(data,'$.data.targetRefName') AS target,
      json_extract(data,'$.data.pullRequestId') AS id FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.fork') IS NULL
      ORDER BY time,observed_at,json_extract(data,'$.data.pullRequestId')`).all(repoId);
    /** Pull request IDs by target. A PR has a row per change, so it is counted once. */
    const targets: Map<string, Set<string>> = new Map();
    const own: string[] = [];
    for (const row of rows) {
      const target = String(row.target ?? '');
      if (!target.startsWith('refs/heads/')) continue;
      const ids = targets.get(target) ?? new Set();
      targets.set(target, ids.add(String(row.id)));
      if (row.source === ref && !own.includes(target)) own.push(target);
    }
    const common = [...targets].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0]?.[0];
    return [...new Set([...own, ...(common ? [common] : [])])].filter(target => target !== ref);
  }
  return { listBranches, commitActivity, relatedActivity, completedCheckoutPulls, branchTipsBefore, forkCandidates };
}
