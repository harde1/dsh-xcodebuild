// The helper a debugger launches owns the channel to the phone, and a leftover one makes the next
// attempt fail at `device select ...: no answer within 30000 ms` — a message with no hint of a cause.
import { describeStuckDebuggers, isDebuggerProcess, parseProcessTable, stuckDebuggers } from '../lib/stuck-debuggers.js'

let passed = 0, failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(c, label, detail) { if (c) { passed++; console.log(`  ok   ${label}`) } else { failed++; console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`) } }
const eq = (a, b, label) => check(a === b, label, JSON.stringify(a))

const table = parseProcessTable(`
  100     1 /sbin/launchd
  210    100 /Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper
  21503    210 /Applications/Xcode.app/Contents/Developer/usr/bin/lldb
  21444    210 /Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/device
  999    100 /Applications/Xcode.app/Contents/Developer/usr/bin/lldb
`)

section('the table is read, and junk lines are not')
eq(table.length, 5, 'five processes')
eq(table[2].pid, 21503, 'pid first, then ppid')
eq(parseProcessTable('').length, 0, 'no output, no processes')
eq(parseProcessTable('not a process line').length, 0, 'a line that is not a process is skipped')

section('what counts as a debugger')
eq(isDebuggerProcess('/Applications/Xcode.app/Contents/Developer/usr/bin/lldb'), 'lldb', 'lldb by absolute path')
eq(isDebuggerProcess('/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/device'), 'device-helper', 'the CoreDevice helper')
eq(isDebuggerProcess('/usr/bin/lldb-rpc-server'), '', 'lldb-rpc-server is not the debugger')
eq(isDebuggerProcess('pgrep -fl lldb'), '', 'a shell command that mentions lldb is nothing')

section('only our own leftovers count')
const mine = stuckDebuggers(table, 210)
eq(mine.length, 2, 'the lldb and the helper under the plugin')
eq(mine.map((e) => e.kind).sort().join(','), 'device-helper,lldb', 'both kinds, named')
eq(mine.some((e) => e.pid === 999), false, 'another client\'s lldb is left alone')
eq(stuckDebuggers(table, 1).length, 0, 'when nothing is running under us, nothing is cleared')
eq(stuckDebuggers(table, 21503).length, 0, 'we never count ourselves')

section('a grandchild is still ours')
const deep = parseProcessTable(`
  1 1 launchd
  210 1 helper
  300 210 xcrun
  310 300 /Applications/Xcode.app/Contents/Developer/usr/bin/lldb
`)
eq(stuckDebuggers(deep, 210).length, 1, 'a debugger behind an intermediate process is found')
const reversed = stuckDebuggers([...deep].reverse(), 210)
eq(reversed.length, 1, 'and the order of the table does not matter')

section('it is said in one sentence, or not at all')
eq(describeStuckDebuggers([]), '', 'nothing found, nothing said')
eq(describeStuckDebuggers(mine).includes('holding the device'), true, 'the sentence says what it was doing')
eq(describeStuckDebuggers(mine).includes('has been ended'), true, 'and that it is over')
eq(describeStuckDebuggers([mine[1]]).includes('a CoreDevice helper'), true, 'a lone helper is named as one')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('stuck debuggers OK')
