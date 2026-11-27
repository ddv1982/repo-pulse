import { required } from './dom.ts';
import type { Actions } from './actions.ts';
import type { Shell } from './shell.ts';

/**
 * The header's controls, which every page shows: refresh, automatic checks (in Settings too), the theme, and the
 * phone check menu, plus the commands Activity banners offer: copying `az login` and the demo's incoming event.
 */
export function createHeaderActions(
  { ui, request, load, feedback }: Shell,
  { header, renderHeader }: { header: HTMLElement; renderHeader: () => void },
) {
  function setMenu(open: boolean) {
    ui.headerMenuOpen = open;
    renderHeader();
  }

  function setRefreshPending(pending: boolean) {
    ui.refreshing = pending;
    for (const button of header.querySelectorAll('[data-action="refresh"]')) {
      if (!(button instanceof HTMLElement)) continue;
      button.setAttribute('aria-busy', String(pending));
      button.setAttribute('aria-disabled', String(pending));
      // The header renders data-idle-title on every refresh button, so the fallback never applies.
      button.title = pending ? 'Refreshing activity…' : (button.dataset.idleTitle ?? '');
    }
  }

  // The phone check menu closes on a click anywhere outside it, and on Escape inside it, which returns focus to it.
  // The click closes it without rendering the header: a render during the click would reset a switch the click just
  // toggled before its change event reads it.
  document.addEventListener('click', event => {
    if (!ui.headerMenuOpen || !(event.target instanceof Element) || event.target.closest('.header-overflow')) return;
    ui.headerMenuOpen = false;
    required('.header-overflow', HTMLDetailsElement, header).open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !ui.headerMenuOpen || !document.activeElement?.closest('.header-overflow')) return;
    setMenu(false);
    required('.header-overflow > summary', HTMLElement, header).focus();
  });

  return {
    'toggle-header-menu': () => setMenu(!ui.headerMenuOpen),
    refresh: async element => {
      setRefreshPending(true);
      try {
        const retrySignIn = element.hasAttribute('data-retry-sign-in');
        const { status } = await request('POST /api/refresh', {
          body: { ...(ui.repoIds === null ? {} : { repoIds: ui.repoIds }), ...(retrySignIn ? { retrySignIn: true } : {}) },
        });
        feedback.toast(
          status.scheduled
            ? 'Activity refresh queued.'
            : status.cooldown
              ? 'A refresh was requested recently. Try again shortly.'
              : retrySignIn
                ? 'No sign-in checks need retrying.'
                : 'No enabled repositories are selected.',
        );
        await load({ force: true });
      } finally {
        setRefreshPending(false);
      }
    },
    'set-theme': element => {
      // web/theme.ts defines repoPulseTheme on window before this module loads; the optional call covers its absence.
      window.repoPulseTheme?.set(element.dataset.theme ?? '');
    },
    'copy-azure-login': async () => {
      try {
        await navigator.clipboard.writeText('az login');
        feedback.toast('Command copied.');
      } catch {
        feedback.toast('Copy is unavailable in this browser. Select the command to copy it manually.');
      }
    },
    'demo-event': async () => {
      await request('POST /api/demo/event', { body: {} });
      await load({ force: true });
      feedback.toast('Fictional incoming hotfix added.');
    },
  } satisfies Actions<'toggle-header-menu' | 'refresh' | 'set-theme' | 'copy-azure-login' | 'demo-event'>;
}
