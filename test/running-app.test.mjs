// Tests for "which process is the app".
//
// The fixtures are the real shapes: the devicectl JSON is what `devicectl device info
// processes --json-output` printed while an app was running on an iPhone 13, and the
// launchctl output is what `simctl spawn <udid> launchctl list` printed on a booted
// iPhone 17 simulator. Both are trimmed to the records that matter, and the names are
// the ones that prompted this module.
//
// Run: node test/running-app.test.mjs
import { findAppProcess, parseLaunchctlList, parseProcessList } from '../lib/running-app.js'

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
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}
function section(title) {
  console.log(`\n== ${title} ==`)
}

// =========================================================================
// devicectl's process list
// =========================================================================

section('a device process list')
{
  const text = JSON.stringify({
    info: { commandType: 'devicectl.device.info.processes' },
    result: {
      runningProcesses: [
        { executable: 'file:///sbin/launchd', processIdentifier: 1 },
        {
          executable: 'file:///private/var/containers/Bundle/Application/4903FA4B-31ED-4DBF-9ADC-6E4D294A0D98/HIDProbe.app/HIDProbe',
          processIdentifier: 13845,
        },
        { executable: 'file:///usr/libexec/backboardd', processIdentifier: 92 },
      ],
    },
  })
  const processes = parseProcessList(text)
  eq(processes.length, 3, 'every process is read')
  eq(processes[1], {
    pid: 13845,
    executable: 'file:///private/var/containers/Bundle/Application/4903FA4B-31ED-4DBF-9ADC-6E4D294A0D98/HIDProbe.app/HIDProbe',
    name: 'HIDProbe',
  }, 'with its pid and the executable\'s own name')
  eq(parseProcessList('not json at all'), [], 'and a JSON error is no processes rather than a throw')
  eq(parseProcessList(JSON.stringify({ result: {} })), [], 'as is a result with no list in it')
  eq(
    parseProcessList(JSON.stringify({ result: { runningProcesses: [{ executable: 'file:///x' }, { processIdentifier: 0 }, { processIdentifier: 'nope' }] } })),
    [],
    'records without a usable pid are dropped, not counted as pid 0',
  )
}

// =========================================================================
// matching the app inside that list
// =========================================================================

section('finding the app among them')
{
  const processes = parseProcessList(JSON.stringify({
    result: {
      runningProcesses: [
        { executable: 'file:///sbin/launchd', processIdentifier: 1 },
        {
          executable: 'file:///private/var/containers/Bundle/Application/4903FA4B-31ED-4DBF-9ADC-6E4D294A0D98/HIDProbe.app/HIDProbe',
          processIdentifier: 13845,
        },
        { executable: 'file:///private/var/containers/Bundle/Application/1/HIDProbeHelper.app/HIDProbeHelper', processIdentifier: 13846 },
      ],
    },
  }))
  eq(findAppProcess(processes, 'HIDProbe')?.pid, 13845, 'the app is found by its bundle directory')
  check(findAppProcess(processes, 'HIDProbe')?.pid !== 13846,
    'and a different app whose name merely starts the same is not it')
  eq(findAppProcess(processes, '蜜语-Dev'), null,
    'an app that is not running is null — the measured case: 339 processes, none of them it')
  eq(findAppProcess(processes, '')?.pid, undefined, 'an empty name matches nothing')
  eq(findAppProcess(null, 'HIDProbe'), null, 'as does no list at all')

  // The bundle's name and the executable's name can differ; the bundle is what the
  // caller has, because that is the path Xcode built.
  const renamed = parseProcessList(JSON.stringify({
    result: { runningProcesses: [{ executable: 'file:///private/var/containers/Bundle/Application/2/MyApp.app/MyAppBinary', processIdentifier: 77 }] },
  }))
  eq(findAppProcess(renamed, 'MyApp')?.pid, 77, 'matched on the bundle even when the executable is named differently')

  // A debugger's own launch can start the binary from outside its bundle.
  const outside = parseProcessList(JSON.stringify({
    result: { runningProcesses: [{ executable: 'file:///tmp/build/Products/HIDProbe', processIdentifier: 78 }] },
  }))
  eq(findAppProcess(outside, 'HIDProbe')?.pid, 78, 'and a process started from outside its bundle is still found by name')
}

// =========================================================================
// a simulator's launchctl list
// =========================================================================

section('a simulator\'s loaded services')
{
  // Real output, tabs and all, including the header and the `-` pid that means
  // "loaded but not running".
  const text = [
    'PID\tStatus\tLabel',
    '-\t0\tcom.apple.progressd',
    '-\t0\tcom.apple.CoreAuthentication.daemon',
    '68331\t0\tUIKitApplication:com.apple.mobilecal[1a99][rb-legacy]',
    '68213\t0\tUIKitApplication:com.apple.Spotlight[d26c][rb-legacy]',
    '68536\t0\tUIKitApplication:com.suishoubo.ppmain2[1dd1][rb-legacy]',
    '',
  ].join('\n')
  eq(parseLaunchctlList(text, 'com.suishoubo.ppmain2'), 68536, 'the app\'s pid is read off its UIKitApplication line')
  eq(parseLaunchctlList(text, 'com.apple.mobilecal'), 68331, 'and so is another app\'s')
  eq(parseLaunchctlList(text, 'com.example.Absent'), null, 'an app that is not running is null')
  eq(parseLaunchctlList(text, 'com.apple.progressd'), null,
    'a service with a `-` pid is loaded, not running, and is not offered as a pid')
  eq(parseLaunchctlList(text, ''), null, 'an empty bundle id never matches the first running line')
  eq(parseLaunchctlList('', 'com.suishoubo.ppmain2'), null, 'and no output is no pid')
  // A bundle id that is a prefix of another must not be mistaken for it.
  check(parseLaunchctlList(text, 'com.apple.mobile') === null, 'a prefix of a running bundle id does not match it')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('running-app OK')
