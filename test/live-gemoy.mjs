// Live end-to-end check against a real Xcode project.
//
// Mounts the plugin exactly as the runtime does, then drives the tools the way
// the model would: detect the project, resolve destinations, build, and read the
// log back. Unlike the other suites this needs a real project and a real
// toolchain, so it is not part of `npm test`.
//
// It is the only check that covers the parts a fake context cannot: argv
// construction, the actual xcodebuild output reaching the classifier, the ring
// buffer under a real build's volume, and the `-showBuildSettings` lookup the
// `run` action uses to find the built .app.
//
// Run: node test/live-gemoy.mjs [project-path]

import { spawn } from 'node:child_process'
import { apply } from '../lib/index.js'

const PROJECT = process.argv[2] ?? '/Users/mac/Project/Gemoy'
const SCHEME = process.env.XCODEBUILD_SCHEME ?? 'Gemoy'

let failures = 0
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- mount -----------------------------------------------------------------

const tools = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
  inject: (_services, callback) => callback({
    effect: (cb) => { const dispose = cb(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
  }),
}
apply(ctx)

const tool = (toolName) => {
  const found = tools.get(toolName)
  if (found === undefined) throw new Error(`tool not mounted: ${toolName}`)
  return found
}

/** Run one tool and render its result to text, the way the model sees it. */
async function run(toolName, args) {
  const definition = tool(toolName)
  const value = await definition.execute(args, {})
  const blocks = definition.output.render(args, value)
  return { value, text: blocks.map((block) => block.text).join('\n') }
}

console.log(`\n== xcode_project (${PROJECT}) ==`)
const project = await run('xcode_project', { path: PROJECT })
check(project.value.kind === 'workspace', 'detected a workspace', project.value.kind)
check(project.value.schemes.includes(SCHEME), `found the ${SCHEME} scheme`)
console.log(`     ${project.value.schemes.length} schemes, location ${project.value.location}`)

console.log(`\n== xcode_destinations (${SCHEME}) ==`)
const destinations = await run('xcode_destinations', { path: PROJECT, scheme: SCHEME })
check(destinations.value.count > 0, 'listed destinations', String(destinations.value.count))
check(typeof destinations.value.recommended === 'string' && destinations.value.recommended !== '', 'recommended a destination')
const simulator = destinations.value.destinations.find((entry) => entry.kind === 'simulator' && !entry.placeholder)
check(simulator !== undefined, 'at least one concrete simulator destination')
if (simulator === undefined) {
  console.error('cannot continue without a simulator destination')
  process.exit(1)
}
console.log(`     recommended: ${destinations.value.recommended}`)

console.log(`\n== xcode_run build (${simulator.name}) ==`)
const started = Date.now()
const result = await run('xcode_run', {
  path: PROJECT,
  action: 'build',
  scheme: SCHEME,
  destination: simulator.destination,
  configuration: 'Debug',
  waitSeconds: 600,
})
const seconds = Math.round((Date.now() - started) / 1000)
check(result.value.exitCode === 0, `build succeeded (exit ${result.value.exitCode})`, result.value.errors?.[0])
check(result.value.lineCount > 100, `captured a real log volume`, `${result.value.lineCount} lines`)
// Deliberately not `warningCount > 0`: a fully incremental build recompiles
// nothing and emits no warnings at all, which is a pass, not a failure. The
// invariant worth pinning is that the summary agrees with the log, and the grep
// check below compares the two directly.
console.log(`     exit ${result.value.exitCode}, ${seconds}s, ${result.value.lineCount} lines, ${result.value.warningCount} warnings`)
console.log(result.text.split('\n').slice(0, 3).map((line) => `     ${line}`).join('\n'))

console.log('\n== xcode_log (incremental + grep) ==')
const tail = await run('xcode_log', { runId: result.value.runId, tailLines: 5 })
check(tail.value.lines.length === 5, 'tail returns the requested number of lines')
check(tail.value.lines.every((line) => typeof line.k === 'string' && typeof line.n === 'number'), 'lines carry number and kind')

const warnings = await run('xcode_log', { runId: result.value.runId, grep: 'warning:', tailLines: 4000 })
check(warnings.value.lines.length === result.value.warningCount,
  'the summary\'s warning count agrees with the log', `${warnings.value.lines.length} vs ${result.value.warningCount}`)
check(warnings.value.lines.every((line) => line.k === 'warning'), 'every grep hit was classified as a warning')
if (warnings.value.lines.length > 0) {
  console.log(`     ${warnings.value.lines.length} warnings; first:`)
  console.log(`     ${warnings.value.lines[0].t.slice(0, 140)}`)
}

const from = await run('xcode_log', { runId: result.value.runId, from: tail.value.lines[0].n })
check(from.value.lines.length === 5, 'incremental read from a line number is exact')
check(from.value.lines[0].n === tail.value.lines[0].n, 'incremental read starts at the requested line')

console.log('\n== -showBuildSettings lookup (what the `run` action relies on) ==')
// The `run` action cannot build the product path by hand: with Xcode's own
// derived data the directory carries a per-project hash. This reproduces the
// lookup and asserts it lands on a real .app.
function capture(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
const settings = await capture([
  'xcodebuild',
  '-workspace', `${PROJECT}/${SCHEME}.xcworkspace`,
  '-scheme', SCHEME,
  '-configuration', 'Debug',
  '-destination', simulator.destination,
  '-showBuildSettings', '-json',
])
check(settings.code === 0, '-showBuildSettings succeeded', settings.stderr.slice(0, 200))
if (settings.code === 0) {
  const report = JSON.parse(settings.stdout)[0] ?? {}
  const buildSettings = report.buildSettings ?? {}
  const productsDir = buildSettings.BUILT_PRODUCTS_DIR
  const productName = buildSettings.FULL_PRODUCT_NAME
  check(typeof productsDir === 'string' && productsDir !== '', 'BUILT_PRODUCTS_DIR is present')
  check(typeof productName === 'string' && productName.endsWith('.app'), 'FULL_PRODUCT_NAME names an .app', productName)
  if (typeof productsDir === 'string' && productsDir !== '' && typeof productName === 'string') {
    const { existsSync } = await import('node:fs')
    check(existsSync(`${productsDir}/${productName}`), 'the located .app exists on disk', `${productsDir}/${productName}`)
    check(productsDir.includes('DerivedData'), 'the product sits in Xcode\'s own DerivedData (the default)', productsDir)
    console.log(`     ${productsDir}/${productName}`)
  } else if (report.error !== undefined) {
    // xcodebuild reports a preparation failure this way rather than exiting
    // non-zero, so surface it instead of leaving the reader guessing.
    console.error(`     xcodebuild reported: ${String(report.error).slice(0, 300)}`)
  }
}

console.log(`\n${failures === 0 ? 'live check OK' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
