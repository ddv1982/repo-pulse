import { createActivityData, activityEvents } from './activity-data.ts';
import { isActivity } from './navigation.ts';
import type { ActivityEvent, ActivityPage } from '../activity.ts';
import type { ActivityView } from './activity-data.ts';
import type { StateResponse, EventResponse } from '../contract.d.ts';

export type View = ActivityView & { eventId: string | null; relatedCi?: boolean | undefined; generation: number };

export type Repo = StateResponse['repos'][number];

export type Metadata = Partial<Omit<StateResponse, 'settings' | 'diagnostics'>> & {
  watched?: Repo[];
  settings?: Partial<StateResponse['settings']>;
  diagnostics?: Partial<StateResponse['diagnostics']>;
};

/** Before the first page arrives only `items` and `loading` are set. */
export type DisplayActivity = Pick<ActivityPage, 'items'> & Partial<Omit<ActivityPage, 'items'>> & { loading?: boolean; error?: string };

export type PageState = Omit<Metadata, 'syncStatus'> & {
  repos: Repo[];
  watched: Repo[];
  streams: StateResponse['streams'];
  settings: Partial<StateResponse['settings']>;
  diagnostics: Partial<StateResponse['diagnostics']>;
  syncStatus: PageSyncStatus;
  activity: DisplayActivity;
  events: ActivityEvent[];
  detailLoading?: boolean;
  detailRelated?: ActivityEvent[] | undefined;
};

export type PageSyncStatus = { overall: import('./health.ts').ShownSyncStatus; repos: StateResponse['syncStatus']['repos'] };

export type RefreshJob = { view: View; force: boolean; more: boolean };

export type RefreshOutcome = { type: 'applied' | 'superseded' } | { type: 'failed'; error: Error };

const noSyncStatus: PageSyncStatus = { overall: { state: 'unavailable' }, repos: {} };

function readMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Local state is unreadable.');
  // Relies on the /api/state response contract; the runtime checks cover the top-level object, repository IDs and the activity revision.
  const data = value as Metadata;
  if (data.repos !== undefined && (!Array.isArray(data.repos) || data.repos.some(repo => typeof repo?.id !== 'string'))) {
    throw new Error('Local repository data is unreadable.');
  }
  if (data.activityRevision !== undefined && typeof data.activityRevision !== 'string') {
    throw new Error('The local Activity revision is unreadable.');
  }
  // Disabled repositories stay manageable on Repositories but leave every other view.
  const watched = data.repos || [];
  const repos = watched.filter(repo => !repo.disabled);
  const streams = (data.streams || []).filter(stream => repos.some(repo => repo.id === stream.repoId));
  const syncStatus = data.syncStatus || noSyncStatus;
  return { ...data, watched, repos, streams, settings: data.settings || {}, diagnostics: data.diagnostics || {}, syncStatus };
}

const viewKey = ({ route, eventId, repoIds, search, kind, unreadOnly, generation }: View) =>
  JSON.stringify([route, eventId, repoIds, search, kind, unreadOnly, generation]);

export function createRefreshController({
  request,
  getView,
  reconcileRepositories,
  onUpdate,
  onError,
}: {
  request: typeof import('../api.ts').request;
  getView: () => View;
  reconcileRepositories: (repos: Repo[]) => void;
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
    settings: {},
    diagnostics: {},
    syncStatus: noSyncStatus,
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
    let savedFilters;
    try {
      const payload = await request('/api/state');
      if (!isCurrent(view)) return { type: 'superseded' };
      const next: PageState = { ...readMetadata(payload), activity: state.activity, events: state.events };
      savedFilters = next.savedFilters;
      const metadata = JSON.stringify(payload);
      reconcileRepositories(next.watched);
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
        if (!cached) next.events = activityEvents(state.activity, detail);
        next.detailRelated = detail.related;
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
      state = { ...state, detailRelated: undefined, detailLoading: !state.events.some(event => event.id === id) };
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
