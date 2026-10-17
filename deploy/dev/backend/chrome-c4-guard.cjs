#!/usr/local/bin/node
'use strict'

const { createHash } = require('node:crypto')
const { isAbsolute, join } = require('node:path')

function decline() {
  process.stderr.write('C4 credential-free development scope was not approved or does not match.\n')
  process.exit(78)
}

let scope
try {
  scope = JSON.parse(process.env.ORCA_C4_BROWSER_DEV_SCOPE ?? 'null')
} catch {
  decline()
}
if (!scope || scope.kind !== 'c4-credential-free-about-blank-loopback' ||
    scope.newProfile !== true || typeof scope.userDataPath !== 'string' ||
    !isAbsolute(scope.userDataPath)) {
  decline()
}
const profile = join(scope.userDataPath, 'browser-chromium')
const session = 'orca-orcad-' + createHash('sha256')
  .update(`${scope.userDataPath}:chromium`).digest('hex').slice(0, 16)
if (process.getuid() !== 1000 || process.env.AGENT_BROWSER_PROFILE !== profile ||
    process.env.AGENT_BROWSER_SESSION !== session) {
  decline()
}

const allowed = new Set(['about:blank'])
if (scope.fixtureUrl !== null) {
  let fixture
  try {
    fixture = new URL(scope.fixtureUrl)
  } catch {
    decline()
  }
  if (typeof scope.fixtureUrl !== 'string' ||
      !['http:', 'https:'].includes(fixture.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(fixture.hostname) ||
      fixture.username || fixture.password) {
    decline()
  }
  allowed.add(scope.fixtureUrl)
}

const args = process.argv.slice(2)
let profiles = 0
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--user-data-dir') {
    if (args[++index] !== profile) decline()
    profiles++
  } else if (arg.startsWith('--user-data-dir=')) {
    if (arg.slice('--user-data-dir='.length) !== profile) decline()
    profiles++
  } else if (!arg.startsWith('-') && !allowed.has(arg)) {
    decline()
  }
}
if (profiles !== 1) {
  decline()
}
// Validation only. The shell parent keeps Chrome's inherited CDP pipe FDs.
