// Cleanup policy for what a launch leaves in the temporary directory. Real names
// from this machine's `/tmp` and `$TMPDIR` are in the fixtures below, because the
// whole point is to recognise what ios-deploy actually writes.
//
// Run: node test/session-files.test.mjs

import {
  APP_LOG_PREFIX,
  CONSOLE_KEEP,
  CONSOLE_MAX_AGE_MS,
  LEFTOVER_MAX_AGE_MS,
  consoleLogStamp,
  isFruitstrapDirFor,
  isSessionTempDir,
  isStaleLeftover,
  prunableConsoleLogs,
} from '../lib/session-files.js'

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
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 23, 11, 30)

console.log('== the launch time is in the name ==')
eq(consoleLogStamp('xr1-1790133524629-ios-deploy.log'), 1790133524629, 'a console file names the launch it belongs to')
eq(consoleLogStamp('xr12-1790133524629-ios-deploy.log'), 1790133524629, 'the run id can be more than one digit')
eq(consoleLogStamp('xr1-ios-deploy.log'), null, 'a name without a stamp is not one of ours')
eq(consoleLogStamp('xr1-123-ios-deploy.log'), null, 'a three-digit number is not an epoch')
eq(consoleLogStamp(undefined), null, 'nothing has no stamp')

console.log('== a new launch keeps the last few sessions and drops the rest ==')
// The stamp in the name is the launch time, so these fixtures express "launched n
// minutes ago" rather than an arbitrary number.
const named = (runId, at) => `${runId}-${String(at)}-ios-deploy.log`
const sessions = [1, 2, 3, 4, 5, 6, 7].map((minutes) => ({
  name: named(`xr${String(minutes)}`, NOW - minutes * MINUTE),
  mtimeMs: NOW - minutes * MINUTE,
}))
equal(
  prunableConsoleLogs(sessions, { now: NOW }),
  [named('xr6', NOW - 6 * MINUTE), named('xr7', NOW - 7 * MINUTE)],
  `the two oldest go when ${String(CONSOLE_KEEP)} are kept`,
)
// The stamp wins over mtime, because a copied file keeps its name but not its time:
// the launch that is OLDER is the one deleted, even though its file was touched last.
equal(
  prunableConsoleLogs(
    [
      { name: named('xr9', NOW - 2 * MINUTE), mtimeMs: NOW - 90 * DAY },
      { name: named('xr8', NOW - 5 * MINUTE), mtimeMs: NOW - 1 * MINUTE },
    ],
    { now: NOW, keep: 1 },
  ),
  [named('xr8', NOW - 5 * MINUTE)],
  "the newer launch is the one kept, whatever the files' mtimes say",
)
// The directory is the plugin's, but a file it did not write is not its litter: only
// a valid launch stamp makes a name a candidate, however old the file is.
equal(
  prunableConsoleLogs([{ name: 'hand-made.log', mtimeMs: NOW - 10 * DAY }], { now: NOW }),
  [],
  'a name without a launch stamp is never deleted, not even an old one',
)
equal(prunableConsoleLogs([], { now: NOW }), [], 'nothing to prune is not an error')
equal(prunableConsoleLogs(undefined, { now: NOW }), [], 'and neither is an unreadable directory')

console.log('== an abandoned directory does not stay forever ==')
equal(
  prunableConsoleLogs(
    [
      { name: named('xr1', NOW - 4 * DAY), mtimeMs: NOW - 4 * DAY },
      { name: named('xr2', NOW - 5 * DAY), mtimeMs: NOW - 5 * DAY },
    ],
    { now: NOW },
  ),
  [named('xr1', NOW - 4 * DAY), named('xr2', NOW - 5 * DAY)],
  `age overrides keeping: nothing survives ${String(Math.round(CONSOLE_MAX_AGE_MS / DAY))} days`,
)
equal(
  prunableConsoleLogs([{ name: named('xr3', NOW - DAY), mtimeMs: NOW - DAY }], { now: NOW }),
  [],
  'a day-old session is still readable',
)

console.log('== an hour of silence is what makes a leftover safe to delete ==')
eq(isStaleLeftover(NOW - 2 * HOUR, { now: NOW }), true, 'a two-hour-old directory has no live session behind it')
eq(isStaleLeftover(NOW - HOUR - 1, { now: NOW }), true, 'just past the boundary')
eq(isStaleLeftover(NOW - HOUR, { now: NOW }), false, 'exactly at the boundary is left alone')
eq(isStaleLeftover(NOW - 30 * MINUTE, { now: NOW }), false, 'a session that started half an hour ago may still be running')
eq(isStaleLeftover(NOW, { now: NOW }), false, 'something being written right now is never touched')
eq(isStaleLeftover(undefined, { now: NOW }), false, 'an unreadable time is never a reason to delete')
eq(LEFTOVER_MAX_AGE_MS, HOUR, 'the boundary is an hour')

console.log('== only the plugin\'s own corners of the temp directory are considered ==')
eq(isSessionTempDir('34BA5F80-63C5-4923-89ED-E328D5564ADA'), true, 'an ios-deploy UUID, from this machine')
eq(isSessionTempDir('46a90340-1af3-495f-ad20-9906dac3e65c'), true, 'lowercase too')
eq(isSessionTempDir(`${APP_LOG_PREFIX}gfaxzm`), true, 'an app-log download')
eq(isSessionTempDir('BlobRegistryFiles-CiZDic3A'), false, 'macOS keeps its own directories here')
eq(isSessionTempDir('AudioComponentRegistrar'), false, 'and plenty of them')
eq(isSessionTempDir('fruitstrap_'), false, 'a directory name alone is not an ios-deploy session')
eq(isSessionTempDir('34BA5F80-63C5-4923-89ED-E328D5564ADA-extra'), false, 'a UUID with something appended is not one')

console.log('== an ios-deploy directory is attributable to a device ==')
eq(isFruitstrapDirFor([`fruitstrap_${UDID}.py`], UDID), true, 'the python module names the device')
eq(isFruitstrapDirFor([`fruitstrap-lldb-prep-cmds-${UDID}`, 'fruitstrap_'], UDID), true, 'so does the prep file')
eq(isFruitstrapDirFor(['fruitstrap_'], UDID), false, 'a half-written directory names nothing')
eq(isFruitstrapDirFor([`fruitstrap_${UDID}.py`], 'other-device'), false, 'another device\'s session is not this one')
eq(isFruitstrapDirFor(['fruitstrap_.py'], ''), false, 'no device, no match')
eq(isFruitstrapDirFor(undefined, UDID), false, 'an unreadable directory is not matched')

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('session files OK')
