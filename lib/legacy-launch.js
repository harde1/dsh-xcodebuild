/**
 * The classic-channel launch verdict (iOS 16 and earlier).
 *
 * An iOS 16 device is absent from CoreDevice entirely, so `run` installs with
 * `ideviceinstaller` and launches with `ios-deploy --justlaunch`. This module
 * decides whether that launch happened, because the tool's own output cannot be
 * read at face value.
 *
 * **What went wrong.** The launch used to be judged by looking for a line that
 * says exactly `success`:
 *
 * ```js
 * if (exitCode !== 0 && !/^success$/m.test(stdout)) throw …
 * ```
 *
 * That line is not an ios-deploy signal at all. `--justlaunch` makes ios-deploy
 * drive lldb through its own generated command script, whose `run` command ends
 * with:
 *
 * ```python
 * debugger.GetSelectedTarget().Launch(launchInfo, startup_error)
 * ...
 * else: print(str(startup_error))       # ← prints the literal "success"
 * ```
 *
 * LLDB's `SBError` stringifies to `success` whenever the call reported no error,
 * so the line appears the moment `Launch()` *returns* — before the process is
 * known to be alive. What actually decides the outcome is the next command,
 * `safequit`:
 *
 * ```python
 * if   state == lldb.eStateRunning: process.Detach(); os._exit(0)
 * elif state >  lldb.eStateRunning: os._exit(state)
 * else: print('\nApplication has not been launched\n'); os._exit(1)
 * ```
 *
 * On the iPhone X (iPhone10,3, iOS 16.7.12) that exposed this, the observed run
 * is: `(lldb) run` → `success` → `(lldb) safequit` → **nothing**, exit **1**. So
 * the process was never in `eStateRunning`, and the message naming that is
 * written but never arrives — Python block-buffers stdout when it is a pipe and
 * `os._exit` discards the buffer:
 *
 * ```console
 * $ python3 -c "print('Application has not been launched'); import os; os._exit(1)" | cat
 * $ echo $?
 * 1                       # zero bytes captured
 * ```
 *
 * The old `&&` test let the `success` line veto that non-zero exit, so every
 * iPhone X run ended as `succeeded` with `artifact.pid === null` and no app on
 * the device.
 *
 * **What decides it here.** The exit code, which is `safequit`'s own verdict: it
 * exits 0 only after detaching a process it saw running, and non-zero otherwise.
 * The output is used only to name a cause that is more specific than a number.
 *
 * **What does not decide it.** The process id, deliberately. A live pid is
 * positive proof and short-circuits to success, but an ABSENT pid proves nothing:
 * `ios-deploy --get_pid` answers with nothing for `com.apple.springboard` on this
 * very device, so treating silence as failure would turn every real launch into a
 * false negative — worse than the bug being fixed. The probe is still worth
 * running, because it is the `pid > 0` evidence the ios-dev-test skill asks of
 * 拉起 and it lands in `artifact.pid`, but it corroborates; it does not veto.
 *
 * @module dsh-xcodebuild/legacy-launch
 */

/** Lines of ios-deploy output a failure message carries. */
const TAIL_LINES = 12

function tailOf(text, lines) {
  const parts = String(text ?? '').split('\n')
  return parts.slice(Math.max(0, parts.length - lines)).join('\n').trim()
}

/**
 * The process id ios-deploy reports, or null when it reports none.
 *
 * `--get_pid` prints `pid: 1234` for an app it can see. It prints nothing for an
 * app it cannot — including ones that are certainly running — so null means
 * "unknown", never "dead".
 *
 * @param {string} text - `ios-deploy --get_pid --bundle_id <id>` output.
 * @returns {number|null} the pid, or null.
 */
export function parseLaunchedPid(text) {
  const match = /\bpid\b\W{0,4}(\d{1,7})/i.exec(String(text ?? ''))
  if (match === null) return null
  const pid = Number.parseInt(match[1], 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Is this a positive, usable process id?
 * @param {unknown} value - candidate.
 * @returns {boolean} true when it names a live process.
 */
function isPid(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Why a classic-channel launch did not put the app on the device, or null when
 * it did.
 *
 * @param {{timedOut?: boolean, exitCode?: number|null, output?: string, pid?: number|null}} facts
 *   what the launch and the liveness probe observed.
 * @returns {string|null} a sentence naming the cause, or null for a real launch.
 */
export function legacyLaunchFailure(facts) {
  const output = String(facts?.output ?? '')
  const tail = tailOf(output, TAIL_LINES)
  const withTail = tail === '' ? '(ios-deploy printed nothing)' : `ios-deploy's last output:\n${tail}`

  // A launch that never returned is a failure even if a pid was seen on the way:
  // `captureTee` settles it with SIGKILL, and killing the process that holds the
  // debug session takes the debugged app down with it. Reporting `succeeded`
  // there is how a five-minute hang came to look like a clean run.
  if (facts?.timedOut === true) {
    return `ios-deploy never returned and was killed after the timeout, so the debug session — `
      + `and the app in it — was torn down. ${withTail}`
  }

  // The only claim strong enough to end the question, when the device makes it.
  if (isPid(facts?.pid)) return null

  if (/Device Locked|FBSOpenApplicationErrorDomain/i.test(output)) {
    return 'the device is locked: ios-deploy said "Device Locked". Unlock the device and run again'
  }
  if (output.includes('Application has not been launched')) {
    return `lldb never got the app running (ios-deploy printed "Application has not been launched", `
      + `exit ${String(facts?.exitCode ?? '?')})`
  }

  const exitCode = facts?.exitCode
  if (typeof exitCode === 'number' && exitCode !== 0) {
    // The `success` line above this exit is noise; see the module comment. The
    // 254 in the locked case and the state number in the crashed case both land
    // here too, so the message keeps the raw tail.
    return `ios-deploy exited ${exitCode}, which under --justlaunch is lldb's own verdict: it detaches a `
      + `running app and exits 0, and reports anything else here. safequit's explanatory line is lost to `
      + `Python's stdout buffer, so the log simply stops. On this generation the launch step has no reliable `
      + `programmatic path — unlocking the device and tapping the app is the practical fallback. `
      + `The pid probe reported nothing, which on this toolchain is not proof either way. ${withTail}`
  }
  // Exit 0 is safequit saying it detached a running process. The probe's silence
  // must not be allowed to overrule the tool that actually did the launching.
  return null
}
