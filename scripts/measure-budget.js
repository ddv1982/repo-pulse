// Simulates live polling and merge enrichment against the shared Azure CLI budget.
// Usage: node scripts/measure-budget.js [--repos 1,5,10,20] [--pushes-per-hour 4] [--commits 5] [--call-ms 1500] [--minutes 60]
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createSync } from '../server/sync.js';
import { createEnrichment } from '../server/enrichment.js';
import { createAzureClient } from '../server/azure-client.js';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repoCounts = option('repos', '1,5,10,20').split(',').map(Number);
const pushesPerHour = Number(option('pushes-per-hour', 4));
const commitsPerPush = Number(option('commits', 5));
const callMs = Number(option('call-ms', 1500));
const minutes = Number(option('minutes', 60));
const LIMIT_PER_MINUTE = 12;
const sha = value => createHash('sha1').update(value).digest('hex');

function simulate(repoTotal) {
  const start = Date.parse('2026-11-17T09:00:00Z');
  const end = start + minutes * 60000;
  let time = start;
  const now = () => time;
  const starts = [];
  let calls = 0;
  // One process-wide queue: wait for a free slot in the sliding minute, then spend the call's duration.
  function charge() {
    while (starts.length && starts[0] <= time - 60000) starts.shift();
    if (starts.length >= LIMIT_PER_MINUTE) {
      time = starts[0] + 60000;
      starts.shift();
    }
    starts.push(time);
    calls++;
    time += callMs;
  }

  const pushes = new Map();
  const commitsOf = new Map();
  for (let r = 0; r < repoTotal; r++) {
    const azureId = `repo-${r}`;
    const list = [];
    let tip = sha(`${azureId}:root`);
    const gap = 3600000 / pushesPerHour;
    for (let at = start + gap * ((r + 1) / (repoTotal + 1)), id = 1; at < end; at += gap, id++) {
      const ids = Array.from({ length: commitsPerPush }, (_, i) => sha(`${azureId}:${id}:${i}`));
      ids.forEach((commitId, i) => commitsOf.set(commitId, i ? ids[i - 1] : tip));
      list.push({ pushId: id, date: new Date(at).toISOString(), pushedBy: { displayName: 'Tester' }, commits: ids,
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: tip, newObjectId: ids.at(-1) }] });
      tip = ids.at(-1);
    }
    pushes.set(azureId, list);
  }

  const pairs = (args, flag) => {
    const index = args.indexOf(flag);
    const values = {};
    if (index === -1) return values;
    for (const entry of args.slice(index + 1)) {
      if (entry.startsWith('--')) break;
      const split = entry.indexOf('=');
      values[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return values;
  };
  const cli = {
    async run(args) {
      charge();
      const resource = args[args.indexOf('--resource') + 1]?.toLowerCase();
      const query = pairs(args, '--query-parameters'), route = pairs(args, '--route-parameters');
      const repoPushes = pushes.get(route.repositoryId) || [];
      if (resource === 'pushes') {
        const from = Date.parse(query['searchCriteria.fromDate']), to = Date.parse(query['searchCriteria.toDate']);
        const visible = repoPushes.filter(push => Date.parse(push.date) >= from && Date.parse(push.date) <= to && Date.parse(push.date) <= time).reverse();
        const skip = Number(query.$skip || 0);
        return { value: visible.slice(skip, skip + Number(query.$top)).map(({ commits, ...push }) => push) };
      }
      if (resource === 'refs') {
        const latest = repoPushes.filter(push => Date.parse(push.date) <= time).at(-1);
        return { value: [{ name: 'refs/heads/main', objectId: latest?.refUpdates[0].newObjectId || sha(`${route.repositoryId}:root`) }] };
      }
      if (resource === 'commits') {
        if (route.commitId) return { commitId: route.commitId, parents: [commitsOf.get(route.commitId) || sha('root')] };
        const page = (ids = [], skip, top) => ({ value: ids.slice(Number(skip || 0), Number(skip || 0) + Number(top)).map(commitId => ({ commitId })) });
        if (query.pushId) return page(repoPushes.find(push => push.pushId === Number(query.pushId))?.commits, query.skip, query.top);
        const push = repoPushes.find(item => item.refUpdates[0].newObjectId === query['searchCriteria.compareVersion.version']);
        return page(push?.commits, query['searchCriteria.$skip'], query['searchCriteria.$top']);
      }
      return { value: [] };
    },
    async runReadQuery(repository, body) {
      charge();
      if (repository.resource === 'commitsbatch') return { value: body.ids.map(commitId => ({ commitId })) };
      return { results: body.queries.map(() => ({})) };
    },
  };

  const store = createStore();
  for (let r = 0; r < repoTotal; r++) {
    store.saveRepo({ id: `r${r}`, name: `Repo ${r}`, organization: 'https://dev.azure.com/org', project: 'P', projectId: 'p',
      azureId: `repo-${r}`, webUrl: `https://dev.azure.com/org/P/_git/Repo${r}` });
  }
  const provider = createAzureClient({ cli, now });
  const enrichment = createEnrichment({ store, provider, now });
  const sync = createSync({ store, provider, now, isForeground: () => true,
    onPrCompleted: (repo, data) => enrichment.reconcilePr(repo, data),
    background: { merge: () => enrichment.tick(), history: async () => false } });
  const generated = [...pushes.values()].reduce((total, list) => total + list.length, 0);
  return { store, sync, end, generated, now: () => time, advance: ms => { time += ms; }, calls: () => calls };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
const minutesOf = ms => ms === null ? 'n/a' : (ms / 60000).toFixed(1);

console.log(`Budget ${LIMIT_PER_MINUTE} calls/min, ${callMs} ms per call, ${pushesPerHour} pushes/hour/repo with ${commitsPerPush} commits, ${minutes} simulated minutes, tab in foreground.`);
console.log('repos | calls/min | pushes | in Activity | delay p50 min | delay p95 min | delay max min | merge jobs left');
for (const repoTotal of repoCounts) {
  const run = simulate(repoTotal);
  const startedAt = run.now();
  while (run.now() < run.end) {
    await run.sync.tick();
    run.advance(1000);
  }
  const elapsedMinutes = (run.now() - startedAt) / 60000;
  const events = run.store.listEvents({ limit: 5000 }).filter(event => event.kind === 'push');
  const delays = events.map(event => Date.parse(event.observedAt) - Date.parse(event.time));
  const jobs = run.store.listJobs({ type: 'merge' }).length;
  console.log([repoTotal, (run.calls() / elapsedMinutes).toFixed(1), run.generated, events.length,
    minutesOf(percentile(delays, 0.5)), minutesOf(percentile(delays, 0.95)), minutesOf(percentile(delays, 1)), jobs].join(' | '));
  run.store.close();
}
