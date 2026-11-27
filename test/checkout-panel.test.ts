import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutPanel, type CheckoutSnapshot } from '../src/ui/checkout.ts';
import { fakeRequest, stub } from './fixtures/typed.ts';

test('an older checkout poll cannot overwrite a fresh reading', async () => {
  const poll = Promise.withResolvers<Record<string, CheckoutSnapshot>>();
  const panel = createCheckoutPanel({
    page: stub<HTMLElement>({
      addEventListener: () => {},
      querySelectorAll: () => stub<NodeListOf<Element>>({ [Symbol.iterator]: [][Symbol.iterator].bind([]) }),
    }),
    request: fakeRequest(async path => {
      if (path === '/api/checkouts') return poll.promise;
      assert.equal(path, '/api/repos/repo/checkout/status?fresh=1');
      return { state: 'current', branch: 'topic' };
    }),
    isVisible: () => true,
    groups: new Map(),
    onChange: () => {},
    onMutation: () => {},
  });
  const pending = panel.refresh();
  await panel.read('repo', true);
  poll.resolve({ repo: { state: 'current', branch: 'main' } });
  await pending;
  assert.equal(panel.snapshots.repo?.branch, 'topic');
});
