// The Azure DevOps reads Repo Pulse makes, as typed requests, and the one table that admits them. A read names its
// organization, area, resource, route values, query and API version; the table turns an admitted read into its REST
// path. The queue refuses a read the table does not list before it starts (server/azure-cli.ts), and the REST reader
// builds the URL from the same table (server/azure-rest.ts).
import { normalizeOrganization } from './repositories.ts';

/** Route values by name: the project, repository, pull request or commit a read is about. */
type Route = { project?: string; repositoryId?: string; pullRequestId?: string; commitId?: string };

/** A route value that is not one non-empty path segment. `.` and `..` would make URL parsing move up the path. */
export class InvalidRoute extends Error {}

/** A route value as one encoded path segment. */
function segment(value: unknown) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw new InvalidRoute('Invalid Azure DevOps route.');
  return encodeURIComponent(value);
}
const repositoryPath = (route: Route) => `${segment(route.project)}/_apis/git/repositories/${segment(route.repositoryId)}`;

/** Every read Repo Pulse may make, by area and resource, with the path below the organization it reads. */
const READS = {
  git: {
    pushes: (route: Route) => `${repositoryPath(route)}/pushes`,
    refs: (route: Route) => `${repositoryPath(route)}/refs`,
    pullrequests: (route: Route) => `${repositoryPath(route)}/pullrequests`,
    commits: (route: Route) => `${repositoryPath(route)}/commits${route.commitId !== undefined ? `/${segment(route.commitId)}` : ''}`,
    pullrequestthreads: (route: Route) => `${repositoryPath(route)}/pullRequests/${segment(route.pullRequestId)}/threads`,
  },
  build: { builds: (route: Route) => `${segment(route.project)}/_apis/build/builds` },
  policy: { evaluations: (route: Route) => `${segment(route.project)}/_apis/policy/evaluations` },
  location: { connectiondata: () => '_apis/connectionData' },
} as const;

type Reads = typeof READS;
export type AzureArea = keyof Reads;
export type AzureResource<A extends AzureArea> = keyof Reads[A];
/** One read: a GET of an admitted area and resource. Query values are sent as given, in order. */
export type AzureRead = {
  [A in AzureArea]: {
    organization: string;
    area: A;
    resource: keyof Reads[A];
    route: Route;
    query: Record<string, string>;
    apiVersion: string;
  };
}[AzureArea];

/** A read of `resource` in `area`. TypeScript cannot narrow the union by a generic area, so the pair is checked here. */
export function azureRead<A extends AzureArea>(
  area: A,
  resource: AzureResource<A>,
  fields: Omit<AzureRead, 'area' | 'resource'>,
): AzureRead {
  return { area, resource, ...fields } as AzureRead;
}

/** The path builder for an admitted read, or undefined for one the table does not list. */
function pathOf(read: { area: unknown; resource: unknown }): ((route: Route) => string) | undefined {
  if (typeof read.area !== 'string' || !Object.hasOwn(READS, read.area)) return undefined;
  const resources: Record<string, (route: Route) => string> = READS[read.area as AzureArea];
  return typeof read.resource === 'string' && Object.hasOwn(resources, read.resource) ? resources[read.resource] : undefined;
}

/** Whether the table admits this read. Values arrive from callers typed, so this guards the area and resource names. */
export function isAllowedRead(read: AzureRead) {
  return pathOf(read) !== undefined && typeof read.apiVersion === 'string' && Boolean(read.apiVersion);
}

/** The REST URL of an admitted read. Throws InvalidRoute for a route value that is not one path segment. */
export function readUrl(read: AzureRead): URL {
  const path = pathOf(read);
  if (!path) throw new InvalidRoute('Unsupported Azure DevOps read.');
  const url = new URL(`${normalizeOrganization(read.organization)}/${path(read.route)}`);
  for (const [key, value] of Object.entries(read.query)) url.searchParams.set(key, value);
  url.searchParams.set('api-version', read.apiVersion);
  return url;
}
