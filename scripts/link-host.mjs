// Link the host packages this plugin imports at runtime.
//
// Why this exists, and why losing it is serious:
//
// `lib/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` as a VALUE,
// not a type. Host packages are deliberately not dependencies — a properly
// installed plugin resolves them by walking up into the profile tree, where
// `profiles/node_modules/@deepseek-ai/*` sits.
//
// A `link:` development install breaks that walk: the plugin's real path is
// somewhere like /Users/you/Project/plugin, and no ancestor of it contains
// `profiles/node_modules`. The import then fails, the plugin tree fails to load,
// and DSH treats that as fatal — it recovers into Safe Mode with every
// third-party plugin disabled.
//
// The loader makes this harder to read than it should be: it reports the
// OUTERMOST specifier ("Cannot find package 'dsh-xcodebuild'") because its
// retry path swallows the real error. The actual failure is the missing host
// package below.
//
// So for development, link the host package here. `npm test` needs it too.
//
// Run: node scripts/link-host.mjs

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = '@deepseek-ai/dsh-tools'

/** Places the deployment keeps its own node_modules, newest-looking first. */
function candidates() {
  const fromEnv = process.env.DSH_APP_ROOT
  const roots = [
    fromEnv,
    '/Applications/DSH Desktop.app/Contents/Resources/app',
    join(process.env.HOME ?? '', 'Applications/DSH Desktop.app/Contents/Resources/app'),
  ]
  return roots.filter((root) => typeof root === 'string' && root !== '')
}

const found = candidates()
  .map((root) => join(root, 'node_modules', PACKAGE))
  .find((path) => existsSync(path))

if (found === undefined) {
  console.error(`Could not find ${PACKAGE} in any of:`)
  for (const root of candidates()) console.error(`  ${join(root, 'node_modules', PACKAGE)}`)
  console.error('\nSet DSH_APP_ROOT to the deployment\'s Resources/app directory and retry.')
  process.exit(1)
}

const scope = join(ROOT, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })

const link = join(scope, 'dsh-tools')
rmSync(link, { force: true })
symlinkSync(found, link, 'dir')

console.log(`linked ${PACKAGE}`)
console.log(`  ${link} -> ${found}`)
console.log('\nThe import in lib/index.js now resolves. Verify with:')
console.log('  node --input-type=module -e "await import(\'./lib/index.js\')" && echo ok')
