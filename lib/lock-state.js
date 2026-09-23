/**
 * Is the device locked?
 *
 * Both channels answer, and they answer the same question — "is a passcode being
 * demanded right now?" — which is what "locked" means for a launch: an app cannot be
 * brought to the foreground on a locked screen, so the launch fails without saying
 * so.
 *
 * - iOS 16 and earlier: `ideviceinfo -k PasswordProtected`. Lockdown information, so
 *   it needs no developer image and no pairing session. Measured to answer for a
 *   newer device too (`00008110-...` over the network, with `-n`), not just for the
 *   generation it was written for.
 * - iOS 17 and later: `devicectl device info lockState`, whose machine interface is
 *   its `--json-output` file — devicectl documents that file as the only supported
 *   way for a program to read its output, so the human listing is not parsed.
 *
 * **Only `true` is a claim, and this is the whole design.** Measured on the iPhone X
 * while its screen was locked, `PasswordProtected` read `false`; a device with no
 * passcode reports `false` in every state, locked or not. So `false` means "no
 * passcode is being demanded", never "the screen is on", and an answer that could not
 * be read means nothing at all. A launch is stopped by a device saying `true`, and by
 * nothing else — the same rule the pid probe and the app's own log follow.
 *
 * An earlier attempt asked `idevicescreenshot` instead and was wrong: it reports
 * `Could not connect to screenshotr!` when the developer disk image is not mounted,
 * and mounting that image is something ios-deploy's own launch does. That probe
 * refused launches that would have worked, which is why the oracle is a device fact
 * rather than a service that has to be up.
 *
 * @module dsh-xcodebuild/lock-state
 */

/**
 * Read the classic channel's answer: `PasswordProtected`.
 *
 * `ideviceinfo -k PasswordProtected` prints the value alone (`false`); its full
 * listing prints `PasswordProtected: false`. Both shapes are read, because both are
 * one command away and neither is wrong.
 *
 * @param {string} text - `ideviceinfo` output, with or without the key.
 * @returns {boolean|null} true for a required passcode, false when the device says
 *   otherwise, null when it does not say.
 */
export function parsePasswordProtected(text) {
  const output = String(text ?? '').trim()
  if (output === '') return null
  const bare = /^(true|false)$/i.exec(output)
  if (bare !== null) return bare[1].toLowerCase() === 'true'
  const keyed = /^[ \t]*PasswordProtected[ \t]*:[ \t]*(true|false)[ \t]*$/im.exec(output)
  if (keyed !== null) return keyed[1].toLowerCase() === 'true'
  return null
}

/**
 * Read the modern channel's answer: `passcodeRequired` from `devicectl ... lockState`.
 *
 * The file written by `--json-output` holds it under `result`, next to
 * `unlockedSinceBoot`. Only the JSON is read: devicectl says its JSON file is the
 * only interface meant for a program, and the human listing is prose that a future
 * Xcode may reword or translate.
 *
 * @param {string} text - contents of the `--json-output` file.
 * @returns {boolean|null} true when a passcode is required, false when not, null when
 *   the answer is not in there.
 */
export function parseDevicectlLockState(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  const value = parsed?.result?.passcodeRequired
  if (value === true) return true
  if (value === false) return false
  return null
}

/**
 * The error for a device that says it needs its passcode.
 *
 * Both channels end at the same refusal, and each names the field it read, because
 * "the device told us" is the part worth being able to check by hand.
 *
 * @param {'classic'|'coredevice'} how - which channel asked.
 * @returns {string} the message to throw.
 */
export function lockedDeviceNotice(how) {
  const source = how === 'coredevice'
    ? 'devicectl reports passcodeRequired=true'
    : 'ideviceinfo reports PasswordProtected=true'
  const cost = how === 'coredevice'
    ? 'the launch would fail'
    : 'the launch would fail about 43s later with a bare exit 1 from safequit'
  return `the device needs its passcode, so its screen is locked (${source}). A locked screen cannot bring an `
    + `app to the foreground, and ${cost}. Unlock the iPhone and run again.`
}
