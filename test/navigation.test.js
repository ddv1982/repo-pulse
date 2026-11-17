import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, activityHref, isActivity } from '../src/ui/navigation.js';

test('new/all activity routes and legacy bookmarks map to the intended view', () => {
  assert.equal(parseRoute('#activity/new').route, 'catchup');
  assert.equal(parseRoute('#activity/all').route, 'activity');
  assert.equal(parseRoute('#catchup').route, 'catchup');
  assert.equal(parseRoute('#activity').route, 'activity');
  assert.equal(parseRoute('#activity/unknown').route, 'catchup');
  assert.equal(parseRoute('').route, 'catchup');
  assert.equal(activityHref('catchup'), '#activity/new');
  assert.equal(activityHref('activity'), '#activity/all');
  assert.equal(isActivity('event'), false);
  assert.equal(parseRoute('#repositories').route, 'repositories');
  assert.equal(parseRoute('#rules').route, 'settings');
});

test('detail routes decode source event IDs without treating activity mode as an ID', () => {
  assert.deepEqual(parseRoute('#activity/new'), { route: 'catchup', eventId: null });
  assert.deepEqual(parseRoute('#event/repo%3Abuild%3A1'), { route: 'event', eventId: 'repo:build:1' });
  assert.deepEqual(parseRoute('#event/%invalid'), { route: 'event', eventId: null });
});
