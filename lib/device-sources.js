// Device discovery beyond `xcodebuild -showdestinations`.
//
// Why this exists, in one measured case: on a bench where Xcode's device layer and
// CoreDevice disagree, `-showdestinations` intermittently omits a phone that is
// plugged in, unlocked, Developer-Mode-enabled and perfectly buildable. While it was
// missing, all of these still knew the device:
//
//   * `xcrun xcdevice list`  — `available: true`, `interface: usb` (this is the layer
//                              Xcode's own GUI lists devices from)
//   * `xcrun devicectl list devices` — `tunnelState: connected`, `pairingState: paired`
//   * `idevice_id -l` + `ideviceinfo` — the classic lockdown channel
//   * `xcodebuild -destination 'platform=iOS,id=<udid>' build` — BUILD SUCCEEDED
//
// A destination list built from that one source therefore loses hardware that works,
// and the panel offers a simulator for a phone that is sitting on the desk. So every
// channel is read, mapped into the record shape `parseDestinations` already produces,
// and merged by device id. `-showdestinations` stays authoritative — it alone knows
// the simulators and macOS destinations — but it is no longer the only voice.
//
// This module is plain JS with no imports, like `parse-destinations.js`, so its exact
// source can also be embedded in the dynamic Cordis host half.

/** `com.apple.platform.*`, as `xcdevice` names them, to the platform `-destination` takes. */
const XCDEVICE_PLATFORMS = {
  'com.apple.platform.iphoneos': 'iOS',
  'com.apple.platform.appletvos': 'tvOS',
  'com.apple.platform.watchos': 'watchOS',
  'com.apple.platform.xros': 'visionOS',
}

/** `xcdevice` prints "26.6.2 (23G90)"; the panel and the tools want "26.6.2". */
export function stripBuildNumber(version) {
  return String(version ?? '').trim().replace(/\s*\(.*$/, '')
}

/**
 * The platform a CoreDevice product type belongs to (`iPhone14,5` -> `iOS`).
 *
 * devicectl does not report a platform name, and a watch or a TV in the list must not
 * be offered as an iOS destination: the string ends up in `-destination`.
 */
export function platformOfProductType(productType) {
  const type = String(productType ?? '').trim()
  if (/^(iPhone|iPad|iPod)/.test(type)) return 'iOS'
  if (/^AppleTV/.test(type)) return 'tvOS'
  if (/^Watch/.test(type)) return 'watchOS'
  if (/^RealityDevice/.test(type)) return 'visionOS'
  return ''
}

/** Keep a source's own yes/no, and "it did not say" as absent rather than as "no". */
function triState(value) {
  if (value === true) return true
  if (value === false) return false
  return undefined
}

/**
 * Parse `xcrun xcdevice list` into destination records.
 *
 * Simulator entries are dropped here: `-showdestinations` already reports every
 * simulator, with the run-time OS version, and duplicating them would double every
 * simulator row in the panel.
 *
 * A partial or malformed answer yields no devices rather than throwing — `xcdevice`
 * prints whatever it managed to collect when a device is slow to answer.
 *
 * @param {string} text - stdout of `xcrun xcdevice list`.
 * @returns {Array<object>} destination records, in the order reported.
 */
export function parseXcdeviceList(text) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    return []
  }
  const entries = Array.isArray(data) ? data : (Array.isArray(data?.devices) ? data.devices : [])
  const out = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.simulator === true) continue
    const platform = XCDEVICE_PLATFORMS[String(entry.platform ?? '')]
    if (platform === undefined) continue
    const id = String(entry.identifier ?? '').trim()
    if (id === '') continue
    const note = entry.error !== null && typeof entry.error === 'object'
      ? String(entry.error.description ?? '')
      : ''
    out.push({
      platform,
      id,
      name: String(entry.name ?? '') !== '' ? String(entry.name) : id,
      os: stripBuildNumber(entry.operatingSystemVersion),
      arch: 'arm64',
      variant: '',
      kind: 'device',
      placeholder: false,
      available: triState(entry.available),
      source: 'xcdevice',
      ...(note !== '' ? { note } : {}),
    })
  }
  return out
}

/**
 * Parse `xcrun devicectl list devices --json-output <file>` into destination records.
 *
 * The id is `hardwareProperties.udid`, deliberately not the `identifier` devicectl
 * prints first: that one is a CoreDevice UUID, `devicectl` accepts it but
 * `xcodebuild -destination id=…` does not, and this record is what the panel turns
 * into a destination string. Verified on the bench: the CoreDevice UUID failed with
 * "Unable to find a device matching the provided destination specifier" while the
 * hardware udid built.
 *
 * @param {string} text - contents of the file devicectl wrote.
 * @returns {Array<object>} destination records.
 */
export function parseDevicectlList(text) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    return []
  }
  const devices = data?.result?.devices
  if (!Array.isArray(devices)) return []
  const out = []
  for (const device of devices) {
    if (device === null || typeof device !== 'object') continue
    const hardware = device.hardwareProperties ?? {}
    const properties = device.deviceProperties ?? {}
    const connection = device.connectionProperties ?? {}
    const id = String(hardware.udid ?? '').trim()
    if (id === '') continue
    const model = String(hardware.marketingName ?? hardware.productType ?? '')
    out.push({
      platform: platformOfProductType(hardware.productType) || 'iOS',
      id,
      name: String(properties.name ?? '') !== '' ? String(properties.name) : (model !== '' ? model : id),
      os: String(properties.osVersionNumber ?? ''),
      arch: 'arm64',
      variant: '',
      kind: 'device',
      placeholder: false,
      // Only a live tunnel means the device can be built for and installed to;
      // `paired` alone is a memory of a phone that is not here now.
      available: connection.tunnelState === 'connected',
      model,
      // The same phone under the name lldb's `device select` accepts. The two halves of the
      // toolchain disagree: xcodebuild wants the hardware udid above, lldb wants this one.
      coreDeviceId: String(device.identifier ?? '').trim(),
      source: 'devicectl',
    })
  }
  return out
}

/** Nothing said here, so another source may fill it in. */
function unset(value) {
  return value === undefined || value === null || value === ''
}

/** Append a source name to a record's provenance, without repeating it. */
function withSource(record, source) {
  if (typeof source !== 'string' || source === '') return record.sources
  const sources = Array.isArray(record.sources) ? record.sources : []
  return sources.includes(source) ? sources : sources.concat(source)
}

/**
 * Merge the extra sources into the authoritative list, one row per device id.
 *
 * Ids, not names, decide identity: a bench routinely holds two phones with the same
 * model name, and collapsing those would silently drop a device. The first record for
 * an id wins its fields, later sightings only fill in what it left unsaid — so
 * `-showdestinations`' own wording survives — while availability may only go up: a
 * source that cannot see the device must not downgrade one that can. A record from
 * `-showdestinations` that says nothing about availability is treated as reachable,
 * because that source lists a device only when it is one.
 *
 * @param {Array<object>} base - records from `-showdestinations` (authoritative).
 * @param {Array<object>} extras - records from every other channel.
 * @returns {Array<object>} merged records, in first-seen order.
 */
export function mergeDestinations(base, extras) {
  const out = []
  const at = new Map()
  /**
   * Take the first sighting of an id into the result, or hand back the row it has.
   *
   * `implied` is the availability this source is asserting by listing the device at
   * all: `true` for `-showdestinations`, which lists a concrete device only when it is
   * one, and `undefined` for a source whose silence means it did not say.
   */
  const adopt = (record, implied) => {
    if (record === null || typeof record !== 'object') return null
    const id = String(record.id ?? '').trim()
    if (id === '') return null
    const seen = at.get(id)
    if (seen !== undefined) return seen
    const copy = { ...record, id, sources: withSource(record, record.source) }
    if (copy.available === undefined && implied !== undefined
      && copy.kind === 'device' && copy.placeholder !== true) {
      copy.available = implied
    }
    at.set(id, copy)
    out.push(copy)
    return copy
  }
  for (const record of Array.isArray(base) ? base : []) adopt(record, true)
  for (const record of Array.isArray(extras) ? extras : []) {
    if (record === null || typeof record !== 'object') continue
    const id = String(record.id ?? '').trim()
    if (id === '') continue
    const seen = at.get(id)
    if (seen === undefined) {
      adopt(record, undefined)
      continue
    }
    for (const field of ['name', 'os', 'arch', 'variant', 'model']) {
      if (unset(seen[field]) && !unset(record[field])) seen[field] = record[field]
    }
    // Availability may only go up. A source that cannot see the device has no vote,
    // and a source that can is evidence; an explicit "no" applies only while nothing
    // has said yes, so the last word is never a device going dark because some
    // channel lost its tunnel.
    if (seen.available !== true && record.available === true) seen.available = true
    else if (seen.available === undefined && record.available === false) seen.available = false
    if (unset(seen.note) && !unset(record.note)) seen.note = record.note
    seen.sources = withSource(seen, record.source)
  }
  for (const record of out) {
    // Nothing said it was unreachable, and it is a concrete device: that is
    // reachability. Placeholders ("Any iOS Device") are not devices.
    if (record.available === undefined && record.kind === 'device' && record.placeholder !== true) {
      record.available = true
    }
  }
  return out
}
