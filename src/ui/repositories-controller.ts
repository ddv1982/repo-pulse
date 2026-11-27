import { createBranchPicker } from './branch-picker.ts';
import { required } from './dom.ts';
import { createHistoryImport } from './history-import.ts';
import { createRepositoryPicker } from './repository-picker.ts';
import type { Actions } from './actions.ts';
import type { CheckoutSnapshot } from './checkout.ts';
import type { MenuManager } from './menus.ts';
import type { Shell } from './shell.ts';

/**
 * The Repositories page: adding checkouts through the picker, enabling and removing watches, the branch picker for a
 * checkout, and importing older history.
 */
export function createRepositoriesController(
  { state, request, load, feedback, commands, confirm }: Shell,
  { menus, checkouts }: { menus: MenuManager; checkouts: () => Record<string, CheckoutSnapshot> },
) {
  const picker = createRepositoryPicker({
    menus,
    request,
    getRepos: () => state().allRepos,
    onAdded: async count => {
      await load({ force: true });
      feedback.toast(`${count} repositories watched.`);
    },
  });
  const branchPicker = createBranchPicker(required('#branch-dialog', HTMLDialogElement), {
    load: async repoId => (await request('GET /api/repos/:id/checkout/branches', { params: { id: repoId } })).branches,
  });
  const historyImport = createHistoryImport(required('#history-dialog', HTMLDialogElement), {
    start: (repoId, days) => request('POST /api/repos/:id/backfill', { params: { id: repoId ?? '' }, body: { days } }),
    onStarted: async id => {
      try {
        await load({ force: true });
        if (document.activeElement === document.body || document.activeElement?.id === `import-${id}`) {
          document.getElementById(`history-${id}`)?.focus({ preventScroll: true });
        }
      } finally {
        feedback.toast('Older activity sync requested.');
      }
    },
    onFollowupError: failure => {
      const detail = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '';
      feedback.showError(`Older activity sync was requested, but its status could not be shown.${detail ? ` ${detail}` : ''}`);
    },
  });
  return {
    picker,
    /** The branch picker belongs to the view that opened it. */
    closeBranchPicker: branchPicker.close,
    actions: {
      ...picker.actions,
      'open-branch-picker': element => {
        const repo = state().enabledRepos.find(item => item.id === element.dataset.repoId);
        const branch = checkouts()[element.dataset.repoId ?? '']?.branch;
        if (repo && branch && !state().demo) void branchPicker.show(repo, branch);
      },
      'open-history-import': element => {
        const repo = state().enabledRepos.find(item => item.id === element.dataset.repoId);
        if (repo) historyImport.show(repo);
      },
      'remove-repo': element => {
        // Remove buttons are rendered from the watched list. A repository removed since the render throws here and the
        // dispatcher reports it.
        const repo = state().allRepos.find(item => item.id === element.dataset.repoId);
        if (!repo) throw new Error('This repository is no longer watched.');
        confirm(
          `Remove ${repo.name} from this app?`,
          'This deletes its local watch and cached history only. The checkout, Azure repository and remote data are unchanged.',
          async () => {
            await request('DELETE /api/repos/:id', { params: { id: repo.id } });
            await load({ force: true });
          },
          'Remove local watch',
          { resource: 'repos' },
        );
      },
      'toggle-repo': control => {
        if (!(control instanceof HTMLInputElement)) return;
        const repo = state().allRepos.find(item => item.id === control.dataset.repoId);
        if (commands.isPending('repos') || !repo) {
          control.checked = !repo?.disabled;
          return;
        }
        const enabled = control.checked;
        void commands.run('repos', async () => {
          try {
            await request('PATCH /api/repos/:id', { params: { id: repo.id }, body: { disabled: !enabled } });
            await load({ force: true });
            feedback.toast(`${repo.name} ${enabled ? 'enabled' : 'disabled'}.`);
          } finally {
            const current = state().allRepos.find(item => item.id === repo.id);
            if (control.isConnected) control.checked = !current?.disabled;
          }
        });
      },
    } satisfies Actions<
      | 'picker-add'
      | 'picker-browse'
      | 'picker-cancel'
      | 'picker-navigate'
      | 'picker-option'
      | 'picker-remove'
      | 'picker-rescan'
      | 'picker-toggle'
      | 'picker-use'
      | 'search-checkouts'
      | 'open-branch-picker'
      | 'open-history-import'
      | 'remove-repo'
      | 'toggle-repo'
    >,
  };
}
