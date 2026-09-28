// The reader that tells a dead app from a finished one.
//
// The bug this file exists for: an iPhone launch that crashed settled as a green
// run, because the only question the settlement asked was "did the app ever come
// up?" — and a crash answers that with a yes. These cases pin the reader that
// replaced it, including the two ways it must stay silent: prose that mentions a
// crash, and a console that says nothing at all.
//
// Run: node test/app-death.test.mjs

import {
  DEATH_OUTCOMES,
  appOutcomeOfLine,
  appOutcomeOfSession,
  isDeath,
  outcomePhrase,
} from '../lib/app-death.js'

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

// --- the markers ios-deploy prints -----------------------------------------

console.log('== the life-cycle markers ==')
eq(appOutcomeOfLine('PROCESS_CRASHED'), 'crashed', 'a crash')
eq(appOutcomeOfLine('PROCESS_STOPPED'), 'stopped', 'a signal')
eq(appOutcomeOfLine('PROCESS_NOT_STARTED'), 'not-started', 'a launch that never took')
eq(appOutcomeOfLine('PROCESS_EXITED'), 'exited', 'a clean exit')
eq(appOutcomeOfLine('PROCESS_DETACHED'), 'detached', 'the debugger letting go')
eq(appOutcomeOfLine('  PROCESS_CRASHED  '), 'crashed', 'trailing whitespace still names the marker')
eq(appOutcomeOfLine('PROCESS_CRASHED because of reasons'), null, 'a marker is the whole line, not a prefix')
eq(appOutcomeOfLine('the app said PROCESS_CRASHED'), null, 'and not a fragment of prose')
eq(appOutcomeOfLine(undefined), null, 'no line, no verdict')

console.log('== what the app prints on the way out ==')
// The banner ObjC prints for an uncaught exception, as the device writes it.
const OBJC_CRASH = [
  '2026-09-24 12:04:31.887 Demo-Dev[29303:1145355] -[SGAppDelegate badThing]: unrecognized selector sent to instance 0x2814f8a00',
  '*** Terminating app due to uncaught exception \'NSInvalidArgumentException\', reason: \'-[SGAppDelegate badThing]: unrecognized selector sent to instance 0x2814f8a00\'',
  '*** First throw call stack:',
  '(0x1a2b3c4d0 0x1a1f3e2a0 0x1a2b3c5e8 0x100f4a2b4 0x100f4b0c0 0x1a7c9e2f0)',
  'libc++abi: terminating with uncaught exception of type NSException',
].join('\n')

const objc = appOutcomeOfSession(OBJC_CRASH)
check(objc !== null, 'an uncaught exception is a death')
eq(objc?.outcome, 'crashed', 'and specifically a crash')
check(objc !== null && objc.evidence.startsWith('*** Terminating app due to uncaught exception'),
  'the evidence is the banner, not the log line above it', objc?.evidence ?? '(none)')
eq(appOutcomeOfLine('Fatal error: Unexpectedly found nil while unwrapping an Optional value'),
  'crashed', "Swift's fatalError is a crash")
eq(appOutcomeOfLine('Swift runtime failure: Index out of range'), 'crashed', 'and the newer spelling')
eq(appOutcomeOfLine('dyld[812]: Library not loaded: @rpath/Foo.framework/Foo'), 'crashed',
  'a bundle that cannot load never runs')
eq(appOutcomeOfLine('Assertion failed: (count > 0), function drain, file Queue.c, line 42.'),
  'crashed', 'a C assertion is a crash too')

console.log('== the debugger, and where it must not speak ==')
const STOPPED_AT = 'Process 29303 stopped\n* thread #1, queue = \'com.apple.main-thread\', stop reason = EXC_BAD_ACCESS (code=1, address=0x0)'
eq(appOutcomeOfSession(STOPPED_AT)?.outcome, 'crashed', 'a debugger stopped on EXC_BAD_ACCESS is a crash')
eq(appOutcomeOfLine('* thread #1, stop reason = breakpoint 1.1'), null,
  'a breakpoint is NOT a death — every debugging run would fail')
eq(appOutcomeOfLine('* thread #1, stop reason = step over'), null, 'and neither is stepping')
eq(appOutcomeOfLine('Process 29303 resuming'), null, 'nor resuming')

console.log('== prose is not evidence ==')
eq(appOutcomeOfSession('[E] crash reporter uploaded 2 pending reports')?.outcome, undefined,
  'an app logging about crashes has not crashed')
eq(appOutcomeOfSession('2026-09-24 12:04:31 Demo-Dev[29303:1] user tapped "exit"')?.outcome, undefined,
  'and a line containing "exit" is not an exit')
eq(appOutcomeOfLine(''), null, 'an empty line says nothing')

// --- the whole session -----------------------------------------------------

console.log('== the session says which one it was ==')
const LAUNCHED_THEN_CRASHED = [
  '$ xcrun devicectl device process launch --console --device ABC --terminate-existing com.example.demo',
  'Launched application with com.example.demo bundle identifier.',
  '2026-09-24 12:04:12.101 Demo-Dev[29303:1145355] app up',
  '*** Terminating app due to uncaught exception \'NSInvalidArgumentException\'',
  'PROCESS_CRASHED',
  'PROCESS_EXITED',
].join('\n')

const verdict = appOutcomeOfSession(LAUNCHED_THEN_CRASHED)
eq(verdict?.outcome, 'crashed', 'a crash is never downgraded by a quieter line that follows it')
// Line 4 is the app's own banner; line 5 is the marker under it. Both are crashes, so
// the first one found is the one reported, and the count is 1-based like an editor's.
eq(verdict?.line, 4, 'and the verdict points at the line that decided it')
check(isDeath(verdict?.outcome ?? null), 'the caller is told this is a death')
eq(verdict?.fatal, true, 'and the verdict carries that answer, so no caller has to re-derive it')
eq(appOutcomeOfSession('app up\nPROCESS_EXITED')?.fatal, false,
  'an exit is not fatal, however the panel chooses to word it')

eq(appOutcomeOfSession('Launched application with com.example.demo bundle identifier.\napp up') , null,
  'a console that never mentions the end yields NO verdict, not a death')
eq(appOutcomeOfSession(''), null, 'and neither does an empty one')
eq(appOutcomeOfSession(undefined), null, 'nor a missing one')

console.log('== the quiet outcomes are not deaths ==')
eq(appOutcomeOfSession('app up\nPROCESS_EXITED')?.outcome, 'exited', 'a clean exit is read as one')
eq(isDeath('exited'), false, 'and it is not a death')
eq(isDeath('detached'), false, 'nor is a detach')
eq(isDeath('stopped'), true, 'a signal is')
eq(isDeath(null), false, 'and no evidence is never a death')

console.log('== every outcome can be said ==')
eq(DEATH_OUTCOMES.length, 5, 'five outcomes, no more')
for (const outcome of DEATH_OUTCOMES) {
  const phrase = outcomePhrase(outcome)
  check(typeof phrase === 'string' && phrase !== '' && phrase !== 'ended', `${outcome} has its own phrasing`)
}
eq(outcomePhrase('crashed'), 'crashed', 'the one the panel shows most often')

// --- done ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
