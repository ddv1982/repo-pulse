import { activityBranch } from '../activity-branch.ts';
import { detailView, type CommitsView, type LoadedView } from './activity-detail.ts';
import { checked } from './dom.ts';
import { activityHref, isActivity } from './navigation.ts';
import { eventIds } from './seen-actions.ts';
import type { Actions } from './actions.ts';
import type { ActivityCheckout } from './checkout-actions.ts';
import type { Shell } from './shell.ts';

/**
 * An Activity detail: the push commits and review data loaded on request, which also serve the commits a feed row
 * loads inline, the related CI section a `/ci` address opens, and the local checkout of the detail's branch.
 */
export function createDetailController(
  { ui, page, state, request, renderPage, navigation, feedback }: Shell,
  currentView: () => () => boolean,
) {
  /** Data each detail page loaded on request, by event. */
  const loaded = new Map<string | null, LoadedView>();
  /** Push commits a feed row loaded inline, by event. */
  const feedCommits = new Map<string, CommitsView>();
  let focusRelatedCi = false;

  return {
    feedCommits,
    /** What the detail shown now loaded on request. */
    loaded: () => loaded.get(ui.eventId),
    /** The page entered `destination`; a detail opened at its related CI focuses that section once it renders. */
    enter(destination: import('./navigation.ts').Route) {
      focusRelatedCi = destination === 'event' && Boolean(ui.relatedCi);
    },
    /** After a render: move focus to the related CI section the address asked for, once it is on the page. */
    revealRelatedCi() {
      if (!focusRelatedCi || ui.route !== 'event') return;
      const summary = checked(page.querySelector('.detail-related > summary'), HTMLElement, '.detail-related > summary');
      if (!summary) return;
      focusRelatedCi = false;
      summary.scrollIntoView({ block: 'start' });
      summary.focus({ preventScroll: true });
    },
    /** The linked checkout of the shown detail's branch, outside demo mode. */
    activityCheckout(this: void): ActivityCheckout | null {
      if (ui.route !== 'event' || state().demo) return null;
      const event = detailView(state(), ui.eventId)?.event;
      const repo = event && state().enabledRepos.find(repo => repo.id === event.repoId);
      const branch = event && activityBranch(event);
      if (!event || !repo?.localPath || !branch) return null;
      return { repoId: repo.id, localPath: repo.localPath, eventId: event.id, branch, isCurrent: currentView() };
    },
    /** Starting from scratch deletes the activity the inline commits belong to. */
    forgetCommits() {
      feedCommits.clear();
    },
    actions: {
      detail: element => {
        // Detail buttons always carry data-event-id, so the fallbacks never apply.
        const row = element.closest('li[data-event-id]');
        const matchingIds = (ui.search || ui.activityFilter) && row instanceof HTMLElement ? eventIds(row) : undefined;
        navigation.remember(element.dataset.eventId ?? null, matchingIds);
        location.hash = `event/${encodeURIComponent(element.dataset.eventId ?? '')}${element.hasAttribute('data-related') ? '/ci' : ''}`;
      },
      'back-to-graph': () => history.back(),
      'back-to-results': () => {
        location.hash = activityHref(navigation.returnUnseenOnly);
      },
      'copy-commit': async element => {
        try {
          await navigator.clipboard.writeText(element.dataset.value || '');
          feedback.toast('Commit copied.');
        } catch {
          feedback.toast('Copy unavailable in this browser. Open Azure DevOps to copy the full commit.');
        }
      },
      'load-review': async element => {
        const { eventId } = ui;
        try {
          loaded.set(
            eventId,
            await request('GET /api/repos/:id/prs/:prId/review', {
              params: { id: element.dataset.repoId ?? '', prId: element.dataset.prId ?? '' },
            }),
          );
        } catch (error) {
          loaded.set(eventId, { error: error instanceof Error ? error.message : String(error) });
        }
        if (ui.route === 'event' && ui.eventId === eventId) renderPage();
      },
      'load-commits': async element => {
        const inlineId = element.dataset.inlineId;
        const eventId = inlineId ?? ui.eventId;
        element.setAttribute('aria-busy', 'true');
        let commits: CommitsView;
        try {
          commits = await request('GET /api/repos/:id/pushes/:pushId/commits', {
            params: { id: element.dataset.repoId ?? '', pushId: element.dataset.pushId ?? '' },
          });
        } catch (error) {
          commits = { error: error instanceof Error ? error.message : String(error) };
        }
        // A feed row keeps its commits apart from the detail page's.
        if (inlineId) feedCommits.set(inlineId, commits);
        else loaded.set(eventId, commits);
        if ((inlineId && isActivity(ui.route)) || (ui.route === 'event' && ui.eventId === eventId)) renderPage();
      },
    } satisfies Actions<'detail' | 'back-to-graph' | 'back-to-results' | 'copy-commit' | 'load-review' | 'load-commits'>,
  };
}
