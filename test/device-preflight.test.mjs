// A device run that cannot possibly succeed says so BEFORE the build.
//
// The mechanism this covers is the one a user asks for without naming it: the phone was not paired,
// the panel said so, the user tapped Trust on the phone — and the plugin has to adjust by itself.
// Nothing may be remembered about a device (every answer is read afresh), and the check that says
// "not now" must be cheap enough to run on every device run, because the alternative is finding out
// after the build: the install fails at the end of it, minutes later.
//
// Both halves are checked here with a faked toolchain on PATH — a `xcrun` that answers
// `devicectl list devices` from a JSON fixture, and an `xcodebuild` that records having been called:
//
//   unpaired phone  → the run fails in about a second, names the phone, and xcodebuild NEVER ran
//   paired phone    → the very next run builds (no refresh, no re-selection, no restart)
//   a device the list has never heard of (an iOS 16 phone) → not this check's business: it builds
//
// Run: node test/device-preflight.test.mjs

import { apply } from '../lib/index.js'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const root = join(tmpdir(), `xcb-preflight-${String(process.pid)}`)
const bin = join(root, 'bin')
const workspace = join(root, 'project')
const marker = join(root, 'xcodebuild-was-called')
const devicesFile = join(root, 'devices.json')
mkdirSync(bin, { recursive: true })
// A project has to look like one — `detectProject` reads the filesystem, and a run for a workspace
// that holds nothing is refused for a reason that has nothing to do with the phone.
const project = join(workspace, 'Enshi.xcodeproj')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'project.pbxproj'), '// faked project\n')
mkdirSync(join(project, 'project.xcworkspace'), { recursive: true })
writeFileSync(join(project, 'project.xcworkspace', 'contents.xcworkspacedata'), '')


/** The device `devicectl` will report, as CoreDevice's own JSON does. */
function answerWith(devices) {
  writeFileSync(devicesFile, JSON.stringify({ result: { devices } }))
}

const PHONE_ID = '00008030-000123456789ABCD'
const phone = (paired) => ({
  identifier: 'F9F9151E-C60F-5AC3-B87B-4051A981C36B',
  hardwareProperties: { udid: PHONE_ID, productType: 'iPhone11,6', marketingName: 'iPhone XS Max' },
  deviceProperties: { name: 'iPhone', osVersionNumber: '18.7.9' },
  connectionProperties: { tunnelState: paired ? 'connected' : 'disconnected', pairingState: paired ? 'paired' : 'unpaired', transportType: 'wired' },
})

// The faked tools. `xcrun` answers only the one question this check is about and fails everything
// else loudly, so a run that reaches the install is a run whose pre-flight said yes.
writeFileSync(join(bin, 'xcrun'), `#!/bin/sh
# the one question: devicectl list devices --json-output <file>
case "$*" in
  *"devicectl list devices"*)
    out=""
    for arg in "$@"; do
      case "$prev" in
        --json-output) out="$arg" ;;
      esac
      prev="$arg"
    done
    if [ -z "$out" ]; then echo "xcrun: no --json-output" >&2; exit 2; fi
    cp "${devicesFile}" "$out" || exit 3
    exit 0
    ;;
esac
echo "the faked xcrun was asked something unexpected: $*" >&2
exit 9
`)
writeFileSync(join(bin, 'xcodebuild'), `#!/bin/sh
echo called >> "${marker}"
# A build line is all that is needed: the run has to be seen reaching the toolchain.
echo "Build succeeded"
exit 0
`)
// The faked tools read their fixture through these, which is why they are written into the script
// rather than passed in the environment.
for (const name of ['xcrun', 'xcodebuild']) chmodSync(join(bin, name), 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
writeFileSync(join(bin, '..', 'devices.json'), '{}')

// --- the panel's own routes, mounted the way the harness mounts them -------
const routes = new Map()
const SESSIONS = { 'preflight': { header: { cwd: workspace } } }
const effect = (callback) => {
  const dispose = callback()
  return typeof dispose === 'function' ? dispose : () => {}
}
apply({
  logger: { info: () => {}, warn: () => {} },
  get: (name) => (name === 'sessions' ? { get: (id) => SESSIONS[id] } : undefined),
  tools: { register: () => () => {} },
  effect,
  inject: (services, callback) => {
    if (services[0] === 'systemPrompt') return callback({ effect, systemPrompt: { section: () => () => {} } })
    if (services[0] === 'skills') return callback({ effect, skills: { register: () => () => {} } })
    callback({
      effect,
      webServer: { register: (route) => { routes.set(route.path.replace('/_dsh/dsh-xcodebuild/', ''), route.handler); return () => {} } },
      connection: { requestRejection: () => undefined },
    })
  },
})

async function route(path, body) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`no route ${path}`)
  let text = ''
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
    resume() {},
  }, {
    setHeader() {},
    end(chunk) { if (typeof chunk === 'string') text += chunk },
    write(chunk) { if (typeof chunk === 'string') text += chunk },
  })
  return text === '' ? null : JSON.parse(text)
}

/** Start a run and wait for it to settle, returning the plugin's own idea of it. */
async function runTo(destination) {
  rmSync(marker, { force: true })
  const started = await route('start', {
    sessionId: 'preflight',
    path: workspace,
    scheme: 'Enshi',
    destination,
    action: 'run',
  })
  const startedAt = Date.now()
  let polled = null
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    // The run is read the way the panel reads it: `state` for the summary, `poll` for the lines.
    polled = await route('poll', { sessionId: 'preflight', runId: started?.runId, from: 0 })
    if (polled !== null && polled.status !== 'running' && polled.status !== 'starting') break
  }
  const state = await route('state', { sessionId: 'preflight', workspace })
  const summary = (state?.runs ?? []).find((entry) => entry.runId === started?.runId)
  return {
    run: { ...(summary ?? {}), ...(polled ?? {}) },
    ms: Date.now() - startedAt,
    lines: (polled?.lines ?? []).map((line) => line.t ?? line.text ?? ''),
  }
}

const DESTINATION = `platform=iOS,id=${PHONE_ID}`

// --- an unpaired phone: refused before anything is compiled ----------------
answerWith([phone(false)])
const unpaired = await runTo(DESTINATION)
check(unpaired.run?.status === 'failed', 'a run to an unpaired phone fails', JSON.stringify(unpaired.run?.status))
check(String(unpaired.run?.note).includes('pairing this Mac does not have') === true,
  'and says the phone has no pairing, rather than passing CoreDevice through', unpaired.run?.note)
check(String(unpaired.run?.note).includes('iPhone (00008030-000123456789ABCD)') === true,
  'naming the phone it is about', unpaired.run?.note)
check(String(unpaired.run?.note).includes('still reports it as unpaired') === true,
  'and that CoreDevice was asked again and still says no — the useful fact after a Trust tap', unpaired.run?.note)
check(existsSync(marker) === false, 'xcodebuild was never started: the build was not wasted')
check(unpaired.lines.some((line) => line.includes('nothing was built')) === true,
  'and the log says so', JSON.stringify(unpaired.lines))
check(unpaired.ms < 10000, 'the refusal is quick, not the length of a build', `${String(unpaired.ms)}ms`)

// --- the same run once the phone is paired: nothing has to be refreshed ----
answerWith([phone(true)])
const paired = await runTo(DESTINATION)
check(existsSync(marker) === true, 'the next run builds, with no refresh, re-selection or restart')
check(paired.run?.status !== 'failed' || String(paired.run?.note ?? '').includes('pairing') === false,
  'and it is not refused for pairing any more', `${String(paired.run?.status)} · ${String(paired.run?.note)}`)

// --- a device CoreDevice never lists is left to the toolchain --------------
rmSync(marker, { force: true })
answerWith([phone(true)])
const legacy = await runTo('platform=iOS,id=d6c2c9dd2da8def539603fe180c1e6c59b277f58')
check(existsSync(marker) === true, 'an iOS 16 phone, absent from CoreDevice, is not refused here')

// --- a paired but unplugged phone is NOT a pairing refusal -----------------
// `tunnelState: disconnected` is what a phone on a cable reports between commands, and a phone that
// has gone away reports `unavailable` — neither is evidence of a missing pairing record, and
// refusing them would be this check overruling the toolchain.
rmSync(marker, { force: true })
answerWith([{ ...phone(true), connectionProperties: { tunnelState: 'available', pairingState: 'paired', transportType: null } }])
await runTo(DESTINATION)
check(existsSync(marker) === true, 'a paired phone that is merely away is still attempted')

// --- a devicectl that never answers does not hold up a build -----------------
// The whole check is an optimization, so its failure may never be the run's failure. A `devicectl`
// that hangs is given a few seconds and then ignored: the build happens, as it did before this
// existed. (The bound is under 10 s; the assertion is generous so a loaded machine cannot fail it.)
rmSync(marker, { force: true })
writeFileSync(join(bin, 'xcrun'), `#!/bin/sh
sleep 60
`)
chmodSync(join(bin, 'xcrun'), 0o755)
const hung = await runTo(DESTINATION)
check(existsSync(marker) === true, 'a devicectl that never answers does not stop the run from building')
check(hung.ms < 30000, 'and it is not waited on indefinitely', `${String(hung.ms)}ms`)

rmSync(root, { recursive: true, force: true })
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('device preflight OK')
