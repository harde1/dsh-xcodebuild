// The modern channel: launching with the console attached, and reading the app's own
// container without a debug session.
//
// Every fixture marked "measured" is copied from a real run against an iPhone 12
// (`00008110-000A1B2C3D4E5F60`, iOS 26.6.2, app `Demo-Dev`).
//
// Run: node test/modern-launch.test.mjs

import {
  appLinePattern,
  modernCopyArgv,
  modernLaunchArgv,
  modernLaunchWitness,
} from '../lib/modern-launch.js'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
}
function eq(actual, expected, label) {
  check(actual === expected, label, `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}
function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}

const UDID = '00008110-000A1B2C3D4E5F60'
const BUNDLE = 'com.example.demoapp'

console.log('== the launch attaches the console ==')
equal(
  modernLaunchArgv({ udid: UDID, bundleId: BUNDLE }),
  ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', UDID, '--terminate-existing', '--console', BUNDLE],
  'the launch waits for the app and connects its streams',
)
check(modernLaunchArgv({ udid: UDID, bundleId: BUNDLE }).includes('--console'), 'without --console there is nothing to read')
check(modernLaunchArgv({ udid: UDID, bundleId: BUNDLE }).includes('--terminate-existing'), 'and this launch still decides what is running')

console.log('== the container is copied by domain, not by path ==')
equal(
  modernCopyArgv({ udid: UDID, bundleId: BUNDLE, source: 'Documents/PPCrashLog', toDir: '/tmp/x' }),
  ['xcrun', 'devicectl', 'device', 'copy', 'from', '--device', UDID, '--domain-type', 'appDataContainer',
    '--domain-identifier', BUNDLE, '--source', 'Documents/PPCrashLog', '--destination', '/tmp/x'],
  'the copy names the app data container and the bundle that identifies it',
)

console.log('== the app\'s own lines are recognised by name and pid ==')
const appPattern = appLinePattern('Demo-Dev')
check(appPattern !== null, 'a name gives a pattern')
// Measured: this is what devicectl's console carried 1.5s after the launch.
const realLine = '2026-09-23 11:41:19.145 Demo-Dev[29303:4901955] 🟦 [I] 11:41:19.145 PPTaskQueue[38] cpu:7 内存:40'
const matched = appPattern.exec(realLine)
check(matched !== null, 'the app\'s own line matches')
eq(matched?.[1], '29303', 'and the pid comes out of it')
eq(appLinePattern('Demo-Dev').test('2026-09-23 11:41:19.145 别的App[1:2] x'), false, "another app's line does not match")
eq(appLinePattern('Demo-Dev').test('Demo-Dev[abc:1]'), false, 'a thread without a pid is not a pid')
eq(appLinePattern(null), null, 'no name, no pattern')
eq(appLinePattern(''), null, 'and an empty name either')
// A name that is also a regular expression must not become one.
eq(appLinePattern('App+Pro').test('App+Pro[7:1] x'), true, 'a name with a plus matches itself')
eq(appLinePattern('App+Pro').test('AppppPro[7:1] x'), false, 'and does not act as a quantifier')
eq(appLinePattern('My.App (Dev)').test('My.App (Dev)[9:1] x'), true, 'parentheses in a name are literal too')

console.log('== either witness is enough, and the stronger one is preferred ==')
// Measured: devicectl prints this, then "Waiting for the application to terminate…".
const devicectlSaid = [
  '11:41:18  Acquired tunnel connection to device.',
  '11:41:18  Enabling developer disk image services.',
  '11:41:18  Acquired usage assertion.',
  `Launched application with ${BUNDLE} bundle identifier.`,
  'Waiting for the application to terminate…',
].join('\n')
const fromLauncher = modernLaunchWitness(devicectlSaid, 'Demo-Dev')
eq(fromLauncher.launched, true, 'the launcher\'s own statement witnesses the launch')
eq(fromLauncher.pid, null, 'but it carries no pid')
eq(fromLauncher.evidence, 'devicectl reported the app launched', 'and it says which evidence it used')
const fromApp = modernLaunchWitness(`${devicectlSaid}\n${realLine}`, 'Demo-Dev')
eq(fromApp.launched, true, 'the app writing is a witness too')
eq(fromApp.pid, 29303, 'and that one carries the pid')
eq(fromApp.evidence, 'the app logged from pid 29303', 'named as the app\'s own line')
eq(modernLaunchWitness('11:41:18  Acquired tunnel connection to device.', 'Demo-Dev').launched, false, 'the tunnel alone is not a launch')
eq(modernLaunchWitness('', 'Demo-Dev').launched, false, 'nothing said, nothing witnessed')
eq(modernLaunchWitness(undefined, 'Demo-Dev').launched, false, 'and a missing console too')
// Without a name the app's own lines cannot be attributed to anything, so the launcher's
// statement is the only witness left — and it carries no pid.
eq(modernLaunchWitness(devicectlSaid, null).launched, true, 'without a process name the launcher line still witnesses')
eq(modernLaunchWitness(devicectlSaid, null).pid, null, 'but no pid can be read from it')
eq(modernLaunchWitness(realLine, null).launched, false, 'and an unattributable app line witnesses nothing')

console.log('== an app that crashes before it logs is not a launch ==')
// Measured shape of a devicectl failure: the app never reaches its own logging.
const failed = 'ERROR: The request to launch the application failed.\nThe application could not be launched.'
eq(modernLaunchWitness(failed, 'Demo-Dev').launched, false, 'a failed launch is not witnessed')

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('modern launch OK')
