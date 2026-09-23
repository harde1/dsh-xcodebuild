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

import { consoleLineKind, legacyLaunchFailure, parseLaunchedPid } from '../lib/legacy-launch.js'

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
eq(parseLaunchedPid('Using 0000a1b2c3d4e5f60718293a4b5c6d7e8f901234 (D22AP, iPhone X)'), null, 'a udid is not a pid')

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
  fromSuccessLine !== null && /retry/i.test(fromSuccessLine),
  'the message names what to do next rather than blaming the flag',
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

// --- the app's own log is the second witness ------------------------------
//
// On an iOS 16 device the app writes Documents/PPCrashLog/log_<timestamp>.log as
// it starts, so a file that was not there before the launch is direct evidence of
// the process, independent of anything the toolchain chooses to print. It obeys
// the same rule as the pid probe in both directions: presence decides, silence
// never does.

console.log('== the app writing its own log corroborates, and does not veto ==')
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: null, appLogStarted: true }),
  null,
  'a new app log beats a non-zero exit: the process demonstrably started',
)
eq(
  legacyLaunchFailure({ timedOut: false, exitCode: 0, output: '', pid: null, appLogStarted: false }),
  null,
  'no new app log does NOT fail a clean exit — the file is written as the process starts and may lag the detach',
)
const noLog = legacyLaunchFailure({ timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: null, appLogStarted: false })
check(
  noLog !== null && noLog.includes('Documents/PPCrashLog'),
  'a failure with no new app log says so, and names the directory it looked in',
  noLog ?? '(no failure)',
)
check(
  legacyLaunchFailure({ timedOut: true, exitCode: -1, output: '', pid: null, appLogStarted: true }) !== null,
  'a timeout still fails even when the app did write a log: the session was killed, not detached',
)

// --- the other ways this launch fails --------------------------------------

console.log('== the device\'s own lock answer is reported, not guessed ==')
const saidLocked = legacyLaunchFailure({
  timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: null, locked: true,
})
check(
  saidLocked !== null && /PasswordProtected=true/.test(saidLocked) && /unlock/i.test(saidLocked),
  'a device that said `true` gets "unlock and retry"',
  saidLocked ?? '(no failure)',
)
const saidOpen = legacyLaunchFailure({
  timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: null, locked: false,
})
check(
  saidOpen !== null && /PasswordProtected=false/.test(saidOpen) && !/so unlock/i.test(saidOpen),
  'a device that said `false` is not told to unlock, because the lock is not the explanation',
  saidOpen ?? '(no failure)',
)
check(
  !/PasswordProtected/.test(fromSuccessLine ?? ''),
  'a failure with no answer claims nothing about the lock',
)

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
// A timeout is not the locked case: the locked case is measured to return at ~43s
// with exit 1. Sending the reader to "unlock" for a stuck debug session would be
// the wrong instruction, so the two messages must not converge.
check(
  hung !== null && !/unlock/i.test(hung) && /debug session|stuck/i.test(hung),
  'a timeout blames a stuck device or debug session, not the lock screen',
  hung ?? '(no failure)',
)

// The exit-1 branch is the one a locked device produces, and it is a race rather
// than a broken flag: measured, safequit judges at ~43s while the app needs ~45s
// to be up. The message has to say that, because "the toolchain cannot do this"
// was the wrong conclusion the last time this was investigated.
// The launch is an attached session now, so an exit code on its own is no verdict:
// this message is produced only when the session ended before the app's own log
// witness appeared, and it has to say that rather than blame a flag that is gone.
const raced = legacyLaunchFailure({ timedOut: false, exitCode: 1, output: REAL_FAILED_LAUNCH, pid: null })
check(
  raced !== null && /launch log/.test(raced) && /attached/.test(raced),
  'the exit-1 message says the session ended before the app wrote its launch witness',
  raced ?? '(no failure)',
)
check(
  raced !== null && !/--justlaunch/.test(raced),
  'and does not explain it with a flag the plugin no longer passes',
  raced ?? '(no failure)',
)

// A noninteractive session prints lifecycle markers. They are not prose: the panel
// colours them, and a crash has to count as an error on the run.

console.log('== the session lifecycle markers ==')
eq(consoleLineKind('PROCESS_CRASHED'), 'error', 'a crash is an error, not a note')
eq(consoleLineKind('PROCESS_STOPPED'), 'error', 'a stopped process is the app dying too')
eq(consoleLineKind('PROCESS_NOT_STARTED'), 'error', 'and an app that never started is a failure')
eq(consoleLineKind('PROCESS_EXITED'), 'note', 'a clean exit is information')
eq(consoleLineKind('PROCESS_DETACHED'), 'note', 'a detach is information')
eq(consoleLineKind('  PROCESS_CRASHED  '), 'error', 'trailing whitespace still names the marker')
eq(consoleLineKind('(lldb) run'), undefined, 'lldb chatter is left to the classifier')
eq(consoleLineKind('2026-09-23 10:50:00.880 Demo-Dev[11464:469318] fps:60'), undefined, 'the app\'s own output too')
// The app's own lines do not go unread: its level marker is the level, and the panel
// colours them by it. Measured on the iPhone 12 — this is what devicectl's console
// carried 1.5s after the launch.
eq(consoleLineKind('2026-09-23 11:41:19.145 Demo-Dev[29303:4901955] 🟦 [I] 11:41:19.145 PPTaskQueue[38] cpu:7 内存:40'), 'info',
  'an Info line from the app is the info level')
eq(consoleLineKind('2026-09-23 11:41:19.145 Demo-Dev[1:2] 🟧 [W] 11:41:19.145 Net[1] retrying'), 'warning', 'and its warning is a warning here too')
eq(consoleLineKind('2026-09-23 11:41:19.145 Demo-Dev[1:2] 🟥 [E] 11:41:19.145 Net[1] failed'), 'error', 'and its error is an error')
eq(consoleLineKind('PROCESS_CRASHED because of reasons'), undefined, 'a marker is the whole line, not a prefix')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('legacy launch OK')
