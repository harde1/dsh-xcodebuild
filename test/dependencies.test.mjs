// The plugin runs tools that macOS and Xcode do not provide, and it is meant to be
// handed to somebody else's machine.
//
// The failure this file exists for: half the device support lives in three SEPARATE
// Homebrew formulae. `brew install libimobiledevice` provides neither
// `ideviceinstaller` nor `ios-deploy`, so following the obvious instruction leaves
// installing and launching an iOS 16 phone both broken — and the breakage lands on a
// user holding the phone, as `spawn ideviceinstaller ENOENT`.
//
// So the source is the fixture: every command the code can spawn is scraped out of
// `lib/index.js` and has to appear in `DEPENDENCIES` with a purpose and an install
// command. Adding a spawn without registering it fails here.
//
// Run: node test/dependencies.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEPENDENCIES,
  LEGACY_TOOLCHAIN_INSTALL,
  doctorReport,
  legacyTool,
  missingToolNotice,
  resolveTool,
} from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual: ${JSON.stringify(actual)} expected: ${JSON.stringify(expected)}`,
  )
}

// --- scrape every command the source can run ------------------------------

/** `capture(['cmd', ...])` and friends, plus bare `spawn('cmd', ...)`. */
function fromCalls(text) {
  const pattern = /(?:capture|captureTee|spawnStreaming|captureBounded|spawn)\(\s*(?:\[\s*)?'([a-zA-Z][\w.-]*)'/g
  return [...text.matchAll(pattern)].map((match) => match[1])
}

/** `const argv = ['cmd', ...]` — the arrays that end up in a spawn. */
function fromArgv(text) {
  const pattern = /const (?:argv|install|launch) = \[\s*'([a-zA-Z][\w.-]*)'/g
  return [...text.matchAll(pattern)].map((match) => match[1])
}

/** `legacyTool('cmd')`, `resolveTool('cmd')`, `missingToolNotice('cmd')`. */
function fromHelpers(text) {
  const pattern = /(?:legacyTool|resolveTool|missingToolNotice)\('([^']+)'\)/g
  return [...text.matchAll(pattern)].map((match) => match[1])
}

const scraped = [...new Set([...fromCalls(SOURCE), ...fromArgv(SOURCE), ...fromHelpers(SOURCE)])].sort()
const registered = DEPENDENCIES.map((entry) => entry.command).sort()

console.log(`source runs: ${scraped.join(', ')}`)
console.log(`registered:  ${registered.join(', ')}`)

equal(scraped, registered, 'every command the source runs is registered as a dependency')

check(scraped.length >= 9, 'the scrape found the full set, or it is not actually checking anything',
  `${scraped.length} commands`)

// --- every entry is usable on its own -------------------------------------

for (const entry of DEPENDENCIES) {
  check(typeof entry.purpose === 'string' && entry.purpose.length > 10,
    `${entry.command} says what it is for`, entry.purpose)
  check(typeof entry.install === 'string' && entry.install !== '',
    `${entry.command} says how to install it`, entry.install)
  check(typeof entry.required === 'boolean', `${entry.command} is explicit about being required`)
  check(typeof entry.group === 'string' && entry.group !== '', `${entry.command} belongs to a group`)
}

// The three that are easiest to get wrong: two of them are NOT in the package whose
// name suggests it provides them.
const formulaOf = (command) => DEPENDENCIES.find((entry) => entry.command === command)?.install
equal(formulaOf('ideviceinstaller'), 'brew install ideviceinstaller',
  'ideviceinstaller is its own formula, not part of libimobiledevice')
equal(formulaOf('ios-deploy'), 'brew install ios-deploy',
  'ios-deploy is its own formula, not part of libimobiledevice')
equal(formulaOf('idevicesyslog'), 'brew install libimobiledevice',
  'idevicesyslog does come from libimobiledevice')

// A required tool that suggested Homebrew would send a user to install Xcode with
// the wrong command.
for (const entry of DEPENDENCIES.filter((item) => item.required)) {
  check(!entry.install.includes('brew install'),
    `${entry.command} is not installed with Homebrew`, entry.install)
}

// --- the optional half is one group, and closed by one command -------------

const legacy = DEPENDENCIES.filter((entry) => !entry.required)
for (const entry of legacy) {
  check(LEGACY_TOOLCHAIN_INSTALL.includes(entry.install.split(' ').pop()),
    `${entry.command}'s formula appears in the combined install command`, LEGACY_TOOLCHAIN_INSTALL)
}
check(legacy.length === 5, 'the classic channel is the whole optional set', `${legacy.length} entries`)

// --- resolution ------------------------------------------------------------

check(resolveTool('sh') !== null, 'a command that is on PATH resolves to a path')
check(resolveTool('sh')?.startsWith('/'), 'resolution answers an absolute path', String(resolveTool('sh')))
check(resolveTool('/bin/sh') === '/bin/sh', 'an absolute path that exists is accepted as-is')
check(resolveTool('/definitely/not/here') === null, 'an absolute path that does not exist resolves to null')
check(resolveTool('dsh-xcodebuild-no-such-tool') === null, 'an unknown command resolves to null')
check(resolveTool('') === null, 'an empty command resolves to null')
check(resolveTool(undefined) === null, 'a missing command resolves to null')

// `legacyTool` keeps the old contract on purpose: the bare name still gives spawn
// its own PATH lookup, so a search miss is not a hard failure.
check(legacyTool('sh') !== null && legacyTool('sh').includes('/'),
  'legacyTool answers a path when the tool is found')
equal(legacyTool('dsh-xcodebuild-no-such-tool'), 'dsh-xcodebuild-no-such-tool',
  'legacyTool falls back to the bare name so spawn can still try PATH')

// --- what a user reads when something is missing --------------------------

check(missingToolNotice('ideviceinstaller').includes('brew install ideviceinstaller'),
  'a missing tool is reported with the command that installs it',
  missingToolNotice('ideviceinstaller'))
check(missingToolNotice('ideviceinstaller').includes('ideviceinstaller'),
  'and it still names the tool', missingToolNotice('ideviceinstaller'))
check(!missingToolNotice('ideviceinstaller').includes('ENOENT'),
  'the message is an instruction, not a raw spawn error')

// --- the report itself -----------------------------------------------------

const report = await doctorReport()
equal(report.tools.map((tool) => tool.command).sort(), registered,
  'the report covers exactly the registered dependencies')
equal(report.missingRequired, report.tools.filter((tool) => tool.required && !tool.ready).map((tool) => tool.command),
  'missingRequired is derived from the same records')
equal(report.ready, report.missingRequired.length === 0, 'readiness means no required tool is missing')
equal(report.legacyInstall, report.missingOptional.length > 0 ? LEGACY_TOOLCHAIN_INSTALL : '',
  'the combined install command is offered exactly when something is missing')

for (const tool of report.tools) {
  equal(tool.ready, tool.found !== null, `${tool.command}'s readiness matches whether it was found`)
  check(tool.found === null || tool.found.startsWith('/'), `${tool.command}'s path is absolute`, String(tool.found))
}

// On this machine everything is installed; say so rather than assuming it.
console.log(`\nready=${report.ready} xcode=${report.xcodeVersion || '(none)'} missing=${JSON.stringify(report.missingRequired.concat(report.missingOptional))}`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('dependencies OK')
