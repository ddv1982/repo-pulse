// @ts-check

import { foldSearchText, matchesPeople, parsePeople } from './activity-people.js';
import { projectActivity } from '../src/activity.js';
import { activityFilterLabel, labels, parseActivityFilter } from '../src/activity-text.js';

/** @typedef {import('node:sqlite').SQLInputValue} SqlValue */
/** @typedef {Record<string, import('node:sqlite').SQLOutputValue>} SqlRow */
/** @typedef {import('../src/activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('../src/activity.js').ActivityRequest} ActivityRequest */
/** @typedef {import('../src/activity.js').ActivityPage} ActivityPage */
/** @typedef {{ key: string, time: number, observed: number, representative: string }} Group */
/** @typedef {{ kind: string, status: string, evidence: string }} FilterRow */
/** @typedef {{ kind: string, count: number, newItems: number, newUpdates: number }} CountRow */
/** @typedef {{ maxSequence: number, filterKey: string, revision?: string, after: Pick<Group, 'key'|'time'|'observed'> }} Position */

const invalidFilter = () => Object.assign(new Error('Activity cursor does not match these filters.'), { code: 'BAD_REQUEST' });

/** @param {string | undefined} cursor @param {string} filterKey @returns {Position | undefined} */
function decodeCursor(cursor, filterKey) {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Number.isSafeInteger(value.maxSequence) &&
      value.maxSequence >= 0 &&
      value.filterKey === filterKey &&
      Number.isFinite(value.after?.observed) &&
      Number.isFinite(value.after?.time) &&
      typeof value.after?.key === 'string'
    )
      return value;
  } catch {
    /* Invalid or outdated cursor. */
  }
  throw invalidFilter();
}

/** @param {FilterRow[]} rows */
function filterOptions(rows) {
  const types = new Set(rows.map(row => row.kind));
  const statuses = new Set();
  const evidence = new Set();
  for (const row of rows) {
    const id = `status:${row.status}`;
    if (row.status && (row.kind === 'branch-deleted' || activityFilterLabel(id) !== activityFilterLabel(row.kind))) statuses.add(id);
    if (row.evidence) evidence.add(`evidence:${row.evidence}`);
  }
  return [
    ...Object.keys(labels).filter(kind => kind !== 'branch-deleted' && types.has(kind)),
    ...[...statuses].sort(),
    ...[...evidence].sort(),
  ];
}

// Most groups have one event. Only look up a representative when several match the scope.
const grouped = (/** @type {string} */ selection) => `
  SELECT group_stats.*, member.kind, member.status_id AS status, member.evidence_id AS evidence
  FROM (
    SELECT group_key AS key, MAX(time) AS time, MAX(observed) AS observed, SUM(unseen) AS unseen,
      CASE WHEN COUNT(*) = 1 THEN MAX(event_id) ELSE (
        SELECT candidate.event_id FROM ${selection} candidate WHERE candidate.group_key = source.group_key
        ORDER BY CASE WHEN candidate.kind='branch-deleted' AND candidate.group_key LIKE '["branch",%' THEN 0 ELSE 1 END,
          candidate.observed DESC, candidate.time DESC, candidate.event_id DESC LIMIT 1
      ) END AS representative
    FROM ${selection} source GROUP BY group_key
  ) group_stats JOIN activity_members member ON member.event_id=group_stats.representative`;

/** @typedef {ReturnType<typeof parseActivityFilter>} ActivityFilter */
/** @typedef {{ scope: string, params: SqlValue[], people: boolean }} MemberScope */

/**
 * Member-level WHERE clause shared by the page query and the member lookup.
 * @param {number} maxSequence @param {string[] | undefined} selected @param {string[]} needles @param {string[]} people @returns {MemberScope}
 */
function memberScope(maxSequence, selected, needles, people) {
  const conditions = ['m.sequence<=?'];
  /** @type {SqlValue[]} */
  const params = [maxSequence];
  if (selected) {
    conditions.push(selected.length ? `e.repo_id IN (${selected.map(() => '?').join(',')})` : '0');
    params.push(...selected);
  }
  if (needles.length) {
    const repoName = "json_extract(r.data,'$.name')";
    const match = `instr(m.search_text,?)>0 OR instr(lower(${repoName}),?)>0`;
    const folded = [...new Set(needles.map(foldSearchText))];
    const direct = [...new Set([...needles, ...folded])];
    const placeholders = folded.map(() => '?').join(',');
    // Run Unicode normalization only after the substring lookup misses and only on non-ASCII text.
    conditions.push(`(CASE
      WHEN ${direct.map(() => match).join(' OR ')} THEN 1
      WHEN m.search_text GLOB '*[^ -~]*' AND matches_folded(m.search_text,${placeholders}) THEN 1
      WHEN ${repoName} GLOB '*[^ -~]*' AND matches_folded(${repoName},${placeholders}) THEN 1
      ELSE 0 END)`);
    params.push(...direct.flatMap(needle => [needle, needle]), ...folded, ...folded);
  }
  if (people.length) {
    conditions.push(`matches_people(e.data,n.data,${people.map(() => '?').join(',')})`);
    params.push(...people);
  }
  return { scope: conditions.join(' AND '), params, people: people.length > 0 };
}

/** @param {MemberScope} member @param {ActivityFilter} filter @param {string} view */
function matchedScope({ scope, params, people }, filter, view) {
  const rawKind = filter.type === 'kind';
  const selection = rawKind ? 'kind_scope' : 'scoped';
  const kindScope = rawKind ? ', kind_scope AS (SELECT * FROM scoped WHERE kind=?)' : '';
  const visible = view === 'new' ? 'WHERE unseen>0' : '';
  const match = filter.type === 'status' ? 'WHERE status=?' : filter.type === 'evidence' ? 'WHERE evidence=?' : '';
  /** @type {SqlValue[]} */
  const queryParams = [...params];
  if (rawKind || match) {
    if (filter.type !== 'all') queryParams.push(filter.id);
  }
  const sql = `
      WITH scoped AS (
        SELECT m.event_id,m.group_key,m.kind,m.status_id,m.evidence_id,m.observed,m.time,
          CASE WHEN e.seen=0 AND e.imported=0 THEN 1 ELSE 0 END AS unseen
        FROM activity_members m JOIN events e ON e.id=m.event_id JOIN repositories r ON r.id=e.repo_id
        ${people ? 'LEFT JOIN enrichment n ON n.event_id=e.id' : ''}
        WHERE ${scope}
      )${kindScope}, visible AS MATERIALIZED (SELECT * FROM (${grouped(selection)}) ${visible}),
      matched AS (SELECT * FROM visible ${match})`;
  return { sql, params: queryParams, selection };
}

/**
 * One statement returns the page of groups (plus one to detect more), per-kind counts and, on the first page, filter choices.
 * @param {MemberScope} member @param {ActivityFilter} filter @param {string} view @param {Position | undefined} position @param {number} pageSize
 */
function pageQuery(member, filter, view, position, pageSize) {
  const { sql: cte, params } = matchedScope(member, filter, view);
  const rawKind = filter.type === 'kind';
  const visible = view === 'new' ? 'WHERE unseen>0' : '';
  const after = position?.after;
  const boundary = after ? 'WHERE (time, observed, key) < (?, ?, ?)' : '';
  const optionsQuery = position
    ? 'NULL'
    : rawKind
      ? `(SELECT json_group_array(json_object('kind',kind,'status',status,'evidence',evidence)) FROM
          (SELECT DISTINCT kind,status,evidence FROM (${grouped('scoped')}) ${visible}))`
      : "(SELECT json_group_array(json_object('kind',kind,'status',status,'evidence',evidence)) FROM (SELECT DISTINCT kind,status,evidence FROM visible))";

  if (after) params.push(after.time, after.observed, after.key);
  params.push(pageSize + 1);
  const sql = `${cte},
      selected_page AS (SELECT * FROM matched ${boundary} ORDER BY time DESC,observed DESC,key DESC LIMIT ?)
      SELECT
        (SELECT json_group_array(json_object('key',key,'time',time,'observed',observed,'representative',representative)) FROM selected_page) AS groups,
        (SELECT json_group_array(json_object('kind',kind,'count',count,'newItems',newItems,'newUpdates',newUpdates))
          FROM (SELECT kind,COUNT(*) AS count,SUM(unseen>0) AS newItems,SUM(unseen) AS newUpdates FROM matched GROUP BY kind)) AS counts,
        ${optionsQuery} AS options
    `;
  return { sql, params };
}

/**
 * Loads and hydrates every event in the selected groups, keyed by group.
 * @param {import('node:sqlite').DatabaseSync} db @param {(row: SqlRow) => ActivityEvent} hydrate
 * @param {MemberScope} member @param {ActivityFilter} filter @param {Group[]} groups
 */
function loadMembers(db, hydrate, { scope, params }, filter, groups) {
  const rawKind = filter.type === 'kind';
  const groupScope = rawKind ? `${scope} AND m.kind=?` : scope;
  const rowParams = rawKind && filter.type === 'kind' ? [...params, filter.id] : params;
  const raw = groups.length
    ? db
        .prepare(
          `
      SELECT e.data,e.seen,e.imported,n.data AS enrichment,m.group_key AS activity_key
      FROM events e LEFT JOIN enrichment n ON n.event_id=e.id
      JOIN activity_members m ON m.event_id=e.id JOIN repositories r ON r.id=e.repo_id
      WHERE ${groupScope} AND m.group_key IN (${groups.map(() => '?').join(',')})
    `,
        )
        .all(...rowParams, ...groups.map(group => group.key))
    : [];
  /** @type {Map<string, ActivityEvent[]>} */
  const members = new Map();
  for (const row of raw) {
    const key = String(row.activity_key);
    const rows = members.get(key);
    if (rows) rows.push(hydrate(row));
    else members.set(key, [hydrate(row)]);
  }
  return members;
}

const PULL_REF = /^refs\/pull\/(\d+)\//;

/**
 * A CI run on refs/pull/N names no branch. Each such run in the page gets the refs of the newest stored event of
 * that pull request, so a reader sees the source branch without the PR being on the same page. Saved events stay as they are.
 * @param {import('node:sqlite').DatabaseSync} db @param {Iterable<ActivityEvent[]>} groups
 */
function attachPullRequests(db, groups) {
  /** @type {Map<string, ActivityEvent[]>} */
  const runs = new Map();
  for (const events of groups)
    for (const event of events) {
      const id = event.kind === 'build' ? PULL_REF.exec(event.branch ?? '')?.[1] : undefined;
      if (!id) continue;
      const key = JSON.stringify([event.repoId, id]);
      const list = runs.get(key);
      if (list) list.push(event);
      else runs.set(key, [event]);
    }
  if (!runs.size) return;
  const wanted = [...runs.keys()].map(key => /** @type {[string, string]} */ (JSON.parse(key)));
  const repoIds = [...new Set(wanted.map(([repoId]) => repoId))];
  const ids = [...new Set(wanted.map(([, id]) => id))];
  const rows = db
    .prepare(
      `SELECT repo_id, CAST(json_extract(data,'$.data.pullRequestId') AS TEXT) AS id,
        json_extract(data,'$.data.sourceRefName') AS source, json_extract(data,'$.data.targetRefName') AS target,
        json_extract(data,'$.data.fork') AS fork
      FROM events WHERE repo_id IN (${repoIds.map(() => '?').join(',')}) AND json_extract(data,'$.kind')='pr'
        AND CAST(json_extract(data,'$.data.pullRequestId') AS TEXT) IN (${ids.map(() => '?').join(',')})
      ORDER BY time DESC, observed_at DESC, rowid DESC`,
    )
    .all(...repoIds, ...ids);
  const done = new Set();
  for (const row of rows) {
    const key = JSON.stringify([row.repo_id, row.id]);
    const events = runs.get(key);
    if (!events || done.has(key)) continue;
    done.add(key);
    const pullRequest = {
      id: Number(row.id),
      ...(row.source ? { sourceRefName: String(row.source) } : {}),
      ...(row.target ? { targetRefName: String(row.target) } : {}),
      ...(row.fork ? { fork: JSON.parse(String(row.fork)) } : {}),
    };
    for (const event of events) event.data = { ...event.data, pullRequest };
  }
}

/** @param {CountRow[]} countRows */
function summarizeCounts(countRows) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Record<string, number>} */
  const newCounts = {};
  let total = 0,
    newItems = 0,
    newUpdates = 0;
  for (const row of countRows) {
    counts[row.kind] = row.count;
    newCounts[row.kind] = row.newItems;
    total += row.count;
    newItems += row.newItems;
    newUpdates += row.newUpdates;
  }
  return { counts, newCounts, total, newItems, newUpdates };
}

/** @param {Group | undefined} last @param {number} maxSequence @param {string} filterKey @param {string | undefined} revision */
function encodeCursor(last, maxSequence, filterKey, revision) {
  return last
    ? Buffer.from(
        JSON.stringify({ maxSequence, filterKey, revision, after: { observed: last.observed, time: last.time, key: last.key } }),
      ).toString('base64url')
    : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(row: SqlRow) => ActivityEvent} hydrate
 * @param {(repoId: string) => unknown} requireRepo
 * @param {() => string} activityRevision
 */
export function createActivityQuery(db, hydrate, requireRepo, activityRevision) {
  db.function('matches_folded', { deterministic: true, varargs: true }, (text, ...terms) => {
    if (typeof text !== 'string') return 0;
    const folded = foldSearchText(text);
    return Number(terms.some(term => folded.includes(/** @type {string} */ (term))));
  });
  db.function('matches_people', { deterministic: true, varargs: true }, (data, enrichment, ...terms) =>
    Number(matchesPeople(hydrate({ data, enrichment }), /** @type {string[]} */ (terms))),
  );
  /** @param {ActivityRequest} input */
  function readScope({ repoIds, kind = '', search = '', people = '' }) {
    if (typeof search !== 'string' || typeof people !== 'string' || typeof kind !== 'string') {
      throw Object.assign(new Error('Invalid activity filter.'), { code: 'BAD_REQUEST' });
    }
    if (search.length > 300) {
      throw Object.assign(new Error('Enter up to 300 characters in Activity search.'), { code: 'BAD_REQUEST' });
    }
    const selected = repoIds ? [...new Set(repoIds)].sort() : undefined;
    selected?.forEach(requireRepo);
    const filter = parseActivityFilter(kind);
    const needles = [
      ...new Set(
        search
          .split(',')
          .map(term => term.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].sort();
    const names = parsePeople(people);
    return { selected, filter, needles, names };
  }

  /** @param {ActivityRequest} [input] @returns {ActivityPage} */
  function queryActivity({ repoIds, view = 'all', kind = '', search = '', people = '', limit = 50, cursor } = {}) {
    if (!['all', 'new'].includes(view)) throw Object.assign(new Error('Invalid activity view.'), { code: 'BAD_REQUEST' });
    const pageSize = Math.max(1, Math.min(Number(limit) || 50, 200));
    const { selected, filter, needles, names } = readScope({ repoIds, kind, search, people });
    const filterKey = JSON.stringify({ selected, view, filter, search: needles, people: names });
    const position = decodeCursor(cursor, filterKey);
    // Search cursors from before accent and name fragment matching must restart.
    const revision = needles.length || names.length ? `2:${activityRevision()}` : undefined;
    if (position && revision !== undefined && position.revision !== revision) {
      throw Object.assign(new Error('Activity changed while loading search results. Try again.'), {
        status: 409,
        code: 'ACTIVITY_CHANGED',
      });
    }
    const maxSequence =
      position?.maxSequence ?? Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS id FROM activity_members').get()?.id);
    const member = memberScope(maxSequence, selected, needles, names);
    const query = pageQuery(member, filter, view, position, pageSize);
    const page = db.prepare(query.sql).get(...query.params);
    const groups = /** @type {Group[]} */ (JSON.parse(String(page?.groups)));
    const countRows = /** @type {CountRow[]} */ (JSON.parse(String(page?.counts)));
    const options = page?.options ? filterOptions(JSON.parse(String(page.options))) : undefined;
    const selectedGroups = groups.slice(0, pageSize);
    const members = loadMembers(db, hydrate, member, filter, selectedGroups);
    attachPullRequests(db, members.values());
    const items = selectedGroups.flatMap(group => projectActivity(group.key, members.get(group.key) || [], group.representative) || []);
    const { counts, newCounts, total, newItems, newUpdates } = summarizeCounts(countRows);
    const nextCursor = groups.length > pageSize ? encodeCursor(selectedGroups.at(-1), maxSequence, filterKey, revision) : null;
    return { items, nextCursor, total, newItems, newUpdates, counts, newCounts, filterOptions: options };
  }
  /** @param {ActivityRequest} input */
  queryActivity.unseenIds = input => {
    const { selected, filter, needles, names } = readScope(input);
    const maxSequence = Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS id FROM activity_members').get()?.id);
    const { sql, params, selection } = matchedScope(memberScope(maxSequence, selected, needles, names), filter, 'new');
    return db
      .prepare(
        `${sql} SELECT source.event_id FROM ${selection} source
      JOIN matched ON matched.key=source.group_key WHERE source.unseen>0`,
      )
      .all(...params)
      .map(row => String(row.event_id));
  };
  return queryActivity;
}
