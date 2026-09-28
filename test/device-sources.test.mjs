// Tests for the extra device sources and the merge that combines them.
//
// The fixtures are the real shapes of what `xcrun xcdevice list` and
// `xcrun devicectl list devices --json-output` printed on the bench that prompted this
// module, with names, udids and serial numbers replaced: the shapes are what matter
// here, and a device list is not something to publish.
//
// Run: node test/device-sources.test.mjs
import {
  mergeDestinations,
  parseDevicectlList,
  parseXcdeviceList,
  platformOfProductType,
  stripBuildNumber,
} from '../lib/device-sources.js'

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
function section(name) {
  console.log(`\n# ${name}`)
}

// --- xcdevice --------------------------------------------------------------

/** One available phone, one unreachable phone, one simulator and one non-iOS platform. */
const XCDEVICE = JSON.stringify([
  {
    simulator: false,
    operatingSystemVersion: '26.6.2 (23G90)',
    identifier: '00008110-00007824AAAA801E',
    available: true,
    platform: 'com.apple.platform.iphoneos',
    interface: 'usb',
    name: 'Chuck iPhone',
  },
  {
    simulator: false,
    operatingSystemVersion: '18.5 (22F76)',
    identifier: '00008110-0000555AAAAA801E',
    available: false,
    platform: 'com.apple.platform.iphoneos',
    interface: 'usb',
    name: 'Eddy iPhone',
    error: {
      code: -27,
      description: 'Browsing on the local area network for Eddy iPhone',
      domain: 'com.apple.dt.deviceprep',
    },
  },
  { simulator: true, operatingSystemVersion: '26.0.1 (23A341)', identifier: '9DCB7BFE-0000-0000-0000-000000000000', available: true, platform: 'com.apple.platform.iphonesimulator', name: 'iPhone 17' },
  { simulator: false, operatingSystemVersion: '11.0 (22R200)', identifier: '00008110-0000AAAA0000001E', available: true, platform: 'com.apple.platform.watchos', interface: 'usb', name: 'Chuck Watch' },
  { simulator: false, operatingSystemVersion: '26.5 (23F71)', identifier: '00008103-001A410C2ED3401E', available: true, platform: 'com.apple.platform.macosx', name: 'My Mac' },
])

section('xcdevice is mapped onto destination records')
{
  const list = parseXcdeviceList(XCDEVICE)
  eq(list.map((d) => d.name), ['Chuck iPhone', 'Eddy iPhone', 'Chuck Watch'], 'simulators and macOS are dropped, hardware kept')
  const phone = list[0]
  eq(phone.id, '00008110-00007824AAAA801E', 'the id is the hardware udid, which is what -destination takes')
  eq(phone.os, '26.6.2', 'the build number is stripped from the version')
  eq(phone.available, true, 'availability is carried as the source reported it')
  eq(list[1].available, false, 'an unreachable device stays in the list, marked')
  check(
    typeof list[1].note === 'string' && list[1].note.includes('local area network'),
    'the reason it is unreachable is kept, so the panel can say why',
  )
  eq(list[2].platform, 'watchOS', 'a watch is offered as watchOS, not as an iOS destination')
  check(list.every((d) => d.kind === 'device' && d.placeholder === false), 'every entry is a concrete device')
  eq(list[0].source, 'xcdevice', 'the record names the source that found it')
}

section('a source that did not answer is no devices, never an exception')
{
  eq(parseXcdeviceList(''), [], 'empty output')
  eq(parseXcdeviceList('not json at all'), [], 'prose')
  eq(parseXcdeviceList('[{"simulator": false'), [], 'a truncated answer')
  eq(parseXcdeviceList('[null, 42, "x"]'), [], 'entries that are not objects')
  eq(stripBuildNumber(' 26.6.2 (23G90) '), '26.6.2', 'the version helper is tolerant of space')
}

// --- devicectl -------------------------------------------------------------

const DEVICECTL = JSON.stringify({
  result: {
    devices: [
      {
        identifier: 'B7485956-FD06-57E9-ACFD-D6D1E41EF111',
        deviceProperties: { name: 'Chuck iPhone', osVersionNumber: '26.6.2', developerModeStatus: 'enabled' },
        hardwareProperties: { udid: '00008110-00007824AAAA801E', serialNumber: 'W4XDH71WVR', marketingName: 'iPhone 13', productType: 'iPhone14,5' },
        connectionProperties: { tunnelState: 'connected', pairingState: 'paired', transportType: 'wired' },
      },
      {
        identifier: 'C442EC09-E86D-56E2-9723-1CD3ED9A67D7',
        deviceProperties: { name: 'Eddy iPhone', osVersionNumber: '18.5' },
        hardwareProperties: { udid: '00008110-0000555AAAAA801E', marketingName: 'iPhone 13', productType: 'iPhone14,5' },
        connectionProperties: { tunnelState: 'unavailable', pairingState: 'paired' },
      },
      {
        identifier: '00000000-0000-0000-0000-000000000000',
        deviceProperties: { name: 'Ghost' },
        hardwareProperties: {},
        connectionProperties: { tunnelState: 'unavailable' },
      },
    ],
  },
})

section('devicectl is mapped onto destination records')
{
  const list = parseDevicectlList(DEVICECTL)
  eq(list.length, 2, 'a device with no hardware udid cannot become a destination and is dropped')
  eq(list[0].id, '00008110-00007824AAAA801E', 'the id is the hardware udid, NOT the CoreDevice UUID devicectl prints first')
  check(list[0].id !== 'B7485956-FD06-57E9-ACFD-D6D1E41EF111', 'which -destination would not match')
  eq(list[0].available, true, 'a connected tunnel means reachable')
  eq(list[1].available, false, 'paired but with no tunnel is not reachable')
  eq(list[1].platform, 'iOS', 'an iPhone product type is an iOS destination')
  eq(platformOfProductType('Watch7,1'), 'watchOS', 'a watch product type is watchOS')
  eq(platformOfProductType('AppleTV14,1'), 'tvOS', 'a TV product type is tvOS')
  eq(parseDevicectlList('{}').length, 0, 'a file without result.devices yields nothing')
  eq(parseDevicectlList('nonsense'), [], 'unparsable output yields nothing')
}

// --- merge -----------------------------------------------------------------

section('sources merge by device id')
{
  const base = [
    { platform: 'iOS', id: '00008110-00007824AAAA801E', name: 'Chuck iPhone', os: '', arch: 'arm64', variant: '', kind: 'device', placeholder: false, source: 'xcodebuild' },
    { platform: 'iOS Simulator', id: 'SIM-1', name: 'iPhone 17', os: '26.0.1', kind: 'simulator', placeholder: false, source: 'xcodebuild' },
  ]
  const extras = parseXcdeviceList(XCDEVICE).concat(parseDevicectlList(DEVICECTL))
  const merged = mergeDestinations(base, extras)
  eq(
    merged.map((d) => d.id),
    ['00008110-00007824AAAA801E', 'SIM-1', '00008110-0000555AAAAA801E', '00008110-0000AAAA0000001E'],
    'one row per device: xcodebuild and both device sources agree on the same phone',
  )
  const phone = merged[0]
  eq(phone.os, '26.6.2', 'a field xcodebuild left empty is filled by a source that knows it')
  eq(phone.sources, ['xcodebuild', 'xcdevice', 'devicectl'], 'provenance records every source that saw it')
  eq(phone.available, true, 'reachability is taken from the sources that report it')
}

section('availability may only go up, and identity is the id')
{
  const base = [{ platform: 'iOS', id: 'A', name: 'Phone', kind: 'device', placeholder: false }]
  eq(mergeDestinations(base, [])[0].available, true, 'a device xcodebuild listed is reachable when nothing says otherwise')
  eq(
    mergeDestinations(base, [{ id: 'A', kind: 'device', available: false, source: 'devicectl' }])[0].available,
    true,
    'a source that cannot see it does not downgrade one that can',
  )
  eq(
    mergeDestinations([{ platform: 'iOS', id: 'A', kind: 'device', placeholder: false, available: false }], [{ id: 'A', kind: 'device', available: true, source: 'xcdevice' }])[0].available,
    true,
    'and one that can see it lifts an unreachable row',
  )
  const twins = mergeDestinations([], [
    { id: 'X', name: 'iPhone 12', kind: 'device', available: true, source: 'xcdevice' },
    { id: 'Y', name: 'iPhone 12', kind: 'device', available: true, source: 'xcdevice' },
  ])
  eq(twins.length, 2, 'two devices with the same name are two devices')
  eq(mergeDestinations([{ platform: 'iOS', id: '', kind: 'device' }], []).length, 0, 'a record with no id cannot be a destination')
  eq(mergeDestinations(null, null), [], 'no input is no destinations')
}

section('the inputs are not rewritten')
{
  const base = [{ platform: 'iOS', id: 'A', name: '', kind: 'device', placeholder: false }]
  const extras = [{ id: 'A', name: 'Filled', kind: 'device', available: true, source: 'xcdevice' }]
  const snapshotBase = JSON.stringify(base)
  const snapshotExtras = JSON.stringify(extras)
  const merged = mergeDestinations(base, extras)
  eq(JSON.stringify(base), snapshotBase, 'the authoritative list is left alone')
  eq(JSON.stringify(extras), snapshotExtras, 'and so are the extras')
  eq(merged[0].name, 'Filled', 'while the merged copy is filled in')
  check(merged[0] !== base[0], 'which is a copy, not the caller\'s object')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
