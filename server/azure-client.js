// @ts-check
import { normalizeOrganization, parseRemote, repositoryKey } from './repositories.js';
import { safeAzureUrl } from '../src/events.js';
import { cliError } from './azure-cli.js';

/** Raw Azure DevOps JSON. Its shape is checked by the code that reads it, not by the compiler. */
/** @typedef {any} AzureRecord */
/** The repository fields the client reads. Watched repositories carry more. */
/** @typedef {{ organization: string, project: string, projectId?: string, azureId: string, webUrl: string }} AzureRepo */
/** @typedef {'pushes'|'refs'|'prs'|'closedPrs'|'builds'|'activeBuilds'} AzureStream */
/**
 * Where the next page starts: `skip` for offset-paged reads, `token` for continuation reads.
 * Build reads also keep their coarse window in `from` and `to`.
 * @typedef {{ skip?: number, token?: string, from?: string, to?: string, allRefs?: boolean }} PageCursor
 */
/** `restarted` marks a first page read in place of the saved cursor's page. @typedef {{ items: AzureRecord[], nextCursor: PageCursor | null, restarted?: boolean }} AzurePage */
/** @typedef {{ since?: string, until?: string, cursor?: PageCursor | null }} ReadOptions */
/**
 * @typedef {{ id: number, source: string, target: string, sourceId: string, targetId: string,
 *   head?: string, result?: string, strategy?: string, url: string }} CheckoutPull
 */
/** @typedef {{ status: 'ok'|'failed', checkedAt: string, code?: string, message?: string }} AccessCheck */
/**
 * @typedef {{ available: boolean, identity: null, identityVerified: boolean, message: string, code?: string,
 *   version?: string, extension?: string, signedIn?: boolean, account?: { name: string },
 *   access?: AccessCheck, capabilities?: { organizationRead: boolean } }} ConnectionStatus
 */
/**
 * @typedef {{ id: string, organization: string, project: string, projectId: string, azureId: string,
 *   name: string, webUrl: string, disabled: false }} ResolvedRepository
 */
/** @typedef {{ organization: string, project: string, repoName?: string, name?: string }} RepositoryInput */
/** The Azure CLI queue the client reads through (see createAzureCli). */
/** @typedef {{ run: (args: string[]) => Promise<AzureRecord> }} AzureClientCli */
/** The provider contract. Sync and backfill type their provider as the subset of it they call. */
/** @typedef {ReturnType<typeof createAzureClient>} AzureProvider */
/**
 * What a PR detail shows on request: counts of people's discussion threads and each policy's result.
 * Vote, reviewer and ref-update threads are Azure's own records of other events, so they are not counted.
 * @typedef {{ threads: { open: number, resolved: number }, policies: { name: string, status: string, blocking: boolean }[] }} PullRequestReview
 */
const RESOLVED = new Set(['fixed', 'wontFix', 'closed', 'byDesign']);
/** @param {unknown} threads @param {unknown} evaluations @returns {PullRequestReview} */
export function reviewOf(threads, evaluations) {
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
/** @param {string | undefined} value */
const iso = value => {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid sync date');
  return date.toISOString();
};
/** @param {string | undefined} value @param {'floor'|'ceil'} round */
const bucket = (value, round) =>
  // A non-empty value always yields a date string (or throws).
  value ? new Date(Math[round](new Date(/** @type {string} */ (iso(value))).getTime() / 300_000) * 300_000).toISOString() : undefined;

/**
 * @param {AzureRecord} response @param {{ skip?: number, mode?: 'skip'|'token' }} options
 * @returns {AzurePage}
 */
function pageOf(response, { skip = 0, mode }) {
  const items = Array.isArray(response) ? response : response?.value;
  if (!Array.isArray(items)) throw cliError('INVALID_RESPONSE', 'Azure CLI did not return an activity list.');
  const token = response?.continuation_token || response?.continuationToken;
  return {
    items,
    nextCursor: mode === 'skip' ? (items.length === PAGE ? { skip: skip + PAGE } : null) : token ? { token: String(token) } : null,
  };
}

/** @param {{ cli?: AzureClientCli, now?: () => number }} [options] */
export function createAzureClient({ cli, now = Date.now } = {}) {
  if (!cli?.run) throw new Error('Azure CLI is required');
  /** @type {Map<string, { expires: number, promise: Promise<AzureRecord> }>} */
  const cache = new Map();
  /** @param {string} key @param {() => Promise<AzureRecord>} work @returns {Promise<AzureRecord>} */
  function cached(key, work, ttl = 30_000) {
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
  /**
   * @param {AzureRepo} repo @param {'git'|'build'|'policy'} area @param {string} resource
   * @param {Record<string, string|number|null|undefined>} [query] @param {Record<string, string>} [route]
   * @returns {Promise<AzureRecord>}
   */
  const invoke = (repo, area, resource, query = {}, route = {}, shared = false) => {
    const org = normalizeOrganization(repo.organization);
    /** @type {Record<string, string>} */
    const routes = { project: repo.projectId || repo.project, ...route };
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
    /** @param {string} [organization] @param {AzureRepo} [repository] @returns {Promise<ConnectionStatus>} */
    async checkConnection(organization, repository) {
      try {
        const version = await cached('cli-version', () => cli.run(['version']), 300_000);
        const extension = await cached('cli-extension', () => cli.run(['extension', 'show', '--name', 'azure-devops']), 300_000);
        /** @type {ConnectionStatus} */
        const result = {
          available: true,
          version: version['azure-cli'],
          extension: extension.version,
          identity: null,
          identityVerified: false,
          signedIn: false,
          message:
            'Azure CLI and the DevOps extension are already installed. Existing CLI credentials will be used when you add a repository.',
        };
        // account show reads local account metadata only; it never acquires, prints or returns a token.
        try {
          const account = await cached('cli-account', () => cli.run(['account', 'show']), 30_000);
          if (account.user?.name) {
            result.signedIn = true;
            result.account = { name: account.user.name };
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
            if (repository && data?.id !== repository.azureId)
              throw cliError('INVALID_RESPONSE', 'Azure CLI did not verify the watched repository.');
            // Activity reads use the Azure CLI's Entra token, which the extension's own credentials do not prove.
            if (repository) await invoke(repository, 'git', 'refs', { filter: 'heads/', $top: 1 });
            return new Date(now()).toISOString();
          };
          try {
            const checkedAt = repository ? await verify() : await cached(`connection:${org}`, verify, 120_000);
            result.access = { status: 'ok', checkedAt };
            if (!repository) {
              result.capabilities = { organizationRead: true };
              result.message = 'Existing Azure CLI access works for this organization.';
            }
          } catch (caught) {
            // Caught values are untyped; CLI failures are errors that may carry a code.
            const error = /** @type {{ code?: string, message: string }} */ (caught);
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
        const error = /** @type {{ code?: string, message: string }} */ (caught);
        return { available: false, code: error.code || 'CLI_ERROR', message: error.message, identity: null, identityVerified: false };
      }
    },
    /** @param {string | RepositoryInput} input @returns {Promise<ResolvedRepository>} */
    async resolveRepository(input) {
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
      if (!raw?.id || !raw?.name || !raw?.project?.name) throw cliError('INVALID_RESPONSE', 'Azure CLI did not resolve this repository.');
      return {
        id: repositoryKey(organization, raw.id),
        organization,
        project: raw.project.name,
        projectId: raw.project.id,
        azureId: raw.id,
        name: raw.name,
        webUrl: `${organization}/${encodeURIComponent(raw.project.name)}/_git/${encodeURIComponent(raw.name)}`,
        disabled: false,
      };
    },
    /** @param {AzureRepo} repo @param {AzureStream} stream @param {ReadOptions} [options] @returns {Promise<AzurePage>} */
    async read(repo, stream, { since, until, cursor } = {}) {
      const skip = Number(cursor?.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid page cursor');
      /** @type {AzureRecord} */
      let response,
        /** @type {'skip'|'token'} */
        mode = 'token';
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
          const page = pageOf(response, { skip, mode });
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
          const page = pageOf(response, { skip, mode });
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
      return pageOf(response, { skip, mode });
    },
    /** @param {AzureRepo} repo @param {string[]} ids @returns {Promise<AzureRecord[]>} */
    async buildsById(repo, ids) {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !/^\d+$/.test(String(id)))) throw new Error('Invalid build IDs');
      if (!ids.length) return [];
      const raw = await invoke(repo, 'build', 'builds', { buildIds: ids.join(',') }, {}, true);
      return pageOf(raw, { skip: 0, mode: 'token' }).items;
    },
    /** @param {AzureRepo} repo @param {string} source @returns {Promise<CheckoutPull[]>} */
    async completedCheckoutPulls(repo, source) {
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
      return pageOf(response, {}).items.flatMap(pr => {
        const targetId = pr?.repository?.id;
        const sourceId = pr?.forkSource ? pr.forkSource.repository?.id : targetId;
        if (
          pr?.status !== 'completed' ||
          pr.sourceRefName !== source ||
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
            target: pr.targetRefName,
            sourceId,
            targetId,
            head: pr.lastMergeSourceCommit?.commitId,
            result: pr.lastMergeCommit?.commitId,
            strategy: pr.completionOptions?.mergeStrategy,
            url: safeAzureUrl(pr._links?.web?.href, `${repo.webUrl}/pullrequest/${encodeURIComponent(pr.pullRequestId)}`),
          },
        ];
      });
    },
    /** @param {AzureRepo} repo @param {string|number} id @returns {Promise<AzureRecord>} */
    async pullRequest(repo, id) {
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
      if (!raw?.pullRequestId || raw.repository?.id !== repo.azureId)
        throw cliError('INVALID_RESPONSE', 'Azure CLI did not return the requested repository pull request.');
      return raw;
    },
    /**
     * One page of commits reachable from the old tip but not from the new one. Empty means the old tip
     * is an ancestor of the new one (a fast-forward); anything else means the update dropped history.
     * @param {AzureRepo} repo @param {string} oldSha @param {string} newSha @returns {Promise<AzurePage>}
     */
    async droppedCommits(repo, oldSha, newSha) {
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
      const page = pageOf(raw, { mode: 'skip' });
      if (page.items.some(item => typeof item?.commitId !== 'string' || !/^[0-9a-f]{40}$/i.test(item.commitId)))
        throw cliError('INVALID_RESPONSE', 'Azure returned invalid ref-range commit evidence.');
      return page;
    },
    /**
     * One commit's parents and the push that first brought it into the repository (null when Azure names none).
     * @param {AzureRepo} repo @param {string} commitId @returns {Promise<{ parents: string[], pushId: number | null }>}
     */
    async commit(repo, commitId) {
      if (typeof commitId !== 'string' || !/^[0-9a-f]{40}$/i.test(commitId))
        throw cliError('INVALID_QUERY', 'A commit read requires a complete commit ID.');
      const raw = await invoke(repo, 'git', 'commits', { changeCount: 0 }, { commitId: commitId.toLowerCase() });
      const parents = raw?.parents;
      if (!Array.isArray(parents) || parents.some(parent => typeof parent !== 'string' || !/^[0-9a-f]{40}$/i.test(parent)))
        throw cliError('INVALID_RESPONSE', 'Azure returned an invalid commit.');
      const pushId = raw?.push?.pushId;
      return { parents: parents.map(parent => parent.toLowerCase()), pushId: Number.isSafeInteger(pushId) ? pushId : null };
    },
    /**
     * Read when a PR detail asks for it, never by polling: one read for discussion threads, one for policy evaluations.
     * @param {AzureRepo} repo @param {string|number} pullRequestId @returns {Promise<PullRequestReview>}
     */
    async prReview(repo, pullRequestId) {
      const id = String(pullRequestId);
      if (!/^\d+$/.test(id) || !repo.projectId) throw cliError('INVALID_QUERY', 'Invalid pull request.');
      const threads = await invoke(repo, 'git', 'pullRequestThreads', {}, { pullRequestId: id });
      const evaluations = await invoke(repo, 'policy', 'evaluations', {
        artifactId: `vstfs:///CodeReview/CodeReviewId/${repo.projectId}/${id}`,
        includeNotApplicable: 'true',
      });
      return reviewOf(threads.value, evaluations.value);
    },
    /** @param {AzureRepo} repo @param {string|number} pushId @param {PageCursor} [cursor] @returns {Promise<AzurePage>} */
    async pushCommits(repo, pushId, cursor = {}) {
      if (!/^\d+$/.test(String(pushId))) throw new Error('Invalid push ID');
      const skip = Number(cursor?.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid page cursor');
      const raw = await invoke(repo, 'git', 'commits', { pushId, top: PAGE, skip });
      return pageOf(raw, { skip, mode: 'skip' });
    },
  };
}
