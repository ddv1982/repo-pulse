import { invalid } from '../errors.ts';
import { remoteToWatch } from '../repositories.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';
import type { Repository } from '../../src/contract.ts';

/** Watched repositories: adding, enabling and removing them, finding local checkouts, and connection checks. */
export function repositoryRoutes({ store, provider, sync, discover, browse }: AppContext) {
  return {
    'GET /api/connection': ({ query }) => {
      const org = query.get('organization') || undefined;
      if (org && !/^https:\/\/dev\.azure\.com\/[A-Za-z0-9_.-]+\/?$/.test(org))
        throw invalid('Use https://dev.azure.com/your-organization.');
      return provider.checkConnection(org, undefined);
    },
    'GET /api/repos/:id/connection': ({ params: { id } }) => provider.checkConnection(undefined, store.getEnabledRepo(id)),
    'POST /api/discover': async ({ body }) => {
      if (typeof body.path !== 'string' || !body.path.trim()) throw invalid('Enter a local folder path.');
      return await discover(body.path);
    },
    'POST /api/folders': ({ body }) => browse(body.path),
    'POST /api/repos': async ({ body }) => {
      const remote = await remoteToWatch(body, discover);
      const repo: Repository = await provider.resolveRepository(remote);
      if (remote.localPath) repo.localPath = remote.localPath;
      const existing = store.listRepos().find(item => item.id === repo.id);
      store.saveRepo({ ...repo, disabled: existing?.disabled || false });
      sync.refresh([repo.id]);
      return repo;
    },
    'PATCH /api/repos/:id': ({ params: { id }, body }) => {
      const repo = store.getRepo(id);
      if (typeof body.disabled !== 'boolean') throw invalid('disabled must be true or false.');
      store.saveRepo({ ...repo, disabled: body.disabled });
      if (!body.disabled) sync.refresh([id]);
      return { ok: true };
    },
    'DELETE /api/repos/:id': ({ params: { id } }) => {
      store.getRepo(id);
      store.removeRepo(id);
      sync.forget?.(id);
      return { ok: true };
    },
  } satisfies Partial<Handlers>;
}
