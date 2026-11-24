// Simulates live polling against the shared Azure call budget.
// Usage: node scripts/measure-budget.ts [--limit 12] [--repos 1,5,10,20] [--pushes-per-hour 4] [--call-ms 1500] [--minutes 60]
//   [--active-prs 0 --pr-every 3]: also spend one threads read and one policy evaluations read per active PR every N minutes.
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.ts';
import { createSync } from '../server/sync.ts';
import { createAzureClient } from '../server/azure-client.ts';

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
const activePrs = Number(option('active-prs', 0));
const prEveryMs = Number(option('pr-every', 3)) * 60000;
const sha = (value: string) => createHash('sha1').update(value).digest('hex');

function simulate(repoTotal: number) {
  const start = Date.parse('2026-11-17T09:00:00Z');
  const end = start + minutes * 60000;
  let time = start;
  const now = () => time;
  const starts: number[] = [];
  let calls = 0;
  // One process-wide queue: wait for a free slot in the sliding minute, then spend the call's duration.
  function charge() {
    while (starts[0] !== undefined && starts[0] <= time - 60000) starts.shift();
    const [oldest] = starts;
    if (oldest !== undefined && starts.length >= LIMIT_PER_MINUTE) {
      time = oldest + 60000;
      starts.shift();
    }
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
    for (let at = start + gap * ((r + 1) / (repoTotal + 1)), id = 1; at < end; at += gap, id++) {
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

  const pairs = (args: string[], flag: string) => {
    const index = args.indexOf(flag);
    const values: Record<string, string> = {};
    if (index === -1) return values;
    for (const entry of args.slice(index + 1)) {
      if (entry.startsWith('--')) break;
      const split = entry.indexOf('=');
      values[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return values;
  };
  const cli = {
    async run(args: string[]) {
      charge();
      const resource = args[args.indexOf('--resource') + 1]?.toLowerCase();
      const query = pairs(args, '--query-parameters'),
        route = pairs(args, '--route-parameters');
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
        return { value: [{ name: 'refs/heads/main', objectId: latest?.refUpdates[0]?.newObjectId || sha(`${route.repositoryId}:root`) }] };
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
  const generated = [...pushes.values()].reduce((total, list) => total + list.length, 0);
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
  `Budget ${LIMIT_PER_MINUTE} calls/min, ${callMs} ms per call, ${pushesPerHour} pushes/hour/repo, ${minutes} simulated minutes, tab in foreground${activePrs ? `, ${activePrs} active PRs/repo read twice every ${prEveryMs / 60000} min` : ''}.`,
);
console.log('repos | calls/min | pushes | in Activity | delay p50 min | delay p95 min | delay max min');
for (const repoTotal of repoCounts) {
  const run = simulate(repoTotal);
  const startedAt = run.now();
  while (run.now() < run.end) {
    await run.sync.tick();
    run.prReads();
    run.advance(1000);
  }
  const elapsedMinutes = (run.now() - startedAt) / 60000;
  const events = run.store.listEvents({ limit: 5000 }).filter(event => event.kind === 'push');
  const delays = events.map(event => Date.parse(event.observedAt) - Date.parse(event.time));
  console.log(
    [
      repoTotal,
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
