// Choosing lldb is not "where is lldb" but "which lldb works": xcrun follows xcode-select, and the
// Command Line Tools' lldb cannot debug an iOS device.
import { chooseLldb, describeLldbChoice, lldbCandidates, lldbVersion } from '../lib/lldb-choice.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(condition, label, detail) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`) }
  else { failed += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`) }
}
const eq = (actual, expected, label) => check(actual === expected, label, JSON.stringify(actual))

section('the version is read out of the banner')
eq(lldbVersion('lldb-1600.0.36.6\nSwift version 5.9'), 'lldb-1600.0.36.6', 'a normal banner')
eq(lldbVersion(''), '', 'no output, no version')
eq(lldbVersion('command not found'), '', 'and an error is not a version')

section('with the Command Line Tools selected, Xcode\'s own lldb comes first')
const clt = lldbCandidates({ developerDir: '/Library/Developer/CommandLineTools', xcodes: ['/Applications/Xcode.app'] })
eq(clt[0].argv[0], '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb', 'Xcode first, because xcrun would not reach it')
eq(clt[0].deviceCapable, true, 'and it can debug a device')
const xcrun = clt.find((entry) => entry.argv[0] === 'xcrun')
eq(xcrun.deviceCapable, false, 'xcrun lldb is kept but flagged as simulator-only')
check(xcrun.label.includes('simulators only'), 'and says so in its label', xcrun.label)
eq(clt[clt.length - 1].deviceCapable, false, 'nothing device-capable is left behind it')

section('with Xcode selected, the debugger it points at leads')
const xcode = lldbCandidates({ developerDir: '/Applications/Xcode.app/Contents/Developer', xcodes: ['/Applications/Xcode.app'] })
eq(xcode[0].argv[0], '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb', 'that Xcode\'s lldb')
eq(xcode.some((entry) => entry.argv.join(' ') === 'xcrun lldb'), true, 'with xcrun kept as a fallback')
eq(xcode.every((entry) => entry.deviceCapable === true), true, 'and everything offered can debug a device')
eq(lldbCandidates({}).length, 1, 'with no facts at all, xcrun lldb is still the one thing to try')
eq(lldbCandidates({ xcodes: ['/Applications/Xcode.app', '/Applications/Xcode.app'] }).length >= 1, true, 'a repeated Xcode is not repeated')
eq(lldbCandidates({ xcodes: ['/Applications/Xcode.app/'] })[0].argv[0].includes('//Contents'), false, 'a trailing slash does not double up')

section('the first candidate that runs is the one used')
const runner = (versions) => async (argv) => {
  const path = argv.slice(0, argv.length - 1).join(' ')
  if (versions[path] === undefined) return { ok: false, stderr: 'command not found' }
  if (versions[path] === '') return { ok: true, stdout: 'no banner here' }
  return { ok: true, stdout: `lldb-${versions[path]}` }
}
const xcodeLldb = '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb'
const broken = await chooseLldb({
  run: runner({ 'xcrun lldb': undefined, [xcodeLldb]: '1600.0.36.6' }),
  candidates: lldbCandidates({ developerDir: '/Library/Developer/CommandLineTools', xcodes: ['/Applications/Xcode.app'] }),
})
eq(broken.argv[0], '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb', 'a broken xcrun is skipped for Xcode\'s lldb')
eq(broken.tried.length, 0, 'and nothing had to fail first')
eq(broken.version, 'lldb-1600.0.36.6', 'with its version')
const fallback = await chooseLldb({
  run: runner({ [xcodeLldb]: undefined, 'xcrun lldb': '1500.0.1' }),
  candidates: lldbCandidates({ developerDir: '/Applications/Xcode.app/Contents/Developer', xcodes: ['/Applications/Xcode.app'] }),
})
eq(fallback.argv.join(' '), 'xcrun lldb', 'a dead Xcode lldb falls through to the next that works')
eq(fallback.tried.length, 1, 'and the one that failed is remembered')
eq(fallback.tried[0].why, 'command not found', 'with the reason it gave')
eq(describeLldbChoice(fallback).includes('xcrun lldb'), true, 'the description names what is used')
eq(describeLldbChoice(fallback).includes('after'), true, 'and what failed before it')
eq(await chooseLldb({ run: async () => ({ ok: true, stdout: 'not a debugger' }), candidates: lldbCandidates({}) }), null,
  'something that answers without a version is not a debugger')
const onlyDevice = await chooseLldb({
  run: runner({ 'xcrun lldb': '1500' }),
  candidates: lldbCandidates({ developerDir: '/Library/Developer/CommandLineTools', xcodes: [] }),
  deviceCapableOnly: true,
})
eq(onlyDevice, null, 'when only the Command Line Tools are installed, a device read says so instead of pretending')
eq(describeLldbChoice(null), 'no usable lldb was found', 'and says it plainly')
eq(await chooseLldb({ run: async () => { throw new Error('spawn failed') }, candidates: lldbCandidates({}) }), null,
  'a runner that throws is a candidate that failed, not a crash')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('lldb choice OK')
