import test from 'node:test';
import assert from 'node:assert/strict';
import { syncLabel } from '../src/ui/health.ts';

test('a throttling delay keeps the Azure DevOps name capitalised in the pill', () => {
  assert.equal(
    syncLabel({ state: 'delayed', reason: 'Azure DevOps asked us to slow down' }),
    'Delayed · Azure DevOps asked us to slow down',
  );
  assert.equal(syncLabel({ state: 'delayed', reason: 'Checks are behind schedule' }), 'Delayed · checks are behind schedule');
});
