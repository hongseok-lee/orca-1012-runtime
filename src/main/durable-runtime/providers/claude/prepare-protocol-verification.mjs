import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [sourceRoot, artifactRoot, cachedPackageJson, fixtureEntry = 'driver.test.mts'] = process.argv.slice(2)
if (!sourceRoot || !artifactRoot || !cachedPackageJson) {
  throw new Error('Provide owned source/artifact roots and an existing esbuild cache resolver')
}
if (!['driver.test.mts', 'cold-focus.test.mts'].includes(fixtureEntry)) {
  throw new Error('Choose an owned provider protocol fixture entry')
}
const { build, transform } = createRequire(cachedPackageJson)('esbuild')
await mkdir(artifactRoot, { recursive: true })
await build({ entryPoints: [join(sourceRoot, 'src/main/durable-runtime/providers/claude', fixtureEntry)],
  outfile: join(artifactRoot, fixtureEntry === 'cold-focus.test.mts' ? 'cold-focus.test.mjs' : 'protocol.test.mjs'),
  bundle: true, platform: 'node', target: 'node24',
  format: 'esm', packages: 'external', logLevel: 'warning' })
if (fixtureEntry === 'driver.test.mts') {
  const nativeSource = await readFile(join(sourceRoot, 'src/main/durable-runtime/providers/claude/native-transport.ts'), 'utf8')
  const native = await transform(nativeSource, { loader: 'ts', target: 'node24', format: 'esm' })
  await writeFile(join(artifactRoot, 'native-transport.syntax.mjs'), native.code)
}
console.log(JSON.stringify({ protocolEntryBundled: true, nativeTransportSyntaxTransformed: fixtureEntry === 'driver.test.mts',
  nativeTransportExecuted: false, providerCalls: 0 }))
