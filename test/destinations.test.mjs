// Tests for the `-showdestinations` parser, driven by real captured output.
// Run: node test/destinations.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseDestinations,
  parseFields,
  destinationString,
  destinationKindOf,
  pickDefaultDestination,
  sortDestinations,
  variantForDestination,
} from '../lib/parse-destinations.js'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(join(here, 'fixtures/showdestinations.txt'), 'utf8')

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

// --- exact regression: the comma inside a bracketed variant ---------------

eq(
  parseFields(', arch:arm64, variant:Designed for [iPad,iPhone], id:ABC, name:My Mac').variant,
  'Designed for [iPad,iPhone]',
  'variant keeps the comma inside its brackets (the original truncation bug)',
)

eq(
  parseFields(', id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device').id,
  'dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder',
  'id keeps its embedded colon',
)

eq(
  parseFields(', name:My iPhone').name,
  'My iPhone',
  'non-ASCII device names survive',
)

// --- parse the real fixture ----------------------------------------------

const list = parseDestinations(RAW)
eq(list.length, 16, 'every destination line in the fixture is parsed')

const mac = list.find((d) => d.kind === 'macos')
check(!!mac, 'the macOS entry is classified as macos')
eq(mac.variant, 'Designed for [iPad,iPhone]', 'macOS variant is complete, not truncated')
eq(mac.name, 'My Mac', 'macOS name parsed after the comma-bearing variant')
eq(mac.id, '00008103-000A1B2C3D4E5F60', 'macOS id parsed even though it follows the variant')

const iphone = list.find((d) => d.name === 'My iPhone')
check(!!iphone, 'a USB device is present')
eq(iphone.kind, 'device', 'a USB device is classified as device')
eq(iphone.arch, 'arm64', 'device arch parsed')

const placeholder = list.find((d) => d.id.includes('DVTiPhonePlaceholder'))
eq(placeholder.placeholder, true, 'placeholder destinations are flagged')
eq(placeholder.name, 'Any iOS Device', 'placeholder name parsed')

const sim = list.find((d) => d.name === 'iPhone 17 Pro')
eq(sim.kind, 'simulator', 'simulator classified')
eq(sim.os, '26.0.1', 'simulator OS parsed')
eq(destinationString(sim), 'platform=iOS Simulator,id=90CAD4BC-C678-4965-9C7F-A32832F33A66', 'simulator destination string')

const count = (k) => list.filter((d) => d.kind === k).length
console.log(`fixture: ${list.length} destinations — ${count('simulator')} simulator, ${count('device')} device, ${count('macos')} macos, ${count('other')} other`)

// --- default selection must not be macOS ---------------------------------

const def = pickDefaultDestination(list)
// Connected hardware leads. A plugged-in phone is what the user is actually
// testing on; a simulator is the fallback, not the default. This was the other
// way round, so the panel offered a simulator with a device attached.
check(def.startsWith('platform=iOS') && !def.includes('Simulator'),
  'default destination is hardware, not a simulator or macOS', def)
const firstDevice = list.find((d) => d.kind === 'device' && !d.placeholder)
check(firstDevice !== undefined, 'the fixture has a concrete device, or hardware-first is untestable')
eq(def, destinationString(firstDevice), 'default is the first concrete device')

// Every simulator present must be reachable by id (the panel offers them all).
for (const d of list) {
  const s = destinationString(d)
  check(s.includes('platform='), `destination string well-formed for ${d.name}`, s)
}
eq(
  destinationString(list.find((d) => d.kind === 'macos')),
  'platform=macOS,arch=arm64,variant=Designed for iPad',
  'macOS destination carries a single-family variant that xcodebuild accepts',
)

// --- the variant projection, verified against real xcodebuild -------------
//
// xcodebuild 26.0.1 rejects the raw `-showdestinations` variant:
//   xcodebuild: error: unreadable input 'iPhone]' at end of value for option 'Destination'

eq(variantForDestination('Designed for [iPad,iPhone]'), 'Designed for iPad', 'bracketed variant collapses to one family')
eq(variantForDestination('Designed for [iPhone]'), 'Designed for iPhone', 'single-family bracket')
eq(variantForDestination('Designed for iPad'), 'Designed for iPad', 'unbracketed variant passes through')
eq(variantForDestination(''), '', 'empty variant')
eq(variantForDestination(undefined), '', 'missing variant')
for (const d of list) {
  const s = destinationString(d)
  check(!s.includes('['), `destination string for ${d.name} has no bracket (xcodebuild rejects brackets)`, s)
}

// --- edge cases -----------------------------------------------------------

eq(parseDestinations('').length, 0, 'empty input yields nothing')
eq(parseDestinations('no destinations here').length, 0, 'non-matching input yields nothing')
eq(parseDestinations('{ platform:iOS Simulator, name:NoId }').length, 0, 'an entry without an id is skipped')
eq(pickDefaultDestination([]), '', 'no destinations yields an empty default')
eq(
  pickDefaultDestination([{ kind: 'macos', platform: 'macOS', arch: 'arm64', variant: '', id: 'x' }]),
  'platform=macOS,arch=arm64',
  'macOS is still usable as a fallback when it is all there is',
)
eq(
  pickDefaultDestination([{ kind: 'simulator', placeholder: true, platform: 'iOS Simulator', id: 'p' }]),
  '',
  'a placeholder-only simulator is not chosen automatically',
)

// ---------------------------------------------------------------------------
// Which `simctl`/`devicectl` family a destination belongs to.
//
// This decides how a built app reaches its target, and getting it wrong is not
// cosmetic: a device asked of `simctl` answers `Invalid device: <udid>`, which
// is how a run against a plugged-in iPhone reported failure AFTER a successful
// build. The device string below is a real one, taken from a project that failed
// exactly that way.
// ---------------------------------------------------------------------------

eq(destinationKindOf('platform=iOS,id=00008110-000A1B2C3D4E5F60'), 'device',
  'a physical iOS destination is a device, not a simulator')
eq(destinationKindOf('platform=iOS,id=000F1E2D3C4B5A69'), 'device',
  'a second physical device is a device too')
eq(destinationKindOf('platform=iOS,id=dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder'), 'device',
  'the generic iOS placeholder is still the device family')
eq(destinationKindOf('platform=iOS Simulator,id=9DCB7BFE-AAF2-4819-8F2C-3A727674B0C3'), 'simulator',
  'a simulator is a simulator')
eq(destinationKindOf('platform=iOS Simulator,id=dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder'), 'simulator',
  'the generic simulator placeholder is still the simulator family')
eq(destinationKindOf('platform=macOS,arch=arm64,variant=Mac Catalyst'), 'macos',
  'macOS is neither, and needs no install step at all')
eq(destinationKindOf('platform=macOS,arch=arm64,variant=Designed for iPad'), 'macos',
  'a Mac Catalyst variant is still macOS')
eq(destinationKindOf('platform=watchOS Simulator,name=Apple Watch'), 'simulator',
  'the rule is the platform suffix, not iOS in particular')
eq(destinationKindOf(''), 'other', 'an empty destination names nothing')
eq(destinationKindOf(undefined), 'other', 'a missing destination names nothing')

// The classifier and the parser must agree on real output, or the panel would
// label a destination one way and then dispatch it another.
for (const entry of parseDestinations(RAW)) {
  eq(destinationKindOf(destinationString(entry)), entry.kind,
    `the classifier agrees with the parser about ${entry.name}`)
}

// --- a remembered destination outranks every guess ------------------------
//
// The panel remembers what a workspace was last set up with, so coming back to
// it does not mean re-picking the same thing. It is validated against the live
// list, so hardware that has since been unplugged falls through instead of
// being offered stale.

eq(pickDefaultDestination(list, destinationString(sim)), destinationString(sim),
  'a remembered destination is restored exactly, ahead of the order')
eq(pickDefaultDestination(list, sim.id), destinationString(sim),
  'a remembered destination is accepted by id as well as by full string')
eq(pickDefaultDestination(list, 'platform=iOS Simulator,id=GONE'), destinationString(firstDevice),
  'a remembered destination that is no longer listed falls back to the order')
eq(pickDefaultDestination([{ kind: 'device', placeholder: true, platform: 'iOS', id: 'p' }], 'p'), '',
  'a placeholder is never restored as a preference')
eq(pickDefaultDestination(list, ''), destinationString(firstDevice), 'an empty preference changes nothing')
eq(pickDefaultDestination(list, undefined), destinationString(firstDevice), 'a missing preference changes nothing')
eq(pickDefaultDestination(list, '   '), destinationString(firstDevice), 'a blank preference changes nothing')

// Hardware leads even when the simulator is printed first, which is the order
// `-showdestinations` actually uses.
eq(
  pickDefaultDestination([
    { kind: 'simulator', placeholder: false, platform: 'iOS Simulator', id: 'S', name: 'Sim' },
    { kind: 'device', placeholder: false, platform: 'iOS', id: 'D', name: 'Phone' },
  ]),
  'platform=iOS,id=D',
  'a device listed after a simulator is still preferred',
)


// --- the order the list is shown in --------------------------------------
//
// A bench swaps phones and simulators all day. The order xcodebuild reports is
// neither grouped nor stable for that: `platform:macOS` is printed first, and the
// iOS 16 devices this plugin discovers itself are appended after everything — so a
// phone plugged in a moment ago appeared LAST, below a dozen simulators, exactly
// when it was the thing being looked for.

const dev = (name, os, extra = {}) => ({
  platform: 'iOS', id: `id-${name}-${os}`, name, os, arch: 'arm64', variant: '',
  kind: 'device', placeholder: false, ...extra,
})
const simulator = (name, os) => ({
  platform: 'iOS Simulator', id: `sim-${name}-${os}`, name, os, arch: 'arm64', variant: '',
  kind: 'simulator', placeholder: false,
})
const macEntry = { platform: 'macOS', id: 'macEntry', name: 'My Mac', os: '', arch: 'arm64', variant: 'Designed for [iPad,iPhone]', kind: 'macos', placeholder: false }
const anyDevice = { platform: 'iOS', id: 'dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder', name: 'Any iOS Device', os: '', arch: 'arm64', variant: '', kind: 'device', placeholder: true }

/** `eq` above is strict, and two arrays are never the same object. */
function equal(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}

const order = (entries) => sortDestinations(entries).map((d) => d.name)

equal(
  order([
    macEntry,
    simulator('iPhone 17 Pro', '26.0.1'),
    simulator('iPad Pro 13-inch (M4)', '26.0.1'),
    anyDevice,
    // The shape `legacyDevices` produces for an iOS 16 phone: discovered here, so
    // appended after xcodebuild's own output.
    dev('iPhone X', '16.7.12', { legacy: true, model: 'iPhone10,3' }),
  ]),
  ['iPhone X', 'Any iOS Device', 'iPad Pro 13-inch (M4)', 'iPhone 17 Pro', 'My Mac'],
  'connected hardware leads, simulators follow, a Mac last — the phone is no longer appended below them',
)

equal(order([simulator('iPhone 17 Pro', '26.0.1'), dev('iPhone 12', '26.6.2')]), ['iPhone 12', 'iPhone 17 Pro'],
  'a device outranks a simulator even when xcodebuild listed the simulator first')
equal(order([macEntry, simulator('iPad Pro 13-inch (M4)', '26.0.1'), dev('iPhone 12', '26.6.2')]), ['iPhone 12', 'iPad Pro 13-inch (M4)', 'My Mac'],
  'macOS is grouped behind both, not left where xcodebuild printed it')

equal(order([dev('iPhone 12', '26.6.2'), anyDevice]), ['iPhone 12', 'Any iOS Device'],
  'a generic entry is a fallback, so it follows the real hardware in its group')
equal(order([anyDevice, simulator('iPhone 17 Pro', '26.0.1')]), ['Any iOS Device', 'iPhone 17 Pro'],
  'and it still leads the simulators, being nearer to the thing being tested on')

equal(order([dev('iPhone 9', '15.0'), dev('iPhone 12', '26.6.2'), dev('iPhone 16', '26.0.1'), dev('iPhone X', '16.7.12')]),
  ['iPhone 9', 'iPhone 12', 'iPhone 16', 'iPhone X'],
  'names are read the way a person reads them: 9 before 12, numbers before letters')

equal(order([dev('iPhone 12', '16.7.12'), dev('iPhone 12', '26.6.2')]), ['iPhone 12', 'iPhone 12'],
  'two entries that differ only by OS keep both')
check(
  sortDestinations([dev('iPhone 12', '16.7.12'), dev('iPhone 12', '26.6.2')])[0].os === '26.6.2',
  'and the newer OS is the one offered first',
)

// A newly connected phone must slot in, not land at the end: this is the whole
// point of sorting on every refresh.
const beforePlug = [macEntry, simulator('iPhone 17 Pro', '26.0.1'), dev('iPhone X', '16.7.12')]
const afterPlug = [simulator('iPhone 17 Pro', '26.0.1'), macEntry, dev('iPhone X', '16.7.12'), dev('iPhone 12', '26.6.2')]
equal(order(afterPlug), ['iPhone 12', 'iPhone X', 'iPhone 17 Pro', 'My Mac'],
  'a device plugged in since the last look takes its place among the hardware')
check(order(afterPlug).indexOf('iPhone 12') < order(beforePlug).length,
  'the new device is not appended below the simulators')

// Two records that agree on everything must not swap on a re-sort, or the list
// would move under the pointer while the user is aiming at it.
const twins = [dev('iPhone 12', '26.6.2', { id: 'first' }), dev('iPhone 12', '26.6.2', { id: 'second' })]
equal(sortDestinations(twins).map((d) => d.id), ['first', 'second'], 'identical entries keep the order the host reported')
eq(JSON.stringify(sortDestinations(sortDestinations(afterPlug))), JSON.stringify(sortDestinations(afterPlug)),
  'sorting twice changes nothing')

eq(JSON.stringify(sortDestinations(undefined)), '[]', 'no list sorts to an empty list')
const withJunk = sortDestinations([{ name: 'broken' }, null, dev('iPhone X', '16.7.12')])
eq(withJunk.length, 3, 'an unusable entry survives sorting rather than throwing')
eq(withJunk[0].name, 'iPhone X', 'and the real hardware still leads')
eq(withJunk[1], null, 'with a record carrying no kind ahead of one that has a name')
eq(withJunk[2].name, 'broken', 'and nothing dropped')
const untouched = [simulator('iPhone 17 Pro', '26.0.1'), dev('iPhone X', '16.7.12')]
sortDestinations(untouched)
equal(untouched.map((d) => d.name), ['iPhone 17 Pro', 'iPhone X'], 'the array handed in is not reordered in place')

console.log('\n== the real fixture, sorted ==')
const sorted = sortDestinations(list)
eq(sorted.length, list.length, 'sorting the real list loses nothing')
const kinds = sorted.map((d) => d.kind)
const rank = { device: 0, simulator: 1, macos: 2, other: 3 }
check(kinds.every((k, i) => i === 0 || rank[kinds[i - 1]] <= rank[k]),
  'every device precedes every simulator in the real list, and macOS is last')
eq(sorted[0].kind, 'device', 'and the first entry is hardware, so the list opens on what is being tested')
check(sorted[0].placeholder !== true, 'which is a concrete device, not a generic fallback')
eq(destinationString(sorted[sorted.length - 1]), 'platform=macOS,arch=arm64,variant=Designed for iPad',
  'with the Mac destination at the end')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('destination parsing OK')
