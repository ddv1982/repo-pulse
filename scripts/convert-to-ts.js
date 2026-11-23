// Temporary codemod for the TypeScript migration (docs/typescript-migration.md); Phase 7 deletes it.
//
//   node scripts/convert-to-ts.js src/events.js src/sync-worst.js
//
// For the given JavaScript files it:
// 1. renames each to .ts with `git mv`;
// 2. points every relative specifier that resolves to a renamed file at the .ts name, in every tracked JS and TS
//    file: `from '...'`, `import '...'`, `import('...')` and JSDoc `import('...')` types;
// 3. turns JSDoc into TypeScript in the renamed files with TypeScript 6.0.3's language service (TypeScript 7 has no
//    JavaScript API): the `convertTypedefToType` and `annotateWithTypeFromJSDoc` fixes (working around two of the
//    latter's defects, see arrowEdits and templateEdits), then JSDoc casts (`/** @type {T} */ (x)` and
//    `@satisfies`), which TypeScript ignores in a .ts file, become `as` and `satisfies`;
// 4. exports the top-level type aliases and interfaces, as JSDoc typedefs were, and formats the files with Prettier.
// Review the diff and run `npm run check:types` afterwards; the fixes leave the old JSDoc comments in place.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';

const files = process.argv.slice(2).map(file => resolve(file));
if (!files.length || files.some(file => !file.endsWith('.js') || !existsSync(file))) {
  console.error('Usage: node scripts/convert-to-ts.js <existing .js file>...');
  process.exit(1);
}
const shell = process.platform === 'win32';
const renamed = new Map(files.map(file => [file, file.replace(/\.js$/, '.ts')]));

for (const [from, to] of renamed) execFileSync('git', ['mv', from, to]);

const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*?)\.js\2/g;
const tracked = execFileSync('git', ['ls-files', '-z', '*.js', '*.ts', '*.cjs', '*.mjs'], { encoding: 'utf8' })
  .split('\0')
  .filter(file => file && !file.startsWith('web/vendor/'));
for (const file of tracked.map(file => resolve(file))) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(specifier, (match, keyword, quote, path) =>
    renamed.has(resolve(dirname(file), `${path}.js`)) ? `${keyword}${quote}${path}.ts${quote}` : match,
  );
  if (next !== text) writeFileSync(file, next);
}

// npx puts the package's .bin on PATH for the command it runs; load TypeScript 6.0.3 from beside it.
const path = execFileSync('npx', ['-y', '-p', 'typescript@6.0.3', 'node', '-e', 'process.stdout.write(process.env.PATH)'], {
  encoding: 'utf8',
  shell,
});
const packageDir = path
  .split(delimiter)
  .map(bin => join(bin, '..', 'typescript'))
  .find(dir => existsSync(join(dir, 'package.json')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === '6.0.3');
if (!packageDir) throw new Error('Could not find typescript@6.0.3 through npx.');
/** @type {any} TypeScript 6's API; the project's own TypeScript 7 has no types for it. */
const ts = createRequire(import.meta.url)(packageDir);

const targets = [...renamed.values()];
/** @type {Map<string, { text: string, version: number }>} */
const sources = new Map(targets.map(file => [file, { text: readFileSync(file, 'utf8'), version: 0 }]));
const { options } = ts.convertCompilerOptionsFromJson(JSON.parse(readFileSync('tsconfig.base.json', 'utf8')).compilerOptions, '.');
const service = ts.createLanguageService({
  getCompilationSettings: () => options,
  getScriptFileNames: () => targets,
  getScriptVersion: file => String(sources.get(file)?.version ?? 0),
  getScriptSnapshot: file => {
    const text = sources.get(file)?.text ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
  fileExists: file => sources.has(file) || ts.sys.fileExists(file),
  readFile: file => sources.get(file)?.text ?? ts.sys.readFile(file),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});

/** @param {string} file @param {{ span: { start: number, length: number }, newText: string }[]} changes */
function apply(file, changes) {
  const source = /** @type {{ text: string, version: number }} */ (sources.get(file));
  for (const { span, newText } of [...changes].sort((a, b) => b.span.start - a.span.start))
    source.text = source.text.slice(0, span.start) + newText + source.text.slice(span.start + span.length);
  source.version++;
}

/** @param {string} file */
const parse = file =>
  ts.createSourceFile(file, /** @type {any} */ (sources.get(file)).text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** @param {any} root @param {(node: any) => void} visit */
function walk(root, visit) {
  /** @param {any} node */
  const each = node => {
    visit(node);
    ts.forEachChild(node, each);
  };
  each(root);
}

/**
 * Parenthesizes the lone parameter of `x => ...`: TypeScript 6.0.3's annotateWithTypeFromJSDoc otherwise writes its
 * `@param` type as the return type (`(x): T => ...`). Prettier removes the parentheses again where no type is added.
 * @param {string} file
 */
function arrowEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    if (!ts.isArrowFunction(node) || node.parameters.length !== 1) return;
    const [parameter] = node.parameters;
    if (source.text[parameter.getStart(source) - 1] === '(') return;
    edits.push(
      { span: { start: parameter.getStart(source), length: 0 }, newText: '(' },
      { span: { start: parameter.end, length: 0 }, newText: ')' },
    );
  });
  return edits;
}

/** Restores `@template {C} T` constraints, which annotateWithTypeFromJSDoc drops. @param {string} file */
function templateEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    if (!node.typeParameters || !ts.isFunctionLike(node)) return;
    for (const tag of ts.getJSDocTags(node).filter(ts.isJSDocTemplateTag)) {
      if (!tag.constraint) continue;
      for (const name of tag.typeParameters) {
        const parameter = node.typeParameters.find(/** @param {any} p */ p => p.name.text === name.name.text && !p.constraint);
        if (parameter)
          edits.push({ span: { start: parameter.name.end, length: 0 }, newText: ` extends ${tag.constraint.type.getText(source)}` });
      }
    }
  });
  return edits;
}

/** Each outermost JSDoc cast in the file as an edit; nested casts are left for the next pass. @param {string} file */
function castEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  /** @param {any} node */
  const visit = node => {
    const doc = ts.isParenthesizedExpression(node) ? node.jsDoc?.at(-1) : undefined;
    const tag = doc?.tags?.find(/** @param {any} tag */ tag => ts.isJSDocTypeTag(tag) || ts.isJSDocSatisfiesTag(tag));
    if (!tag) return ts.forEachChild(node, visit);
    const start = doc.pos;
    const operator = ts.isJSDocTypeTag(tag) ? 'as' : 'satisfies';
    const newText = `(${node.expression.getText(source)} ${operator} ${tag.typeExpression.type.getText(source)})`;
    edits.push({ span: { start, length: node.end - start }, newText });
  };
  visit(source);
  return edits;
}

/** Puts `export` before each top-level type alias and interface that lacks it. @param {string} file */
function exportEdits(file) {
  const source = parse(file);
  return source.statements
    .filter(
      /** @param {any} node */ node =>
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        !node.modifiers?.some(/** @param {any} modifier */ modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map(/** @param {any} node */ node => ({ span: { start: node.getStart(source), length: 0 }, newText: 'export ' }));
}

for (const file of targets) {
  apply(file, arrowEdits(file));
  for (const fix of ['convertTypedefToType', 'annotateWithTypeFromJSDoc']) {
    const { changes } = service.getCombinedCodeFix({ type: 'file', fileName: file }, fix, ts.getDefaultFormatCodeSettings(), {});
    for (const change of changes) apply(change.fileName, change.textChanges);
  }
  apply(file, templateEdits(file));
  for (let edits = castEdits(file); edits.length; edits = castEdits(file)) apply(file, edits);
  apply(file, exportEdits(file));
  writeFileSync(file, /** @type {any} */ (sources.get(file)).text);
}
execFileSync('npx', ['prettier', '--write', ...targets], { stdio: 'inherit', shell });
console.log(`Converted ${targets.length} files. Run npm run check:types and review the diff.`);
