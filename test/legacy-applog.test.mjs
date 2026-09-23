// The app's own log on the classic channel: which file, where it lands, how it is
// fetched, and how much of it is safe to return.
//
// Every constant below came off the device while it was locked, which is the only
// reason this route is worth having: the log that survives a launch failure can be
// read without waking the device, while the launch itself cannot happen at all.
//
// Run: node test/legacy-applog.test.mjs

import {
  APP_LOG_DIR,
  APP_LOG_TAIL_BYTES,
  appLogPullArgv,
  appLogStamp,
  downloadedPathFor,
  isAppLogName,
  newLaunchLog,
  newLinesSince,
  pickLatestAppLog,
  rankAppLogs,
  tailOfAppLog,
} from '../lib/legacy-applog.js'

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
// The pump's answers are line arrays, where `===` compares identity and would fail
// on two identical lists.
function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}

// The real directory listing (pymobiledevice3's AFC listing of
// Documents/PPCrashLog on the iPhone X, 2026-09-22 22:42), reproduced verbatim:
// three launch logs and one stall report.
const DEVICE_LISTING = [
  'log_2026-09-22-22-09-45.462.log',
  'watchdog_stall.log',
  'log_2026-09-22-22-06-46.546.log',
  'log_2026-09-22-22-05-31.401.log',
]

console.log('== which files are launch logs ==')
eq(isAppLogName('log_2026-09-22-22-09-45.462.log'), true, 'the real name')
eq(isAppLogName('log_2026-09-22-22-09-45.log'), true, 'a name without milliseconds still counts')
eq(isAppLogName('watchdog_stall.log'), false, 'the stall report shares the directory and is not a launch log')
eq(isAppLogName('log_.log'), false, 'a log with no stamp names no launch')
eq(isAppLogName('log_2026-09-22.log'), false, 'a date alone is not the app format')
eq(isAppLogName(''), false, 'empty')
eq(isAppLogName(undefined), false, 'absent')

console.log('== the stamp is the launch instant ==')
eq(appLogStamp('log_2026-09-22-22-09-45.462.log'), '2026-09-22 22:09:45.462', 'the launch that entered a live room and was killed')
eq(appLogStamp('log_2026-09-22-22-05-31.401.log'), '2026-09-22 22:05:31.401', 'an earlier launch')
eq(appLogStamp('watchdog_stall.log'), null, 'not a launch log')
eq(appLogStamp('log_2026-09-22-22-09-45.log'), '2026-09-22 22:09:45', 'no milliseconds, no dot')

console.log('== the newest launch is the one to read ==')
// ios-deploy does not preserve the device mtime, so the NAME is the ordering key.
// Its format is fixed-width, which is what makes a string sort correct here.
eq(pickLatestAppLog(DEVICE_LISTING), 'log_2026-09-22-22-09-45.462.log', 'the newest launch wins')
eq(pickLatestAppLog(['watchdog_stall.log']), null, 'stall reports alone are not a launch log')
eq(pickLatestAppLog([]), null, 'nothing downloaded')
eq(pickLatestAppLog(undefined), null, 'no listing at all')
eq(
  rankAppLogs(DEVICE_LISTING).join(','),
  'log_2026-09-22-22-09-45.462.log,log_2026-09-22-22-06-46.546.log,log_2026-09-22-22-05-31.401.log',
  'newest first, stall report excluded',
)
// A name sort that ignored the format would put `log_...-9-45` ahead of
// `log_...-10-45` only if the fields were not zero-padded; this pins the ordering
// across a minute and an hour boundary.
eq(
  pickLatestAppLog(['log_2026-09-22-09-59-59.999.log', 'log_2026-09-22-10-00-00.001.log']),
  'log_2026-09-22-10-00-00.001.log',
  'the sort survives an hour boundary',
)

console.log('== the transfer that was measured on the device ==')
// `--bundle_id` selects the app container; without it ios-deploy addresses the
// media filesystem, a different tree entirely.
eq(APP_LOG_DIR, 'Documents/PPCrashLog', 'the path the app writes to')
eq(
  appLogPullArgv({
    launcher: '/opt/homebrew/bin/ios-deploy',
    udid: '0000a1b2c3d4e5f60718293a4b5c6d7e8f901234',
    bundleId: 'com.example.demoapp',
    devicePath: APP_LOG_DIR,
    toDir: '/tmp/dltree',
    directory: true,
  }).join(' '),
  '/opt/homebrew/bin/ios-deploy --id 0000a1b2c3d4e5f60718293a4b5c6d7e8f901234 --bundle_id com.example.demoapp '
    + '--download=Documents/PPCrashLog --to /tmp/dltree --non-recursively',
  'the directory download, verbatim',
)
eq(
  appLogPullArgv({
    launcher: 'ios-deploy',
    udid: 'U',
    bundleId: 'B',
    devicePath: 'Documents/PPCrashLog/log_2026-09-22-22-09-45.462.log',
    toDir: '/tmp/x',
  }).includes('--non-recursively'),
  false,
  'a single file is not asked for non-recursively',
)

// Verified against the device: downloading /Documents/PPCrashLog into /tmp/dltree
// produced /tmp/dltree/Documents/PPCrashLog/<name>, and a single file download
// produced /tmp/wd.log/Documents/PPCrashLog/watchdog_stall.log.
console.log('== where the download lands ==')
eq(
  downloadedPathFor('/tmp/dltree', 'Documents/PPCrashLog/log_2026-09-22-22-09-45.462.log'),
  '/tmp/dltree/Documents/PPCrashLog/log_2026-09-22-22-09-45.462.log',
  'the device path is kept under --to',
)
eq(downloadedPathFor('/tmp/dltree', '/Documents/PPCrashLog'), '/tmp/dltree/Documents/PPCrashLog', 'a leading slash is not doubled')
eq(downloadedPathFor('/tmp/dltree/', '/Documents'), '/tmp/dltree/Documents', 'a trailing slash on the target is not doubled')
eq(downloadedPathFor('/tmp/dltree', '/'), '/tmp/dltree', 'the container root lands at --to itself')

console.log('== a new file on the other side of a launch is the evidence ==')
// This is the decision the launch makes: the name before the launch, the name
// after it, and whether the app wrote one. It is the same rule as the pid probe —
// presence decides, silence never does — because the file is written as the
// process starts and can lag the detach.
eq(
  newLaunchLog('log_2026-09-22-22-06-46.546.log', 'log_2026-09-22-22-09-45.462.log'),
  'log_2026-09-22-22-09-45.462.log',
  'a different name after the launch is this launch',
)
eq(
  newLaunchLog(null, 'log_2026-09-22-22-09-45.462.log'),
  'log_2026-09-22-22-09-45.462.log',
  'the app had never logged before, so the first file is this launch',
)
eq(
  newLaunchLog('log_2026-09-22-22-09-45.462.log', 'log_2026-09-22-22-09-45.462.log'),
  null,
  'the same name means the launch wrote nothing new — and does not mean it failed',
)
eq(newLaunchLog('log_2026-09-22-22-09-45.462.log', null), null, 'an unreadable container proves nothing')
eq(newLaunchLog(undefined, ''), null, 'absent on both sides')

console.log('== the tail is what is returned ==')
const long = `${'x'.repeat(APP_LOG_TAIL_BYTES * 2)}\nlast line\n`
const tail = tailOfAppLog(long)
check(tail.length <= APP_LOG_TAIL_BYTES, 'the tail respects the ceiling', `length ${tail.length}`)
eq(tail, 'last line\n', 'the cut lands on a line boundary and keeps the end of the log')
eq(tailOfAppLog('short\n'), 'short\n', 'a small log is returned whole')
eq(tailOfAppLog(undefined), '', 'an absent log is empty text')

// The pump that keeps a running app's log flowing into the panel cannot count lines
// or track a byte offset: it re-downloads the file's TAIL every tick, so indices shift
// as the beginning slides out. The marker is the last line already pushed.

console.log("== only what the app's log gained ==")
const first = 'boot\nfps 34\nfps 35'
equal(newLinesSince(first, null), ['boot', 'fps 34', 'fps 35'], 'a first look has nothing to compare against')
equal(newLinesSince('boot\nfps 34\nfps 35\nfps 36', 'fps 35'), ['fps 36'], 'the lines after the marker are new')
equal(newLinesSince(first, 'fps 35'), [], 'a log that has not grown has nothing new')
equal(newLinesSince('fps 35\n', 'fps 35'), [''], 'a trailing newline is an empty line, not a repeat')
// A repeated line is why the LAST occurrence is the marker: the app logs `fps` over
// and over, and matching the first one would reprint everything since boot.
equal(
  newLinesSince('fps 34\nmid\nfps 34\nfps 35', 'fps 34'),
  ['fps 35'],
  'a repeated line matches its last occurrence, so nothing already pushed comes back',
)
eq(
  newLinesSince('totally different content', 'fps 35'),
  null,
  'a marker that scrolled out of the tail window is "cannot tell", never "everything is new"',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('legacy app log OK')
