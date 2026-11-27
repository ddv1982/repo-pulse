// Active pull request and build reconciliation: after a complete listing of active PRs or in-progress builds, the ones
// sync still holds as active but Azure no longer lists are looked up by ID, a few per read, so a PR that closed or a
// build that finished between reads is still recorded. Sync owns when this runs; this module owns which IDs each turn
// asks for, what came back unreadable, and which builds Azure no longer has.
import { isRecord } from './azure-records.ts';
import { addUnreadable } from './read-warnings.ts';
import type { AzureProvider } from './azure-client.ts';
import type { AzureStreamRecord, StreamState, UnreadableRecords } from '../src/contract.ts';
import type { WatchedRepo } from './normalize.ts';
import type { Entity, EntityData, EntityType } from './store-records.ts';

type UnreadableLookups = StreamState['unreadableLookups'];
type LookupStore = {
  listEntities: <T extends EntityType>(repoId: string, type: T) => { id: string; data: EntityData[T] }[];
};

/**
 * Up to `size` of the missing IDs, those that have waited longest for a lookup first. `order` holds the missing IDs in
 * turn order: an ID joins the end when it goes missing, in numeric order with the others that do, and `lookedUp` moves
 * it to the end, so neither IDs that stay missing nor IDs that keep going missing can hold every turn.
 */
function lookupTurn(order: Set<string>, missing: string[], size: number) {
  const wanted = new Set(missing);
  for (const id of order) if (!wanted.has(id)) order.delete(id);
  for (const id of [...missing].sort((a, b) => Number(a) - Number(b))) order.add(id);
  return [...order].slice(0, size);
}
/** Moves an ID that is being looked up to the end of the turn order. */
function lookedUp(order: Set<string>, id: string) {
  order.delete(id);
  order.add(id);
}
/** The remembered unreadable lookups of IDs that are still missing, by ID. */
const rememberedLookups = (remembered: UnreadableLookups, missing: (id: string) => boolean) =>
  new Map((remembered || []).filter(entry => missing(entry.id)).map(entry => [entry.id, entry.field]));
/** The count and fields of the remembered unreadable lookups, or undefined when there are none. */
const lookupsUnreadable = (lookups: Map<string, string>): UnreadableRecords | undefined =>
  lookups.size ? { count: lookups.size, fields: [...new Set(lookups.values())] } : undefined;
/**
 * The lookups over one store and provider. A provider without `buildsById` or `pullRequest` looks nothing up. The turn
 * order is kept per repository in memory; `prune`, `forget` and `clear` drop it when a repository stops being watched
 * or activity starts from scratch.
 */
export function createActiveLookups({
  store,
  provider,
}: {
  store: LookupStore;
  provider: Partial<Pick<AzureProvider, 'buildsById' | 'pullRequest'>>;
}) {
  /** The turn order of the cached active PRs and in-progress builds to look up by ID, per repository (see lookupTurn). */
  const prTurns: Map<string, Set<string>> = new Map();
  const buildTurns: Map<string, Set<string>> = new Map();
  const turnOrder = (turns: Map<string, Set<string>>, repoId: string) => {
    const order = turns.get(repoId) ?? new Set();
    turns.set(repoId, order);
    return order;
  };
  /**
   * Looks up by ID up to 20 cached in-progress builds that the active list no longer holds. Returns the builds Azure
   * answered with, what it returned unreadable, and the builds it no longer has. A build whose lookup came back
   * unreadable is remembered and counted in every read until it reads, its lookup finds it gone, or it is listed
   * active again, so a read whose turn skips it does not clear the warning.
   */
  async function lookUpBuilds(repo: WatchedRepo, activeIds: string[], remembered: UnreadableLookups, listed: number) {
    if (!provider.buildsById) return { items: [], gone: [] };
    const missing = new Map(
      store
        .listEntities(repo.id, 'build')
        .filter(entry => entry.data.status !== 'completed' && !activeIds.includes(entry.id))
        .map(entry => [entry.id, entry.data]),
    );
    const lookups = rememberedLookups(remembered, id => missing.has(id));
    const order = turnOrder(buildTurns, repo.id);
    const turn = lookupTurn(order, [...missing.keys()], 20);
    if (!turn.length) return { items: [], gone: [] };
    for (const id of turn) lookedUp(order, id);
    const byId = await provider.buildsById(repo, turn);
    // Azure omits a build it no longer has (removed by retention, see docs/probe-results.md), so stop asking for it.
    // The fingerprint stays, so no event is made for it and a later sighting still compares against its last state.
    // With more pages to read, an omitted build may only be on a later one, so none is given up this turn. A build
    // Azure returned unreadable is not omitted, and when one of those has no readable ID it may be any build asked
    // for, so none is given up either.
    const named = byId.unreadableIds || [];
    const answered = new Set([...byId.items.map(item => String(item.id)), ...named.map(entry => entry.id)]);
    const unnamed = (byId.unreadable?.count ?? 0) - named.length;
    const gone: Entity[] =
      byId.nextCursor || unnamed > 0
        ? []
        : turn.flatMap(id => {
            // `turn` holds IDs of `missing` only.
            const data = missing.get(id);
            return answered.has(id) || !data ? [] : [{ type: 'build', id, data: { ...data, status: 'completed' } } satisfies Entity];
          });
    // A remembered build leaves the warning only when this lookup read it or found it gone, not when the answer had
    // more pages or unreadable builds without an ID, either of which may be it.
    for (const id of [...byId.items.map(item => String(item.id)), ...gone.map(entry => entry.id)]) lookups.delete(id);
    // An unreadable build without a readable ID cannot be remembered, so it counts only in this read, and not for a
    // remembered build asked for in this lookup, or for one of the `listed` builds the active list returned without a
    // readable ID, either of which it may be and which are counted already. Its fields are named either way, since they
    // are what this read found.
    const namedIds = new Set(named.map(entry => entry.id));
    const counted = turn.filter(id => lookups.has(id) && !namedIds.has(id)).length;
    const anonymous = Math.max(0, unnamed - counted - listed);
    for (const { id, field } of named) lookups.set(id, field);
    const unreadable = addUnreadable(
      lookupsUnreadable(lookups),
      unnamed > 0 && byId.unreadable ? { count: anonymous, fields: byId.unreadable.fields } : undefined,
    );
    return { items: byId.items, unreadable, gone, unreadableLookups: [...lookups].map(([id, field]) => ({ id, field })) };
  }
  /**
   * Looks up by ID up to 3 cached active PRs that the active list no longer holds. Returns the PRs Azure answered with,
   * what it returned unreadable, and the PRs to remember, or null when `stillWatched` says the repository stopped being
   * watched. A lookup that came back unreadable counts in every read until that PR reads, its lookup finds it deleted
   * or moved, or it is no longer missing, so a read whose turn skips it does not clear the warning. `listed` counts the
   * records without a readable ID the active list returned in this read.
   */
  async function lookUpPrs(
    repo: WatchedRepo,
    activeIds: string[],
    remembered: UnreadableLookups,
    listed: number,
    stillWatched: () => boolean,
  ) {
    const pullRequest = provider.pullRequest;
    if (!pullRequest) return { items: [], unreadable: undefined, unreadableLookups: undefined };
    const missing = store
      .listEntities(repo.id, 'pr')
      .filter(entry => entry.data.status === 'active' && !activeIds.includes(entry.id))
      .map(entry => entry.id);
    const lookups = rememberedLookups(remembered, id => missing.includes(id));
    const order = turnOrder(prTurns, repo.id);
    const items: AzureStreamRecord[] = [];
    // Answers whose own ID cannot be read count only in this read, and not again for a PR remembered already or for
    // one of the `listed` records, either of which they may be. Their fields are named either way.
    const anonymous: UnreadableRecords = { count: 0, fields: [] };
    for (const id of lookupTurn(order, missing, 3)) {
      if (!stillWatched()) return null;
      lookedUp(order, id);
      try {
        items.push(await pullRequest(repo, id));
        lookups.delete(id);
      } catch (error) {
        // Only "this PR cannot be read" (unreadable, deleted, or now in another repository) is left for a later turn.
        if (!isRecord(error) || !['UNREADABLE_RECORD', 'NOT_FOUND', 'WRONG_REPOSITORY'].includes(String(error.code))) throw error;
        if (error.code !== 'UNREADABLE_RECORD') {
          lookups.delete(id);
          continue;
        }
        // A PR Azure returned in a shape this code cannot read is skipped and counted like an unreadable page record.
        const field = typeof error.field === 'string' ? error.field : 'record';
        if (error.anonymous !== true) {
          lookups.set(id, field);
          continue;
        }
        anonymous.fields = [...new Set([...anonymous.fields, field])];
        if (!lookups.has(id)) anonymous.count++;
      }
    }
    anonymous.count = Math.max(0, anonymous.count - listed);
    const unreadable = addUnreadable(lookupsUnreadable(lookups), anonymous.fields.length ? anonymous : undefined);
    return { items, unreadable, unreadableLookups: [...lookups].map(([id, field]) => ({ id, field })) };
  }

  return {
    builds: lookUpBuilds,
    prs: lookUpPrs,
    /** Drops the lookup order of every repository `watched` no longer names, so one added again starts afresh. */
    prune(watched: Set<string>) {
      for (const turns of [prTurns, buildTurns]) for (const repoId of turns.keys()) if (!watched.has(repoId)) turns.delete(repoId);
    },
    forget(repoId: string) {
      prTurns.delete(repoId);
      buildTurns.delete(repoId);
    },
    clear() {
      prTurns.clear();
      buildTurns.clear();
    },
  };
}

export type ActiveLookups = ReturnType<typeof createActiveLookups>;
