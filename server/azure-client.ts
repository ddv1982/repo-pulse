import { normalizeOrganization, parseRemote, repositoryKey } from './repositories.ts';
import { safeAzureUrl } from '../src/events.ts';
import { cliError } from './azure-cli.ts';
import { isAzurePullRequest, isRecord, recordId, streamGuards, unreadableField } from './azure-records.ts';

export type AzureRepo = import('../src/contract.ts').AzureRepo;
export type AzureStream = import('../src/contract.ts').AzureStream;
export type AzureStreamRecord = import('../src/contract.ts').AzureStreamRecord;
export type AzureBuild = import('../src/contract.ts').AzureBuild;
export type AzurePullRequest = import('../src/contract.ts').AzurePullRequest;
export type UnreadableRecords = import('../src/contract.ts').UnreadableRecords;
export type PageCursor = import('../src/contract.ts').PageCursor;
/**
 * `restarted` marks a first page read in place of the saved cursor's page. `unreadable` counts the records left out
 * of `items` because a field they need is missing or malformed; it is absent when there were none. `unreadableIds`
 * names the pull requests and builds among them whose ID could still be read, so sync knows Azure listed them.
 */
export type AzurePage<T = AzureStreamRecord> = {
  items: T[];
  nextCursor: PageCursor | null;
  restarted?: boolean;
  unreadable?: UnreadableRecords;
  unreadableIds?: string[];
};
/** One page of a stream, as sync and backfill read it. */
export type StreamRead = (repo: AzureRepo, stream: AzureStream, options?: ReadOptions) => Promise<AzurePage>;
export type ReadOptions = { since?: string; until?: string; cursor?: PageCursor | null };
export type CheckoutPull = {
  id: number;
  source: string;
  target: string;
  sourceId: string;
  targetId: string;
  head?: string;
  result?: string;
  strategy?: string;
  url: string;
};
export type AccessCheck = import('../src/contract.ts').AccessCheck;
export type ConnectionStatus = import('../src/contract.ts').ConnectionStatus;
export type ResolvedRepository = {
  id: string;
  organization: string;
  project: string;
  projectId: string;
  azureId: string;
  name: string;
  webUrl: string;
  disabled: false;
};
export type RepositoryInput = { organization: string; project: string; repoName?: string; name?: string };
/** The Azure CLI queue the client reads through (see createAzureCli). */
export type AzureClientCli = { run: (args: string[]) => Promise<unknown> };
/** The provider contract. Sync and backfill type their provider as the subset of it they call. */
export type AzureProvider = ReturnType<typeof createAzureClient>;
export type PullRequestReview = import('../src/contract.ts').PullRequestReview;
const RESOLVED = new Set(['fixed', 'wontFix', 'closed', 'byDesign']);
export function reviewOf(threads: unknown, evaluations: unknown): PullRequestReview {
  if (!Array.isArray(threads) || !Array.isArray(evaluations))
    throw cliError('INVALID_RESPONSE', 'Azure returned no pull request review data.');
  const discussion = threads.filter(thread => !thread?.isDeleted && !thread?.properties?.CodeReviewThreadType);
  const resolved = discussion.filter(thread => RESOLVED.has(thread.status)).length;
  return {
    threads: { open: discussion.length - resolved, resolved },
    policies: evaluations
      .filter(item => item?.configuration?.isEnabled !== false && !item?.configuration?.isDeleted)
      .map(item => ({
        name: String(item.configuration?.type?.displayName || 'Policy'),
        status: String(item.status || 'unknown'),
        blocking: Boolean(item.configuration?.isBlocking),
      })),
  };
}

const PAGE = 100;
const iso = (value: string | undefined) => {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid sync date');
  return date.toISOString();
};
const bucket = (value: string | undefined, round: 'floor' | 'ceil') =>
  // A non-empty value always yields a date string (or throws).
  value ? new Date(Math[round](new Date(iso(value) as string).getTime() / 300_000) * 300_000).toISOString() : undefined;

/**
 * The records of one list response that `readable` accepts. The rest are counted with the fields `field` names, so
 * a record Azure returns in a changed shape is reported instead of failing the page or disappearing; `idOf` names
 * those whose ID can still be read. A skip-paged read counts every record Azure returned, so a page with unreadable
 * records still pages on.
 */
function pageOf<T>(
  response: unknown,
  readable: (value: unknown) => value is T,
  field: (value: unknown) => string | null,
  { skip = 0, mode, idOf }: { skip?: number; mode?: 'skip' | 'token'; idOf?: (value: unknown) => string | undefined },
): AzurePage<T> {
  const list: unknown = Array.isArray(response) ? response : isRecord(response) ? response.value : undefined;
  if (!Array.isArray(list)) throw cliError('INVALID_RESPONSE', 'Azure CLI did not return an activity list.');
  const token = isRecord(response) ? response.continuation_token || response.continuationToken : undefined;
  const items: T[] = [];
  const fields: Set<string> = new Set();
  const unreadableIds: string[] = [];
  let skipped = 0;
  for (const item of list) {
    if (readable(item)) {
      items.push(item);
      continue;
    }
    skipped++;
    fields.add(field(item) ?? 'record');
    const id = idOf?.(item);
    if (id !== undefined) unreadableIds.push(id);
  }
  return {
    items,
    nextCursor: mode === 'skip' ? (list.length === PAGE ? { skip: skip + PAGE } : null) : token ? { token: String(token) } : null,
    ...(skipped ? { unreadable: { count: skipped, fields: [...fields] } } : {}),
    ...(unreadableIds.length ? { unreadableIds } : {}),
  };
}
/** Pages whose items the caller checks itself. */
const everyItem = (_value: unknown): _value is unknown => true;
const noField = () => null;
/** A field of a response that is not an object reads as absent. */
const fieldOf = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const textOf = (value: unknown) => (typeof value === 'string' ? value : undefined);

export function createAzureClient({ cli, now = Date.now }: { cli?: AzureClientCli; now?: () => number } = {}) {
  if (!cli?.run) throw new Error('Azure CLI is required');
  const cache: Map<string, { expires: number; promise: Promise<unknown> }> = new Map();
  function cached(key: string, work: () => Promise<unknown>, ttl = 30_000): Promise<unknown> {
    const found = cache.get(key);
    if (found && found.expires > now()) return found.promise;
    const promise = Promise.resolve().then(work);
    cache.set(key, { expires: now() + ttl, promise });
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    if (cache.size > 200) for (const [entry, value] of cache) if (value.expires <= now()) cache.delete(entry);
    return promise;
  }
  const invoke = (
    repo: AzureRepo,
    area: 'git' | 'build' | 'policy',
    resource: string,
    query: Record<string, string | number | null | undefined> = {},
    route: Record<string, string> = {},
    shared = false,
  ): Promise<unknown> => {
    const org = normalizeOrganization(repo.organization);
    const routes: Record<string, string> = { project: repo.projectId || repo.project, ...route };
    if (area === 'git') routes.repositoryId = repo.azureId;
    const args = [
      'devops',
      'invoke',
      '--organization',
      org,
      '--detect',
      'false',
      '--area',
      area,
      '--resource',
      resource,
      '--api-version',
      // Policy evaluations exist only as a preview API.
      area === 'policy' ? '7.1-preview.1' : '7.1',
      '--http-method',
      'GET',
      '--route-parameters',
      ...Object.entries(routes).map(([key, value]) => `${key}=${value}`),
    ];
    const queries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
    if (queries.length) args.push('--query-parameters', ...queries.map(([key, value]) => `${key}=${value}`));
    return shared ? cached(JSON.stringify(args), () => cli.run(args), 45_000) : cli.run(args);
  };
  return {
    async checkConnection(organization?: string, repository?: AzureRepo): Promise<ConnectionStatus> {
      try {
        const version = await cached('cli-version', () => cli.run(['version']), 300_000);
        const extension = await cached('cli-extension', () => cli.run(['extension', 'show', '--name', 'azure-devops']), 300_000);
        const result: ConnectionStatus = {
          available: true,
          version: textOf(fieldOf(version, 'azure-cli')),
          extension: textOf(fieldOf(extension, 'version')),
          identity: null,
          identityVerified: false,
          signedIn: false,
          message:
            'Azure CLI and the DevOps extension are already installed. Existing CLI credentials will be used when you add a repository.',
        };
        // account show reads local account metadata only; it never acquires, prints or returns a token.
        try {
          const account = await cached('cli-account', () => cli.run(['account', 'show']), 30_000);
          const name = fieldOf(fieldOf(account, 'user'), 'name');
          if (typeof name === 'string' && name) {
            result.signedIn = true;
            result.account = { name };
            result.message = 'Existing Azure CLI sign-in detected. No additional setup is needed; choose repositories to watch.';
          }
        } catch {
          // The DevOps extension may already use its own configured credentials.
          // Lack of an Entra account must not force a redundant login/setup flow.
        }
        if (repository || organization) {
          const org = normalizeOrganization(repository?.organization ?? organization);
          const verify = async () => {
            const data = await cli.run(
              repository
                ? [
                    'repos',
                    'show',
                    '--repository',
                    repository.azureId,
                    '--project',
                    repository.projectId || repository.project,
                    '--organization',
                    org,
                    '--detect',
                    'false',
                  ]
                : ['devops', 'project', 'list', '--organization', org, '--top', '1', '--detect', 'false'],
            );
            if (repository && fieldOf(data, 'id') !== repository.azureId)
              throw cliError('INVALID_RESPONSE', 'Azure CLI did not verify the watched repository.');
            // Activity reads use the Azure CLI's Entra token, which the extension's own credentials do not prove.
            if (repository) await invoke(repository, 'git', 'refs', { filter: 'heads/', $top: 1 });
            return new Date(now()).toISOString();
          };
          try {
            // The cache holds what verify() returned, which is always the time as a string.
            const checkedAt = repository ? await verify() : String(await cached(`connection:${org}`, verify, 120_000));
            result.access = { status: 'ok', checkedAt };
            if (!repository) {
              result.capabilities = { organizationRead: true };
              result.message = 'Existing Azure CLI access works for this organization.';
            }
          } catch (caught) {
            // Caught values are untyped; CLI failures are errors that may carry a code.
            const error = caught as { code?: string; message: string };
            result.access = {
              status: 'failed',
              checkedAt: new Date(now()).toISOString(),
              code: error.code || 'CLI_ERROR',
              message: error.message,
            };
          }
        }
        return result;
      } catch (caught) {
        const error = caught as { code?: string; message: string };
        return { available: false, code: error.code || 'CLI_ERROR', message: error.message, identity: null, identityVerified: false };
      }
    },
    async resolveRepository(input: string | RepositoryInput): Promise<ResolvedRepository> {
      const parsed = typeof input === 'string' ? parseRemote(input) : input;
      const organization = normalizeOrganization(parsed.organization);
      const project = parsed.project,
        name = parsed.repoName || parsed.name;
      if (typeof project !== 'string' || typeof name !== 'string' || !project || !name || /^[-@]/.test(project) || /^[-@]/.test(name))
        throw new Error('Choose a valid Azure repository.');
      const raw = await cli.run([
        'repos',
        'show',
        '--repository',
        name,
        '--project',
        project,
        '--organization',
        organization,
        '--detect',
        'false',
      ]);
      const id = textOf(fieldOf(raw, 'id')),
        resolved = textOf(fieldOf(raw, 'name')),
        projectName = textOf(fieldOf(fieldOf(raw, 'project'), 'name')),
        projectId = textOf(fieldOf(fieldOf(raw, 'project'), 'id'));
      if (!id || !resolved || !projectName || projectId === undefined)
        throw cliError('INVALID_RESPONSE', 'Azure CLI did not resolve this repository.');
      return {
        id: repositoryKey(organization, id),
        organization,
        project: projectName,
        projectId,
        azureId: id,
        name: resolved,
        webUrl: `${organization}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(resolved)}`,
        disabled: false,
      };
    },
    async read(repo: AzureRepo, stream: AzureStream, { since, until, cursor }: ReadOptions = {}): Promise<AzurePage> {
      const skip = Number(cursor?.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid page cursor');
      const readable = (value: unknown): value is AzureStreamRecord => streamGuards[stream](value);
      const pageOfStream = (response: unknown, options: { skip?: number; mode?: 'skip' | 'token' }) =>
        pageOf(response, readable, value => unreadableField(stream, value), { ...options, idOf: value => recordId(stream, value) });
      let response: unknown,
        mode: 'skip' | 'token' = 'token';
      switch (stream) {
        case 'pushes':
          response = await invoke(repo, 'git', 'pushes', {
            $top: PAGE,
            $skip: skip,
            'searchCriteria.fromDate': iso(since),
            'searchCriteria.toDate': iso(until),
            'searchCriteria.includeRefUpdates': 'true',
          });
          mode = 'skip';
          break;
        case 'refs': {
          // A token saved by the branch-only query used before tags pages a different list, so that snapshot restarts.
          response = await invoke(repo, 'git', 'refs', {
            peelTags: 'true',
            $top: PAGE,
            continuationToken: cursor?.allRefs ? cursor.token : undefined,
          });
          const page = pageOfStream(response, { skip, mode });
          if (page.nextCursor) page.nextCursor.allRefs = true;
          if (cursor?.token && !cursor.allRefs) page.restarted = true;
          return page;
        }
        case 'prs':
          response = await invoke(repo, 'git', 'pullRequests', {
            $top: PAGE,
            $skip: skip,
            'searchCriteria.status': 'active',
            'searchCriteria.repositoryId': repo.azureId,
          });
          mode = 'skip';
          break;
        case 'closedPrs':
          response = await invoke(repo, 'git', 'pullRequests', {
            $top: PAGE,
            $skip: skip,
            'searchCriteria.status': 'all',
            'searchCriteria.repositoryId': repo.azureId,
            'searchCriteria.queryTimeRangeType': 'closed',
            'searchCriteria.minTime': iso(since),
            'searchCriteria.maxTime': iso(until),
          });
          mode = 'skip';
          break;
        case 'builds': {
          // Coarse overlapping windows coalesce same-repository reads without project-wide history scans.
          const from = cursor?.from || bucket(since, 'floor'),
            to = cursor?.to || bucket(until, 'ceil');
          response = await invoke(
            repo,
            'build',
            'builds',
            {
              $top: PAGE,
              continuationToken: cursor?.token,
              minTime: from,
              maxTime: to,
              repositoryId: repo.azureId,
              repositoryType: 'TfsGit',
              queryOrder: 'queueTimeDescending',
            },
            {},
            true,
          );
          const page = pageOfStream(response, { skip, mode });
          if (page.nextCursor) Object.assign(page.nextCursor, { from, to });
          return page;
        }
        case 'activeBuilds':
          response = await invoke(
            repo,
            'build',
            'builds',
            {
              $top: PAGE,
              continuationToken: cursor?.token,
              statusFilter: 'notStarted,inProgress,cancelling,postponed',
              repositoryId: repo.azureId,
              repositoryType: 'TfsGit',
              queryOrder: 'queueTimeDescending',
            },
            {},
            true,
          );
          break;
        default:
          throw new Error('Unknown Azure activity stream');
      }
      return pageOfStream(response, { skip, mode });
    },
    /** A next cursor means Azure has more of the requested builds than this page holds. */
    async buildsById(repo: AzureRepo, ids: string[]): Promise<AzurePage<AzureBuild>> {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !/^\d+$/.test(String(id)))) throw new Error('Invalid build IDs');
      if (!ids.length) return { items: [], nextCursor: null };
      const raw = await invoke(repo, 'build', 'builds', { buildIds: ids.join(',') }, {}, true);
      return pageOf(raw, streamGuards.builds, value => unreadableField('builds', value), {
        skip: 0,
        mode: 'token',
        idOf: value => recordId('builds', value),
      });
    },
    async completedCheckoutPulls(repo: AzureRepo, source: string): Promise<CheckoutPull[]> {
      if (typeof source !== 'string' || !/^refs\/heads\/[^\s\x00-\x1f]+$/.test(source) || source.length > 1024) return [];
      const response = await invoke(
        repo,
        'git',
        'pullRequests',
        {
          $top: 20,
          'searchCriteria.status': 'completed',
          'searchCriteria.repositoryId': repo.azureId,
          'searchCriteria.sourceRepositoryId': repo.azureId,
          'searchCriteria.sourceRefName': source,
        },
        {},
        true,
      );
      // A pull request this lookup cannot read is not offered as advice.
      return pageOf(response, isAzurePullRequest, noField, {}).items.flatMap(pr => {
        const targetId = pr.repository?.id;
        const sourceId = pr.forkSource ? pr.forkSource.repository?.id : targetId;
        const target = pr.targetRefName;
        const head = pr.lastMergeSourceCommit?.commitId,
          result = pr.lastMergeCommit?.commitId,
          strategy = pr.completionOptions?.mergeStrategy;
        if (
          pr.status !== 'completed' ||
          pr.sourceRefName !== source ||
          typeof target !== 'string' ||
          typeof targetId !== 'string' ||
          typeof sourceId !== 'string' ||
          targetId.toLowerCase() !== repo.azureId.toLowerCase() ||
          sourceId.toLowerCase() !== repo.azureId.toLowerCase()
        )
          return [];
        return [
          {
            id: pr.pullRequestId,
            source,
            target,
            sourceId,
            targetId,
            // A field Azure did not send stays absent.
            ...(typeof head === 'string' ? { head } : {}),
            ...(typeof result === 'string' ? { result } : {}),
            ...(typeof strategy === 'string' ? { strategy } : {}),
            url: safeAzureUrl(pr._links?.web?.href, `${repo.webUrl}/pullrequest/${encodeURIComponent(pr.pullRequestId)}`),
          },
        ];
      });
    },
    /**
     * Throws UNREADABLE_RECORD, with the field that is missing or malformed, for a pull request that cannot be read,
     * including one whose ID or repository cannot be read. An answer whose readable ID names another pull request is
     * INVALID_RESPONSE, and one whose readable repository is another is WRONG_REPOSITORY.
     */
    async pullRequest(repo: AzureRepo, id: string | number): Promise<AzurePullRequest> {
      if (!/^\d+$/.test(String(id))) throw new Error('Invalid PR ID');
      const raw = await cli.run([
        'repos',
        'pr',
        'show',
        '--id',
        String(id),
        '--organization',
        normalizeOrganization(repo.organization),
        '--detect',
        'false',
      ]);
      const prId = recordId('prs', raw);
      if (prId !== undefined && prId !== String(id))
        throw cliError('INVALID_RESPONSE', 'Azure CLI did not return the requested repository pull request.');
      const repositoryId = textOf(fieldOf(fieldOf(raw, 'repository'), 'id'))?.trim();
      // A PR that now belongs to another repository, for example after a move, cannot be read for this one.
      if (repositoryId && repositoryId.toLowerCase() !== repo.azureId?.toLowerCase())
        throw cliError('WRONG_REPOSITORY', 'Azure returned this pull request for a different repository.');
      const unreadable = unreadableField('prs', raw) ?? (repositoryId ? null : 'repository.id');
      if (unreadable !== null || !isAzurePullRequest(raw)) {
        const field = unreadable ?? 'record';
        throw Object.assign(cliError('UNREADABLE_RECORD', `Azure returned pull request ${String(id)} without a readable ${field}.`), {
          field,
        });
      }
      return raw;
    },
    /**
     * One page of commits reachable from the old tip but not from the new one. Empty means the old tip
     * is an ancestor of the new one (a fast-forward); anything else means the update dropped history.
     */
    async droppedCommits(repo: AzureRepo, oldSha: string, newSha: string): Promise<AzurePage<unknown>> {
      if (![oldSha, newSha].every(sha => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)))
        throw cliError('INVALID_QUERY', 'Commit queries require at most 100 complete commit IDs.');
      const old = oldSha.toLowerCase(),
        current = newSha.toLowerCase();
      if (/^0+$/.test(old) || /^0+$/.test(current) || old === current) return { items: [], nextCursor: null };
      // Azure walks from compareVersion until itemVersion, so the old tip is compared against the new one.
      const raw = await invoke(repo, 'git', 'commits', {
        'searchCriteria.$top': PAGE,
        'searchCriteria.$skip': 0,
        'searchCriteria.compareVersion.version': old,
        'searchCriteria.compareVersion.versionType': 'commit',
        'searchCriteria.itemVersion.version': current,
        'searchCriteria.itemVersion.versionType': 'commit',
      });
      const page = pageOf(raw, everyItem, noField, { mode: 'skip' });
      if (
        page.items.some(item => {
          const commitId = fieldOf(item, 'commitId');
          return typeof commitId !== 'string' || !/^[0-9a-f]{40}$/i.test(commitId);
        })
      )
        throw cliError('INVALID_RESPONSE', 'Azure returned invalid ref-range commit evidence.');
      return page;
    },
    /**
     * One commit's parents and the push that first brought it into the repository (null when Azure names none).
     */
    async commit(repo: AzureRepo, commitId: string): Promise<{ parents: string[]; pushId: number | null }> {
      if (typeof commitId !== 'string' || !/^[0-9a-f]{40}$/i.test(commitId))
        throw cliError('INVALID_QUERY', 'A commit read requires a complete commit ID.');
      const raw = await invoke(repo, 'git', 'commits', { changeCount: 0 }, { commitId: commitId.toLowerCase() });
      const parents: unknown = fieldOf(raw, 'parents');
      const ids = Array.isArray(parents) ? parents.filter(parent => typeof parent === 'string' && /^[0-9a-f]{40}$/i.test(parent)) : [];
      if (!Array.isArray(parents) || ids.length !== parents.length) throw cliError('INVALID_RESPONSE', 'Azure returned an invalid commit.');
      const pushId = fieldOf(fieldOf(raw, 'push'), 'pushId');
      return {
        parents: ids.map(parent => String(parent).toLowerCase()),
        pushId: typeof pushId === 'number' && Number.isSafeInteger(pushId) ? pushId : null,
      };
    },
    /**
     * Read when a PR detail asks for it, never by polling: one read for discussion threads, one for policy evaluations.
     */
    async prReview(repo: AzureRepo, pullRequestId: string | number): Promise<PullRequestReview> {
      const id = String(pullRequestId);
      if (!/^\d+$/.test(id) || !repo.projectId) throw cliError('INVALID_QUERY', 'Invalid pull request.');
      const threads = await invoke(repo, 'git', 'pullRequestThreads', {}, { pullRequestId: id });
      const evaluations = await invoke(repo, 'policy', 'evaluations', {
        artifactId: `vstfs:///CodeReview/CodeReviewId/${repo.projectId}/${id}`,
        includeNotApplicable: 'true',
      });
      return reviewOf(fieldOf(threads, 'value'), fieldOf(evaluations, 'value'));
    },
    async pushCommits(repo: AzureRepo, pushId: string | number, cursor: PageCursor = {}): Promise<AzurePage<Record<string, unknown>>> {
      if (!/^\d+$/.test(String(pushId))) throw new Error('Invalid push ID');
      const skip = Number(cursor?.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid page cursor');
      const raw = await invoke(repo, 'git', 'commits', { pushId, top: PAGE, skip });
      // A commit that is not an object has nothing to show, so it is left out.
      return pageOf(raw, isRecord, () => 'record', { skip, mode: 'skip' });
    },
  };
}
