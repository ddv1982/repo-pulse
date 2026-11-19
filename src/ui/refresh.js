// @ts-check

import { createActivityData, activityEvents } from './activity-data.js';
import { isActivity } from './navigation.js';

/**
 * @typedef {import('../activity.js').ActivityEvent} ActivityEvent
 * @typedef {import('../activity.js').ActivityPage} ActivityPage
 * @typedef {import('./activity-data.js').EventDetail} EventDetail
 * @typedef {import('./activity-data.js').ActivityView & {eventId: string|null, generation: number}} View
 * @typedef {import('../api.js').StateResponse} StateResponse
 * @typedef {typeof import('../api.js').request} Request
 * @typedef {StateResponse['repos'][number]} Repo
 * @typedef {Partial<Omit<StateResponse, 'settings' | 'diagnostics'>> & { watched?: Repo[],
 *   settings?: Partial<StateResponse['settings']>, diagnostics?: Partial<StateResponse['diagnostics']> }} Metadata
 * @typedef {Pick<ActivityPage, 'items'> & Partial<Omit<ActivityPage, 'items'>> & { loading?: boolean, error?: string }} DisplayActivity
 *   Before the first page arrives only `items` and `loading` are set.
 * @typedef {Omit<Metadata, 'syncStatus'> & {repos: Repo[], watched: Repo[], streams: StateResponse['streams'], settings: Partial<StateResponse['settings']>,
 *   diagnostics: Partial<StateResponse['diagnostics']>, syncStatus: PageSyncStatus, activity: DisplayActivity,
 *   events: ActivityEvent[], detailLoading?: boolean}} PageState
 * @typedef {{ overall: import('./health.js').ShownSyncStatus, repos: StateResponse['syncStatus']['repos'] }} PageSyncStatus
 * @typedef {{ view: View, force: boolean, more: boolean }} RefreshJob
 * @typedef {{ type: 'applied'|'superseded' } | { type: 'failed', error: Error }} RefreshOutcome
 */

/** @type {PageSyncStatus} */
const noSyncStatus = { overall: { state: 'unavailable' }, repos: {} };

/** @param {unknown} value */
function readMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Local state is unreadable.');
  // Relies on the /api/state response contract; the runtime checks cover the top-level object, repository IDs and the activity revision.
  const data = /** @type {Metadata} */ (value);
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

/** @param {View} view */
const viewKey = ({ route, eventId, repoIds, search, people, kind, generation }) =>
  JSON.stringify([route, eventId, repoIds, search, people, kind, generation]);

/**
 * @param {{
 *   request: Request,
 *   getView: () => View, reconcileRepositories: (repos: Repo[]) => void,
 *   onUpdate: (event: {metadata: string, force: boolean}) => void, onError: (error: Error, force: boolean) => void
 * }} options
 */
export function createRefreshController({ request, getView, reconcileRepositories, onUpdate, onError }) {
  const activityData = createActivityData(request);
  /** @type {PageState} */
  let state = {
    repos: [],
    watched: [],
    activity: { items: [], loading: true },
    events: [],
    streams: [],
    settings: {},
    diagnostics: {},
    syncStatus: noSyncStatus,
  };
  /** @type {EventDetail|null|undefined} */
  let detailResult;
  /** @type {string|undefined} */
  let detailRevision;
  /** @type {{view: View, promise: Promise<RefreshOutcome>}|null|undefined} */
  let active;
  /** @type {(RefreshJob & PromiseWithResolvers<RefreshOutcome>) | null | undefined} */
  let queued;
  /** @param {View} view */
  const isCurrent = view => viewKey(view) === viewKey(getView());

  /** @param {RefreshJob} job @returns {Promise<RefreshOutcome>} */
  async function read({ view, force, more }) {
    if (!isCurrent(view)) return { type: 'superseded' };
    let savedFilters;
    try {
      const payload = await request('/api/state');
      if (!isCurrent(view)) return { type: 'superseded' };
      /** @type {PageState} */
      const next = { ...readMetadata(payload), activity: state.activity, events: state.events };
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
        const cached = !force && detailResult?.event?.id === view.eventId && detailRevision === next.activityRevision;
        const detail = cached ? detailResult : await activityData.event(view.eventId);
        if (!detail) throw new Error('Activity details are unavailable.');
        if (!isCurrent(view)) return { type: 'superseded' };
        detailResult = detail;
        detailRevision = next.activityRevision;
        if (!cached) next.events = activityEvents(state.activity, detail);
        next.detailLoading = false;
      }

      state = next;
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

  /** @param {RefreshJob} job */
  function start(job) {
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
    capacity: activityData.capacity,
    /** @param {number} [capacity] */
    resetActivity(capacity) {
      activityData.reset(capacity);
      detailResult = null;
      state = { ...state, activity: { items: [], loading: true }, events: [] };
    },
    /** @param {string|null} id */
    prepareDetail(id) {
      state = { ...state, detailLoading: !state.events.some(event => event.id === id) };
    },
    load({ force = false, more = false } = {}) {
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
