import { createActivityData, activityEvents } from './activity-data.ts';
import { detailView } from './activity-detail.ts';
import { isActivity } from './navigation.ts';
import type { ActivityEvent, ActivityPage } from '../activity.ts';
import type { ActivityView } from './activity-data.ts';
import type { StateResponse, EventResponse } from '../contract.ts';

export type View = ActivityView & { eventId: string | null; relatedCi?: boolean | undefined; generation: number };

export type Repo = StateResponse['repos'][number];

/** Before the first page arrives only `items` and `loading` are set. */
type DisplayActivity = Pick<ActivityPage, 'items'> & Partial<Omit<ActivityPage, 'items'>> & { loading?: boolean; error?: string };

/**
 * The state the page renders: the last /api/state answer, checked once in `readState`, with disabled repositories left
 * out of `repos` and `streams` (`watched` keeps them for Repositories), and the Activity rows or detail loaded for it.
 * Before the first answer every field holds an empty placeholder, and `diagnostics` stays empty.
 */
export type PageState = Omit<StateResponse, 'syncStatus' | 'diagnostics'> & {
  watched: Repo[];
  diagnostics: Partial<StateResponse['diagnostics']>;
  syncStatus: PageSyncStatus;
  activity: DisplayActivity;
  events: ActivityEvent[];
  detailLoading?: boolean;
  /** The server's answer for the detail shown, once it arrives: the event, its group and related activity. */
  detail?: EventResponse | undefined;
};

type PageSyncStatus = { overall: import('./health.ts').ShownSyncStatus; repos: StateResponse['syncStatus']['repos'] };

type RefreshJob = { view: View; force: boolean; more: boolean };

type RefreshOutcome = { type: 'applied' | 'superseded' } | { type: 'failed'; error: Error };

const noSyncStatus: PageSyncStatus = { overall: { state: 'unavailable' }, repos: {} };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The /api/state answer as the page reads it, checked once here: every field the page reads is present with its type.
 * Repository IDs and the activity revision keep their own messages; any other missing or mistyped field makes the state
 * unreadable. The fields inside each entry are trusted to match the contract.
 */
export function readState(value: unknown): StateResponse {
  if (!isObject(value)) throw new Error('Local state is unreadable.');
  const { repos, streams, diagnostics, jobs, activityRevision, savedFilters, settings, syncStatus, demo } = value;
  if (!Array.isArray(repos) || repos.some(repo => !isObject(repo) || typeof repo.id !== 'string'))
    throw new Error('Local repository data is unreadable.');
  if (typeof activityRevision !== 'string') throw new Error('The local Activity revision is unreadable.');
  if (
    !Array.isArray(streams) ||
    !Array.isArray(jobs) ||
    !Array.isArray(savedFilters) ||
    !isObject(diagnostics) ||
    !isObject(diagnostics.sync) ||
    !isObject(settings) ||
    typeof settings.refreshEnabled !== 'boolean' ||
    (settings.refreshResumedAt !== null && typeof settings.refreshResumedAt !== 'number') ||
    !isObject(syncStatus) ||
    !isObject(syncStatus.overall) ||
    typeof syncStatus.overall.state !== 'string' ||
    !isObject(syncStatus.repos) ||
    typeof demo !== 'boolean'
  )
    throw new Error('Local state is unreadable.');
  // Checked above field by field; the entries inside each list follow the route map in src/contract.ts.
  return value as StateResponse;
}

/** The page state for a checked answer: disabled repositories stay manageable on Repositories but leave every other view. */
function pageMetadata(data: StateResponse) {
  const watched = data.repos;
  const repos = watched.filter(repo => !repo.disabled);
  const streams = data.streams.filter(stream => repos.some(repo => repo.id === stream.repoId));
  return { ...data, watched, repos, streams };
}

const viewKey = ({ route, eventId, repoIds, search, kind, unreadOnly, generation }: View) =>
  JSON.stringify([route, eventId, repoIds, search, kind, unreadOnly, generation]);

export function createRefreshController({
  request,
  getView,
  reconcile,
  onUpdate,
  onError,
}: {
  request: typeof import('../api.ts').request;
  getView: () => View;
  /** Brings the navigation state in line with each state answer as it arrives: the repository scope and the saved filter. */
  reconcile: (next: Pick<PageState, 'watched' | 'savedFilters'>) => void;
  onUpdate: (event: { metadata: string; force: boolean }) => void;
  onError: (error: Error, force: boolean) => void;
}) {
  const activityData = createActivityData(request);
  let state: PageState = {
    repos: [],
    watched: [],
    activity: { items: [], loading: true },
    events: [],
    streams: [],
    jobs: [],
    activityRevision: '',
    savedFilters: [],
    settings: { refreshEnabled: true, refreshResumedAt: null },
    diagnostics: {},
    syncStatus: noSyncStatus,
    demo: false,
  };
  // Until the first state read lands, state.watched is a placeholder, not the watch list.
  let loaded = false;
  let detailResult: EventResponse | null | undefined;
  let detailRevision: string | undefined;
  let detailCi: boolean | undefined;
  let active: { view: View; promise: Promise<RefreshOutcome> } | null | undefined;
  let queued: (RefreshJob & PromiseWithResolvers<RefreshOutcome>) | null | undefined;
  const isCurrent = (view: View) => viewKey(view) === viewKey(getView());

  async function read({ view, force, more }: RefreshJob): Promise<RefreshOutcome> {
    if (!isCurrent(view)) return { type: 'superseded' };
    let savedFilters: PageState['savedFilters'] | undefined;
    try {
      const payload = await request('GET /api/state');
      if (!isCurrent(view)) return { type: 'superseded' };
      const next: PageState = { ...pageMetadata(readState(payload)), activity: state.activity, events: state.events };
      savedFilters = next.savedFilters;
      const metadata = JSON.stringify(payload);
      reconcile(next);
      const reconciled = getView();
      if (viewKey(view) !== viewKey(reconciled)) more = false;
      view = reconciled;

      if (isActivity(view.route)) {
        const activity = await activityData.read(view, { more, force, activityRevision: next.activityRevision });
        if (!activity || !isCurrent(view)) return { type: 'superseded' };
        next.activity = activity;
        if (activity !== state.activity) next.events = activityEvents(activity);
      } else if (view.route === 'event') {
        if (view.eventId === null) throw new Error('Activity details are unavailable.');
        const cached =
          !force && detailResult?.event?.id === view.eventId && detailRevision === next.activityRevision && detailCi === view.relatedCi;
        const detail = cached ? detailResult : await activityData.event(view.eventId, view.relatedCi);
        if (!detail) throw new Error('Activity details are unavailable.');
        if (!isCurrent(view)) return { type: 'superseded' };
        detailResult = detail;
        detailRevision = next.activityRevision;
        detailCi = view.relatedCi;
        next.detail = detail;
        next.detailLoading = false;
      }

      state = next;
      loaded = true;
      onUpdate({ metadata, force });
      return { type: 'applied' };
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      if (!isCurrent(view)) return { type: 'superseded' };
      if (savedFilters) state = { ...state, savedFilters };
      if (isActivity(view.route)) state = { ...state, activity: { ...state.activity, loading: false, error: error.message } };
      if (view.route === 'event') state = { ...state, detailLoading: false };
      onError(error, force);
      return { type: 'failed', error };
    }
  }

  function start(job: RefreshJob) {
    const current = Promise.resolve().then(() => read(job));
    active = { view: job.view, promise: current };
    const finish = () => {
      active = null;
      if (!queued) return;
      const next = queued;
      queued = null;
      start(next).then(next.resolve, next.reject);
    };
    current.then(finish, finish);
    return current;
  }

  return {
    get state() {
      return state;
    },
    get loaded() {
      return loaded;
    },
    capacity: activityData.capacity,
    resetActivity(capacity?: number) {
      activityData.reset(capacity);
      detailResult = null;
      state = { ...state, activity: { items: [], loading: true }, events: [] };
    },
    prepareDetail(id: string | null) {
      // The answer for another detail no longer applies; until this one's arrives, its Activity row stands in.
      const cleared = { ...state, detail: undefined };
      state = { ...cleared, detailLoading: !detailView(cleared, id) };
    },
    load(this: void, { force = false, more = false } = {}) {
      const view = getView();
      if (!active) return start({ view, force, more });
      if (!force && !more && viewKey(active.view) === viewKey(view)) return active.promise;
      const sameQuery = queued && viewKey(queued.view) === viewKey(view);
      queued = {
        ...(queued || Promise.withResolvers()),
        view,
        more: more || Boolean(sameQuery && queued?.more),
        force: force || more || Boolean(sameQuery && queued?.force),
      };
      return queued.promise;
    },
  };
}
