import type { AzureClientCli } from '../../server/azure-client.ts';
import type { AzureRead } from '../../server/azure-reads.ts';

/**
 * A typed read as the words tests match on: `read`, the area and resource, the route and query values as
 * `key=value` in order, and the API version.
 */
export const readWords = (read: AzureRead) => [
  'read',
  read.area,
  String(read.resource),
  ...[...Object.entries(read.route), ...Object.entries(read.query)].map(([key, value]) => `${key}=${value}`),
  `api-version=${read.apiVersion}`,
];

/** A client queue whose az commands and REST reads one handler answers: az arguments as given, reads as readWords. */
export function fakeCli(answer: (words: string[]) => unknown): AzureClientCli {
  return {
    run: async args => answer(args),
    read: async request => answer(readWords(request)),
  };
}
