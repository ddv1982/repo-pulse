import { html } from './format.ts';

/**
 * Every action a control can name in `data-action`, by the event that runs it. Markup names an action through
 * `action()`, so a name missing from this list fails the type check; the dispatcher's table must handle every name.
 */
const ACTIONS = {
  click: [
    'ack-item',
    'ack-matching',
    'all-repos',
    'apply-saved-filter',
    'back-to-graph',
    'back-to-results',
    'carry-checkout-branch',
    'check-checkout',
    'check-connection',
    'choose-activity-type',
    'clear-filters',
    'clear-graph-search',
    'confirm-dialog',
    'copy-azure-login',
    'copy-commit',
    'copy-diagnostics',
    'delete-filter',
    'demo-event',
    'detach-filter',
    'detail',
    'dismiss-error',
    'filter-activity-type',
    'load-commits',
    'load-more-activity',
    'load-review',
    'more-graph',
    'next-graph-match',
    'no-repos',
    'open-branch-picker',
    'open-history-import',
    'picker-add',
    'picker-browse',
    'picker-cancel',
    'picker-navigate',
    'picker-option',
    'picker-remove',
    'picker-rescan',
    'picker-toggle',
    'picker-use',
    'previous-graph-match',
    'pull-checkout',
    'refresh',
    'reload-graph',
    'remove-checkout-branch',
    'remove-repo',
    'rename-filter',
    'reset-activity',
    'restore-filter',
    'retry-activity',
    'review-checkout-branch',
    'save-filter',
    'set-theme',
    'switch-activity-branch',
    'switch-checkout-branch',
    'switch-checkout-target',
    'toggle-activity-filters',
    'toggle-group',
    'toggle-header-menu',
    'toggle-unread',
    'undo-ack',
    'update-filter',
  ],
  change: ['choose-carry-commit', 'choose-connection-repo', 'choose-graph-repo', 'scope-repo', 'toggle-automatic-checks', 'toggle-repo'],
  input: ['search-activity', 'search-checkouts', 'search-graph'],
} as const;

type ActionEvent = keyof typeof ACTIONS;
export type ClickAction = (typeof ACTIONS)['click'][number];
export type ActionName = (typeof ACTIONS)[ActionEvent][number];

const eventOf = new Map<string, ActionEvent>(
  Object.entries(ACTIONS).flatMap(([type, names]) => names.map(name => [name, type as ActionEvent] as const)),
);

export const isActionName = (name: string): name is ActionName => eventOf.has(name);
const isClickAction = (name: ActionName): name is ClickAction => eventOf.get(name) === 'click';

/** The `data-action` attribute that names an action. */
export const action = (name: ActionName) => html`data-action="${name}"`;

/** Runs an action for the control that names it. */
export type Action = (element: HTMLElement, event: Event) => unknown;
/** The handlers of a set of actions, one for each name. */
export type Actions<N extends ActionName> = { [K in N]: Action };

const unknown = (name: string) => new Error(`Repo Pulse: unknown action ${JSON.stringify(name)}`);

/**
 * One delegated listener for each event type, registered once. A click on a control or inside it runs its click action
 * through `run`, which holds a command back while another on the same resource runs; an input or change event runs the
 * action the control itself names. A name the list does not know is broken markup, reported instead of ignored.
 */
export function createDispatcher({
  actions,
  run,
  report,
}: {
  actions: Actions<ActionName>;
  run: (name: ClickAction, callback: () => unknown) => void;
  report: (error: Error) => void;
}) {
  document.addEventListener('click', event => {
    const element = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!(element instanceof HTMLElement)) return;
    const name = element.dataset.action ?? '';
    if (!isActionName(name)) {
      event.preventDefault();
      return report(unknown(name));
    }
    // A switch or a search box names the action of its own event; a click on it keeps its default.
    if (!isClickAction(name)) return;
    // A disabled control does nothing, even when its click reaches the document.
    if (element.matches(':disabled')) return;
    event.preventDefault();
    run(name, () => actions[name](element, event));
  });
  for (const type of ['input', 'change'] as const) {
    document.addEventListener(type, event => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || element.dataset.action === undefined) return;
      const name = element.dataset.action;
      if (!isActionName(name)) return report(unknown(name));
      if (eventOf.get(name) !== type) return;
      try {
        const result = actions[name](element, event);
        if (result instanceof Promise) result.catch((error: unknown) => report(error instanceof Error ? error : new Error(String(error))));
      } catch (error) {
        report(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
