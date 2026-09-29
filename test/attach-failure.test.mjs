// The two attach failures have opposite remedies, and offering the wrong one wastes the user's
// afternoon: an app with an anti-debugging guard is not going to be inspected by taking it over.
import { attachFailure } from '../lib/attach-failure.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`)
  }
}
const eq = (actual, expected, label) => check(actual === expected, label, JSON.stringify(actual))

const quietDevice = {
  note: 'attached but the process never stopped: still attaching after 90105 ms',
  quiet: true,
  kind: 'device',
  heldByRun: true,
  pid: 4242,
  name: '蜜语-Dev',
}

section('an app that refuses debuggers is not told to be taken over')
const refused = attachFailure(quietDevice)
eq(refused.refused, true, 'the refusal is reported as its own case')
check(refused.note.includes('anti-debugging guard'), 'the note names the guard')
check(refused.note.includes('PT_DENY_ATTACH'), 'and the call that usually implements it')
check(refused.note.includes('taking it over') && refused.note.includes('cannot help either'),
  'and says plainly that takeover is not the remedy', refused.note.slice(0, 120))
eq(/pass mode=launch to take the app over instead/.test(refused.note), false,
  'the takeover suggestion is gone, because it would be a dead end')
check(refused.note.includes('蜜语-Dev is not the plugin failing to read it'),
  'and the app is named as the reason, not the plugin')
check(refused.note.startsWith('attached but the process never stopped'), 'with LLDB\'s own words kept')
check(refused.remedies.some((r) => r.includes('without the guard')), 'the remedy that works is listed')
check(refused.remedies.some((r) => r.includes('recursiveDescription')),
  'and so is reading it from inside the app')

section('a session that merely holds the app is told to be stopped or taken over')
const held = attachFailure({ ...quietDevice, quiet: false })
eq(held.refused, false, 'a slow attach that said something is not a refusal')
check(held.note.includes('ios-deploy'), 'the console session holding it is named')
check(held.note.includes('stop that run, or pass mode=launch to take the app over instead') ||
  held.note.includes('Stop that run, or pass mode=launch to take the app over instead'),
  'with both remedies offered', held.note)
check(!held.note.includes('anti-debugging'), 'and no guard is invented for it')

section('what is not a refusal')
eq(attachFailure({ ...quietDevice, kind: 'simulator' }).refused, false,
  'a simulator says nothing for its own reasons, and a guard is not one of them')
eq(attachFailure({ ...quietDevice, pid: null }).refused, false,
  'nor is a failure that never had a pid to attach to')
eq(attachFailure({ quiet: true, kind: 'device', pid: 1 }).refused, true,
  'the refusal itself needs no more than silence, a device and a pid')
eq(attachFailure({ quiet: true, kind: 'device', pid: 1 }).note.includes('the app is not the plugin'),
  true, 'and an unnamed app is still named honestly')
eq(attachFailure(null).refused, false, 'no failure at all is not a refusal')
eq(attachFailure({ quiet: true, kind: 'device', pid: 1 }).remedies.length, 2, 'two remedies, both of which work')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('attach failure OK')
