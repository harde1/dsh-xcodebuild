// Tests for the ring buffer the xcodebuild plugin host actually ships.
//
// These import `lib/ring.js` itself rather than a copy, so the assertions cannot
// drift away from the implementation they protect: the index arithmetic is the
// only non-obvious part of the log path, and a stale duplicate here would keep
// passing while the shipped module regressed.
//
// The buffer exists because the obvious implementation evicts with
// `lines.splice(0, lines.length - CAP)`, which shifts every retained element on
// every line — O(n) per push, O(n^2) per run.
//
// Run: node test/ring-buffer.test.mjs

import { createRing, ringPush, ringSlice, ringFirst } from '../lib/ring.js'

/** Reference implementation: unbounded array, same observable contract. */
function reference(capacity) {
  const all = []
  return {
    push(value) { all.push({ n: all.length, value }) },
    slice(fromN) {
      const kept = all.slice(Math.max(0, all.length - capacity))
      if (typeof fromN !== 'number') return kept.slice()
      return kept.filter((e) => e.n >= fromN)
    },
    first() { return all.length - Math.min(all.length, capacity) },
    get count() { return all.length },
  }
}

let failures = 0
let checks = 0
function assertEqual(actual, expected, label) {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`FAIL ${label}\n  actual:   ${a}\n  expected: ${b}`)
  }
}

// --- explicit cases -------------------------------------------------------

const r3 = createRing(3)
for (let i = 0; i < 5; i++) ringPush(r3, 'line' + i)
assertEqual(r3.count, 5, 'count tracks every line ever pushed')
assertEqual(ringFirst(r3), 2, 'oldest retained line number')
assertEqual(ringSlice(r3).map((e) => e.n), [2, 3, 4], 'keeps exactly the newest `capacity` lines')
assertEqual(ringSlice(r3).map((e) => e.value), ['line2', 'line3', 'line4'], 'values stay in push order')
assertEqual(ringSlice(r3, 3).map((e) => e.n), [3, 4], 'fromN mid-buffer')
assertEqual(ringSlice(r3, 0).map((e) => e.n), [2, 3, 4], 'fromN older than retained clamps to oldest')
assertEqual(ringSlice(r3, 99).map((e) => e.n), [], 'fromN past the end is empty')

const empty = createRing(4)
assertEqual(ringSlice(empty), [], 'empty ring yields nothing')
assertEqual(ringFirst(empty), 0, 'empty ring first is 0')

const exact = createRing(4)
for (let i = 0; i < 4; i++) ringPush(exact, i)
assertEqual(ringSlice(exact).map((e) => e.n), [0, 1, 2, 3], 'exactly full: no wrap yet')
ringPush(exact, 4)
assertEqual(ringSlice(exact).map((e) => e.n), [1, 2, 3, 4], 'one past full: wraps correctly')

// --- randomised cross-check against the reference -------------------------

for (let trial = 0; trial < 300; trial++) {
  const capacity = 1 + Math.floor(Math.random() * 40)
  const pushes = Math.floor(Math.random() * 200)
  const ring = createRing(capacity)
  const ref = reference(capacity)
  for (let i = 0; i < pushes; i++) {
    ringPush(ring, i)
    ref.push(i)
  }
  assertEqual(ring.count, ref.count, `trial${trial} count`)
  assertEqual(ringFirst(ring), ref.first(), `trial${trial} first`)
  assertEqual(ringSlice(ring), ref.slice(), `trial${trial} full slice`)
  for (let k = 0; k < 5; k++) {
    const fromN = Math.floor(Math.random() * (pushes + 5)) - 2
    assertEqual(ringSlice(ring, fromN), ref.slice(fromN), `trial${trial} slice from ${fromN}`)
  }
}

// --- performance guard: the regression this rewrite exists to prevent -----
//
// Both paths must actually overflow the cap for the comparison to mean
// anything: pick cap 4000 and push 14000 lines, so 10000 lines trigger the
// eviction path.

const CAP = 4000
const LINES = 14000
const text = (i) => 'CompileSwift normal arm64 /Users/x/File' + i + '.swift'

const big = createRing(CAP)
const t0 = process.hrtime.bigint()
for (let i = 0; i < LINES; i++) ringPush(big, text(i))
const t1 = process.hrtime.bigint()
assertEqual(ringSlice(big).length, CAP, 'ring retains exactly `capacity` lines after overflow')
assertEqual(ringFirst(big), LINES - CAP, 'ring first line number after overflow')

const t2 = process.hrtime.bigint()
const scanned = ringSlice(big).filter((e) => /File1\d\d\d\d/.test(e.value)).length
const t3 = process.hrtime.bigint()

// The old splice implementation, identical workload, eviction path exercised.
const legacy = []
const t4 = process.hrtime.bigint()
for (let i = 0; i < LINES; i++) {
  legacy.push({ n: i, value: text(i) })
  if (legacy.length > CAP) legacy.splice(0, legacy.length - CAP)
}
const t5 = process.hrtime.bigint()
assertEqual(legacy.length, CAP, 'legacy reference also ends at `capacity`')

const ringMs = Number(t1 - t0) / 1e6
const legacyMs = Number(t5 - t4) / 1e6
console.log(`push ${LINES} lines, cap ${CAP} (10000 evictions):`)
console.log(`  ring buffer (O(1) push): ${ringMs.toFixed(1)} ms`)
console.log(`  legacy splice:           ${legacyMs.toFixed(1)} ms  (${(legacyMs / ringMs).toFixed(1)}x slower)`)
console.log(`  scan+filter retained:    ${(Number(t3 - t2) / 1e6).toFixed(1)} ms (${scanned} matched)`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('ring buffer OK')
