import { join } from 'node:path'

// Native addons must exist on the host; they cannot be bundled.
// `electron` is external so a residual import fails loudly at require() time rather
// than silently bundling the npm package's installer shim, which is what happened the
// first time and made the bundle look clean while it was not.
// Why only these: measured, not guessed. `node-pty` is a hard `require.resolve` — orcad
// exits at startup without it. `@parcel/watcher` is a guarded dynamic import, so the
// server boots without it but every watch install fails. `fsevents` is macOS-only and
// optional upstream. better-sqlite3 / keytar / cpu-features were externalized here
// defensively and appear nowhere in the graph; listing them implied a shipping burden
// that does not exist.
export const ORCAD_EXTERNAL = ['electron', 'node-pty', '@parcel/watcher', 'fsevents']

/** Why: the UMD build's relative dynamic requires do not bundle. Same fix build-relay.mjs uses. */
function jsoncParserEsm(root) {
  return {
    name: 'jsonc-parser-esm',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^jsonc-parser$/ }, () => ({
        path: join(root, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')
      }))
    }
  }
}

/** Why: optional native deps reference prebuilt .node files that may not exist here. */
const externalNativeAddons = {
  name: 'external-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }))
  }
}

export function orcadBuildOptions(root, entryPoints, destination, main = true) {
  return {
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    ...destination,
    external: ORCAD_EXTERNAL,
    plugins: main ? [jsoncParserEsm(root), externalNativeAddons] : [externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent'
  }
}

export function orcadGraphErrors(metafiles) {
  const importers = (matches) => {
    const files = new Set()
    for (const metafile of metafiles) {
      for (const [file, info] of Object.entries(metafile.inputs)) {
        for (const imported of info.imports ?? []) {
          if (matches(imported.original ?? imported.path)) {
            files.add(file)
          }
        }
      }
    }
    return [...files]
  }
  return [
    ['electron', importers((s) => s === 'electron' || s.startsWith('electron/'))],
    ['node:sqlite', importers((s) => s === 'node:sqlite')]
  ]
    .filter(([, files]) => files.length)
    .map(
      ([name, files]) =>
        `${files.length} module(s) in the bundle import ${name}:\n${files.map((f) => `  - ${f}`).join('\n')}`
    )
}
