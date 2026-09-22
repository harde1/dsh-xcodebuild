// Which channel reaches a physical device, and where its tools live.
//
// Getting this wrong is not cosmetic. CoreDevice (`devicectl`) knows iOS 17 and
// later only; sending an iPhone X on iOS 16 there fails as a device that does not
// exist, AFTER a build that had already succeeded — which points at the wrong
// thing entirely. Every case below comes from a device that was actually probed.
//
// Run: node test/device-channel.test.mjs

import { needsLegacyChannel, legacyTool } from '../lib/index.js'

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

// --- the CoreDevice boundary ---------------------------------------------

console.log('== the CoreDevice boundary ==')
eq(needsLegacyChannel('16.7.12'), true, 'the iPhone X (iPhone10,3) that exposed this')
eq(needsLegacyChannel('16.0'), true, '16.x is still classic')
eq(needsLegacyChannel('15.8.3'), true, '15 is well before the boundary')
eq(needsLegacyChannel('12.5.7'), true, 'the oldest devices still in the field')
eq(needsLegacyChannel('17.0'), false, '17.0 is the first CoreDevice release')
eq(needsLegacyChannel('18.4'), false, 'a later release')
eq(needsLegacyChannel('26.0.1'), false, 'the toolchain installed here')

// --- an unreadable version must not pick a dead channel -------------------
//
// If the probe fails the routed-away channel is the SAFE one: devicectl is what
// a modern device needs, and a wrong guess toward it fails loudly rather than
// silently shelling out to a toolchain that is not installed.

console.log('== an unreadable version is not guessed at ==')
eq(needsLegacyChannel(''), false, 'empty string')
eq(needsLegacyChannel(undefined), false, 'absent')
eq(needsLegacyChannel('garbage'), false, 'unparseable')
eq(needsLegacyChannel(' 16.7.12 '), true, 'surrounding whitespace is tolerated')
eq(needsLegacyChannel('16.7.12 (20H364)'), true, 'a trailing build tag does not hide the major')

// --- tool resolution ------------------------------------------------------

console.log('== tool resolution ==')
// These are brewed, not shipped by Xcode, so they are not necessarily on the PATH
// the harness was launched with; resolving the absolute path is what makes the
// difference between a working command and `spawn ENOENT`.
check(legacyTool('ideviceinstaller').includes('ideviceinstaller'), 'ideviceinstaller is resolved by name at worst')
eq(
  legacyTool('definitely-not-a-real-tool'),
  'definitely-not-a-real-tool',
  'an unknown tool is returned untouched, so the failure still names what it wanted',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('device channel OK')
