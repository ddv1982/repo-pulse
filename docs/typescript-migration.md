# TypeScript migration plan

Goal: every source, script and test file is strict TypeScript on TypeScript 7.0.2, with behaviour
unchanged and the same end state as `crv-jamq-queue-view`. The existing 469 unit and 85 Chromium tests
prove behaviour. Each phase is one PR and ends with the full CI matrix green (`check`, `check:types`,
`lint`, `test` on ubuntu and windows, `test:ui` on ubuntu).

This is a conversion, not a rewrite. Production code already passes strict `checkJs` with 0 errors,
carries about 356 `@typedef`s and has no `@ts-ignore`. Two council rounds (Claude Opus 5.5, GPT-6.2 Sol,
Gemini 4 Neon, 2026-11-23) asked what a from-scratch TypeScript 7 design would look like. All three
said it would be close to this one: Node 26, zero runtime dependencies, `node:test`, hand-written
boundary guards and `SafeHtml`, written in `.ts`. Decisions D1 to D3 are recorded under "Decisions".

## Toolchain

| Concern | Choice | Why |
| --- | --- | --- |
| Compiler | `typescript@7.0.2` (already installed), exact pin | Matches `oxlint-tsgolint@7.0.2008` |
| Node code and tests | Native type stripping on Node 26 (`node server.ts`, `node --test "test/*.test.ts"`) | Stable on Node 26, no warning, no loader |
| Browser code | **D1**, recommended: `tsc` emit to gitignored `dist/` | Same as crv-jamq; see D1 |
| tsconfig | `tsconfig.base.json` plus `web` (DOM lib, `types: []`), `node` (no DOM, `types: ["node"]`) and `test` (Node + DOM for linkedom and Playwright callbacks) | Today one program lets `src/` use `process` and `server/` use `document` |
| Strict flags | `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`; then `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (Phases 7 and 8) | What a greenfield project and crv-jamq use |
| Linter | `oxlint@1.95.0` + `oxlint-tsgolint@7.0.2008`, exact pins | `typescript-eslint` 8.74.0 requires `typescript <6.1.0`; its tsgo backend is experimental and needs a 7.1 nightly |
| Custom rules | Native `complexity` at 30; `no-restricted-syntax` via `oxlint-plugin-eslint@1.95.0`, registered as the JS plugin `eslint-js` (`eslint` is reserved) | Native `complexity` verified: at 29 it flags `server/checkout-observations.js:67` and `server/normalize.js:160` |
| Formatter | Prettier 3.10.1, unchanged | `oxfmt` 0.80.0 is pre-1.0; Biome would mean rewriting the custom rules |
| Boundary validation | Hand-written guards from `unknown` | zod, valibot or arktype would be the first runtime dependency |
| SQLite rows | Convert the existing casts one-for-one; typed row readers are later work | `@types/node` 26.6.6 types rows as `Record<string, SQLOutputValue>`; a generic `get<T>()` is just a cast |

Rejected by all three: a bundler (Vite 8.3.8, Rolldown 1.3.3, esbuild 0.28.2), Bun or Deno, Vitest,
an ORM, project references (TS2878 with `rewriteRelativeImportExtensions`, verified by Neon) and
`isolatedDeclarations` (for declaration emit, which an app doesn't need).

### D1: how the browser gets JavaScript

`PLAN.md:30` and `docs/MAINTAINING.md:20` promise "no build step". The browser loads `src/*.js` directly
through `staticFile` (`server.js:167`). Every source file ends up `.ts` with either option.

| Option | Council | Cost |
| --- | --- | --- |
| **A. `tsc` emit to `dist/` (recommended)** | Sol, Neon | A build before `start`, `demo` and tests (about 0.5 s for 38 files); `tsc --watch` while editing. Plain `.js` to the browser, no runtime warning, and the `web` config's `types: []` keeps Node APIs out of browser code at compile time. Amends the constraint to "zero runtime dependencies, no bundler; browser TypeScript compiled with `tsc`". |
| B. Strip types on serve | Opus | About 3 lines in `staticFile` using `node:module` `stripTypeScriptTypes`; keeps "no build step". The API is release-candidate, prints an `ExperimentalWarning` on Node 26.13.1 (verified), and Node's docs say its output "should not be considered stable across Node.js versions". |

Opus's case for B is that crv-jamq already had a build step (`build:css` for Tailwind, verified in its
history), so adding `tsc` cost it nothing new, while repo-pulse has none. A is recommended anyway: it
matches crv-jamq, avoids an experimental API on the serving path, and enforces the browser/server split
at compile time. Moving from A to B later only touches `staticFile` and the build script.

## Phase 0: replace ESLint with Oxlint (code stays JavaScript)

- [x] Add exact pins `oxlint@1.95.0`, `oxlint-plugin-eslint@1.95.0`; write `.oxlintrc.json` with the Node, browser and CommonJS scopes, the four core rules, native `complexity` at 30, and the HTML-regex selector on its three named tests (patterns cover `.js` and `.ts`)
- [x] Compare against `eslint . --max-warnings=0` on the clean tree; both exit 0
- [x] Seed one violation per rule (including complexity 31 and an HTML regex in a `.ts` file), show Oxlint reports each, remove the seeds
- [x] Remove `eslint`, `globals`, `eslint.config.js`; `lint` becomes `oxlint --deny-warnings . && prettier --check .`
- [x] CI green on ubuntu and windows (proves the native binary and the alpha JS plugin on Windows)

## Phase 1: split the type boundary (code stays JavaScript)

- [x] Move the server types the browser uses (30 distinct type names from `server.js` and 7 `server/` modules, imported 36 times from 9 `src/` files) into a Node-free `src/contract.js`; repoint the `import()` types in `src/` and `server/`
- [x] `tsconfig.base.json` plus `tsconfig.web.json`, `tsconfig.json` (node) and `tsconfig.test.json`, all `noEmit` for now; `check:types` runs `web` and `node`. `scripts/` stays out of the node config (93 errors when added) until Phase 4, and `tsconfig.test.json` (2,299 errors) joins `check:types` once Phases 5 and 6 bring it to 0
- [x] `web` and `node` report 0 errors, the `node` program has no DOM lib, and `tsc -p tsconfig.web.json --listFilesOnly` lists no `server/` file

## Phase 2: TypeScript scaffolding and browser build (no source converted)

- [x] Base config adds `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`; include globs cover `.ts`; `allowJs`/`checkJs` stay
- [x] `tsconfig.web.json` emits `src/` and `web/theme` to `dist/` with `rewriteRelativeImportExtensions`, `noEmitOnError`; `web/theme` compiles as a classic script (`moduleDetection: "legacy"`, no `export`; `auto` and `force` append `export {}`). TypeScript 7 removed `alwaysStrict: false`, so `dist/web/theme.js` starts with `"use strict"`, which its IIFE does not notice. `check:types` passes `--noEmit` to the web config
- [x] `build:web` cleans `dist/` (cross-platform, in Node) and runs `tsc`; wired into `prestart`, `predemo`, `pretest`, `pretest:ui` and CI; `watch:web` for editing; `dist/` in `.gitignore`, `.prettierignore` and Oxlint ignores
- [x] `staticFile` serves `/src/*.js` and `/web/theme.js` from `dist/`, CSS, SVG and `web/vendor/` from `web/`, with the root prefix checks kept
- [x] `test/server.test.js`: JS content type for the built routes, unchanged CSS and vendor routes, 404 for `.ts` source and for server code (line 103 retargeted so it stays meaningful); fails when `dist/` is missing, naming `npm run build:web` (the server itself answers 404)
- [x] `test/escaping.test.js:677`: the sole-`innerHTML`-sink test scans `.js` and `.ts`; seed an `innerHTML` in a `.ts` file and watch it fail (otherwise it passes vacuously after the rename)
- [x] `scripts/check.js`: skip `.ts` and `dist/` (`node --check` rejects type syntax on Node 26, verified; its `.js` filter already skipped `.ts`)
- [x] Commit the conversion codemod as a temporary script (rename, `.ts` import paths, TypeScript's `annotateWithTypeFromJSDoc`/`convertTypedefToType` via `npx typescript@6.0.3` once, export only top-level aliases). It also turns JSDoc casts into `as`/`satisfies` (TypeScript ignores them in `.ts`) and works around the defects in TypeScript 6.0.3's fixes that the conversions hit (see the script's header)
- [x] Update `PLAN.md:30`, `docs/MAINTAINING.md:20` and the README with the new constraint wording
- [x] Full CI green; `npm run demo` loads from `dist/`

## Phase 3: browser and shared code (`src/`, `web/theme`, 37 files, about 5,500 lines)

- [x] 3a: `src/contract`, `events`, `sync-worst`, `activity*`, `api`, `ui/format`, `ui/dom` to `.ts`; update importers in `server/`, `src/` and `test/` in the same PR
- [x] 3a: type `SafeHtml`, `html(strings: TemplateStringsArray, ...values)` and `setHtml(element, markup: SafeHtml)`; keep the private-field brand, construction token and sole sink; add a `@ts-expect-error` type test showing a raw string, a plain array and a lookalike object are rejected
- [x] 3b: remaining `src/ui/*`, `src/web` and `web/theme` to `.ts`; check by hand that the stored theme applies on first paint with no flash, and that `dist/web/theme.js` has no `export`
- [x] Idiomorph keeps its vendored bytes and `.d.ts` (`test/vendor.test.js` hash unchanged)
- [x] No `.js` left under `src/`; full CI green in each PR

## Phase 4: server and scripts (about 8,200 lines)

- [x] 4a: lower-risk `server/*` modules, `server.ts`, `scripts/*.ts`; `start`, `demo`, `doctor` point at `.ts`; add `scripts/**` to the node config and fix the 93 strict errors it surfaces
- [ ] 4b: `server/store`, `sync`, `azure-*` and `checkout-*` to `.ts`, with the full cross-model review `docs/MAINTAINING.md:72` requires for these paths
- [x] `server/checkout-delete-guard.cjs` stays CommonJS JavaScript: it is copied as an extensionless Git hook, and Node cannot strip types there (verified)
- [x] Audit `new URL(..., import.meta.url)` and dynamic imports for `.js` paths
- [ ] Full CI green on both OSes; `npm start`, `npm run demo` and `npm run doctor` run

## Phase 5: unit tests (40 files, about 12,000 lines, 2 to 3 PRs)

Scope depends on **D2**.

- [ ] While mixed, `test` runs `node --test "test/*.test.js" "test/*.test.ts"` (no brace globs, for Windows); after the last batch, `"test/*.test.ts"` only
- [ ] Fix string paths to renamed modules: `test/azure-cli.test.js:23`, `test/azure-rest.test.js:276`, `test/doctor.test.js:12,250`
- [ ] Typed stub factories in `test/fixtures/` instead of `as any` for partial fakes
- [ ] The HTML-regex rule still fires on the three renamed UI tests (seeded check)
- [ ] Test count unchanged (469) and CI green after each batch

## Phase 6: e2e (3 files, about 3,700 lines)

- [ ] `e2e/*.test.ts`; `test:ui` runs `node --test "e2e/*.test.ts"`; 85 Chromium tests pass

## Phase 7: close-out

- [ ] Remove `allowJs`/`checkJs` and the `.js` include globs; keep the `.cjs` hook checked explicitly
- [ ] Delete the codemod script
- [ ] Update `.js` paths and commands in the living docs: `docs/MAINTAINING.md` (66 references), README (4), `PLAN.md` (2). Leave dated records (`docs/probe-results.md`, `docs/IMPROVEMENT-PLAN.md`, `docs/FULL-COVERAGE-RESEARCH.md`) as written; also rename `.js` file names in comments under `test/` and `e2e/` (`server/`, `src/` and `scripts/` were done in Phase 4b, and `docs/MAINTAINING.md`'s review-tier paths too)
- [ ] Clean-clone `npm ci` plus the full check matrix; no `.js` outside `dist/` and `web/vendor/` except the hook

## Phase 8: stricter compiler flags (one PR each)

- [ ] `noUncheckedIndexedAccess` (124 errors in today's production code)
- [ ] `exactOptionalPropertyTypes` (46 errors)

## Phase 9: type-aware lint

- [ ] Add `oxlint-tsgolint@7.0.2008`; enable `no-floating-promises` and `no-misused-promises`
- [ ] Fix or justify the 7 known findings (`src/ui/dom.js:34`, `server.js:685`, `server.js:860-861`, `server/open-browser.js:60`, `src/ui/saved-filters.js:101`, `src/ui/history-import.js:54`); a real bug gets a failing test first

## Rules for every phase

- Conversion PRs preserve behaviour. A real bug the types expose gets its own commit with a failing test first.
- No stricter flags or new lint rules inside conversion PRs; they have their own phases.

## Later (out of scope)

- Replace `AzureRecord = any` (32 uses) and SQLite `parse: any` casts with `unknown` plus guards and per-table row readers
- Oxlint's default correctness rules (7 warnings, including a `'\/'` escape at `e2e/history.test.js:818`)
- TypeScript 7.1 once it and a matching `oxlint-tsgolint` are stable; `oxfmt` once it reaches 1.0

## Decisions

Decided 2026-11-23 when the owner asked for the full migration to start now.

- **D1** Browser delivery: A, `tsc` emit to `dist/`.
- **D2** Test strictness: full strict, converted in batches.
- **D3** Timing: all phases now, one PR per phase, each merged before the next starts.

## Effort

Round-one estimates ranged from 7 to 19 days. With Phases 8 and 9 in scope, plan for about 11 to 12
working days; tests (Phases 5 and 6) are about half.
