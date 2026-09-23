// What one launch leaves behind, and when it is safe to delete.
//
// Three kinds of file accumulate in the temporary directory, and none of them is
// cleaned by whoever wrote it:
//
// 1. **The console file this plugin redirects a session to**
//    (`<tmp>/dsh-xcodebuild/xr1-<epoch>-ios-deploy.log`). One per attached launch,
//    and it grows for as long as the app logs. Run ids also restart at `xr1` every
//    time DSH does, so the names repeat and a directory full of them is meaningless
//    without the timestamp in the name.
// 2. **ios-deploy's own litter**: a fresh `<tmp>/<UUID>/` per launch, holding
//    `fruitstrap-lldb-prep-cmds-<udid>`, `fruitstrap_<udid>.py` and an empty
//    `fruitstrap_/`. ios-deploy never removes them.
// 3. **An app-log download abandoned mid-read** (`dsh-xcodebuild-applog-*`), which
//    `readLegacyAppLog` removes in a `finally` — unless the host is killed between
//    the download and the read.
//
// The age gate is what makes deleting any of this safe: a directory that has not
// been touched for an hour cannot belong to a live session, because a session writes
// to its files as the app runs. Everything here is a decision about NAMES and TIMES,
// with no filesystem access, so the policy can be pinned by a test.

/** How many previous console files are kept, newest first. */
export const CONSOLE_KEEP = 5

/** How long a console file is kept at all, even among the newest. */
export const CONSOLE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/** How old a leftover must be before it cannot belong to a running session. */
export const LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000

/** The prefix `readLegacyAppLog` gives its temporary download directories. */
export const APP_LOG_PREFIX = 'dsh-xcodebuild-applog-'

/** A directory ios-deploy created, i.e. one of its `NSTemporaryDirectory()` UUIDs. */
const UUID_DIR = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

/**
 * The launch time embedded in a console file's name, when it has one.
 *
 * The name is `<runId>-<epoch>-ios-deploy.log`, and the epoch is authoritative: a
 * copied file keeps its name but not its mtime, and mtime is what a prune would
 * otherwise sort by.
 *
 * @param {string} name - the file's name.
 * @returns {number|null} epoch milliseconds, or null when the name is not one of ours.
 */
export function consoleLogStamp(name) {
  const match = /^(.+)-(\d{10,16})-ios-deploy\.log$/.exec(String(name ?? ''))
  if (match === null) return null
  const stamp = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(stamp) ? stamp : null
}

/**
 * Which console files a new launch should delete first.
 *
 * The newest `keep` stay, so the last few sessions can still be read after the fact —
 * and the current run's file is not among the entries at all, because it does not
 * exist until the launch starts. Age then overrides keeping: a machine that has not
 * launched anything for a while should not hold a directory of dead sessions.
 *
 * Only names this plugin wrote are candidates. The directory is its own, but a file
 * someone put there on purpose — notes, a copy of a log, anything without a launch
 * stamp — is not litter to be swept up by a build.
 *
 * @param {{name: string}[]} entries - what the directory holds.
 * @param {{keep?: number, now?: number, maxAgeMs?: number}} [options] - policy.
 * @returns {string[]} names to delete.
 */
export function prunableConsoleLogs(entries, options = {}) {
  const keep = Number.isInteger(options.keep) && options.keep >= 0 ? options.keep : CONSOLE_KEEP
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : CONSOLE_MAX_AGE_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const stamped = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ name: String(entry?.name ?? ''), at: consoleLogStamp(entry?.name) }))
    .filter((entry) => entry.name !== '' && entry.at !== null)
  const kept = new Set(
    [...stamped].sort((left, right) => right.at - left.at).slice(0, keep).map((entry) => entry.name),
  )
  return stamped
    .filter((entry) => !kept.has(entry.name) || now - entry.at > maxAgeMs)
    .map((entry) => entry.name)
}

/**
 * Is this leftover old enough to delete?
 *
 * A session writes to its files continuously, so an hour of silence is proof that
 * whatever created this is gone. Refusing to delete anything younger is what keeps
 * this from reaching into a session that is merely slow.
 *
 * @param {number} mtimeMs - when the entry was last touched.
 * @param {{now?: number, maxAgeMs?: number}} [options] - policy.
 * @returns {boolean} true when it can safely go.
 */
export function isStaleLeftover(mtimeMs, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : LEFTOVER_MAX_AGE_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  if (!Number.isFinite(mtimeMs)) return false
  return now - mtimeMs > maxAgeMs
}

/**
 * Is this temporary directory something this plugin should consider at all?
 *
 * Cheap, so a prune of the whole temporary directory does not stat two hundred
 * unrelated macOS directories.
 *
 * @param {string} name - a directory name under the temporary root.
 * @returns {boolean} true for ios-deploy's UUIDs and this plugin's own downloads.
 */
export function isSessionTempDir(name) {
  const text = String(name ?? '')
  return UUID_DIR.test(text) || text.startsWith(APP_LOG_PREFIX)
}

/**
 * Does this ios-deploy temporary directory belong to a device?
 *
 * The prep files are named after the device id, which is what makes a UUID directory
 * attributable rather than just old.
 *
 * @param {string[]} files - names inside the directory.
 * @param {string} udid - the device's id.
 * @returns {boolean} true when ios-deploy prepared a session for this device here.
 */
export function isFruitstrapDirFor(files, udid) {
  const id = String(udid ?? '')
  if (id === '') return false
  return (Array.isArray(files) ? files : []).some((file) => {
    const name = String(file ?? '')
    return name === `fruitstrap_${id}.py` || name === `fruitstrap-lldb-prep-cmds-${id}` || name === `fruitstrap_${id}`
  })
}
