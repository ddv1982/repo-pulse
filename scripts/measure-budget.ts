// Simulates live polling against the shared Azure call budget.
// Usage: node scripts/measure-budget.ts [--limit 12] [--repos 1,5,10,20] [--pushes-per-hour 4] [--call-ms 1500] [--minutes 60]
//   [--recent-pushes 0] [--refs-per-repo 1] [--active-prs 0 --pr-every 3]: also spend one threads read and one policy evaluations read per active PR every N minutes.
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createAzureClient } from '../server/azure-client.ts';
import type { AzureRead } from '../server/azure-reads.ts';

const option = <T>(name: string, fallback: T) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repoOption = option('repos', '1,5,10,20');
if (repoOption === undefined) throw new Error('--repos needs a value.');
const repoCounts = repoOption.split(',').map(Number);
const pushesPerHour = Number(option('pushes-per-hour', 4));
const callMs = Number(option('call-ms', 1500));
const minutes = Number(option('minutes', 60));
const LIMIT_PER_MINUTE = Number(option('limit', 12));
// A limit below 1 can never admit a call; the simulation failed with a RangeError for it before as well.
if (!(LIMIT_PER_MINUTE >= 1)) throw new RangeError('--limit must be at least 1.');
const refsPerRepo = Number(option('refs-per-repo', 1));
if (!Number.isSafeInteger(refsPerRepo) || refsPerRepo < 1) throw new RangeError('--refs-per-repo must be a positive integer.');
const recentPushes = Number(option('recent-pushes', 0));
if (!Number.isSafeInteger(recentPushes) || recentPushes < 0) throw new RangeError('--recent-pushes must be a non-negative integer.');
const activePrs = Number(option('active-prs', 0));
const prEveryMs = Number(option('pr-every', 3)) * 60000;
const sha = (value: string) => createHash('sha1').update(value).digest('hex');
const extraRefs = Array.from({ length: refsPerRepo - 1 }, (_, i) => ({ name: `refs/heads/branch-${i}`, objectId: sha(`branch-${i}`) }));

function simulate(repoTotal: number) {
  const start = Date.parse('2026-11-17T09:00:00Z');
  const end = start + minutes * 60000;
  let time = start;
  const now = () => time;
  const starts: number[] = [];
  const queueWaits: number[] = [];
  let calls = 0;
  // One process-wide queue: wait for a free slot in the sliding minute, then spend the call's duration.
  function charge() {
    const arrivedAt = time;
    while (starts[0] !== undefined && starts[0] <= time - 60000) starts.shift();
    const [oldest] = starts;
    if (oldest !== undefined && starts.length >= LIMIT_PER_MINUTE) {
      time = oldest + 60000;
      starts.shift();
    }
    queueWaits.push(time - arrivedAt);
    starts.push(time);
    calls++;
    time += callMs;
  }

  const pushes = new Map<
    string,
    {
      pushId: number;
      date: string;
      pushedBy: { displayName: string };
      refUpdates: { name: string; oldObjectId: string; newObjectId: string }[];
    }[]
  >();
  for (let r = 0; r < repoTotal; r++) {
    const azureId = `repo-${r}`;
    const list = [];
    let tip = sha(`${azureId}:root`);
    const gap = 3600000 / pushesPerHour;
    const firstLivePush = start + gap * ((r + 1) / (repoTotal + 1));
    for (let id = 1; id <= recentPushes; id++) {
      const at = start - 86400000 + Math.floor((id * 86400000) / (recentPushes + 1));
      const next = sha(`${azureId}:recent:${id}`);
      list.push({
        pushId: id,
        date: new Date(at).toISOString(),
        pushedBy: { displayName: 'Tester' },
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: tip, newObjectId: next }],
      });
      tip = next;
    }
    for (let at = firstLivePush, id = recentPushes + 1; at < end; at += gap, id++) {
      const next = sha(`${azureId}:${id}`);
      list.push({
        pushId: id,
        date: new Date(at).toISOString(),
        pushedBy: { displayName: 'Tester' },
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: tip, newObjectId: next }],
      });
      tip = next;
    }
    pushes.set(azureId, list);
  }

  const cli = {
    async run() {
      charge();
      return { value: [] };
    },
    async read({ resource, query, route }: AzureRead) {
      charge();
      const repoPushes = pushes.get(route.repositoryId ?? '') || [];
      if (resource === 'pushes') {
        // A missing date parses to NaN either way.
        const from = Date.parse(query['searchCriteria.fromDate'] ?? ''),
          to = Date.parse(query['searchCriteria.toDate'] ?? '');
        const visible = repoPushes
          .filter(push => Date.parse(push.date) >= from && Date.parse(push.date) <= to && Date.parse(push.date) <= time)
          .reverse();
        const skip = Number(query.$skip || 0);
        return { value: visible.slice(skip, skip + Number(query.$top)) };
      }
      if (resource === 'refs') {
        const latest = repoPushes.filter(push => Date.parse(push.date) <= time).at(-1);
        const main = { name: 'refs/heads/main', objectId: latest?.refUpdates[0]?.newObjectId || sha(`${route.repositoryId}:root`) };
        const from = Number(query.continuationToken ?? 0);
        const to = from + Number(query.$top);
        return { value: [main, ...extraRefs].slice(from, to), continuation_token: to < refsPerRepo ? String(to) : undefined };
      }
      return { value: [] };
    },
  };

  // Per-PR reads are spread evenly over their interval and share the queue with every other read.
  const prDue = Array.from({ length: repoTotal * activePrs }, (_, i) => start + (prEveryMs * i) / (repoTotal * activePrs || 1));
  function prReads() {
    for (const [i, due] of prDue.entries()) {
      if (due > time) continue;
      charge();
      charge();
      prDue[i] = due + prEveryMs;
    }
  }

  const store = createStore();
  for (let r = 0; r < repoTotal; r++) {
    store.saveRepo({
      id: `r${r}`,
      name: `Repo ${r}`,
      organization: 'https://dev.azure.com/org',
      project: 'P',
      projectId: 'p',
      azureId: `repo-${r}`,
      webUrl: `https://dev.azure.com/org/P/_git/Repo${r}`,
    });
  }
  const provider = createAzureClient({ cli, now });
  const sync = createSync({
    store,
    provider,
    now,
    isForeground: () => true,
    background: { history: async () => false },
  });
  const generated = [...pushes.values()].reduce((total, list) => total + list.length - recentPushes, 0);
  return {
    store,
    sync,
    end,
    generated,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    calls: () => calls,
    queueWaits,
    prReads,
  };
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}
const minutesOf = (ms: number | null) => (ms === null ? 'n/a' : (ms / 60000).toFixed(1));

console.log(
  `Budget ${LIMIT_PER_MINUTE} calls/min, ${callMs} ms per call, ${pushesPerHour} pushes/hour/repo, ${minutes} simulated minutes, ${refsPerRepo} refs/repo, ${recentPushes} recent pushes/repo, tab in foreground${activePrs ? `, ${activePrs} active PRs/repo read twice every ${prEveryMs / 60000} min` : ''}.`,
);
console.log(
  'repos | first page with rows s | initial sync s | queue wait p95/max s | calls/min | live pushes | in Activity | delay p50 min | delay p95 min | delay max min',
);
for (const repoTotal of repoCounts) {
  const run = simulate(repoTotal);
  const startedAt = run.now();
  let startupMs: number | undefined;
  let firstPageMs: number | undefined;
  let pageRevision = run.store.activityRevision();
  mock.timers.enable({ apis: ['setTimeout'] });
  run.sync.start();
  try {
    while (run.now() < run.end) {
      run.advance(100);
      mock.timers.tick(100);
      await new Promise(resolve => setImmediate(resolve));
      run.prReads();
      if (firstPageMs === undefined && pageRevision !== run.store.activityRevision()) {
        pageRevision = run.store.activityRevision();
        if (run.store.queryActivity({ limit: 50 }).items.length) firstPageMs = run.now() - startedAt;
      }
      if (startupMs === undefined && run.store.getStreams().every(stream => stream.initialized)) startupMs = run.now() - startedAt;
    }
  } finally {
    await run.sync.stop();
    mock.timers.reset();
  }
  const elapsedMinutes = (run.now() - startedAt) / 60000;
  const events = run.store.listEvents({ limit: 5000 }).filter(event => event.kind === 'push' && !event.imported);
  const delays = events.map(event => Date.parse(event.observedAt) - Date.parse(String(event.time)));
  console.log(
    [
      repoTotal,
      firstPageMs === undefined ? 'n/a' : (firstPageMs / 1000).toFixed(1),
      startupMs === undefined ? 'n/a' : (startupMs / 1000).toFixed(1),
      [0.95, 1].map(p => ((percentile(run.queueWaits, p) ?? 0) / 1000).toFixed(1)).join('/'),
      (run.calls() / elapsedMinutes).toFixed(1),
      run.generated,
      events.length,
      minutesOf(percentile(delays, 0.5)),
      minutesOf(percentile(delays, 0.95)),
      minutesOf(percentile(delays, 1)),
    ].join(' | '),
  );
  run.store.close();
}
