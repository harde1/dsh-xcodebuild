/**
 * Which device lldb thinks you mean.
 *
 * A phone has two names, and the two halves of the toolchain use different ones:
 *
 *   xcodebuild -showdestinations / xcdevice / devicectl   B7485956-...? no:   00008110-000078242EBB801E
 *   lldb's `device list` and `device select`              B7485956-FD06-57E9-ACFD-D6D1E41EF111
 *
 * Handing the first to `device select` is the worst kind of failure, because it is silent: lldb does
 * not report an unknown device, it selects nothing, and the `process attach` that follows waits
 * forever. Measured on 蜜语-Dev: `device select` on the name lldb knows returns in 4 seconds; the
 * hardware UDID produced no answer in 90 seconds, every time, with no tree at the end of it. That is
 * what "always hangs and never a tree" was.
 *
 * So the device list is read from lldb itself and the target is resolved against it — by identifier,
 * then by name — before anything is attached to. Pure decisions over that text, so the rule is
 * testable without a phone.
 */

/**
 * @param {string} text - output of `lldb -b -o "device list" -o quit`
 * @returns {Array<{name: string, identifier: string, state: string, configuration: string}>}
 */
export function parseDeviceList(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('  ')) continue
    if (/^\s*Name\s+Identifier/.test(line)) continue
    if (/^\s*-{3,}/.test(line)) continue
    if (/^\(lldb\)/.test(line.trim())) continue
    const parts = line.trim().split(/\s{2,}/)
    if (parts.length < 3) continue
    const [name, identifier, state, ...rest] = parts
    if (!/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(identifier)
      && !/^[0-9a-f]{40}$/.test(identifier)) continue
    out.push({ name, identifier, state, configuration: rest.join(' ').trim() })
  }
  return out
}

/** The devices lldb can actually attach to right now. */
export function connectedDevices(devices) {
  return (Array.isArray(devices) ? devices : []).filter((device) => device.state.toLowerCase() === 'connected')
}

/**
 * The identifier lldb will accept for this destination, or '' when it names nothing lldb has.
 *
 * @param {Array<object>} devices - from parseDeviceList
 * @param {{id?: string, coreDeviceId?: string, deviceName?: string}} target - `coreDeviceId` is the
 *   bridge devicectl reports for a hardware udid; `deviceName` is the phone's name, a fallback.
 * @returns {string}
 */
export function resolveDeviceId(devices, target) {
  const id = typeof target?.id === 'string' ? target.id.trim() : ''
  const coreDeviceId = typeof target?.coreDeviceId === 'string' ? target.coreDeviceId.trim() : ''
  // The DEVICE's name. Never the app's: a target also carries the process name (`蜜语-Dev`), and
  // matching a phone against that is how 0.3.9 told a user their app "is not a device".
  const name = typeof target?.deviceName === 'string' ? target.deviceName.trim() : ''
  const connected = connectedDevices(devices)
  for (const wanted of [coreDeviceId, id]) {
    if (wanted === '') continue
    const found = connected.find((device) => device.identifier.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) return found.identifier
  }
  if (name === '') return ''
  const byName = connected.find((device) => device.name.trim().toLowerCase() === name.toLowerCase())
  return byName === undefined ? '' : byName.identifier
}

/** What lldb has instead, for a note that can be acted on. */
export function describeConnectedDevices(devices) {
  const connected = connectedDevices(devices)
  if (connected.length === 0) return 'lldb lists no connected device at all'
  return `lldb can attach to: ${connected.map((device) => `${device.name} (${device.identifier})`).join(', ')}`
}

/**
 * Whether two ids name the same phone, given the aliases learned when an attach resolved one into
 * the other (hardware UDID ↔ CoreDevice identifier, lower-cased both ways).
 *
 * The session remembers the id lldb accepted; requests arrive with the destination's UDID. Comparing
 * them as plain strings made every View Hierarchy throw a working session away and attach again.
 *
 * @param {string} a - one id.
 * @param {string} b - the other.
 * @param {Map<string, string>} aliases - id → its other name.
 * @returns {boolean} whether they are the same device.
 */
export function sameDeviceId(a, b, aliases) {
  const x = String(a ?? '').toLowerCase()
  const y = String(b ?? '').toLowerCase()
  if (x === '' || y === '') return false
  return x === y || aliases?.get(x) === y || aliases?.get(y) === x
}
