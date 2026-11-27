import type { ClickAction } from './actions.ts';

/** Commands that change the same local data share a resource; every other command is its own. */
const resources: Partial<Record<ClickAction, string>> = {
  'ack-item': 'activity',
  'undo-ack': 'activity',
  'ack-matching': 'activity',
  'reset-activity': 'activity',
  'demo-event': 'activity',
  'switch-activity-branch': 'checkout',
  'switch-checkout-branch': 'checkout',
  'check-checkout': 'checkout',
  'pull-checkout': 'checkout',
  'switch-checkout-target': 'checkout',
  'review-checkout-branch': 'checkout',
  'remove-checkout-branch': 'checkout',
  'carry-checkout-branch': 'checkout',
  'update-filter': 'saved-filters',
  'delete-filter': 'saved-filters',
  'remove-repo': 'repos',
};

/**
 * Commands in flight, by the resource they change. A command is held back only while another command on the same
 * resource runs, so a pending refresh never blocks navigation or a detail view.
 */
export function createCommands({ report, confirmed }: { report: (error: unknown) => void; confirmed: () => string | undefined }) {
  const pending = new Set<string>();

  async function run(resource: string, callback: () => unknown) {
    if (pending.has(resource)) return;
    pending.add(resource);
    try {
      await callback();
    } catch (error) {
      report(error);
    } finally {
      pending.delete(resource);
    }
  }

  return {
    run,
    /** Whether any command runs, so a background render waits. */
    get busy() {
      return pending.size > 0;
    },
    isPending: (resource: string) => pending.has(resource),
    /** The resource a named action changes; a confirmation runs under the resource of the command that asked for it. */
    resourceOf(name: ClickAction) {
      if (name === 'confirm-dialog') return confirmed() ?? name;
      return resources[name] ?? name;
    },
    /**
     * Runs a dialog's submission under a resource, so it cannot overlap a command on the same resource. A busy resource
     * throws, and the dialog shows the message.
     */
    holding<T extends unknown[]>(resource: string, message: string, callback: (...args: T) => Promise<void>) {
      return async (...args: T) => {
        if (pending.has(resource)) throw new Error(message);
        pending.add(resource);
        try {
          await callback(...args);
        } finally {
          pending.delete(resource);
        }
      };
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;
