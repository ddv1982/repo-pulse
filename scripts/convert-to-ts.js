// Temporary codemod for the TypeScript migration (docs/typescript-migration.md); Phase 7 deletes it.
//
//   node scripts/convert-to-ts.js src/events.js src/sync-worst.js
//
// For the given JavaScript files it:
// 1. renames each to .ts with `git mv`;
// 2. points every relative specifier that resolves to a renamed file at the .ts name, in every tracked JS and TS
//    file: `from '...'`, `import '...'`, `import('...')` and JSDoc `import('...')` types;
// 3. turns JSDoc into TypeScript in the renamed files with TypeScript 6.0.3's language service (TypeScript 7 has no
//    JavaScript API): the `convertTypedefToType` and `annotateWithTypeFromJSDoc` fixes (working around two defects of
//    the former and four of the latter, see typedefEdits, arrowEdits, templateEdits, optionalEdits and bindingEdits),
//    then JSDoc casts, nested ones included (`/** @type {T} */ (x)` and `@satisfies`), which TypeScript ignores in a
//    .ts file, become `as` and `satisfies`, keeping `(a ?? b)` parenthesized so the whole expression is cast;
// 4. exports the top-level type aliases and interfaces, as JSDoc typedefs were;
// 5. removes the JSDoc types the TypeScript now carries and `// @ts-check`, keeping the prose (see jsdocEdits), and
//    formats the files with Prettier.
// Review the diff, check any JSDoc tag it reports as kept, and run `npm run check:types` afterwards.
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

// TypeScript reports file names with forward slashes, also on Windows.
const targets = [...renamed.values()].map(file => file.replaceAll('\\', '/'));
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
    if (node.getChildren(source).some(/** @param {any} child */ child => child.kind === ts.SyntaxKind.OpenParenToken)) return;
    edits.push(
      { span: { start: parameter.getStart(source), length: 0 }, newText: '(' },
      { span: { start: parameter.end, length: 0 }, newText: ')' },
    );
  });
  return edits;
}

/**
 * Ends each JSDoc comment that holds a `@typedef` and is followed by another JSDoc comment with an empty statement:
 * TypeScript 6.0.3's convertTypedefToType does nothing for a typedef whose statement has a later JSDoc comment, such as
 * the `@param` block of the function below it. Prettier removes the empty statements again.
 * @param {string} file
 */
function typedefEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    for (const doc of node.jsDoc?.slice(0, -1) ?? [])
      if (doc.tags?.some(ts.isJSDocTypedefTag)) edits.push({ span: { start: doc.end, length: 0 }, newText: ';' });
  });
  return edits;
}

/**
 * Restores `@template {C} T` constraints, which annotateWithTypeFromJSDoc drops, and the `@template` parameters of a
 * generic `@typedef`, which convertTypedefToType drops altogether.
 * @param {string} file
 */
function templateEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    if (ts.isTypeAliasDeclaration(node) && !node.typeParameters) {
      const parameters = ts
        .getJSDocTags(node)
        .filter(ts.isJSDocTemplateTag)
        .flatMap(
          /** @param {any} tag */ tag =>
            tag.typeParameters.map(
              /** @param {any} p */ p =>
                p.name.text +
                (tag.constraint ? ` extends ${tag.constraint.type.getText(source)}` : '') +
                (p.default ? ` = ${p.default.getText(source)}` : ''),
            ),
        );
      if (parameters.length) edits.push({ span: { start: node.name.end, length: 0 }, newText: `<${parameters.join(', ')}>` });
      return;
    }
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

/** Restores the `?` of optional `@param {T} [name]` parameters, which annotateWithTypeFromJSDoc drops. @param {string} file */
function optionalEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    if (!ts.isParameter(node) || node.questionToken || node.initializer || node.dotDotDotToken || !ts.isIdentifier(node.name)) return;
    if (ts.getJSDocParameterTags(node).some(/** @param {any} tag */ tag => tag.isBracketed))
      edits.push({ span: { start: node.name.end, length: 0 }, newText: '?' });
  });
  return edits;
}

/** Adds the `@type` of a destructuring declaration, which annotateWithTypeFromJSDoc leaves out. @param {string} file */
function bindingEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  walk(source, node => {
    if (!ts.isVariableDeclaration(node) || node.type || ts.isIdentifier(node.name)) return;
    const tag = ts.getJSDocTypeTag(node);
    if (tag) edits.push({ span: { start: node.name.end, length: 0 }, newText: `: ${tag.typeExpression.type.getText(source)}` });
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
    // The full text keeps the JSDoc of a nested cast, which getText would drop, for the next pass to convert.
    let expression = node.expression.getFullText(source).trim();
    // `as` and `satisfies` bind tighter than these, so `(a ?? b as T)` would cast only `b`.
    const { expression: inner } = node;
    if (ts.isBinaryExpression(inner) || ts.isConditionalExpression(inner) || ts.isArrowFunction(inner) || ts.isYieldExpression(inner))
      expression = `(${expression})`;
    const newText = `(${expression} ${operator} ${tag.typeExpression.type.getText(source)})`;
    edits.push({ span: { start, length: node.end - start }, newText });
  };
  visit(source);
  return edits;
}

/**
 * Puts `export` before each top-level type alias and interface that lacks it, in modules only: an export would turn a
 * classic script such as web/theme into a module.
 * @param {string} file
 */
function exportEdits(file) {
  const source = parse(file);
  if (
    !source.statements.some(
      /** @param {any} node */ node =>
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node) ||
        node.modifiers?.some(/** @param {any} modifier */ modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
  )
    return [];
  return source.statements
    .filter(
      /** @param {any} node */ node =>
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        !node.modifiers?.some(/** @param {any} modifier */ modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map(/** @param {any} node */ node => ({ span: { start: node.getStart(source), length: 0 }, newText: 'export ' }));
}

/**
 * Removes the JSDoc types that the TypeScript now carries, which TypeScript ignores in a .ts file: the `{T}` of
 * `@param`, `@returns` and `@type` whose declaration has a type annotation, and `@template` tags of declarations with
 * type parameters. A tag without prose goes entirely; prose stays. A tag whose declaration has no annotation is kept and
 * printed, to be checked by hand.
 * @param {string} file
 */
function jsdocEdits(file) {
  const source = parse(file);
  /** @type {{ span: { start: number, length: number }, newText: string }[]} */
  const edits = [];
  /** @type {Set<any>} */
  const handled = new Set();
  /** @param {any} tag */
  const strip = tag => {
    if (handled.has(tag)) return;
    handled.add(tag);
    const start = tag.pos;
    const prose = tag.comment && !ts.isJSDocTemplateTag(tag);
    if (!prose) return edits.push({ span: { start, length: tag.end - start }, newText: '' });
    // Keep `@param name` and `@returns`; a `@type` tag keeps only its prose.
    const from = ts.isJSDocTypeTag(tag) ? start : tag.typeExpression.pos;
    let to = tag.typeExpression.end;
    while (/\s/.test(source.text[to])) to++;
    edits.push({ span: { start: from, length: to - from }, newText: '' });
  };
  walk(source, node => {
    if (ts.isParameter(node)) for (const tag of ts.getJSDocParameterTags(node)) if (tag.typeExpression && node.type) strip(tag);
    if (ts.isFunctionLike(node)) {
      const tag = ts.getJSDocReturnTag(node);
      if (tag?.typeExpression && node.type) strip(tag);
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) {
      const tag = ts.getJSDocTypeTag(node);
      if (tag && node.type) strip(tag);
    }
    if (node.typeParameters)
      for (const tag of ts.getJSDocTags(node).filter(ts.isJSDocTemplateTag))
        if (
          tag.typeParameters.every(
            /** @param {any} p */ p => node.typeParameters.some(/** @param {any} q */ q => q.name.text === p.name.text),
          )
        )
          strip(tag);
  });
  walk(source, node => {
    for (const doc of node.jsDoc ?? [])
      for (const tag of doc.tags ?? [])
        if (!handled.has(tag) && (tag.typeExpression || ts.isJSDocTemplateTag(tag))) {
          handled.add(tag);
          const { line } = source.getLineAndCharacterOfPosition(tag.pos);
          console.warn(`${file}:${line + 1}: kept JSDoc @${tag.tagName.text}; check it by hand`);
        }
  });
  return edits;
}

/**
 * Tidies the comments jsdocEdits emptied or shortened, joins the one-line comments that convertTypedefToType
 * splits over two lines, and drops `// @ts-check`, which a .ts file does not need.
 * @param {string} text
 */
const tidyComments = text =>
  text
    .replace(/^\/\/ @ts-check\n\n?/, '')
    .replace(/\/\*\* ([^\n]*?)\n[ \t]*\*\//g, '/** $1 */')
    .replace(/^[ \t]*\/\*\*[\s*]*\*\/[ \t]*\n/gm, '')
    .replace(/\/\*\*[\s*]*\*\/[ \t]*/g, '')
    .replace(/\n([ \t]*)\* \*\//g, '\n$1*/')
    .replace(/\n[ \t]*\*[ \t]*\n([ \t]*\*\/)/g, '\n$1');

for (const file of targets) {
  apply(file, arrowEdits(file));
  apply(file, typedefEdits(file));
  for (const fix of ['convertTypedefToType', 'annotateWithTypeFromJSDoc']) {
    const { changes } = service.getCombinedCodeFix({ type: 'file', fileName: file }, fix, ts.getDefaultFormatCodeSettings(), {});
    for (const change of changes) apply(change.fileName, change.textChanges);
  }
  apply(file, templateEdits(file));
  apply(file, optionalEdits(file));
  apply(file, bindingEdits(file));
  for (let edits = castEdits(file); edits.length; edits = castEdits(file)) apply(file, edits);
  apply(file, exportEdits(file));
  apply(file, jsdocEdits(file));
  writeFileSync(file, tidyComments(/** @type {any} */ (sources.get(file)).text));
}
execFileSync('npx', ['prettier', '--write', ...targets], { stdio: 'inherit', shell });
console.log(`Converted ${targets.length} files. Run npm run check:types and review the diff.`);
