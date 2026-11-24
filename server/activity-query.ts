import { foldSearchText, matchesPeople, parsePeople } from './activity-people.ts';
import { projectActivity } from '../src/activity.ts';
import { activityFilterLabel, labels, parseActivityFilter } from '../src/activity-text.ts';

export type SqlValue = import('node:sqlite').SQLInputValue;
export type SqlRow = Record<string, import('node:sqlite').SQLOutputValue>;
export type ActivityEvent = import('../src/activity.ts').ActivityEvent;
export type ActivityRequest = import('../src/activity.ts').ActivityRequest;
export type ActivityPage = import('../src/activity.ts').ActivityPage;
export type Group = { key: string; time: number; observed: number; representative: string };
export type FilterRow = { kind: string; status: string; evidence: string };
export type CountRow = { kind: string; count: number; newItems: number; newUpdates: number };
export type Position = { maxSequence: number; filterKey: string; revision?: string; after: Pick<Group, 'key' | 'time' | 'observed'> };

const invalidFilter = () => Object.assign(new Error('Activity cursor does not match these filters.'), { code: 'BAD_REQUEST' });

function decodeCursor(cursor: string | undefined, filterKey: string): Position | undefined {
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

function filterOptions(rows: FilterRow[]) {
  const types = new Set(rows.map(row => row.kind));
  const statuses = new Set<string>();
  const evidence = new Set<string>();
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
const grouped = (selection: string) => `
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

export type ActivityFilter = ReturnType<typeof parseActivityFilter>;
export type MemberScope = { scope: string; params: SqlValue[]; people: boolean };

/**
 * Member-level WHERE clause shared by the page query and the member lookup.
 */
function memberScope(maxSequence: number, selected: string[] | undefined, needles: string[], people: string[]): MemberScope {
  const conditions = ['m.sequence<=?'];
  const params: SqlValue[] = [maxSequence];
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
    conditions.push(`matches_people(e.id,e.data,n.data,${people.map(() => '?').join(',')})`);
    params.push(...people);
  }
  return { scope: conditions.join(' AND '), params, people: people.length > 0 };
}

function matchedScope({ scope, params, people }: MemberScope, filter: ActivityFilter, view: string) {
  const rawKind = filter.type === 'kind';
  const selection = rawKind ? 'kind_scope' : 'scoped';
  const kindScope = rawKind ? ', kind_scope AS (SELECT * FROM scoped WHERE kind=?)' : '';
  const visible = view === 'new' ? 'WHERE unseen>0' : '';
  const match = filter.type === 'status' ? 'WHERE status=?' : filter.type === 'evidence' ? 'WHERE evidence=?' : '';
  const queryParams: SqlValue[] = [...params];
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
 */
function pageQuery(member: MemberScope, filter: ActivityFilter, view: string, position: Position | undefined, pageSize: number) {
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
 */
function loadMembers(
  db: import('node:sqlite').DatabaseSync,
  hydrate: (row: SqlRow) => ActivityEvent,
  { scope, params }: MemberScope,
  filter: ActivityFilter,
  groups: Group[],
) {
  const rawKind = filter.type === 'kind';
  const groupScope = rawKind ? `${scope} AND m.kind=?` : scope;
  const rowParams = rawKind && filter.type === 'kind' ? [...params, filter.id] : params;
  const raw = groups.length
    ? db
        .prepare(
          `
      SELECT e.id,e.data,e.seen,e.imported,n.data AS enrichment,m.group_key AS activity_key
      FROM events e LEFT JOIN enrichment n ON n.event_id=e.id
      JOIN activity_members m ON m.event_id=e.id JOIN repositories r ON r.id=e.repo_id
      WHERE ${groupScope} AND m.group_key IN (${groups.map(() => '?').join(',')})
    `,
        )
        .all(...rowParams, ...groups.map(group => group.key))
    : [];
  const members: Map<string, ActivityEvent[]> = new Map();
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
 */
function attachPullRequests(db: import('node:sqlite').DatabaseSync, groups: Iterable<ActivityEvent[]>) {
  const runs: Map<string, ActivityEvent[]> = new Map();
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
  const wanted = [...runs.keys()].map(key => JSON.parse(key) as [string, string]);
  const repoIds = [...new Set(wanted.map(([repoId]) => repoId))];
  const ids = [...new Set(wanted.map(([, id]) => id))];
  const rows = db
    .prepare(
      `SELECT repo_id, CAST(json_extract(data,'$.data.pullRequestId') AS TEXT) AS id,
        COALESCE(json_extract(data,'$.data.sourceRefName'), NULLIF(json_extract(data,'$.branch'),'')) AS source, json_extract(data,'$.data.targetRefName') AS target,
        json_extract(data,'$.data.fork') AS fork
      FROM events WHERE repo_id IN (${repoIds.map(() => '?').join(',')}) AND json_extract(data,'$.kind')='pr'
        AND CAST(json_extract(data,'$.data.pullRequestId') AS TEXT) IN (${ids.map(() => '?').join(',')})
        AND source IS NOT NULL
      ORDER BY julianday(time) DESC, julianday(observed_at) DESC, rowid DESC`,
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
      sourceRefName: String(row.source),
      ...(row.target ? { targetRefName: String(row.target) } : {}),
      ...(row.fork ? { fork: JSON.parse(String(row.fork)) } : {}),
    };
    for (const event of events) event.data = { ...event.data, pullRequest };
  }
}

function summarizeCounts(countRows: CountRow[]) {
  const counts: Record<string, number> = {};
  const newCounts: Record<string, number> = {};
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

function encodeCursor(last: Group | undefined, maxSequence: number, filterKey: string, revision: string | undefined) {
  return last
    ? Buffer.from(
        JSON.stringify({ maxSequence, filterKey, revision, after: { observed: last.observed, time: last.time, key: last.key } }),
      ).toString('base64url')
    : null;
}

export function createActivityQuery(
  db: import('node:sqlite').DatabaseSync,
  hydrate: (row: SqlRow) => ActivityEvent,
  requireRepo: (repoId: string) => unknown,
  activityRevision: () => string,
) {
  db.function('matches_folded', { deterministic: true, varargs: true }, (text, ...terms) => {
    if (typeof text !== 'string') return 0;
    const folded = foldSearchText(text);
    return Number(terms.some(term => folded.includes(term as string)));
  });
  db.function('matches_people', { deterministic: true, varargs: true }, (id, data, enrichment, ...terms) =>
    Number(matchesPeople(hydrate({ id, data, enrichment }), terms.map(String))),
  );
  function readScope({ repoIds, kind = '', search = '', people = '' }: ActivityRequest) {
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

  function queryActivity({
    repoIds,
    view = 'all',
    kind = '',
    search = '',
    people = '',
    limit = 50,
    cursor,
  }: ActivityRequest = {}): ActivityPage {
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
    const groups = JSON.parse(String(page?.groups)) as Group[];
    const countRows = JSON.parse(String(page?.counts)) as CountRow[];
    const options = page?.options ? filterOptions(JSON.parse(String(page.options))) : undefined;
    const selectedGroups = groups.slice(0, pageSize);
    const members = loadMembers(db, hydrate, member, filter, selectedGroups);
    attachPullRequests(db, members.values());
    const items = selectedGroups.flatMap(group => projectActivity(group.key, members.get(group.key) || [], group.representative) || []);
    const { counts, newCounts, total, newItems, newUpdates } = summarizeCounts(countRows);
    const nextCursor = groups.length > pageSize ? encodeCursor(selectedGroups.at(-1), maxSequence, filterKey, revision) : null;
    return { items, nextCursor, total, newItems, newUpdates, counts, newCounts, filterOptions: options, asOf: maxSequence };
  }
  // `through` is the snapshot a page was read at, so updates recorded after the user saw the page stay unread.
  queryActivity.unseenIds = (input: ActivityRequest & { through?: number | undefined }) => {
    const { selected, filter, needles, names } = readScope(input);
    const latest = Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS id FROM activity_members').get()?.id);
    const maxSequence = input.through === undefined ? latest : Math.min(input.through, latest);
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
