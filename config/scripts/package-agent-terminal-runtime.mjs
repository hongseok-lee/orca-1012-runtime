import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package the installed, patched node-pty and its actually loadable addon.
 * No download, native compilation, archive extraction or application build. */
export async function packageAgentTerminalRuntime(projectRoot, outputDirectory) {
  if (process.platform !== 'linux') { throw new Error('AGENT_TERMINAL_PLATFORM') }
  const require = createRequire(join(resolve(projectRoot), 'package.json'))
  const entry = require.resolve('node-pty'), libraryDirectory = dirname(entry)
  require(entry)
  const utils = require(join(libraryDirectory, 'utils.js'))
  const loaded = utils.loadNativeModule('pty').module
  const addonPath = Object.values(require.cache).find(item => item?.exports === loaded && item.filename.endsWith('.node'))?.filename
  if (!addonPath) { throw new Error('AGENT_TERMINAL_ADDON_UNRESOLVED') }
  const addon = await readFile(await realpath(addonPath))
  const { build } = require('esbuild')
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs',
    define: { 'process.platform': '"linux"' }, external: ['./terminal-pty.node'], legalComments: 'inline',
    plugins: [{ name: 'fixed-native-addon', setup(build) {
      build.onLoad({ filter: /[/\\]utils\.js$/ }, async args => {
        if (args.path !== join(libraryDirectory, 'utils.js')) { return undefined }
        return { contents: `${await readFile(args.path, 'utf8')}
exports.loadNativeModule = function(name) {
  if (name !== 'pty') throw new Error('AGENT_TERMINAL_ADDON_NAME');
  return { dir: __dirname, module: require('./terminal-pty.node') };
};`, resolveDir: libraryDirectory, loader: 'js' }
      })
    } }] })
  if (bundle.outputFiles.length !== 1) { throw new Error('AGENT_TERMINAL_BUNDLE_SHAPE') }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const files = []
  for (const [name, bytes] of [['terminal-runtime.cjs', bundle.outputFiles[0].contents], ['terminal-pty.node', addon]]) {
    await writeFile(join(outputDirectory, name), bytes, { flag: 'wx', mode: 0o700 })
    files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length })
  }
  const manifest = { version: 1, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, files }
  await writeFile(join(outputDirectory, 'terminal-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) { throw new Error('Usage: package-agent-terminal-runtime.mjs PROJECT_ROOT OUTPUT_DIRECTORY') }
  console.log(JSON.stringify(await packageAgentTerminalRuntime(process.argv[2], process.argv[3])))
}
