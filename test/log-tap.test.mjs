// The reader half of an attached launch, pinned against the shapes a real console
// file takes while it is being written: a partial line, a multi-byte character split
// across two reads, and a file that was truncated under the reader.
//
// Run: node test/log-tap.test.mjs

import { MAX_TAPPED_LINE, flushCarry, nextReadOffset, takeLines } from '../lib/log-tap.js'

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

console.log('== a line is only a line once it ends ==')
equal(takeLines('[100%] Built target\n').lines, ['[100%] Built target'], 'a terminated line is emitted')
equal(takeLines('[100%] Built target\n').carry, '', 'and nothing is carried')
equal(takeLines('(lldb) run').lines, [], 'half a line is not emitted')
eq(takeLines('(lldb) run').carry, '(lldb) run', 'it is carried instead')
equal(takeLines('process 1588 launched\n(lldb) ').lines, ['process 1588 launched'], 'the complete one is emitted')
eq(takeLines('process 1588 launched\n(lldb) ').carry, '(lldb) ', 'and only the fragment is carried')

console.log('== the carry joins the next read ==')
equal(takeLines('launched\n(lldb) ', '').lines, ['launched'], 'a first read needs no carry')
const first = takeLines('the app star')
const second = takeLines('ted up\n', first.carry)
equal(second.lines, ['the app started up'], 'a line split across two reads arrives whole')
eq(second.carry, '', 'and leaves nothing behind')

console.log('== carriage returns are for the terminal, not the panel ==')
equal(takeLines('55% done\r\n').lines, ['55% done'], 'a CRLF line does not carry the CR')
eq(flushCarry('55% done\r'), '55% done', 'nor does a flushed one')

console.log('== a multi-byte character split across two reads ==')
// The reader decodes bytes with a streaming decoder, so this is the decoder's job —
// but the carry must still assemble the two halves into one line, which is what a
// naive `buffer.toString()` per read gets wrong.
const decoder = new TextDecoder()
const bytes = Buffer.from('Demo-Dev 启动\n', 'utf8')
const head = decoder.decode(bytes.subarray(0, 5), { stream: true })
const tailBytes = bytes.subarray(5)
const tail = decoder.decode(tailBytes, { stream: true })
const split = takeLines(head + tail)
equal(split.lines, ['Demo-Dev 启动'], 'a Chinese line survives being split mid-character')

console.log('== one line cannot grow without bound ==')
const long = takeLines('x'.repeat(20000))
eq(long.lines.length, 0, 'no newline, no line')
check(long.carry.length <= MAX_TAPPED_LINE, 'the fragment is capped', `${long.carry.length} chars`)
check(long.carry.endsWith('x'), 'and keeps the newest end of the line, not the oldest', long.carry.slice(-8))

console.log('== an offset only moves forward over bytes already read ==')
equal(nextReadOffset(0, 120), { offset: 0, reset: false }, 'nothing read yet')
equal(nextReadOffset(120, 300), { offset: 120, reset: false }, 'read on from where it stopped')
equal(nextReadOffset(500, 40), { offset: 0, reset: true }, 'a file that shrank is read again from the start')
equal(nextReadOffset(-5, 10), { offset: 0, reset: false }, 'a nonsense offset starts at the beginning')
equal(nextReadOffset(10, 0), { offset: 0, reset: true }, 'an emptied file restarts')

console.log('== what is left behind when the writer is gone ==')
eq(flushCarry('(lldb) safequit'), '(lldb) safequit', 'the last unterminated line is still output')
eq(flushCarry(''), null, 'nothing to say when the carry is empty')
eq(flushCarry(undefined), null, 'and nothing to say when there is no carry at all')

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('log tap OK')
