import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, activityHref, isActivity } from '../src/ui/navigation.ts';

test('Activity defaults to all history and preserves legacy unread bookmarks', () => {
  for (const hash of ['', '#activity', '#activity/all', '#activity/unknown']) {
    assert.deepEqual(parseRoute(hash), { route: 'activity', eventId: null, unreadOnly: false });
  }
  for (const hash of ['#activity/new', '#catchup', '#activity/unread']) {
    assert.deepEqual(parseRoute(hash), { route: 'activity', eventId: null, unreadOnly: true });
  }
  assert.equal(activityHref(true), '#activity/unread');
  assert.equal(activityHref(false), '#activity');
  assert.equal(isActivity('event'), false);
  assert.equal(parseRoute('#repositories').route, 'repositories');
  assert.equal(parseRoute('#rules').route, 'settings');
});

test('detail routes decode source event IDs without treating activity mode as an ID', () => {
  assert.deepEqual(parseRoute('#event/repo%3Abuild%3A1'), { route: 'event', eventId: 'repo:build:1' });
  assert.deepEqual(parseRoute('#event/%invalid'), { route: 'event', eventId: null });
});
