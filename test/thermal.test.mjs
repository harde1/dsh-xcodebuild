// The battery temperature a run tags its log with, and the report it prints at the end.
//
// The two things that can go wrong here are both silent: a temperature parsed in the wrong unit is
// 100x too hot and nobody notices because it still looks like a number, and a tag that changes what
// `classify` sees turns every note and section in the log a different colour. Both are pinned below
// against real device output and against the classifier itself.
//
// Run: node test/thermal.test.mjs

import {
  THERMAL_TEMP_UNIT,
  batteryMonitorArgv,
  findHotWindows,
  formatClock,
  normalizeLine,
  parseBatterySample,
  smoothSeries,
  tagLine,
  thermalSummary,
  thermalTag,
  topMessages,
} from '../lib/thermal.js'
import { classify } from '../lib/classify.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function eq(actual, expected, label) {
  check(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// --- the unit ---------------------------------------------------------------

console.log('\n== the PMU reports 0.01 °C ==')
check(THERMAL_TEMP_UNIT === 0.01, 'the unit is documented as 0.01, not guessed per sample')

// Real output, measured on an iPhone 13 (iPhone14,5, iOS 16.4.1) over the classic diagnostics
// channel. 3179 is 31.79 °C; the phone was on charge at 93%.
const REAL_LINE = '{"InstantAmperage": 858, "Temperature": 3179, "Voltage": 4297, "IsCharging": true, "CurrentCapacity": 93}'
const sample = parseBatterySample(REAL_LINE)
check(sample !== null, 'a real monitor line parses')
eq(sample.tempC, 31.79, '3179 counts is 31.79 °C')
eq(sample.charging, true, 'charging is read from IsCharging')
eq(sample.currentMa, 858, 'the amperage is kept')
eq(sample.capacity, 93, 'the capacity is kept')

// A second real reading, this one from an iPhone 12 (iOS 18.3.1) while charging at 25%.
eq(parseBatterySample('{"InstantAmperage": 875, "Temperature": 3519, "Voltage": 3939, "IsCharging": true, "CurrentCapacity": 25}').tempC, 35.19,
  '3519 counts is 35.19 °C')

console.log('\n== what is not a sample ==')
eq(parseBatterySample(''), null, 'an empty line is not a sample')
eq(parseBatterySample('   '), null, 'whitespace is not a sample')
eq(parseBatterySample('2026-10-27 pymobiledevice3 ERROR Device not found: usbmux has no device'), null,
  'the tool\'s own error is not a sample')
eq(parseBatterySample('Usage: pymobiledevice3 diagnostics battery monitor'), null, 'a usage line is not a sample')
eq(parseBatterySample('{not json'), null, 'a truncated object is not a sample')
eq(parseBatterySample('[1,2,3]'), null, 'an array is not a sample')
eq(parseBatterySample('null'), null, 'a bare null is not a sample')
eq(parseBatterySample(undefined), null, 'an absent line is not a sample')

// A line with no Temperature at all: the sample is still useful for charging and capacity, and
// answering `null` for the temperature is what keeps it out of the analysis.
const noTemp = parseBatterySample('{"InstantAmperage": 12, "Voltage": 4000, "IsCharging": false, "CurrentCapacity": 50}')
check(noTemp !== null, 'a sample without a temperature is still a sample')
eq(noTemp.tempC, null, 'and its temperature is null rather than zero')
eq(noTemp.charging, false, 'its charge state is still read')

// --- the tag ----------------------------------------------------------------

console.log('\n== the tag ==')
eq(thermalTag(28.693, false), '[T=28.69C]', 'two decimals, no charge mark')
eq(thermalTag(28.693, true), '[T=28.69C+]', 'the plus says the phone is charging')
eq(thermalTag(31.79, false), '[T=31.79C]', 'a real PMU reading')
eq(thermalTag(null, false), null, 'no temperature is no tag')
eq(thermalTag(undefined, true), null, 'an absent temperature is no tag')
eq(thermalTag(Number.NaN, false), null, 'NaN is no tag')
eq(thermalTag(0, false), '[T=0.00C]', 'zero is a temperature, not an absence')

eq(tagLine('Compiling Foo.swift', 28.693, false), '[T=28.69C] Compiling Foo.swift', 'the tag goes in front')
eq(tagLine('Compiling Foo.swift', null, false), 'Compiling Foo.swift', 'no temperature leaves the line alone')

console.log('\n== the tag must not change what a line IS ==')
// The whole reason the tag is applied AFTER classification: these anchors sit at the start of the
// line, so classifying the tagged text would silently demote every note and every section heading
// to a plain line — the temperature would be readable while the colours it broke were not.
const tagged = [
  ['note: Run script build phase will be run during every build', 'note'],
  ['=== BUILD TARGET Foo OF PROJECT Bar WITH CONFIGURATION Debug ===', 'section'],
  ['--- xcodebuild: WARNING: Using the first of multiple matching destinations', 'section'],
  ['$ xcodebuild -scheme Foo build', 'section'],
  ['error: no such module \'Alamofire\'', 'error'],
  ['warning: the iOS deployment target is set to 12.0', 'warning'],
  ['Compile Foo.swift', 'task'],
]
for (const [line, kind] of tagged) {
  eq(classify(line), kind, `the raw line is a ${kind}`)
}
// The two shapes the tag genuinely destroys, named so that the fix cannot be undone silently: the
// run stores the tagged text and the kind classified from the raw text, and this is what would go
// wrong if that order were ever swapped.
eq(classify(tagLine('note: something', 31.79, false)), 'plain',
  'classifying the tagged note would demote it — which is why pushLine classifies first')
eq(classify(tagLine('=== BUILD ===', 31.79, false)), 'plain',
  'and why the tagged section heading would lose its rule')
// Everything without an anchored prefix survives either way, so the ordering is only load-bearing
// for those two families and the fix costs nothing elsewhere.
eq(classify(tagLine('error: no such module', 31.79, false)), 'error', 'an error is still an error tagged')

// --- the window analysis ----------------------------------------------------

console.log('\n== smoothing ==')
// 12:00:00 and 12:00:01 land in the same 5 s bucket; 12:00:05 starts the next one.
const flat = [0, 1, 2, 3, 4].map((i) => ({ at: i, tempC: 30 + i * 0.1 }))
const smoothed = smoothSeries(flat, 5)
eq(smoothed.length, 1, 'five seconds of samples under one bucket collapse to one point')
check(Math.abs(smoothed[0][1] - 30.2) < 1e-9, 'and the point is their average')

const two = smoothSeries([{ at: 0, tempC: 30 }, { at: 5, tempC: 32 }], 5)
eq(two.length, 2, 'a sample on the bucket boundary starts a new one')
eq(two[1][1], 32, 'with its own average')

eq(smoothSeries([{ at: 0, tempC: null }, { at: 1, tempC: Number.NaN }], 5).length, 0,
  'samples without a usable temperature are dropped rather than averaged in as zero')

console.log('\n== a warming window is found ==')
// 20 minutes at 30 °C, then a 5-minute climb to 33.5 °C, then flat. The window that matters is the
// climb: +3.5 °C over five minutes, well over the 0.3 °C threshold.
const climb = []
for (let t = 0; t <= 1200; t += 10) climb.push({ at: t, tempC: 30 })
for (let t = 1210; t <= 1500; t += 10) climb.push({ at: t, tempC: 30 + ((t - 1200) / 300) * 3.5 })
for (let t = 1510; t <= 2400; t += 10) climb.push({ at: t, tempC: 33.5 })

const windows = findHotWindows(climb)
check(windows.length >= 1, 'the climb produces a window', `${windows.length} found`)
eq(windows[0].delta.toFixed(1), '3.5', 'and its size is the climb')
check(windows[0].end >= 1200 && windows[0].end <= 1520, 'the window ends inside the climb', String(windows[0].end))
check(windows[0].end - windows[0].start >= 240 && windows[0].end - windows[0].start <= 360,
  'and it is about five minutes long', String(windows[0].end - windows[0].start))

console.log('\n== a flat phone has no window ==')
const flatPhone = []
for (let t = 0; t <= 2400; t += 10) flatPhone.push({ at: t, tempC: 30 })
eq(findHotWindows(flatPhone).length, 0, 'no warming, no window')

// Cooling by more than the threshold is not warming: the report is about heat, and a phone that
// cooled by 3 °C says nothing about what is making it hot.
const cooling = []
for (let t = 0; t <= 1200; t += 10) cooling.push({ at: t, tempC: 34 })
for (let t = 1210; t <= 1500; t += 10) cooling.push({ at: t, tempC: 34 - ((t - 1200) / 300) * 3 })
eq(findHotWindows(cooling).length, 0, 'cooling is not a warming window')

check(findHotWindows([{ at: 0, tempC: 30 }]).length === 0, 'one sample cannot make a window')
check(findHotWindows([]).length === 0, 'no samples cannot make a window')

console.log('\n== the threshold is a threshold ==')
// 0.2 °C over five minutes is under it; 0.4 °C is over.
const barely = []
for (let t = 0; t <= 1200; t += 60) barely.push({ at: t, tempC: 30 })
for (let t = 1260; t <= 1500; t += 60) barely.push({ at: t, tempC: 30.2 })
eq(findHotWindows(barely).length, 0, 'a 0.2 °C drift is not a window')

const clearly = []
for (let t = 0; t <= 1200; t += 60) clearly.push({ at: t, tempC: 30 })
for (let t = 1260; t <= 1500; t += 60) clearly.push({ at: t, tempC: 30.4 })
check(findHotWindows(clearly).length >= 1, 'a 0.4 °C rise is a window')

// --- the messages inside a window ------------------------------------------

console.log('\n== which messages fired inside the window ==')
eq(normalizeLine('2026-10-27 14:18:33.782713 Foo: TimeStamp 0x7f3a2', undefined), 'Foo: TimeStamp #',
  'the timestamp and the numbers are normalized away')
eq(normalizeLine('Foo: TimeStamp 0x7f999'), normalizeLine('Foo: TimeStamp 0x7f3a2'),
  'two lines that differ only in a number are the same message')
eq(normalizeLine('Foo: finished in 12.5 ms'), 'Foo: finished in # ms', 'decimals are numbers too')
eq(normalizeLine('Foo: 0xDEADBEEF'), 'Foo: #', 'hexadecimal is a number')

const records = [
  { at: 100, line: '2026-10-27 12:00:00.000 Foo: heartbeat' },
  { at: 110, line: '2026-10-27 12:00:10.000 Foo: heartbeat' },
  { at: 120, line: '2026-10-27 12:00:20.000 Foo: heartbeat' },
  { at: 1300, line: '2026-10-27 12:20:00.000 Foo: hot path 0x1' },
  { at: 1310, line: '2026-10-27 12:20:10.000 Foo: hot path 0x2' },
  { at: 1320, line: '2026-10-27 12:20:20.000 Foo: hot path 0x3' },
]
const top = topMessages(records, 1290, 1330, 5)
eq(top.length, 1, 'only the message that fired inside the window is listed')
eq(top[0].count, 3, 'the hot path fired three times inside')
eq(top[0].outside, 0, 'and never outside')
eq(top[0].message, 'Foo: hot path #', 'the three lines are one message, with the numbers normalized away')
check(!top.some((entry) => entry.message.includes('heartbeat')),
  'a message that only fired outside the window is not listed')

// A message that fires equally in and out of the window is normal work, and the report says so by
// keeping the outside count next to it rather than by hiding it.
const noisy = [
  { at: 10, line: 'Foo: tick' },
  { at: 1300, line: 'Foo: tick' },
]
const noisyTop = topMessages(noisy, 1290, 1330, 5)
eq(noisyTop[0].message, 'Foo: tick', 'a message present both in and out is still listed')
eq(noisyTop[0].count, 1, 'with its count inside')
eq(noisyTop[0].outside, 1, 'and its count outside, which is what tells the two apart')

// --- the report -------------------------------------------------------------

console.log('\n== the report a run prints ==')
const report = thermalSummary({
  samples: climb,
  records: [
    { at: 1300, line: 'Foo: hot path 0x1' },
    { at: 1310, line: 'Foo: hot path 0x2' },
  ],
  logPath: '/tmp/xr1-123-ios-deploy.log',
})
check(report.windows >= 1, 'the report found the window')
check(report.text.includes('温度窗口分析'), 'and it names itself in the log')
check(report.text.includes('热'), 'and it is written for a reader of the log')
check(report.text.includes('+3.5') || report.text.includes('+3.4') || report.text.includes('+3.6'),
  'the window size is printed', report.text)
check(report.text.includes('/tmp/xr1-123-ios-deploy.log'), 'the sed command names the run\'s log')
check(report.text.includes('Foo: hot path'), 'and the messages that fired inside it')

const empty = thermalSummary({ samples: flatPhone, records: [], logPath: '/tmp/x.log' })
eq(empty.windows, 0, 'a flat run reports no windows')
check(empty.text.includes('没有找到明显升温窗口'), 'and says why rather than printing nothing')
check(!empty.text.includes('sed -n'), 'with no sed command for a window that does not exist')

// The report must not claim a window it did not find, and must not print a `sed` line the user
// cannot run because no log path was given.
const noPath = thermalSummary({ samples: climb, records: [], logPath: '' })
check(!noPath.text.includes('sed -n'), 'no log path means no sed command rather than `sed -n ... /`')

console.log('\n== the clock ==')
// `formatClock` is what the sed range is built from, so it has to agree with the timestamps in the
// log, and those are the host's local time.
const when = new Date(2026, 9, 27, 14, 18, 33).getTime()
eq(formatClock(when / 1000), '14:18:33', 'HH:MM:SS in the host\'s own time')

// --- the command line -------------------------------------------------------

console.log('\n== the command a monitor runs ==')
const argv = batteryMonitorArgv('00008030-000123456789ABCD', '/opt/homebrew/bin/pymobiledevice3')
eq(argv[0], '/opt/homebrew/bin/pymobiledevice3', 'the resolved tool is used, not a bare name')
eq(argv.slice(1).join(' '), 'diagnostics battery monitor --udid 00008030-000123456789ABCD',
  'the subcommand and the udid are exactly what was measured')
eq(batteryMonitorArgv('X')[0], 'pymobiledevice3', 'a bare name is allowed when nothing was resolved')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('thermal OK')
