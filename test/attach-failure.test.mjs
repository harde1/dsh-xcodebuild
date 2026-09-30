// What an attach failure says. It used to call silence an anti-debugging guard; on the app it was
// written about that was wrong — the silence was the plugin not listening to an asynchronous error.
import { attachFailure } from '../lib/attach-failure.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(condition, label, detail) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`) }
  else { failed += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`) }
}
const eq = (actual, expected, label) => check(actual === expected, label, JSON.stringify(actual))

const base = { kind: 'device', heldByRun: false, pid: 15348, name: '蜜语-Dev' }

section('LLDB\'s own reason is reported, not a guessed one')
const e96 = attachFailure({ ...base, quiet: false, note: 'error: attach failed: no such process' })
eq(e96.refused, false, 'no failure is declared a refusal any more')
check(e96.note.startsWith('error: attach failed: no such process'), 'LLDB\'s words come first', e96.note)
check(e96.note.includes('debugserver'), 'and it says the refusal comes from the phone', e96.note)
check(e96.note.includes('mode=launch'), 'with the one retry that can help')
eq(/anti-debugging|PT_DENY_ATTACH/.test(e96.note), false, 'and no guard is invented')
eq(e96.remedies.length, 2, 'two concrete things to try')

section('real silence is reported as silence, and nothing more')
const quiet = attachFailure({ ...base, quiet: true, note: 'attached but the process never stopped: still attaching after 90000 ms, and LLDB printed nothing at all' })
check(quiet.note.includes('Nothing was printed by LLDB'), 'it says nothing was printed', quiet.note)
eq(/anti-debugging|PT_DENY_ATTACH|refuses a debugger/.test(quiet.note), false, 'without a diagnosis it cannot see')
eq(quiet.refused, false, 'and it is not called a refusal')

section('a run that really holds the app is named')
const held = attachFailure({ ...base, quiet: false, heldByRun: true, note: 'attached but the process never stopped' })
check(held.note.includes('console session (ios-deploy)'), 'the console session is named', held.note)
eq(held.remedies[0], 'stop the run that holds it', 'and stopping it is the first remedy')
eq(attachFailure({ ...base, kind: 'simulator', heldByRun: true, note: 'x' }).note.includes('ios-deploy'), false,
  'a simulator has no ios-deploy session to blame')

section('a released debugger and cleared leftovers are said, on every path')
for (const [label, extra] of [['E96', { note: 'error: attach failed: no such process' }], ['silence', { quiet: true, note: 'timeout' }], ['held', { heldByRun: true, note: 'x' }], ['other', { note: 'error: something else' }]]) {
  const answer = attachFailure({ ...base, ...extra, released: true, stuck: 'an lldb from an earlier attempt was still holding the device; it has been ended' })
  check(answer.note.includes('has been ended, so the app is not left frozen'), `${label}: the release is reported`, answer.note)
  check(answer.note.includes('earlier attempt'), `${label}: and so are the cleared leftovers`)
}
eq(attachFailure({ ...base, note: 'x' }).note.includes('has been ended'), false, 'nothing released, nothing claimed')

section('degenerate input')
eq(attachFailure(null).refused, false, 'no failure at all is not a refusal')
check(attachFailure(null).note.length > 0, 'and still says something')
eq(attachFailure({ ...base, kind: 'simulator', note: 'error: attach failed: no such process' }).note.includes('debugserver'), false,
  'the phone-side explanation is only given for a phone')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('attach failure OK')
