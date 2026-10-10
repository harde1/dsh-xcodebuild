// What the inspector says to a phone CoreDevice cannot see.
//
// The whole point of this module is that ONE string never reaches a user:
//
//   ERROR: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000 (0x3E8))
//
// It was measured on an iPhone X (iPhone10,3, iOS 16.7.12) that was plugged in, paired and
// answering on the classic channel at the time — `devicectl` cannot reach that generation at
// all, not even by name. The error blames the phone, so a notice that replaces it has to name
// the real boundary, the phone, and what still works.
//
// Run: node test/legacy-inspector.test.mjs

import {
  classicAttachCommands,
  debugserverProxyArgv,
  deviceSupportSymbolsPath,
  legacyChannelNotice,
} from '../lib/legacy-inspector.js'
import { legacyInspectorRefusal } from '../lib/index.js'

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

const X = {
  name: 'congiPhone',
  id: 'd6c2c9dd2da8def539603fe180c1e6c59b277f58',
  version: '16.7.12',
}

// --- the notice names the boundary, not the phone -------------------------

console.log('== the notice names the boundary ==')
const notice = legacyChannelNotice({ ...X, what: 'Attaching the debugger' })
check(notice.includes('congiPhone'), 'the phone is named as the user knows it', notice)
check(notice.includes(X.id), 'and by its udid, which is the only id it has', notice)
check(notice.includes('16.7.12'), 'the iOS version that draws the line', notice)
check(/iOS 17 and later only/.test(notice), 'why CoreDevice cannot help', notice)
check(notice.startsWith('Attaching the debugger'), 'the operation leads, so the message reads as an answer', notice)

// --- and never the raw error, which blames the phone ----------------------

console.log('== the raw CoreDevice error never appears ==')
// The error is what this exists to replace. Asserting on the CODE as well as the wording,
// because `devicectl` may reword its prose and the code is what a reader would search for.
check(!/CoreDeviceError/.test(notice), 'no CoreDeviceError', notice)
check(!/error 1000/.test(notice), 'no error 1000', notice)
check(!/0x3E8/.test(notice), 'no 0x3E8', notice)
check(!/device was not found/i.test(notice), 'nothing that reads as "the phone is missing"', notice)

// --- what DOES work is said, because that is the useful half --------------

console.log('== the working channel is named ==')
check(/classic USB\/lockdown channel/.test(notice), 'the channel that does reach the phone', notice)
check(/building, running and the device log/.test(notice), 'what already works on it', notice)
check(/Xcode/.test(notice), 'and the way to debug this generation today', notice)

// --- a phone with no name, or no version, still reads ---------------------

console.log('== the notice survives missing facts ==')
const unnamed = legacyChannelNotice({ id: X.id, version: '16.7.12', what: 'Listing the running apps' })
check(unnamed.includes(X.id), 'no name: the udid is used rather than "undefined"', unnamed)
check(!/undefined/.test(unnamed), 'and nothing renders as undefined', unnamed)

const unversioned = legacyChannelNotice({ name: 'congiPhone', id: X.id, what: 'Listing the running apps' })
check(/iOS 16 or earlier device/.test(unversioned), 'no version: the generation is still named', unversioned)
check(!/iOS\s+device/.test(unversioned), 'and not as a blank version', unversioned)

const bare = legacyChannelNotice({ what: 'This' })
check(/this device/.test(bare), 'nothing at all: "this device"', bare)
check(!/undefined|null/.test(bare), 'and still nothing renders as undefined or null', bare)

// --- whitespace is not a value --------------------------------------------

console.log('== blank fields are not values ==')
const blanked = legacyChannelNotice({ name: '   ', id: X.id, version: '  ', what: 'X' })
check(blanked.includes(X.id), 'a whitespace-only name falls back to the udid', blanked)
check(/iOS 16 or earlier device/.test(blanked), 'a whitespace-only version falls back to the generation', blanked)

// --- the guard: who is refused, and who is not asked about ----------------

console.log('== only a named device on hardware is asked about ==')
// These three must decide WITHOUT probing: a simulator is not a CoreDevice question, and an
// unnamed target is nothing to ask about. Each returns null, which means "go on".
eq(await legacyInspectorRefusal({ kind: 'simulator', id: 'A1B2' }, '/', 'X'), null, 'a simulator is never refused')
eq(await legacyInspectorRefusal({ id: X.id }, '/', 'X'), null, 'a target with no kind is not asked about')
eq(await legacyInspectorRefusal({ kind: 'device', id: '   ' }, '/', 'X'), null, 'a blank id is not a device to ask about')
eq(await legacyInspectorRefusal(null, '/', 'X'), null, 'no target at all')

// A device that answers nothing is NOT a verdict: `null` (go on) rather than a refusal, so a
// phone that is briefly unreachable is not pinned as legacy for the rest of the process.
eq(await legacyInspectorRefusal({ kind: 'device', id: 'not-a-device-at-all' }, '/', 'X'), null, 'an unknown device is not refused')

// --- the recipe the classic attach needs, kept ready ----------------------
//
// libimobiledevice 1.3.0 could not forward a debugserver port (it asks for `com.apple.debugserver`,
// which answers `InvalidService`). pymobiledevice3 can, and the route now uses it — see
// legacy-forwarder.test.mjs and the classic recipe in lldb-session.test.mjs. The sysroot rule
// below is what that attach uses.

console.log('== the sysroot carries /Symbols, which is the footgun ==')
const SYM = deviceSupportSymbolsPath({
  root: '/Users/x/Library/Developer/Xcode/iOS DeviceSupport',
  productType: 'iPhone10,3',
  productVersion: '16.7.12',
  buildVersion: '20H364',
})
eq(
  SYM,
  '/Users/x/Library/Developer/Xcode/iOS DeviceSupport/iPhone10,3 16.7.12 (20H364)/Symbols',
  'the measured iPhone X path, /Symbols included',
)
// Without the suffix the platform adopts a DIFFERENT device's SDK root — it picked an iPhone 13's
// while an iPhone X was being debugged — which is a silent way to read wrong symbols.
check(SYM.endsWith('/Symbols'), 'the bare DeviceSupport directory is never what is handed to --sysroot', SYM)
eq(deviceSupportSymbolsPath({ root: '/x', productType: 'iPhone10,3', productVersion: '16.7.12' }), '', 'a missing build is no path at all')
eq(deviceSupportSymbolsPath({ productType: 'iPhone10,3', productVersion: '16.7.12', buildVersion: '20H364' }), '', 'a missing root is no path at all')
eq(deviceSupportSymbolsPath({ root: '/x/', productType: 'iPhone10,3', productVersion: '16.7.12', buildVersion: '20H364' }), '/x/iPhone10,3 16.7.12 (20H364)/Symbols', 'a trailing slash on the root does not double up')

console.log('== the attach commands, in the order ios-deploy uses ==')
const commands = classicAttachCommands({ appPath: '/tmp/蜜语-Dev.app', port: 52350, process: '蜜语-Dev', symbolsPath: SYM })
eq(commands[0], `platform select remote-ios --sysroot "${SYM}"`, 'the platform is selected with THIS device sysroot, first')
eq(commands[1], 'target create "/tmp/蜜语-Dev.app"', 'the bundle is the target, so its symbols exist')
eq(commands[2], 'process connect connect://127.0.0.1:52350', 'then the tunnel, at a host:port — never connect://<udid>, which lldb refuses')
eq(commands[3], 'process attach --name "蜜语-Dev"', 'and only then is the process named')
check(
  commands.findIndex((c) => c.startsWith('process connect')) < commands.findIndex((c) => c.startsWith('process attach')),
  'connect precedes attach, because connect alone leaves nothing loaded',
)
// A named process is not assumed: with none known, the commands stop at the tunnel.
eq(classicAttachCommands({ port: 1 }).length, 2, 'no app and no process: platform and connect only')

console.log('== the proxy argv ==')
eq(
  debugserverProxyArgv({ proxy: '/opt/homebrew/bin/idevicedebugserverproxy', udid: X.id, port: 23456 }).join(' '),
  `/opt/homebrew/bin/idevicedebugserverproxy -u ${X.id} 23456`,
  'the port is positional, not a flag — measured: `-l` prints usage',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('legacy inspector OK')
