// Destination parsing for `xcodebuild -showdestinations`.
//
// Two bugs this exists to prevent, both found by running against the real
// output for a 24-scheme CocoaPods workspace rather than by inspection:
//
//  1. Field values can contain commas. `-showdestinations` prints
//        { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:..., name:My Mac }
//     A naive `variant:([^,]*)` stops at the comma inside the brackets and
//     yields "Designed for [iPad". Fields must be split on commas that are
//     followed by another `key:`, not on every comma.
//
//  2. `platform:macOS` appears FIRST in the output, ahead of every simulator.
//     A "first entry wins" default therefore silently picks "My Mac" for an
//     iOS app, contradicting the `recommended` field the tool itself reports.
//     Defaults must prefer a concrete simulator.
//
// This module is plain JS with no imports so its exact source can also be
// embedded in the dynamic Cordis host half, where import/require are unavailable.

/** Split the substring after `platform:` into a field map. */
export function parseFields(rest) {
  const out = {}
  // Split only on `,` that begins a new `key:` — protects values like
  // `Designed for [iPad,iPhone]` and ids like `...-iphonesimulator:placeholder`.
  const parts = String(rest).split(/,\s*(?=[A-Za-z_][A-Za-z0-9_]*:)/)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const colon = part.indexOf(':')
    if (colon <= 0) continue
    const key = part.slice(0, colon).trim()
    if (!key) continue
    out[key] = part.slice(colon + 1).trim()
  }
  return out
}

/** Parse the stdout of `xcodebuild -showdestinations` into destination records. */
export function parseDestinations(stdout) {
  const out = []
  const re = /\{\s*platform:([^,}]+)([^}]*)\}/g
  let m
  while ((m = re.exec(String(stdout || ''))) !== null) {
    const platform = m[1].trim()
    const fields = parseFields(m[2])
    const id = fields.id || ''
    if (!id) continue
    const isSim = platform === 'iOS Simulator' || platform === 'tvOS Simulator' || platform === 'watchOS Simulator'
    const isDevice = platform === 'iOS' || platform === 'tvOS' || platform === 'watchOS'
    out.push({
      platform: platform,
      id: id,
      name: fields.name || '',
      os: fields.OS || '',
      arch: fields.arch || '',
      variant: fields.variant || '',
      kind: isSim ? 'simulator' : (isDevice ? 'device' : (platform === 'macOS' ? 'macos' : 'other')),
      placeholder: id.indexOf('placeholder') >= 0,
    })
  }
  return out
}

/**
 * Convert a `variant:` field into a value usable in a `-destination` argument.
 *
 * Verified against xcodebuild 26.0.1: the raw field cannot be echoed back.
 * `-showdestinations` prints `variant:Designed for [iPad,iPhone]`, but
 * xcodebuild also splits `-destination` on commas, so that literal string
 * fails with:
 *     xcodebuild: error: unreadable input 'iPhone]' at end of value for
 *     option 'Destination'
 * The accepted form names a single family without brackets: `Designed for iPad`.
 * Keep the full field on the record for display; only this projection is
 * allowed into an argv.
 */
export function variantForDestination(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const open = s.indexOf('[')
  if (open < 0) return s.split(',')[0].trim()
  const close = s.indexOf(']', open)
  const inner = close < 0 ? s.slice(open + 1) : s.slice(open + 1, close)
  const first = inner.split(',')[0].trim()
  const prefix = s.slice(0, open).trim()
  return (prefix + ' ' + first).trim()
}

/** The exact `-destination` argument for one parsed destination. */
export function destinationString(d) {
  if (!d) return ''
  if (d.kind === 'macos') {
    const parts = ['platform=macOS']
    if (d.arch) parts.push('arch=' + d.arch)
    // "Designed for [iPad,iPhone]" is a macOS destination that runs an iOS
    // binary; dropping the variant would silently target a native macOS app.
    const variant = variantForDestination(d.variant)
    if (variant) parts.push('variant=' + variant)
    return parts.join(',')
  }
  return 'platform=' + d.platform + ',id=' + d.id
}

/**
 * Default destination when the caller did not choose one.
 * Prefers a concrete simulator over macOS, matching the `recommended` field
 * `xcode_destinations` reports, so the two paths cannot disagree.
 */
export function pickDefaultDestination(list, preferred) {
  const arr = list || []
  // A destination this project already used outranks every guess: it is explicit
  // intent, and it is what makes returning to a workspace feel like returning
  // rather than starting over. It is validated against the live list, so a device
  // that is no longer plugged in falls through instead of being offered stale.
  const want = typeof preferred === 'string' ? preferred.trim() : ''
  if (want !== '') {
    const match = arr.find((d) => d.placeholder !== true
      && (d.id === want || destinationString(d) === want))
    if (match !== undefined) return destinationString(match)
  }
  // Connectable hardware leads. A plugged-in phone is the thing the user is
  // actually testing on; a simulator is the fallback, not the default. This used
  // to prefer a simulator, which meant the panel offered a simulator even with a
  // device attached.
  for (const d of arr) if (d.kind === 'device' && !d.placeholder) return destinationString(d)
  for (const d of arr) if (d.kind === 'simulator' && !d.placeholder) return destinationString(d)
  for (const d of arr) if (d.kind === 'macos') return destinationString(d)
  return ''
}

/**
 * What a `-destination` string names.
 *
 * The panel hands back a destination STRING, not the destination record it came
 * from, so the kind has to be read back out of it. This decides how a built app
 * reaches the target: `simctl` only ever talks to simulators, and a physical
 * device needs `devicectl` — which is why a device build used to report
 * `Invalid device: <udid>` after the build itself had already succeeded.
 */
export function destinationKindOf(destination) {
  const text = String(destination ?? '')
  const match = /platform=([^,]+)/.exec(text)
  if (match === null) return 'other'
  const platform = match[1].trim()
  if (platform === 'macOS') return 'macos'
  if (platform.endsWith('Simulator')) return 'simulator'
  return 'device'
}
