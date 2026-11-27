import type { Actions } from './actions.ts';
import type { createConnectionController } from './connection.ts';
import type { Shell } from './shell.ts';

/**
 * Settings: automatic checks (also switched from the header), the Azure connection checks (also run from
 * Repositories), copying diagnostics, and starting from scratch.
 */
export function createSettingsController(
  { state, request, load, renderPage, feedback, commands, confirm }: Shell,
  { connection, onReset }: { connection: ReturnType<typeof createConnectionController>; onReset: () => void },
) {
  return {
    'toggle-automatic-checks': control => {
      if (!(control instanceof HTMLInputElement)) return;
      const checked = control.checked;
      if (commands.isPending('settings')) {
        control.checked = state().settings.refreshEnabled;
        return;
      }
      void commands.run('settings', async () => {
        try {
          await request('PATCH /api/settings', { body: { refreshEnabled: checked } });
          await load({ force: true });
        } finally {
          for (const toggle of document.querySelectorAll('[data-action="toggle-automatic-checks"]')) {
            if (toggle instanceof HTMLInputElement) toggle.checked = state().settings.refreshEnabled;
          }
        }
      });
    },
    'check-connection': element => {
      void connection.check(element.dataset.repoId || '', { force: true });
    },
    'choose-connection-repo': element => {
      if (!(element instanceof HTMLSelectElement)) return;
      connection.select(element.value);
      renderPage();
    },
    'copy-diagnostics': async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(state().diagnostics, null, 2));
        feedback.toast('Diagnostics copied.');
      } catch {
        feedback.toast('Copy is unavailable in this browser.');
      }
    },
    'reset-activity': () => {
      confirm(
        'Start from scratch?',
        'This deletes all stored activity, seen marks and imported history on this computer, then imports the last seven days from Azure DevOps again. Older history can be imported from Repositories. Your repositories, linked checkouts and settings stay.',
        async () => {
          await request('POST /api/reset', { body: {} });
          // The activity Undo would restore is being deleted.
          onReset();
          await load({ force: true });
          feedback.toast('Starting from scratch. Stored activity is being deleted, then the last seven days are imported.');
        },
        'Delete and import again',
        { destructive: true, resource: 'activity' },
      );
    },
  } satisfies Actions<'toggle-automatic-checks' | 'check-connection' | 'choose-connection-repo' | 'copy-diagnostics' | 'reset-activity'>;
}
