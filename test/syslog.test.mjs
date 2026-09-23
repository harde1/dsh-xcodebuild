// The live device-log feed: what the panel shows instead of waiting on a 2MB download.
//
// The escaped lines below are copied byte-for-byte out of `idevicesyslog`'s output on
// the real iPhone X (`d6c2c9dd…`, iOS 16.7.12, app `Demo-Dev`), because the point of the
// decoder is to survive exactly what that tool emits.
//
// Run: node test/syslog.test.mjs

import {
  SYSLOG_LEVELS,
  decodeSyslogEscapes,
  syslogFeedArgv,
  syslogLevel,
  syslogLineKind,
  syslogProcessName,
} from '../lib/syslog.js'

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

const UDID = '0000a1b2c3d4e5f60718293a4b5c6d7e8f901234'

console.log('== the emoji and the Chinese survive the escaping ==')
// 🟩 is F0 9F 9F A9, which is what those four escapes are.
eq(decodeSyslogEscapes('\\M-p\\M^_\\M^_\\M-) [D] cpu:4'), '🟩 [D] cpu:4', 'a green square comes back as an emoji')
// 内存 is E5 86 85 E5 AD 98.
eq(decodeSyslogEscapes('cpu:71 \\M-e\\M^F\\M^E\\M-e\\M--\\M^X:346'), 'cpu:71 内存:346', 'and so does the Chinese')
// The three-byte form: 渲 is E6 B8 B2 and 染 is E6 9F 93.
eq(
  decodeSyslogEscapes('\\M-p\\M^_\\M^_\\M-) [D] 11:30:45.395 \\M-f\\M-8\\M-2\\M-f\\M^_\\M^S'),
  '🟩 [D] 11:30:45.395 渲染',
  'a multi-byte character is decoded as one character, not as its bytes',
)

console.log('== plain text is left alone ==')
eq(decodeSyslogEscapes('[connected]'), '[connected]', 'a line with nothing escaped passes through')
eq(decodeSyslogEscapes(''), '', 'and so does an empty one')
eq(decodeSyslogEscapes(undefined), '', 'and a missing one')
// The device sends UTF-8, so a lone high byte is genuinely not text. It reads as the
// replacement character, which keeps the line's shape without inventing a character.
eq(decodeSyslogEscapes('a\\M-zb'), 'a\uFFFDb', 'a lone high byte is not valid UTF-8 and reads as a replacement')
eq(decodeSyslogEscapes('\\M-^?'), '\uFFFD', 'the highest byte, escaped as a caret form')
eq(decodeSyslogEscapes('C:\\\\Users'), 'C:\\Users', 'an escaped backslash stays one backslash')
eq(decodeSyslogEscapes('one\\ntwo'), 'one\ntwo', 'an escape sequence for a control character is honoured')
eq(decodeSyslogEscapes('100% \\M-x plain'), '100% \uFFFD plain', 'the escape is decoded even mid-sentence')
eq(decodeSyslogEscapes('^A beep'), '\u0001 beep', 'a bare caret escape is a control byte')

console.log('== the process name comes from the bundle ==')
eq(syslogProcessName('/Users/mac/…/Build/Products/Debug-iphoneos/Demo-Dev.app'), 'Demo-Dev', 'the bundle name is the process name')
eq(syslogProcessName('/tmp/My App.app/'), 'My App', 'a trailing slash does not change it')
eq(syslogProcessName('/tmp/MyApp.xcarchive'), null, 'something that is not a bundle names no process')
eq(syslogProcessName('/tmp/.app'), null, 'a bundle with no name names nothing')
eq(syslogProcessName(''), null, 'no path, no name')
eq(syslogProcessName(undefined), null, 'and a missing path too')

console.log('== the system log has four levels, and each one is read back ==')
// The tokens below are the ones libimobiledevice actually prints: the os_trace path maps
// the header's raw OSLogType number through a switch (0 -> Notice, 0x01 -> Info,
// 0x02 -> Debug, 0x10 -> Error, 0x11 -> Fault), and the older relay path passes the
// device's own four spellings through.
equal(SYSLOG_LEVELS, ['verbose', 'info', 'warning', 'error'], 'there are four levels, and only four')
eq(syslogLevel('<Debug>: cpu:4 内存:269'), 'verbose', 'OSLogType .debug is the app\'s verbose')
eq(syslogLevel('<Info>: loaded 12 items'), 'info', 'OSLogType .info is info')
eq(syslogLevel('<Notice>: retrying in 3s'), 'warning', 'OSLogType .default is the app\'s WARNING, not an ordinary line')
eq(syslogLevel('<Fault>: unhandled state'), 'error', 'OSLogType .fault is the app\'s error')
eq(syslogLevel('<Error>: something broke'), 'error', 'and so is OSLogType .error')
// The relay path is the one that can send these two spellings.
eq(syslogLevel('<Warning>: disk nearly full'), 'warning', 'the relay path\'s Warning is a warning')
eq(syslogLevel('<Default>: first launch'), 'warning', 'OSLogType\'s own name reads the same way')
eq(syslogLevel('<Critical>: out of memory'), 'error', 'a severity above error is still an error, not an ordinary line')
eq(syslogLevel('Demo-Dev(Foundation)[11902] <Fault>: bad'), 'error', 'the whole relayed line is searched, not just its head')
eq(syslogLevel('🟩 [D] cpu:4 内存:269'), null, 'a line that declares nothing declares nothing')
eq(syslogLevel('multi-line continuation of the line above'), null, 'and neither does a continuation')
eq(syslogLevel('the app said "<Error>" in a sentence: no colon, no level'), null, 'the colon is part of the token')
eq(syslogLevel(undefined), null, 'and a missing line declares nothing')

console.log('== and the panel is told which of the two diagnostics it is ==')
eq(syslogLineKind('<Error>: something broke'), 'error', 'an Error severity line is an error')
eq(syslogLineKind('Demo-Dev(Foundation)[11902] <Fault>: bad'), 'error', 'and so is a Fault')
eq(syslogLineKind('Demo-Dev(Foundation)[11902] <Notice>: warning the app wrote'), 'warning', 'a Notice is the app\'s warning, and reads as one in the panel')
eq(syslogLineKind('<Warning>: disk nearly full'), 'warning', 'and so is a Warning')
// Declared verbose/info is an ordinary line, said outright: the level is the device's, so
// the text classifier does not get a second opinion on a line that already has one.
eq(syslogLineKind('<Debug>: error: this is only debug text'), 'verbose', 'a Debug line is the verbose level, even when its text says otherwise')
eq(syslogLineKind('<Info>: failed to load warning icons'), 'info', 'and an Info line is info')
eq(syslogLineKind('🟩 [D] cpu:4 内存:269'), undefined, 'a line with no declared level is left to the text classifier')

console.log("== and the app's own level marker says the same thing ==")
// Measured, both channels, same logger: the marker is followed by the time it always
// writes next. `[V]`, `[D]` and `[I]` were measured; `[W]`/`[E]` are `.warning`/`.error`,
// which the mapping above writes as `.default`/`.fault`.
const consoleLine = '2026-09-23 11:41:19.145 Demo-Dev[29303:4901955] 🟦 [I] 11:41:19.145 PPTaskQueue[38] cpu:7 内存:40'
eq(syslogLevel(consoleLine), 'info', 'the console line the iPhone 12 carried is an Info line')
eq(syslogLineKind(consoleLine), 'info', 'and reads as an info line in the panel')
eq(syslogLevel('2026-09-23 11:41:19.145 Demo-Dev[1:2] 🟩 [V] 11:41:19.145 T[1] x'), 'verbose', '[V] is verbose')
eq(syslogLevel('🟩 [D] 11:30:45.395 PPHomeRecommendCell[1264] cpu:4'), 'verbose', 'and [D] is its debug, which the four levels call verbose')
eq(syslogLineKind('🟩 [D] 11:30:45.395 PPHomeRecommendCell[1264] cpu:4'), 'verbose', 'so it is the panel\'s verbose level')
eq(syslogLevel('🟧 [W] 11:41:19.145 Net[38] retrying'), 'warning', '[W] is the app warning')
eq(syslogLineKind('🟥 [E] 11:41:19.145 Net[38] failed'), 'error', 'and [E] is its error')
eq(syslogLevel('🟩 [D] cpu:4 内存:269'), null, 'a marker without the time the app writes after it is not a level')
eq(syslogLevel('the panel prints "[E]" for an error: no marker here'), null, 'nor is a bracketed letter in a sentence')
eq(syslogLevel(''), null, 'an empty line declares nothing')

console.log("== the device's token and the app's marker are one statement ==")
// `[W]` is written as `.default`, so the line carries both. Agreeing is the normal case.
eq(syslogLevel('Demo-Dev[1:2] <Notice>: 🟧 [W] 11:41:19.145 Net[38] slow'), 'warning', 'both spellings agree on a warning')
eq(syslogLevel('Demo-Dev[1:2] <Debug>: 🟩 [D] 11:41:19.145 T[38] x'), 'verbose', 'and both agree on a verbose line')
// If they ever disagree, the louder one is the answer: nothing is made harmless by a
// marker that disagrees with the device's own severity.
eq(syslogLevel('Demo-Dev[1:2] <Fault>: 🟩 [I] 11:41:19.145 T[38] x'), 'error', 'a Fault outranks an Info marker')
eq(syslogLevel('Demo-Dev[1:2] <Notice>: 🟥 [E] 11:41:19.145 T[38] x'), 'error', 'and an Error marker outranks a Notice token')

console.log('== the stream is filtered to this app and ends with the device ==')
equal(
  syslogFeedArgv({ launcher: '/opt/homebrew/bin/idevicesyslog', udid: UDID, processName: 'Demo-Dev' }),
  ['/opt/homebrew/bin/idevicesyslog', '-u', UDID, '-p', 'Demo-Dev', '-x', '--no-colors'],
  'the argv filters by process, drops colors and exits on disconnect',
)
check(
  syslogFeedArgv({ launcher: 'l', udid: UDID, processName: 'App' }).includes('--no-colors'),
  'colors are off so the panel is not full of escapes',
)

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('syslog OK')
