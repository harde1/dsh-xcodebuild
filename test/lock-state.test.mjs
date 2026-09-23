// Is the device locked? One question, two channels, and a rule about what an answer
// is allowed to mean.
//
// The failure this file exists for: `idevicescreenshot` was used as the lock oracle
// because it reports `Could not connect to screenshotr!` on a locked iPhone X. It is
// not an oracle — screenshotr needs the developer disk image mounted, and mounting
// that image is one of the things ios-deploy's launch does — so the probe refused
// launches that would have worked. The oracle has to be a device fact.
//
// Both fixtures below are real output, not invented:
//
//   $ ideviceinfo -u 0000a1b2c3d4e5f60718293a4b5c6d7e8f901234 -k PasswordProtected
//   false                      ← while that iPhone X's screen was locked
//   $ ideviceinfo -n -u 00008110-000F1E2D3C4B5A69 -k PasswordProtected
//   false                      ← an iOS 17+ device, which is why the classic key is
//                                not a legacy-only question
//   $ xcrun devicectl device info lockState --device AEDB651E-... --json-output f.json
//   { "result": { "passcodeRequired": false, "unlockedSinceBoot": true } }
//
// Run: node test/lock-state.test.mjs

import {
  lockedDeviceNotice,
  parseDevicectlLockState,
  parsePasswordProtected,
} from '../lib/lock-state.js'

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

console.log('== the classic channel: PasswordProtected ==')
eq(parsePasswordProtected('false'), false, 'the bare value `-k PasswordProtected` prints')
eq(parsePasswordProtected('true'), true, 'the bare value when a passcode is required')
eq(parsePasswordProtected('false\n'), false, 'the trailing newline of a real run')
eq(parsePasswordProtected('PasswordProtected: true'), true, 'the keyed form from the full listing')
eq(
  parsePasswordProtected('fm-activation-locked: WUVT\nPasswordProtected: false\nUses24HourClock: false'),
  false,
  'the key is found among the other lockdown keys',
)
eq(parsePasswordProtected('TRUE'), true, 'a shouty answer is still an answer')
eq(parsePasswordProtected('PasswordProtected: yes'), null, 'a value that is not a boolean is not read as one')
eq(parsePasswordProtected('ERROR: Device 00008110-000F1E2D3C4B5A69 not found!'), null, 'a failed lookup is not a false')
eq(parsePasswordProtected(''), null, 'no output is not a lock')
eq(parsePasswordProtected(undefined), null, 'nothing at all is not a lock')

console.log('== the modern channel: devicectl lockState ==')
eq(
  parseDevicectlLockState('{"result":{"deviceIdentifier":"AEDB651E","passcodeRequired":false,"unlockedSinceBoot":true}}'),
  false,
  'the JSON file devicectl writes, unlocked and never re-locked since boot',
)
eq(
  parseDevicectlLockState('{"result":{"passcodeRequired":true,"unlockedSinceBoot":true}}'),
  true,
  'a passcode required is a lock, whatever happened since boot',
)
eq(
  parseDevicectlLockState('{"result":{"passcodeRequired":false,"unlockedSinceBoot":false}}'),
  false,
  'never unlocked since boot still is not a required passcode',
)
eq(parseDevicectlLockState('{"info":{"outcome":"success"},"result":{}}'), null, 'a result without the field says nothing')
eq(parseDevicectlLockState('{"result":{"passcodeRequired":"true"}}'), null, 'a string is not the boolean devicectl writes')
eq(parseDevicectlLockState('not json at all'), null, 'an unparsable file is not a lock')
eq(parseDevicectlLockState(''), null, 'an empty file is not a lock')
eq(parseDevicectlLockState(undefined), null, 'nothing at all is not a lock')

// The asymmetry is the design, not an oversight: `false` was measured on a locked
// iPhone X, so it can never be turned into "the device is unlocked".
console.log('== false is not "unlocked", and only true stops a run ==')
check(
  parsePasswordProtected('false') === false && parseDevicectlLockState('{"result":{"passcodeRequired":false}}') === false,
  'both channels report `false` without claiming the screen is on',
)

console.log('== the refusal names the field it read ==')
const classic = lockedDeviceNotice('classic')
check(classic.includes('PasswordProtected=true'), 'the classic refusal quotes the classic field', classic)
check(/43s|safequit/.test(classic), 'and says what the launch would have cost', classic)
const modern = lockedDeviceNotice('coredevice')
check(modern.includes('passcodeRequired=true'), 'the modern refusal quotes the modern field', modern)
check(!/43s|safequit/.test(modern), 'and does not borrow the classic channel\'s failure', modern)
for (const [how, notice] of [['classic', classic], ['coredevice', modern]]) {
  check(/unlock/i.test(notice), `${how}: the refusal says what to do about it`, notice)
  check(notice.startsWith('the device needs its passcode'), `${how}: it names the reason first`, notice)
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('lock state OK')
