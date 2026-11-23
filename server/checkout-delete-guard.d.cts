// The TypeScript importers' view of checkout-delete-guard.cjs. tsconfig.hook.json checks the hook's exports against it.
export type RunGit = (path: string, args: string[]) => Promise<string>;
export declare function worktreeUsesBranch(run: RunGit, path: string, ref: string): Promise<boolean>;
export declare function isSymbolicRef(run: RunGit, path: string, ref: string): Promise<boolean>;
