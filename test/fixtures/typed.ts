// Helpers that keep tests strictly typed without `any`. A test passes the code under test stand-ins with only the
// members that code uses; the type checks each supplied member against the real one, so a stand-in cannot drift from
// the real signature, while the members left out need no placeholder.
import assert from 'node:assert/strict';
import type { request } from '../../src/api.ts';

/** A T built from the members a test supplies. A member left out is undefined, so the test fails if it is used. */
export function stub<T>(members: Partial<T>): T {
  return members as T;
}

/**
 * src/api.js `request` answered by the test, with partial responses and sometimes synchronously: its callers await
 * the answer either way, and an answer stays synchronous so a test's timing does not change.
 */
export function fakeRequest(answer: (path: string) => unknown) {
  return answer as typeof request;
}

/** The value, after failing the test if it is null or undefined. */
export function present<T>(value: T | null | undefined, what = 'the value'): T {
  if (value == null) assert.fail(`${what} is missing`);
  return value;
}

/** What a rejection or throw check reads from the error it is given; a check whose property is missing fails. */
export type Thrown = Error & { code?: string; status?: number };
