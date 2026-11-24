import { checkAge, renderCheckout } from './checkout-render.ts';
import { setHtml } from './dom.ts';
import type { CheckoutStatus, BlockedCheckout, Review, FollowupSummary } from '../contract.ts';

export type { CheckoutStatus, BlockedCheckout, Review, FollowupSummary };

/**
 * One repository's checkout as this page reads it. Every /api/checkouts entry fits: the server adds `followup`
 * when a branch follow-up is open, and the page keeps the `review` and `nextStep` a branch action returned.
 */
export type CheckoutSnapshot = {
  state: CheckoutStatus['state'];
  canPull?: boolean;
  followup?: FollowupSummary;
  review?: Review | undefined;
  nextStep?: string | undefined;
} & Partial<Omit<BlockedCheckout, 'state' | 'canPull'>>;
export type CheckoutUpdate = {
  checkout: CheckoutSnapshot;
  updated?: boolean;
  message?: string | undefined;
  notice?: string | undefined;
  switchReview?: import('../contract.ts').ActivitySwitchReview | undefined;
  review?: Review | undefined;
  nextStep?: string | undefined;
};
export type CheckoutOperation = 'check' | 'pull' | 'switch-activity' | 'switch-branch' | 'switch-update' | 'review' | 'remove' | 'carry';

export function createCheckoutPanel({
  page,
  request,
  isVisible,
}: {
  page: HTMLElement;
  request: typeof import('../api.ts').request;
  isVisible: () => boolean;
}) {
  let snapshots: Record<string, CheckoutSnapshot> = {};
  let reading = false,
    mutating = false,
    generation = 0;

  function retainLocalState(id: string, checkout: CheckoutSnapshot) {
    const previous = snapshots[id];
    if (
      previous?.review &&
      previous.followup?.id === checkout.followup?.id &&
      previous.head === checkout.head &&
      previous.state === checkout.state &&
      previous.dirty === checkout.dirty
    ) {
      checkout.review = previous.review;
    }
    if (previous?.nextStep && previous.branch === checkout.branch && previous.head === checkout.head) {
      checkout.nextStep = previous.nextStep;
    }
    return checkout;
  }

  function publish(next: Record<string, CheckoutSnapshot>) {
    const before = snapshots;
    snapshots = next;
    if (!isVisible()) return;
    for (const target of page.querySelectorAll('[data-checkout-part]')) {
      if (!(target instanceof HTMLElement)) continue;
      const { checkoutId = '', checkoutPart } = target.dataset;
      if (JSON.stringify(before[checkoutId]) === JSON.stringify(next[checkoutId])) {
        const time = target.querySelector('[data-branch-check-time]');
        if (time instanceof HTMLTimeElement) {
          const label = checkAge(time.dateTime);
          if (time.textContent !== label) time.textContent = label;
        }
        continue;
      }
      const focused = document.activeElement;
      const focusedId = focused && target.contains(focused) ? focused.id : '';
      const options = target.querySelector('.checkout-update-options');
      const updateOptionsOpen = options instanceof HTMLDetailsElement && options.open;
      setHtml(target, renderCheckout(checkoutId, next[checkoutId], checkoutPart));
      if (updateOptionsOpen) target.querySelector('.checkout-update-options')?.setAttribute('open', '');
      if (focusedId) {
        const replacement =
          document.getElementById(focusedId) ||
          (target.hidden || !target.textContent.trim() ? target.closest('article')?.querySelector('[data-checkout-part=status]') : target);
        if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      }
    }
  }

  return {
    get snapshots() {
      return snapshots;
    },
    async read(id: string): Promise<CheckoutSnapshot> {
      const issued = generation;
      const checkout = await request(`/api/repos/${encodeURIComponent(id)}/checkout/status`);
      if (!mutating && issued === generation) publish({ ...snapshots, [id]: retainLocalState(id, checkout) });
      return checkout;
    },
    async refresh() {
      if (!isVisible() || reading || mutating) return;
      const issued = generation;
      reading = true;
      try {
        const next: Record<string, CheckoutSnapshot> = await request('/api/checkouts');
        if (!mutating && issued === generation) {
          for (const [id, checkout] of Object.entries(next)) retainLocalState(id, checkout);
          publish(next);
        }
      } catch {
        if (!mutating && issued === generation)
          publish(
            Object.fromEntries(
              [...page.querySelectorAll('[data-checkout-part="status"]')]
                .filter(element => element instanceof HTMLElement)
                .map(element => [element.dataset.checkoutId ?? '', { state: 'unavailable' as const }]),
            ),
          );
      } finally {
        reading = false;
      }
    },
    async update(
      id: string,
      operation: CheckoutOperation,
      // Sent as JSON, which leaves out a field holding undefined.
      expected: { [K in 'branch' | 'head' | 'upstream' | 'identity' | 'switchIdentity']?: CheckoutSnapshot[K] | undefined },
      options: Record<string, unknown> = {},
    ): Promise<CheckoutUpdate> {
      mutating = true;
      generation++;
      try {
        const result: CheckoutUpdate = await request(`/api/repos/${encodeURIComponent(id)}/checkout`, {
          method: 'POST',
          body: { ...options, operation, expected },
        });
        publish({
          ...snapshots,
          [id]: {
            ...result.checkout,
            review: result.review ?? (result.nextStep ? snapshots[id]?.review : undefined),
            nextStep: result.nextStep,
          },
        });
        return result;
      } finally {
        mutating = false;
      }
    },
  };
}
