/**
 * The pieces of mirroring another app's window that are worth testing without a window.
 *
 * The panel shows Lookin.app's own window — it is a separate install, its UI is its own, and
 * the only honest way to put it inside the Harness page is to show its pixels. Everything here
 * is the arithmetic and the parsing around that: which window is the one to mirror, where a
 * click in the mirrored image lands in screen coordinates, and what the native helper said.
 *
 * Kept free of `fs` and `spawn` on purpose, the same way `lookin-app.js` is: the decisions are
 * testable as strings and numbers, and the host does the I/O.
 *
 * Two coordinate facts this file exists to keep straight:
 *
 *   - `wininfo list` prints GLOBAL DISPLAY POINTS with the origin at the top-left of the main
 *     display — the space `CGWindowListCopyWindowInfo` reports bounds in and the space posted
 *     events are read in.
 *   - The captured JPEG is in PIXELS at the backing scale (2x on Retina), and it includes the
 *     window's title bar, because `screencapture -l` captures the frame and not the content
 *     view. Measured: a 420x300 content rect came back 420x332 points.
 *
 * So a click is mapped through the FRACTION of the window, never through pixels: the same
 * fraction of a 2x image and of a 1x frame is the same place, and the mapping survives a
 * Retina display, a scaled display, and a future capture that changes resolution.
 *
 * @module dsh-xcodebuild/lookin-window
 */

/** A window smaller than this in either direction is a utility panel, not the UI to mirror. */
export const MIN_MIRROR_EDGE = 120

/** Windows narrower than this are toolbars and status items on this system, measured. */
export const MIN_MIRROR_WIDTH = 200

/**
 * Parse one line of `wininfo list` output per window.
 *
 * The format is tab-separated and the title is last, so a title containing a tab (stripped by
 * the helper) or a space costs nothing. A short line is skipped rather than guessed at: a
 * half-read window would be a window the panel offers and the mirror cannot capture.
 *
 * @param {string} stdout - the helper's stdout.
 * @returns {Array<{pid: number, id: number, x: number, y: number, width: number, height: number, layer: number, owner: string, title: string}>} the windows it listed.
 */
export function parseWindowList(stdout) {
  const windows = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 8) continue
    const [pid, id, x, y, width, height, layer] = parts.map((value) => Number(value))
    if (![pid, id, x, y, width, height, layer].every(Number.isFinite)) continue
    windows.push({
      pid,
      id,
      x,
      y,
      width,
      height,
      layer,
      owner: parts[7] ?? '',
      title: parts[8] ?? '',
    })
  }
  return windows
}

/**
 * The window worth mirroring for one process: its largest ordinary window.
 *
 * Largest rather than first, because the list is in front-to-back order and an app that has
 * just been launched puts its splash or its crash panel in front — Lookin opened a report
 * window in front of its main window on this very machine, which is what a "first window"
 * rule would have mirrored. Layer 0 excludes menus, the Dock and the menu-bar extras, and the
 * size floor excludes the small floating panels an inspector app keeps around.
 *
 * @param {ReturnType<typeof parseWindowList>} windows - parsed windows, any order.
 * @param {number} [pid] - the process to pick from; omit to consider every owner.
 * @returns {ReturnType<typeof parseWindowList>[number] | null} the window, or null when there is none.
 */
export function pickMirrorWindow(windows, pid) {
  let best = null
  for (const window of windows) {
    if (pid !== undefined && window.pid !== pid) continue
    if (window.layer !== 0) continue
    if (window.width < MIN_MIRROR_WIDTH || window.height < MIN_MIRROR_EDGE) continue
    if (best === null || window.width * window.height > best.width * best.height) best = window
  }
  return best
}

/**
 * The first pid in `pgrep`-style output, or null.
 *
 * Needed because "Lookin is running" and "Lookin has a window" are different states: an app
 * that is up with every window closed still has a pid, and that is what activation and event
 * posting need. Reading it off the window list instead would conflate the two.
 *
 * @param {string} stdout - one pid per line.
 * @returns {number | null} the first pid, or null.
 */
export function parseFirstPid(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const value = Number(trimmed)
    if (Number.isInteger(value) && value > 0) return value
  }
  return null
}

/**
 * Clamp a fraction into the window.
 *
 * A pointer that leaves the mirrored image mid-drag still produces fractions slightly outside
 * it, and a click at -0.02 of the window is a click in the neighbouring app — which is a click
 * nobody asked for. Outside the window there is no honest mapping, so the edge is used.
 *
 * @param {number} value - a fraction of the window's width or height.
 * @returns {number} the same fraction, inside [0, 1].
 */
export function clampFraction(value) {
  // NaN first, and only NaN: it means no position was measured at all, and the answer has to
  // be inside the window — 0 is the left/top edge, never the middle, so a missing fraction
  // cannot turn into a click on something the user did not point at. An infinite fraction is a
  // real direction (dragged far off the edge) and falls out of the comparisons below.
  if (Number.isNaN(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Where a click at one fraction of the mirrored image lands, in global display points.
 *
 * The bounds are the window's frame, which is also what the image contains, so the mapping is
 * one multiplication per axis with no title-bar compensation.
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds - the window's frame, in points.
 * @param {number} fx - fraction across, 0 at the left edge.
 * @param {number} fy - fraction down, 0 at the top edge.
 * @returns {{x: number, y: number}} a global display point.
 */
export function mirrorPoint(bounds, fx, fy) {
  return {
    x: Math.round(bounds.x + clampFraction(fx) * bounds.width),
    y: Math.round(bounds.y + clampFraction(fy) * bounds.height),
  }
}

/**
 * What `wininfo status` reported.
 *
 * `accessibility` is the one that decides whether a forward click can do anything: posting
 * events to another process is gated on it, and the gate is on the *responsible* process, so
 * the answer is about the Harness app rather than about the helper binary. Measured on this
 * machine: the Harness app holds it, the Helper process it launches does not, and a click
 * posted either to the app's pid or to the system is silently dropped.
 *
 * @param {string} stdout - the helper's stdout.
 * @returns {{accessibility: boolean, screenCapture: boolean, frontmostPid: number}} the flags, false when absent.
 */
export function parseHelperStatus(stdout) {
  const text = String(stdout ?? '')
  const read = (name) => {
    const match = new RegExp(`${name}=(-?\\d+)`).exec(text)
    return match === null ? null : Number(match[1])
  }
  return {
    accessibility: read('accessibility') === 1,
    screenCapture: read('screenCapture') === 1,
    frontmostPid: read('frontmostPid') ?? 0,
  }
}

/**
 * Where the compiled helper lives, per user.
 *
 * A cache directory and not the plugin's own tree: the plugin directory is a git checkout
 * during development and may be read-only when it is not, and a binary does not belong in
 * either. The name is the plugin's, so two plugin versions share one helper — it is rebuilt
 * from source whenever the source is newer, so sharing is safe.
 *
 * @param {string} home - the user's home directory.
 * @returns {string} the helper binary's path.
 */
export function helperBinaryPath(home) {
  const root = typeof home === 'string' && home !== '' ? home.replace(/\/+$/, '') : ''
  return `${root}/Library/Caches/dsh-xcodebuild/wininfo`
}

/**
 * Whether the helper has to be compiled again.
 *
 * Missing binary, or a source file newer than it: the source is the truth and a stale binary
 * is a bug that looks like a feature not working. Compared in milliseconds; an unreadable
 * source counts as newer, so a checkout with odd timestamps rebuilds rather than guesses.
 *
 * @param {number} binaryMs - the binary's mtime in ms, or null when there is none.
 * @param {number} sourceMs - the source's mtime in ms, or null when it cannot be read.
 * @returns {boolean} true when `swiftc` should run.
 */
export function needsHelperBuild(binaryMs, sourceMs) {
  if (binaryMs === null || !Number.isFinite(binaryMs)) return true
  if (sourceMs === null || !Number.isFinite(sourceMs)) return true
  return sourceMs > binaryMs
}

/**
 * A wheel delta the mirrored app can be expected to survive.
 *
 * Browser wheel deltas are pixel distances and a trackpad flick arrives as a burst of events
 * with large values; forwarding them raw turns one gesture into a jump to the end of a list.
 * The cap is per event, so a real flick still scrolls — it stays a gesture rather than a leap.
 * A delta that is not a number is no scroll at all.
 *
 * @param {number} value - the delta the panel reported, in pixels.
 * @param {number} [limit] - the largest magnitude forwarded.
 * @returns {number} the delta to forward, as an integer.
 */
export function clampWheelDelta(value, limit = 400) {
  if (!Number.isFinite(value)) return 0
  const capped = Math.max(-limit, Math.min(limit, value))
  return Math.trunc(capped)
}

/**
 * What to tell the user about the grants the mirror needs, or an empty string when it has them.
 *
 * Naming the failing half matters more than naming the feature: the mirror needs Screen
 * Recording to show the window and Accessibility to click into it, the two are granted to
 * different processes on this machine (measured — the Harness app holds the first, the Helper
 * process it spawns was denied the second), and a message that says "permission needed" without
 * saying which one and for which process leaves the user toggling the wrong switch.
 *
 * Every sentence names the process, the pane, and the step, because that is the whole task.
 *
 * @param {{accessibility: boolean, screenCapture: boolean}} permissions - what the helper reported.
 * @returns {string} one sentence per missing grant, or ''.
 */
export function lookinPermissionNote(permissions) {
  const notes = []
  if (permissions?.screenCapture === false) {
    notes.push('Showing the window needs Screen Recording: System Settings → Privacy & Security → Screen & System Audio Recording → turn on the Harness app, then restart it.')
  }
  if (permissions?.accessibility === false) {
    notes.push('Clicking through needs Accessibility for the process that posts the events: System Settings → Privacy & Security → Accessibility → turn on "DSH Desktop Helper", then restart the Harness.')
  }
  return notes.join(' ')
}
