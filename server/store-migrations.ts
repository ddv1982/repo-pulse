import { DatabaseSync } from 'node:sqlite';
import { chmodSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { azureDevOpsService, SEARCH_INDEX_VERSION } from '../src/activity-text.ts';
import { forkJob } from './jobs.ts';
import { isRecord } from './azure-records.ts';
import { corruptRow, readEvent, readOverlay } from './store-records.ts';
import { SELECT_EVENTS } from './store-events.ts';
import type { StoreDb } from './store-db.ts';
import type { StoreEvents } from './store-events.ts';
import type { StoreLinks } from './store-links.ts';
import type { StoreState } from './store-state.ts';

/**
 * The live store helpers the migrations call. Each one writes a derived row that today's code reads back (activity
 * membership and labels, push tips and PR links, the enrichment overlay, a fork check job), so a migration that builds
 * one builds it the way the current reader expects. A migration whose result must not follow later changes keeps its
 * own copy instead, as migration 15 does for the first sync's window.
 */
type MigrationDeps = {
  events: Pick<StoreEvents, 'hydrate' | 'saveMembership' | 'indexLabels' | 'reindexAll' | 'enrich'>;
  links: Pick<StoreLinks, 'indexPush'>;
  state: Pick<StoreState, 'getSetting' | 'setSetting' | 'bumpActivity' | 'requestCompact'>;
};
type Migration = readonly [version: number, run: () => void];

/** The window the first sync imported when migration 15 was written (FIRST_SYNC_MS in server/time.ts, 7 days then). */
const FIRST_SYNC_WINDOW_AT_V15 = 7 * 86400000;

/**
 * Writes a copy of a database about to be upgraded from `version` next to it, as `<name>.pre-v<version>`, and removes
 * older copies. The copy goes to a temporary name first: if another opener upgraded the file since `version` was read,
 * the copy is not at `version`, so it is dropped and the copy that opener made stays.
 */
export function copyBeforeUpgrade(db: DatabaseSync, path: string, version: number) {
  const name = `${basename(path)}.pre-v${version}`;
  const copy = join(dirname(path), name);
  const temporary = `${copy}.tmp-${process.pid}`;
  try {
    rmSync(temporary, { force: true });
    db.prepare('VACUUM INTO ?').run(temporary);
    const check = new DatabaseSync(temporary, { readOnly: true });
    const copied = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    if (copied !== version) return;
    chmodSync(temporary, 0o600);
    renameSync(temporary, copy);
  } finally {
    rmSync(temporary, { force: true });
  }
  const prefix = `${basename(path)}.pre-v`;
  for (const entry of readdirSync(dirname(path)))
    if (entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)) && entry !== name)
      rmSync(join(dirname(path), entry), { force: true });
}

/**
 * Each step upgrades a database below its version and is recorded in user_version once it has run, in the order
 * listed. A fresh database runs every step against empty tables and ends at the last version. Versions 1 and 3 to 6
 * changed only the schema, which the CREATE statements in `migrate` and the pre-v7 column fix cover.
 */
function migrations({ db, q }: StoreDb, { events, links, state }: MigrationDeps): Migration[] {
  return [
    [
      2,
      () => {
        // Membership is added without rewriting any existing event or read flag. Live: saveMembership.
        for (const row of q('SELECT id,data FROM events ORDER BY rowid').all()) events.saveMembership(readEvent(row));
      },
    ],
    [
      7,
      () => {
        // Live: indexLabels.
        events.reindexAll();
        db.exec('DROP INDEX IF EXISTS activity_label; DROP INDEX IF EXISTS activity_evidence;');
      },
    ],
    [
      8,
      () => {
        // Paused repositories kept showing cached activity; disabled ones are hidden everywhere except Repositories.
        db.exec(`UPDATE repositories SET data=json_remove(json_set(data,'$.disabled',
        json(CASE WHEN json_extract(data,'$.paused') THEN 'true' ELSE 'false' END)),'$.paused');`);
      },
    ],
    [
      9,
      () => {
        // Pull now uses git merge --ff-only, so the crash journal for the custom fast-forward is gone.
        db.exec('DROP TABLE IF EXISTS pull_operations;');
      },
    ],
    [
      10,
      () => {
        // Pushes link to completed PRs from stored events; index the stored pushes and link the pairs already stored.
        // Live: indexPush.
        for (const row of q("SELECT id,data FROM events WHERE json_extract(data,'$.kind')='push'").all()) links.indexPush(readEvent(row));
      },
    ],
    [
      11,
      () => {
        // Background merge analysis stopped: its queue goes and saved evidence stays. Evidence a running or retrying job
        // left behind is marked incomplete without progress or retry wording, since nothing will finish it.
        // Live: enrich (the overlay merge and its relabel).
        const rows = q(`SELECT event_id,data FROM enrichment WHERE json_extract(data,'$.mergeEvidence.status')='enriching'
          OR event_id IN (SELECT json_extract(data,'$.eventId') FROM jobs WHERE type='merge')`).all();
        q("DELETE FROM jobs WHERE type='merge'").run();
        const settled = (text: string) => text.replace(/\s*Retrying later\.$/, '');
        for (const row of rows) {
          const id = String(row.event_id);
          const evidence = readOverlay(id, row.data).mergeEvidence;
          if (!isRecord(evidence) || evidence.status === 'complete' || evidence.status === 'not-applicable') continue;
          const listed = evidence.limitations || [];
          if (!Array.isArray(listed) || !listed.every(item => typeof item === 'string'))
            throw corruptRow('enrichment', id, 'mergeEvidence.limitations');
          const limitations = listed.filter(item => item !== 'Merge enrichment is still in progress.').map(settled);
          const stored = evidence.error;
          const error =
            stored && typeof stored === 'object'
              ? { ...stored, message: settled('message' in stored && typeof stored.message === 'string' ? stored.message : '') }
              : // JSON values other than objects have no default object representation.
                // oxlint-disable-next-line typescript/no-base-to-string
                stored && settled(String(stored));
          events.enrich(id, {
            mergeEvidence: { ...evidence, status: 'incomplete', limitations: [...new Set(limitations)], ...(error ? { error } : {}) },
          });
        }
      },
    ],
    [
      12,
      () => {
        // The merge analysis cached Azure commits and their PR lookups, which nothing reads any more, and no code ever
        // wrote a rule. Pushes indexed under the retired "Merge commit" badge get their labels again. Live: indexLabels.
        q("DELETE FROM entities WHERE type IN ('commit','commit-pr')").run();
        db.exec('DROP TABLE IF EXISTS rules;');
        for (const row of q(`${SELECT_EVENTS} JOIN activity_members m ON m.event_id=e.id WHERE m.evidence_id='merge-commit'`).all())
          events.indexLabels(events.hydrate(row));
        state.requestCompact();
      },
    ],
    [
      13,
      () => {
        // Index named searchable fields instead of stringifying entire event payloads into search_text. Live: indexLabels.
        events.reindexAll();
        state.requestCompact();
      },
    ],
    [
      14,
      () => {
        // Sync used to save Azure's merge preview updates (refs/pull/N/merge) as service pushes without a branch, and
        // no longer does. The saved ones leave the activity index, so no view lists or counts them. The events stay.
        q(`DELETE FROM activity_members WHERE kind='push' AND event_id IN (SELECT id FROM events
          WHERE json_extract(data,'$.actor')=? AND COALESCE(json_extract(data,'$.branch'),'')=''
          AND COALESCE(json_array_length(data,'$.data.refUpdates'),0)=0)`).run(azureDevOpsService);
        state.bumpActivity();
      },
    ],
    [
      15,
      () => {
        // Branch creations stored before fork checks existed get one, if a sync recorded them: live, or imported by
        // the first sync's 7-day window. An explicit history import stays unchecked, as it does when it runs.
        // A history import can store rows inside that window too, and they cannot be told apart, so a repository that
        // ran one keeps all its imported rows unchecked. Live: forkJob, since the fork check reads the job it queues.
        const insert = q('INSERT OR IGNORE INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?)');
        const histories = new Set(
          q("SELECT DISTINCT repo_id FROM jobs WHERE type='backfill'")
            .all()
            .map(row => String(row.repo_id)),
        );
        const rows = q(`${SELECT_EVENTS} WHERE json_extract(e.data,'$.kind')='branch-created'`).all();
        for (const row of rows) {
          const event = events.hydrate(row);
          const job = event.data?.forkOrigin ? null : forkJob(event);
          if (!job) continue;
          if (event.imported) {
            if (histories.has(event.repoId)) continue;
            const baseline = Date.parse(state.getSetting(`baseline:${event.repoId}`, ''));
            if (!(Date.parse(String(event.time)) >= baseline - FIRST_SYNC_WINDOW_AT_V15)) continue;
          }
          insert.run(job.id, job.repoId, job.type, job.nextAt || '1970-01-01T00:00:00.000Z', JSON.stringify(job));
        }
      },
    ],
  ];
}

/**
 * Brings the database to the latest version: refuses one a newer version wrote, copies a database with data before
 * upgrading it, creates the schema, then runs each pending step in version order in one transaction.
 */
export function migrate(conn: StoreDb, deps: MigrationDeps) {
  const { db, path, q, transaction } = conn;
  const steps = migrations(conn, deps);
  for (const [index, [target]] of steps.entries()) {
    const previous = steps[index - 1]?.[0] ?? 0;
    if (target <= previous) throw new Error(`Store migration ${target} is listed after migration ${previous}.`);
  }
  const version = (q('PRAGMA user_version').get() as { user_version: number }).user_version;
  // The list above is never empty.
  const latest = steps.at(-1)?.[0] ?? 0;
  if (version > latest) {
    db.close();
    throw new Error('This database was created by a newer Repo Pulse version.');
  }
  // Some migrations delete rows and commit even when their logic is wrong, so a database with data is copied first.
  // Only the copy from the latest upgrade is kept.
  if (path !== ':memory:' && version < latest && q('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
    try {
      copyBeforeUpgrade(db, path, version);
    } catch (error) {
      db.close();
      // Upgrading without the copy would leave nothing to recover rows a faulty migration deletes.
      throw new Error(
        `Could not copy the database before upgrading it, so it was left unchanged. Free disk space and start again. (${String((error as Error)?.message || error)})`,
      );
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        time TEXT NOT NULL, observed_at TEXT NOT NULL, seen INTEGER NOT NULL, imported INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(time DESC,observed_at DESC);
      CREATE TABLE IF NOT EXISTS streams (repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repo_id,stream));
      CREATE TABLE IF NOT EXISTS entities (repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repo_id,type,id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_members (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL,kind TEXT NOT NULL,status_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL,observed REAL NOT NULL,time REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_group ON activity_members(group_key);
      CREATE INDEX IF NOT EXISTS activity_kind ON activity_members(kind);
      CREATE TABLE IF NOT EXISTS enrichment (event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,next_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(type,next_at);
      CREATE TABLE IF NOT EXISTS push_tips (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,ref TEXT NOT NULL,
        repo_id TEXT NOT NULL,tip TEXT NOT NULL,PRIMARY KEY(event_id,ref)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS push_tips_lookup ON push_tips(repo_id,ref,tip);
      CREATE INDEX IF NOT EXISTS events_pr_merge ON events(repo_id,json_extract(data,'$.data.targetRefName'),
        lower(json_extract(data,'$.data.mergeCommit'))) WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='completed';
      CREATE INDEX IF NOT EXISTS events_pr_source ON events(repo_id,json_extract(data,'$.data.sourceRefName'),time DESC)
        WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='completed';
      CREATE INDEX IF NOT EXISTS events_open_pr_source ON events(repo_id,json_extract(data,'$.data.sourceRefName'))
        WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='active';
      CREATE INDEX IF NOT EXISTS events_pr_id ON events(repo_id,CAST(json_extract(data,'$.data.pullRequestId') AS TEXT))
        WHERE json_extract(data,'$.kind')='pr';
      CREATE INDEX IF NOT EXISTS events_push_id ON events(repo_id,json_extract(data,'$.data.pushId'))
        WHERE json_extract(data,'$.kind')='push';
      CREATE INDEX IF NOT EXISTS events_branch_boundary ON events(repo_id,json_extract(data,'$.data.name'),julianday(time) DESC)
        WHERE json_extract(data,'$.kind') IN ('branch-created','branch-deleted') AND json_extract(data,'$.data.evidence')='push';
    `);
    if (version < 7) {
      // Databases from before version 7 have no status columns, or the older label and evidence names.
      // This runs before every step because saveMembership in step 2 already writes status_id and evidence_id.
      const columns = q('PRAGMA table_info(activity_members)').all();
      if (columns.some(column => column.name === 'label')) {
        db.exec(
          'ALTER TABLE activity_members RENAME COLUMN label TO status_id; ALTER TABLE activity_members RENAME COLUMN evidence TO evidence_id;',
        );
      } else if (!columns.some(column => column.name === 'status_id')) {
        db.exec(
          "ALTER TABLE activity_members ADD COLUMN status_id TEXT NOT NULL DEFAULT ''; ALTER TABLE activity_members ADD COLUMN evidence_id TEXT NOT NULL DEFAULT '';",
        );
      }
    }
    for (const [target, run] of steps) {
      if (version >= target) continue;
      run();
      db.exec(`PRAGMA user_version = ${target}`);
    }
    // Search text is computed when a row is saved, so rows saved under older terms are rebuilt as migration 13 did.
    // A new database has no rows to rebuild.
    if (deps.state.getSetting('searchIndexVersion', null) !== SEARCH_INDEX_VERSION) {
      if (version > 0) deps.events.reindexAll();
      deps.state.setSetting('searchIndexVersion', SEARCH_INDEX_VERSION);
    }
  });
}
