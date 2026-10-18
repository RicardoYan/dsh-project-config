// Builds the published bundles from the TypeScript sources.
//
//   src/**/*.ts   → lib/**/*.js     ESM, loaded by the Host through Node
//   src/client.ts → lib/client.js   classic script registering window.__ModuleLoader__
//
// The Host half may span several modules and nested folders (this plugin keeps
// its settings, workspace and feature modules apart), so every Host source is
// emitted beside its siblings and relative imports keep working unchanged.
//
// Type checking is a separate step (`npm run typecheck`): tsc here only strips
// types, so a build never depends on the checker having passed.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const OUT = join(ROOT, 'lib')

const HOST = {
  target: ts.ScriptTarget.ES2024,
  // `transpileModule` sees one file and no package.json, so ESM has to be spelled
  // out here; NodeNext would fall back to CommonJS and break the package's exports.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: false,
  sourceMap: false,
  declaration: false,
}

const CLIENT = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: false,
  sourceMap: false,
  declaration: false,
}

/** Compile one source file in memory and return the emitted JavaScript. */
async function emit(file, options) {
  const result = ts.transpileModule(await readFile(file, 'utf8'), { fileName: file, compilerOptions: options })
  if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    })
    throw new Error(formatted)
  }
  return result.outputText
}

/**
 * Wrap a module body as one classic script.
 *
 * The browser loads client bundles as classic `<script>` elements, several of
 * them concatenated into one combo response, so top-level `const`/`let` would
 * share a single global lexical scope across every plugin (`Identifier 'NS'
 * has already been declared`). Leading `"use strict"` is hoisted out of the
 * wrapper so the directive still applies. The module marker tsc appends is
 * dropped: `export {}` is a syntax error in a classic script, and the bundle's
 * only effect is the `window.__ModuleLoader__` call.
 * @param code - the emitted module text.
 * @returns the same program as one self-contained classic script.
 */
function asClassicScript(code) {
  const body = code.replace(/\n*export \{\};\s*$/, '\n')
  const strict = body.match(/^(["'])use strict\1;\n/) === null ? '' : '"use strict";\n'
  const rest = strict === '' ? body : body.slice('"use strict";\n'.length)
  return `${strict}(() => {\n${rest.trimEnd()}\n})();\n`
}

/** Every `.ts` file under `dir`, as paths relative to `src`. */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.ts')) out.push(relative(SRC, full))
  }
  return out.sort()
}

const sources = await walk(SRC)
if (!sources.includes('index.ts')) throw new Error('src/index.ts is required: it is the package entry')
// `client.ts` is the browser half and `*.guards.ts` files are type-only; the rest
// make up the Host bundle.
const isClient = (name) => name === 'client.ts'
const isTypeOnly = (name) => name.endsWith('.guards.ts')

await rm(OUT, { recursive: true, force: true })
const built = []
for (const name of sources) {
  if (isClient(name) || isTypeOnly(name)) continue
  const target = resolve(OUT, name.replace(/\.ts$/, '.js'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await emit(join(SRC, name), HOST), 'utf8')
  built.push(`lib/${name.replace(/\.ts$/, '.js').split(sep).join('/')}`)
}
// A package without a browser half (no `dsh.client` declaration) ships only the
// Host bundle; only compile the client entry when its source exists.
if (existsSync(join(SRC, 'client.ts'))) {
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'client.js'), asClassicScript(await emit(join(SRC, 'client.ts'), CLIENT)), 'utf8')
  built.push('lib/client.js')
}
console.log(`built ${built.join(', ')}`)
