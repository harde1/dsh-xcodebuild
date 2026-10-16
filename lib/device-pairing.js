/**
 * The phone CoreDevice can see but has no pairing with.
 *
 * A different failure from the one `legacy-inspector.js` exists for, and it arrives on the
 * same roads. A cabled iPhone whose pairing record this Mac does not have — never trusted,
 * trusted by another Mac, reset, or with an expired record — is still DISCOVERED by
 * CoreDevice, so it appears in `xcrun devicectl list devices` (`pairingState: unpaired`) and
 * is offered as a destination, and then every route that touches it answers:
 *
 * ```console
 * $ xcrun devicectl device install app --device F9F9151E-… MyApp.app
 * ERROR: The device must be paired before it can be connected. (com.apple.dt.CoreDeviceError error 2 (0x02))
 *        ----------------------------------------
 *            The device must be paired before it can be connected. (com.apple.dt.RemotePairingError error 2 (0x02))
 * ```
 *
 * The second line is the real one: `RemotePairingError`. Nothing about this is the app's fault,
 * nothing about it is fixable by rebuilding, and the raw sentence does not say what to do about
 * it — so no route lets it through unexplained. `pairingNotice` is what they say instead.
 *
 * @module dsh-xcodebuild/device-pairing
 */

/**
 * Whether a command's output IS the pairing failure.
 *
 * Matched on the two things Apple's wording carries that nothing else does: the
 * `RemotePairingError` domain, and the sentence itself. The CoreDevice error code is checked
 * too, but never on its own — `error 2` is a number many domains use, and a route that
 * mistook another failure for this one would send the reader to the wrong problem.
 *
 * @param {string} text - a command's stdout and stderr, together.
 * @returns {boolean} true when this is the unpaired-device failure.
 */
export function isPairingFailure(text) {
  const said = String(text ?? '')
  if (said === '') return false
  if (said.includes('RemotePairingError')) return true
  return said.includes('must be paired before it can be connected')
}

/**
 * What a route says when the phone it was handed is not paired.
 *
 * Says the three things that make it actionable, in the order they are needed: which phone,
 * what state it is in (`devicectl` can see it, so this is not "not found" and not "unplugged"),
 * and what to do — which is a person unlocking a phone, not a rebuild.
 *
 * @param {{name?: string, id?: string, what?: string, state?: string}} spec - the device, the
 *   operation as a subject (`what: 'Installing the app'`), and what CoreDevice says about the pairing
 *   RIGHT NOW: `state: 'unpaired'` when it was asked again and still says no, which is worth saying
 *   out loud — a person who has just tapped Trust needs to know whether it landed, and "unpaired"
 *   after a Trust tap means the record is stale rather than the phone being slow.
 * @returns {string} one paragraph, ending with what to do.
 */
export function pairingNotice({ name = '', id = '', what = 'This', state = '' } = {}) {
  const named = String(name ?? '').trim()
  const identifier = String(id ?? '').trim()
  const phone = named === ''
    ? (identifier === '' ? 'this device' : identifier)
    : `${named} (${identifier})`
  const still = String(state ?? '') === 'unpaired'
    ? ' CoreDevice still reports it as unpaired, so the trust prompt has not finished.'
    : ''
  return `${what} needs a pairing this Mac does not have: ${phone} is connected, and CoreDevice `
    + `cannot connect to it until it is paired.${still} Unlock the phone, plug it in, and tap "Trust" `
    + 'when it asks — if it does not ask, the record is stale, so pair it again with '
    + `\`xcrun devicectl manage pair --device ${identifier === '' ? '<udid>' : identifier}\`, or `
    + 'remove and re-add the device in Xcode\'s Devices and Simulators window. Then run again.'
}
