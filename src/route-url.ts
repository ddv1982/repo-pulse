import type { RouteKey } from './contract.ts';

/** What a request names besides its route: path parameters and query parameters. A query value left undefined is not sent. */
export type RouteTarget = { params?: Record<string, string>; query?: Record<string, string | undefined> | URLSearchParams };

/** The method and URL of a route, with its path parameters encoded and the query parameters that have a value. */
export function routeUrl(route: RouteKey, { params = {}, query = {} }: RouteTarget = {}) {
  const [method = 'GET', path = ''] = route.split(' ');
  const filled = path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
  const search = new URLSearchParams(
    query instanceof URLSearchParams ? query : Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return { method, url: search ? `${filled}?${search}` : filled };
}
