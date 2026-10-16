// The unpaired-device failure, and what the plugin says instead of it.
//
// The failure this covers, measured on this desk with a cabled iPhone XS Max (iOS 18.7.9) whose
// pairing record this Mac does not have — `devicectl` DISCOVERS it (`pairingState: unpaired`) and
// then refuses every command:
//
//   $ xcrun devicectl device info processes --device F9F9151E-…
//   ERROR: The device must be paired before it can be connected. (com.apple.dt.CoreDeviceError error 2 (0x02))
//          ----------------------------------------
//              The device must be paired before it can be connected. (com.apple.dt.RemotePairingError error 2 (0x02))
//
// Run: node test/device-pairing.test.mjs

import { isPairingFailure, pairingNotice } from '../lib/device-pairing.js'
import { parseDevicectlList, mergeDestinations } from '../lib/device-sources.js'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- the exact output this was written from -------------------------------

const REAL = [
  'ERROR: The device must be paired before it can be connected. (com.apple.dt.CoreDeviceError error 2 (0x02))',
  '       ----------------------------------------',
  '           The device must be paired before it can be connected. (com.apple.dt.RemotePairingError error 2 (0x02))',
].join('\n')

check(isPairingFailure(REAL) === true, 'the real devicectl output is recognised')
check(isPairingFailure('ERROR: The device must be paired before it can be connected. (com.apple.dt.CoreDeviceError error 2 (0x02))') === true,
  'and so is a capture of only its first line')
check(isPairingFailure('RemotePairingError error 2 (0x02)') === true, 'and a line that names only the domain')
check(isPairingFailure('') === false, 'empty output is not a pairing failure')
check(isPairingFailure('ERROR: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000 (0x3E8))') === false,
  'a device that is not there is a DIFFERENT failure, and the legacy notice owns it')
check(isPairingFailure('error: attach failed: no such process') === false, 'and so is a debugger attach failure')
// The code alone is the trap: `error 2` belongs to many domains, and a route that matched it on its
// own would blame pairing for a problem that has nothing to do with a phone.
check(isPairingFailure('The operation could not be completed. (SomeOtherDomain error 2.)') === false,
  'a bare `error 2` from another domain is not a pairing failure')
check(isPairingFailure('ERROR: Failed to install the app. (com.apple.dt.CoreDeviceError error 2002 (0x7D2))') === false,
  'nor is another CoreDevice error that merely ends in 2')

// --- what is said instead -------------------------------------------------

const named = pairingNotice({ name: 'iPhone', id: 'F9F9151E-C60F-5AC3-B87B-4051A981C36B', what: 'Installing the app' })
check(named.startsWith('Installing the app needs a pairing this Mac does not have'), 'the notice leads with the operation', named)
check(named.includes('iPhone (F9F9151E-C60F-5AC3-B87B-4051A981C36B)'), 'names the phone and its id', named)
check(/Trust/.test(named) === true, 'says to trust the phone', named)
check(named.includes('xcrun devicectl manage pair --device F9F9151E-C60F-5AC3-B87B-4051A981C36B'),
  'and gives the command that pairs it again', named)
check(named.includes('Xcode') === true, 'and the other way to fix a stale record, which is not a terminal')
check(isPairingFailure(named) === false, 'the notice does not restate the raw sentences it replaces')

// The state CoreDevice reports NOW changes what the message is worth: after a Trust tap, "still
// unpaired" is the difference between waiting and re-pairing.
const stillUnpaired = pairingNotice({ name: 'iPhone', id: 'F9F9151E-C60F-5AC3-B87B-4051A981C36B', what: 'Running Enshi', state: 'unpaired' })
check(stillUnpaired.includes('CoreDevice still reports it as unpaired') === true,
  'a fresh check that still says unpaired is stated in the notice', stillUnpaired)
check(named.includes('still reports') === false, 'and is absent when nothing was asked again', named)
check(pairingNotice({ state: 'paired' }).includes('still reports') === false, 'as it is for any other answer')

const anonymous = pairingNotice({ what: 'Reading the app log' })
check(anonymous.includes('this device') === true, 'with no name or id, it still reads as a sentence', anonymous)
check(anonymous.includes('manage pair --device <udid>') === true, 'and the command stays usable as a template', anonymous)

// --- the state that makes it detectable up front --------------------------

const LIST = JSON.stringify({
  result: {
    devices: [
      {
        identifier: 'F9F9151E-C60F-5AC3-B87B-4051A981C36B',
        hardwareProperties: { udid: '00008030-000123456789ABCD', productType: 'iPhone11,6', marketingName: 'iPhone XS Max' },
        deviceProperties: { name: 'iPhone', osVersionNumber: '18.7.9' },
        connectionProperties: { tunnelState: 'disconnected', pairingState: 'unpaired', transportType: 'wired' },
      },
      {
        identifier: 'B7485956-FD06-57E9-ACFD-D6D1E41EF111',
        hardwareProperties: { udid: '00008110-000A1B2C3D4E5F6G', productType: 'iPhone14,5', marketingName: 'iPhone 13' },
        deviceProperties: { name: 'chuck的iPhone', osVersionNumber: '26.6.2' },
        connectionProperties: { tunnelState: 'connected', pairingState: 'paired', transportType: 'wired' },
      },
    ],
  },
})

const parsed = parseDevicectlList(LIST)
check(parsed.length === 2, 'both devices are read out of the list', String(parsed.length))
const unpaired = parsed.find((record) => record.name === 'iPhone')
const paired = parsed.find((record) => record.name === 'chuck的iPhone')
check(unpaired?.paired === false, 'the unpaired one says so', JSON.stringify(unpaired))
check(paired?.paired === true, 'and the paired one says that', JSON.stringify(paired))
check(unpaired?.available === false, 'neither is available without a tunnel', JSON.stringify(unpaired?.available))

const merged = mergeDestinations(
  [{ id: '00008030-000123456789ABCD', kind: 'device', name: 'iPhone', platform: 'iOS', available: true, destination: 'platform=iOS,id=00008030-000123456789ABCD' }],
  parsed,
)
const row = merged.find((record) => record.id === '00008030-000123456789ABCD')
check(row?.paired === false, 'a record that said nothing about pairing takes devicectl\'s answer', JSON.stringify(row))
check(row?.available === true, 'while availability is decided by its own rule, unchanged')

// A source that does not mention pairing must not erase what another one knew.
const kept = mergeDestinations(
  [{ id: 'x', kind: 'device', name: 'P', platform: 'iOS', available: true, paired: true, destination: 'platform=iOS,id=x' }],
  [{ id: 'x', kind: 'device', source: 'xcdevice', available: true }],
)
check(kept[0]?.paired === true, 'and a source with no opinion never overrules one that has one', JSON.stringify(kept[0]))

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('device pairing OK')
