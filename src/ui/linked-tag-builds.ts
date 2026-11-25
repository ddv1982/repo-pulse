import type { ActivityItem } from '../activity.ts';

function isSuccessfulPushBuild(build: ActivityItem) {
  const { status, result, reason } = build.data ?? {};
  return status === 'completed' && result === 'succeeded' && reason === 'individualCI';
}

/** Only fold a unique successful push-triggered run of the tag's exact revision. */
export function linkedTagBuilds(items: ActivityItem[]) {
  const tags = new Map<string, ActivityItem | null>();
  const builds = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const ref = item.kind === 'tag' ? item.data?.name : item.kind === 'build' ? item.data?.sourceBranch : undefined;
    if (!ref?.startsWith('refs/tags/')) continue;
    const key = JSON.stringify([item.repoId, ref]);
    if (item.kind === 'tag') {
      tags.set(key, tags.has(key) ? null : item);
    } else {
      const runs = builds.get(key);
      if (runs) runs.push(item);
      else builds.set(key, [item]);
    }
  }

  const links = new Map<string, ActivityItem>();
  for (const [key, tag] of tags) {
    if (!tag || tag.unseen || tag.data?.evidence !== 'push' || tag.data.change !== 'created') continue;
    const revision = (tag.data.peeledObjectId || tag.data.newObjectId)?.toLowerCase();
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) continue;
    const matches = builds.get(key)?.filter(build => build.data?.sourceVersion?.toLowerCase() === revision);
    const build = matches?.length === 1 ? matches[0] : undefined;
    if (build && !build.unseen && isSuccessfulPushBuild(build) && new Date(build.time).valueOf() >= new Date(tag.time).valueOf()) {
      links.set(tag.id, build);
    }
  }
  return links;
}
