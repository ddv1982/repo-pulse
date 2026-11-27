// Helpers that keep tests strictly typed without `any`. A test passes the code under test stand-ins with only the
// members that code uses; the type checks each supplied member against the real one, so a stand-in cannot drift from
// the real signature, while the members left out need no placeholder.
import assert from 'node:assert/strict';
import type { request } from '../../src/api.ts';
import type { AzureRepo, Repository, RouteKey } from '../../src/contract.ts';
import { routeUrl, type RouteTarget } from '../../src/route-url.ts';

/**
 * A T built from the members a test supplies, like the object literal it replaces. Calling a member left out throws;
 * reading one gives undefined, which the code under test may treat as absent. A member supplied as undefined reads the
 * same as one left out.
 */
export function stub<T>(members: { [K in keyof T]?: T[K] | undefined }): T {
  return members as T;
}

/**
 * src/api.ts `request` answered by the test, with partial responses and sometimes synchronously: its callers await
 * the answer either way, and an answer stays synchronous so a test's timing does not change.
 */
export function fakeRequest(answer: (path: string) => unknown) {
  return ((route: RouteKey, target?: RouteTarget) => answer(routeUrl(route, target).url)) as typeof request;
}

/** The value, after failing the test if it is null or undefined. */
export function present<T>(value: T | null | undefined, what = 'the value'): T {
  if (value == null) assert.fail(`${what} is missing`);
  return value;
}

/** An event's data, after failing the test if the event or its data is missing. */
export function dataOf<T>(event: { data?: T } | null | undefined): T {
  return present(present(event, 'the event').data, 'its data');
}

/** The fields of a stored JSON value, after failing the test if it is not an object. */
export function fieldsOf(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, 'expected an object');
  return value as Record<string, unknown>;
}

/**
 * The ID of the repository the app passes to a provider method. The method is typed with the Azure fields only; the
 * app passes the watched repository, which carries its ID.
 */
export const watchedIdOf = (repo: AzureRepo | undefined) => (repo as Repository | undefined)?.id;

/** What a rejection or throw check reads from the error it is given; a check whose property is missing fails. */
export type Thrown = Error & { code?: string; status?: number };

/**
 * A handle for a fake setTimer to return. The code under test only checks that it holds one and passes it back to
 * clearTimer, which the fakes do not need.
 */
export const fakeTimer = () => stub<NodeJS.Timeout>({});
