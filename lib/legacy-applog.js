/**
 * The app's own log, read out of its sandbox on the classic channel.
 *
 * An iOS 16 device is not CoreDevice, so `xcrun devicectl device copy from` is
 * not available for it — the transfer route that works on iOS 17 hardware does
 * not exist here. The app does keep a log, though, and it is the only log that
 * survives a crash: `Documents/PPCrashLog/log_<timestamp>.log` inside the app's
 * container, one file per launch.
 *
 * Two facts from the device, both surprising enough to be worth stating:
 *
 * 1. **`ios-deploy --list` is a silent no-op here.** It exits 0 and prints
 *    nothing at all, not even for a path that does not exist, with or without
 *    `--json`, `-v` or `--file_system`. So the directory cannot be enumerated
 *    first; it has to be downloaded and enumerated on the host. `--get_pid` has
 *    the same failure mode on this toolchain (it answers nothing even for a
 *    running SpringBoard), which is why neither is trusted as a verdict.
 * 2. **`ios-deploy --download` does work, and works while the device is locked.**
 *    A directory download of the whole log directory took ~3.4s for four files
 *    (420 KB) with `locked: 1` in the device syslog, so this route does not need
 *    the device unlocked or awake the way a launch does.
 *
 * The download lands the device path underneath the `--to` directory, keeping the
 * path as it was (`--download=/Documents/PPCrashLog --to /tmp/x` produces
 * `/tmp/x/Documents/PPCrashLog/<name>`), so the local path is reconstructed
 * rather than guessed.
 *
 * The file name is the ordering key. ios-deploy does not preserve the device
 * mtime (every downloaded file is stamped with the download time), but the app
 * names each file after its own launch instant —
 * `log_2026-09-22-22-09-45.462.log` — and that format is fixed-width, so a plain
 * lexicographic maximum is the newest launch.
 *
 * @module dsh-xcodebuild/legacy-applog
 */

/** Where the app writes its per-launch log, relative to Documents in its container. */
export const APP_LOG_DIR = 'Documents/PPCrashLog'

/**
 * `log_<YYYY>-<MM>-<DD>-<HH>-<mm>-<ss>[.<ms>].log`, as the app names them.
 *
 * Deliberately strict: `watchdog_stall.log` lives in the same directory and is a
 * different thing (a stall report, not a launch log), so a loose `*.log` match
 * would hand back the wrong file.
 */
const APP_LOG_PATTERN = /^log_(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?\.log$/

/**
 * Is this the app's per-launch log file?
 *
 * @param {string} name - a file name (a full path is not accepted; take the basename first).
 * @returns {boolean} true for `log_<timestamp>.log`.
 */
export function isAppLogName(name) {
  return APP_LOG_PATTERN.test(String(name ?? ''))
}

/**
 * The launch instant encoded in the file name, for display.
 *
 * @param {string} name - an app log file name.
 * @returns {string|null} `2026-09-22 22:09:45.462`, or null when it is not one.
 */
export function appLogStamp(name) {
  const match = APP_LOG_PATTERN.exec(String(name ?? ''))
  if (match === null) return null
  const [, y, mo, d, h, mi, s, ms] = match
  return `${y}-${mo}-${d} ${h}:${mi}:${s}${ms === undefined ? '' : `.${ms}`}`
}

/**
 * Newest first: the app log file names in launch order.
 *
 * The names are fixed-width up to the optional millisecond field, and that field
 * is always three digits when present, so string order is time order. Using the
 * name rather than a stat keeps this a pure function and sidesteps the mtime that
 * the download does not preserve.
 *
 * @param {Iterable<string>} names - whatever the directory download produced.
 * @returns {string[]} matching names, newest first.
 */
export function rankAppLogs(names) {
  const matched = []
  for (const name of names ?? []) {
    if (isAppLogName(name)) matched.push(String(name))
  }
  return matched.sort().reverse()
}

/**
 * The most recent launch log, or null when the app has never logged one.
 *
 * @param {Iterable<string>} names - file names found in the log directory.
 * @returns {string|null} the newest `log_*.log`.
 */
export function pickLatestAppLog(names) {
  return rankAppLogs(names)[0] ?? null
}

/**
 * The launch log this run created, or null when none appeared.
 *
 * The two names, taken on either side of a launch, are what turn the app's own
 * file into evidence: a name that was not in the container before the launch can
 * only have been written by a process that started. A null result is NOT proof of
 * failure — the file is written as the process starts and can lag the detach — so
 * callers must treat it exactly like a silent `--get_pid` probe: worth reporting,
 * never a verdict on its own.
 *
 * @param {string|null} before - newest log name before the launch (null when there was none).
 * @param {string|null} after - newest log name after the launch.
 * @returns {string|null} the new file name, or null.
 */
export function newLaunchLog(before, after) {
  const name = typeof after === 'string' && after !== '' ? after : null
  if (name === null) return null
  return name === (before ?? null) ? null : name
}

/**
 * The lines an app's log gained since the last look.
 *
 * The pump that keeps the app's own log flowing into the panel after an attached
 * launch cannot count lines: `readLegacyAppLog` returns the file's TAIL, so once the
 * log grows past that window its beginning slides out and every line index shifts.
 * It cannot trust a byte offset either, because each look is a fresh download of a
 * file the app may have rewritten.
 *
 * So the last line already pushed is the marker: everything after its LAST
 * occurrence is new. When the marker has scrolled out of the window the answer is
 * null — "cannot tell" — and the caller says so and re-anchors rather than
 * reprinting a tail as if it were new.
 *
 * @param {string} text - the tail of the app's log, as read now.
 * @param {string|null} marker - the last line pushed, or null when nothing has been.
 * @returns {string[]|null} the new lines, or null when the marker is gone.
 */
export function newLinesSince(text, marker) {
  const body = typeof text === 'string' ? text : ''
  if (marker === null || marker === undefined) return body.split('\n')
  const at = body.lastIndexOf(marker)
  if (at < 0) return null
  const rest = body.slice(at + marker.length)
  if (rest === '') return []
  return (rest.startsWith('\n') ? rest.slice(1) : rest).split('\n')
}

/**
 * Where a downloaded device path lands locally.
 *
 * `ios-deploy --download=<path> --to <dir>` keeps the device path under `<dir>`,
 * verified against the device: downloading `/Documents/PPCrashLog` into
 * `/tmp/dltree` produced `/tmp/dltree/Documents/PPCrashLog/<name>`. Reconstructing
 * it is what lets the caller read the file it just asked for.
 *
 * @param {string} toDir - the local directory passed as `--to`.
 * @param {string} devicePath - the device path passed as `--download`.
 * @returns {string} the local path the download creates.
 */
export function downloadedPathFor(toDir, devicePath) {
  const relative = String(devicePath ?? '').replace(/^\/+/, '')
  const base = String(toDir ?? '').replace(/\/+$/, '')
  return relative === '' ? base : `${base}/${relative}`
}

/**
 * The argv that pulls one file or one directory out of the app container.
 *
 * `--bundle_id` is what selects the app container (HouseArrest); without it
 * ios-deploy would address the device's media filesystem instead, which is a
 * different tree. `-F` is only correct for a directory: it stops the walk from
 * descending, and the log directory is flat, so it bounds the transfer.
 *
 * @param {{launcher: string, udid: string, bundleId: string, devicePath: string, toDir: string, directory?: boolean}} spec
 *   the transfer to perform.
 * @returns {string[]} argv for ios-deploy.
 */
export function appLogPullArgv(spec) {
  const argv = [
    spec.launcher,
    '--id', spec.udid,
    '--bundle_id', spec.bundleId,
    `--download=${spec.devicePath}`,
    '--to', spec.toDir,
  ]
  if (spec.directory === true) argv.push('--non-recursively')
  return argv
}

/**
 * A log file that is too large to inject into a model turn.
 *
 * The Tail is what matters — the failure is at the end — so the caller reads the
 * last bytes rather than the whole file. Kept here so the panel, the tool and the
 * tests agree on the ceiling.
 */
export const APP_LOG_TAIL_BYTES = 262144

/**
 * The last `APP_LOG_TAIL_BYTES` of a log, trimmed to whole lines.
 *
 * @param {string|Buffer} content - the whole file, or its tail.
 * @param {number} [max] - byte ceiling.
 * @returns {string} the tail, starting at a line boundary when one is present.
 */
export function tailOfAppLog(content, max = APP_LOG_TAIL_BYTES) {
  const text = String(content ?? '')
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const newline = cut.indexOf('\n')
  return newline < 0 ? cut : cut.slice(newline + 1)
}
