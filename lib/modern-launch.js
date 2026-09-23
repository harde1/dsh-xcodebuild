// Bringing an app up on iOS 17 and later, and reading it live once it is up.
//
// CoreDevice replaced the whole classic toolchain, and it changed two things that this
// module has to respect:
//
// 1. **`--console` is an attached session, not a one-shot launch.** It connects the app's
//    standard streams to devicectl's and waits for the app to exit, and it forwards
//    catchable signals to the app. Measured on an iPhone 12 (iOS 26.6.2) with this app:
//    128 KB of the app's own logging arrived in the first twelve seconds — the same
//    `[I]`/`[D]`/`[V]` lines the classic channel only ever had in a file. What ends that
//    session was measured too, because it is not what the classic channel takes: SIGINT is
//    ignored (devicectl survived it, and so did the app), while SIGTERM terminates the app
//    — devicectl said `App terminated due to signal 15` — and then ends devicectl itself.
//    So the modern channel reads its log the same way the classic one reads a console: an
//    attached child, redirected to a file, tapped by a separate reader.
// 2. **The app's container is reachable without a debug session.** `devicectl device copy
//    from --domain-type appDataContainer` fetched the whole log directory, 348 KB, in
//    **0.9 seconds** — against 50 seconds for the 2.4 MB the classic download took. That
//    makes the container file a usable fallback rather than a last resort, for an app
//    that logs only to its own file and leaves the console empty.

/** `devicectl`'s own statement that the app is up, as it appears on the console. */
const LAUNCHED_LINE = /Launched application with \S+ bundle identifier/

/**
 * Escape a process name so it can be part of a regular expression.
 *
 * App names really do contain these characters — a `+` in a name would otherwise turn
 * the witness pattern into a quantifier and match the wrong lines.
 *
 * @param {string} text - the literal text.
 * @returns {string} the text, escaped.
 */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The line an app's own logging produces on the console.
 *
 * devicectl connects the process's standard streams, so the app's output arrives the way
 * the app prints it: `<timestamp> <process>[<pid>:<thread>] <message>`. The pid is the
 * useful part — it is the only proof that this is the launched process rather than an
 * older line about it.
 *
 * @param {string|null} processName - the app's process name.
 * @returns {RegExp|null} the pattern, or null when there is no name to look for.
 */
export function appLinePattern(processName) {
  if (processName === null || processName === undefined || processName === '') return null
  return new RegExp(`${escapeForRegExp(String(processName))}\\[(\\d+):`)
}

/**
 * The command that launches an app with its console attached.
 *
 * `--terminate-existing` keeps the meaning the one-shot form had: this launch is the one
 * that decides what the device is running. `--console` is what makes the run a session —
 * without it there is nothing to read from.
 *
 * @param {{udid: string, bundleId: string, launcher?: string}} spec - what to launch.
 * @returns {string[]} argv.
 */
export function modernLaunchArgv(spec) {
  const launcher = spec.launcher ?? 'xcrun'
  return [
    launcher, 'devicectl', 'device', 'process', 'launch',
    '--device', spec.udid,
    '--terminate-existing',
    '--console',
    spec.bundleId,
  ]
}

/**
 * The command that copies a path out of the app's data container.
 *
 * The domain pair is what selects the container: `appDataContainer` plus the bundle id.
 * The destination is a local directory, and — measured — the copied items land directly
 * in it rather than under a directory named after the source.
 *
 * @param {{udid: string, bundleId: string, source: string, toDir: string, launcher?: string}} spec - what to copy.
 * @returns {string[]} argv.
 */
export function modernCopyArgv(spec) {
  const launcher = spec.launcher ?? 'xcrun'
  return [
    launcher, 'devicectl', 'device', 'copy', 'from',
    '--device', spec.udid,
    '--domain-type', 'appDataContainer',
    '--domain-identifier', spec.bundleId,
    '--source', spec.source,
    '--destination', spec.toDir,
  ]
}

/**
 * Read a launch out of what the console has said so far.
 *
 * Two things count, and they are not equally strong. devicectl's own
 * `Launched application with <bundle> bundle identifier.` is the launcher reporting that
 * the process exists; a line from the app itself, carrying its pid, is the app proving it
 * by writing. Either is enough to call the launch witnessed — but only the second one has
 * a pid in it, and a pid is what later lets a caller ask about that process.
 *
 * @param {string} text - the console text so far.
 * @param {string|null} processName - the app's process name.
 * @returns {{launched: boolean, pid: number|null, evidence: string|null}} what was found.
 */
export function modernLaunchWitness(text, processName) {
  const body = String(text ?? '')
  const pattern = appLinePattern(processName)
  if (pattern !== null) {
    const match = pattern.exec(body)
    if (match !== null) {
      const pid = Number.parseInt(match[1], 10)
      return {
        launched: true,
        pid: Number.isSafeInteger(pid) ? pid : null,
        evidence: `the app logged from pid ${match[1]}`,
      }
    }
  }
  if (LAUNCHED_LINE.test(body)) {
    return { launched: true, pid: null, evidence: 'devicectl reported the app launched' }
  }
  return { launched: false, pid: null, evidence: null }
}
