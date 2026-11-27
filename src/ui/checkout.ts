import { checkAge, renderCheckout } from './checkout-render.ts';
import { setHtml } from './dom.ts';
import type { CheckoutStatus, BlockedCheckout, Review, FollowupSummary } from '../contract.d.ts';

export type { CheckoutStatus, BlockedCheckout, Review, FollowupSummary };

/**
 * One repository's checkout as this page reads it. Every /api/checkouts entry fits: the server adds `followup`
 * when a branch follow-up is open, and the page keeps the `review` and `nextStep` a branch action returned, and the
 * review commits a person ticked (`carry`).
 */
export type CheckoutSnapshot = {
  state: CheckoutStatus['state'];
  canPull?: boolean;
  followup?: FollowupSummary;
  review?: Review | undefined;
  carry?: string[] | undefined;
  nextStep?: string | undefined;
} & Partial<Omit<BlockedCheckout, 'state' | 'canPull'>>;
export type CheckoutUpdate = {
  checkout: CheckoutSnapshot;
  updated?: boolean;
  message?: string | undefined;
  notice?: string | undefined;
  switchReview?: import('../contract.d.ts').ActivitySwitchReview | undefined;
  review?: Review | undefined;
  nextStep?: string | undefined;
};
export type CheckoutOperation = 'check' | 'pull' | 'switch-activity' | 'switch-branch' | 'switch-update' | 'review' | 'remove' | 'carry';

export function createCheckoutPanel({
  page,
  request,
  isVisible,
  onChange,
  onMutation,
}: {
  page: HTMLElement;
  request: typeof import('../api.ts').request;
  isVisible: () => boolean;
  onChange: (before: Record<string, CheckoutSnapshot>) => void;
  onMutation: (id: string) => void;
}) {
  let snapshots: Record<string, CheckoutSnapshot> = {};
  const singleReads = new Map<string, symbol>();
  let reading = false,
    mutating = false,
    generation = 0,
    refreshGeneration = 0;

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
      checkout.carry = previous.carry;
    }
    if (previous?.nextStep && previous.branch === checkout.branch && previous.head === checkout.head) {
      checkout.nextStep = previous.nextStep;
    }
    return checkout;
  }

  function publish(next: Record<string, CheckoutSnapshot>) {
    const before = snapshots;
    snapshots = next;
    onChange(before);
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

  // Ticked review commits live on the snapshot, so a render after a poll keeps them.
  page.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'checkout-commit') return;
    const checkout = snapshots[input.dataset.id ?? ''];
    if (!checkout?.review) return;
    const carry = new Set(checkout.carry);
    if (input.checked) carry.add(input.value);
    else carry.delete(input.value);
    checkout.carry = [...carry];
  });

  return {
    get snapshots() {
      return snapshots;
    },
    async read(id: string, fresh = false): Promise<CheckoutSnapshot> {
      const issued = generation;
      refreshGeneration++;
      const read = Symbol(id);
      singleReads.set(id, read);
      const path = `/api/repos/${encodeURIComponent(id)}/checkout/status` as const;
      const checkout = await request(fresh ? `${path}?fresh=1` : path).catch(() => ({ state: 'unavailable' as const }));
      if (singleReads.get(id) === read) {
        singleReads.delete(id);
        if (!mutating && issued === generation) publish({ ...snapshots, [id]: retainLocalState(id, checkout) });
      }
      return checkout;
    },
    async refresh() {
      if (!isVisible() || reading || mutating) return;
      const issued = generation;
      const issuedRefresh = refreshGeneration;
      const current = () => isVisible() && !mutating && issued === generation && issuedRefresh === refreshGeneration;
      reading = true;
      try {
        const next: Record<string, CheckoutSnapshot> = await request('/api/checkouts');
        if (current()) {
          for (const [id, checkout] of Object.entries(next)) retainLocalState(id, checkout);
          publish(next);
        }
      } catch {
        if (current())
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
        generation++;
        mutating = false;
        if (operation !== 'review') onMutation(id);
      }
    },
  };
}
