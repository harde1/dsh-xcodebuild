// The classic-channel (iOS 16 and earlier) launch verdict.
//
// This file exists for one bug, and the first case below is that bug: the launch
// used to be judged on a line that says exactly `success`, which ios-deploy's
// generated lldb script prints from `str(startup_error)` the moment `Launch()`
// returns — before the process is known to be alive. Every iPhone X run then
// ended as `succeeded`, with `artifact.pid === null` and no app on the device.
//
// The verdict must therefore come from lldb's `safequit` exit code, and the pid
// probe must never be allowed to veto a launch.
//
// Run: node test/legacy-launch.test.mjs

import { legacyLaunchFailure, parseLaunchedPid } from '../lib/legacy-launch.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}
function eq(actual, expected, label) {
  check(actual === expected, label, `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}

// The tail of a real launch against an iPhone X (iPhone10,3, iOS 16.7.12),
// captured while reproducing the bug: exit code 1, and the log simply stops after
// `safequit`. Note what is present (`success`) and what is absent (any process).
const REAL_FAILED_LAUNCH = [
  '(lldb)     command script add -s asynchronous -f fruitstrap.safequit_command safequit',
  '(lldb)     connect',
  '(lldb)     run',
  'success',
  '(lldb)     safequit',
  '',
].join('\n')

// --- reading the probe -----------------------------------------------------

console.log('== reading the pid probe ==')
eq(parseLaunchedPid('pid: 1234'), 1234, 'the documented answer')
eq(parseLaunchedPid('[....] Waiting for iOS device to be connected\npid: 55688\n'), 55688, 'the pid is found under the tool chatter')
eq(parseLaunchedPid(''), null, 'a device with no such process prints nothing at all')
eq(parseLaunchedPid(undefined), null, 'no output is not a launch')
eq(parseLaunchedPid('pid: 0'), null, 'pid 0 is not a process')
eq(parseLaunchedPid('[  0%] Looking up developer disk image'), null, 'progress percentages are not pids')
eq(parseLaunchedPid('Using d6c2c9dd2da8def539603fe180c1e6c59b277f58 (D22AP, iPhone X)'), null, 'a udid is not a pid')

// --- the regression: `success` is not a launch -----------------------------

console.log('== `success` is not a launch ==')
const fromSuccessLine = legacyLaunchFailure({
  timedOut: false,
  exitCode: 1,
  output: REAL_FAILED_LAUNCH,
  pid: null,
})
check(fromSuccessLine !== null, 'a `success` line plus safequit exit 1 is a FAILURE')
check(
  fromSuccessLine !== null && fromSuccessLine.includes('exited 1'),
  'the message names the exit code, which is safequit reporting the app never ran',
  fromSuccessLine ?? '(no failure)',
)
check(
  fromSuccessLine !== null && /tapping the app/.test(fromSuccessLine),
  'the message names the practical fallback on this generation',
  fromSuccessLine ?? '(no failure)',
)
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 7, output: REAL_FAILED_LAUNCH, pid: null }) === null,
  false,
  "safequit's crashed state number is a failure too, `success` line and all",
)

// --- the pid must never veto ----------------------------------------------
//
// `ios-deploy --get_pid` answers nothing for `com.apple.springboard` on this
// device. If silence were read as "dead", every real launch would become a false
// negative, which is worse than the bug being fixed.

console.log('== the pid corroborates, it does not veto ==')
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 0, output: '', pid: null }),
  null,
  'exit 0 with no pid is a launch: safequit exits 0 only after detaching a running process',
)
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: 4242 }),
  null,
  'a live pid wins even over a non-zero exit — ios-deploy is allowed to exit 1 after a real launch',
)
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 0, output: 'pid: 7\n', pid: 7 }),
  null,
  'a live pid on a clean exit is a launch',
)

// --- the other ways this launch fails --------------------------------------

console.log('== named causes ==')
const locked = legacyLaunchFailure({ timedOut: false, exitCode: 254, output: '\nDevice Locked\n', pid: null })
check(locked !== null && /unlock/i.test(locked), 'a locked device is named, with the way out', locked ?? '(no failure)')

const notLaunched = legacyLaunchFailure({
  timedOut: false,
  exitCode: 1,
  output: '\nApplication has not been launched\n',
  pid: null,
})
check(
  notLaunched !== null && notLaunched.includes('Application has not been launched'),
  'when the message does survive the buffer, it is quoted rather than paraphrased',
  notLaunched ?? '(no failure)',
)

const hung = legacyLaunchFailure({ timedOut: true, exitCode: -1, output: REAL_FAILED_LAUNCH, pid: null })
check(hung !== null && /never returned/.test(hung), 'a killed ios-deploy is a failure', hung ?? '(no failure)')
check(
  legacyLaunchFailure({ timedOut: true, exitCode: -1, output: '', pid: 99 }) !== null,
  'a timeout fails even if a pid was seen: SIGKILL tears down the debug session that holds the app',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('legacy launch OK')
