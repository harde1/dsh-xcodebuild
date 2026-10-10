// Tests for "which process is the app".
//
// The fixtures are the real shapes: the devicectl JSON is what `devicectl device info
// processes --json-output` printed while an app was running on an iPhone 13, and the
// launchctl output is what `simctl spawn <udid> launchctl list` printed on a booted
// iPhone 17 simulator. Both are trimmed to the records that matter, and the names are
// the ones that prompted this module.
//
// Run: node test/running-app.test.mjs
import { findAppProcess, parseDvtProcessList, parseLaunchctlList, parseProcessList } from '../lib/running-app.js'

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

  // devicectl percent-encodes the path, and an app can be called anything. This is the
  // measured shape of a running 蜜语-Dev: matching the name as it is printed in the panel
  // against the URL as it arrives found nothing, so a running app was reported as not
  // running.
  const nonAscii = parseProcessList(JSON.stringify({
    result: {
      runningProcesses: [{
        executable: 'file:///private/var/containers/Bundle/Application/A1215665-9E24-477F-AAFF-C8CFC050D8BC/%E8%9C%9C%E8%AF%AD-Dev.app/%E8%9C%9C%E8%AF%AD-Dev',
        processIdentifier: 14224,
      }],
    },
  }))
  eq(findAppProcess(nonAscii, '蜜语-Dev')?.pid, 14224, 'an app whose name is not ASCII is found through the URL encoding')
  eq(nonAscii[0].name, '蜜语-Dev', 'and its name is decoded, so a message can name it')
  check(nonAscii[0].executable.includes('蜜语-Dev.app'), 'as is the path it is matched on')
  eq(findAppProcess(parseProcessList(JSON.stringify({
    result: { runningProcesses: [{ executable: 'file:///tmp/100%.app/100%', processIdentifier: 9 }] },
  })), '100%')?.pid, 9, 'while a stray percent sign is tolerated rather than thrown on')

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
// --- pymobiledevice3's DVT list, for an iOS 16 and earlier device -----------
//
// Trimmed from `pymobiledevice3 developer dvt proclist --udid …` on an iPhone X, iOS 16.7.12.
{
  const dvt = JSON.stringify([
    { isApplication: false, name: 'diagnosticd', pid: 351, realAppName: '/usr/libexec/diagnosticd', startDate: '2026-10-10 04:53:55+00:00' },
    { isApplication: true, name: 'RunnerExt-NotificationService', pid: 342, realAppName: '/private/var/containers/Bundle/Application/B1DF/Runner.app/PlugIns/RunnerExt-NotificationService.appex/RunnerExt-NotificationService' },
    { isApplication: true, name: 'AegirPoster', pid: 573, realAppName: '/System/Library/CoreServices/AegirProxyApp.app/PlugIns/AegirPoster.appex/AegirPoster' },
    { bundleIdentifier: 'com.apple.mobilesafari', isApplication: true, name: 'MobileSafari', pid: 319, realAppName: '/Applications/MobileSafari.app/MobileSafari' },
    { bundleIdentifier: 'com.suishoubo.ppmain3', isApplication: true, name: '蜜语-Dev', pid: 954, realAppName: '/var/containers/Bundle/Application/B950/蜜语-Dev.app/蜜语-Dev' },
  ])
  const apps = parseDvtProcessList(dvt)
  check(apps.length === 2, 'only apps with a bundle id, and no extensions or daemons', JSON.stringify(apps.map((app) => app.name)))
  const ours = apps.find((app) => app.bundleId === 'com.suishoubo.ppmain3')
  check(ours?.pid === 954 && ours?.name === '蜜语-Dev', 'the app keeps its pid and its own (unencoded) name', JSON.stringify(ours))
  check(parseDvtProcessList('not json').length === 0, 'output that is not the list is no apps')
  check(parseDvtProcessList('{"a":1}').length === 0, 'and neither is JSON of another shape')
}

if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('running-app OK')
