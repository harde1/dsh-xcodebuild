/**
 * The classic-channel launch verdict (iOS 16 and earlier).
 *
 * An iOS 16 device is absent from CoreDevice entirely, so `run` installs with
 * `ideviceinstaller` and launches with an ATTACHED `ios-deploy --noninteractive` session,
 * which is left in the background with its console redirected to a file. This module
 * decides what that session's ending means, because the tool's own output cannot be
 * read at face value.
 *
 * **What went wrong first.** The launch was judged by looking for a line that says
 * exactly `success`:
 *
 * ```js
 * if (exitCode !== 0 && !/^success$/m.test(stdout)) throw …
 * ```
 *
 * That line is not an ios-deploy signal at all. ios-deploy drives lldb through its
 * own generated command script, whose `run` command ends with:
 *
 * ```python
 * debugger.GetSelectedTarget().Launch(launchInfo, startup_error)
 * ...
 * else: print(str(startup_error))       # ← prints the literal "success"
 * ```
 *
 * LLDB's `SBError` stringifies to `success` whenever the call reported no error, so
 * the line appears the moment `Launch()` *returns* — before the process is known to
 * be alive. What actually decides the outcome is the next command, `safequit`:
 *
 * ```python
 * if   state == lldb.eStateRunning: process.Detach(); os._exit(0)
 * elif state >  lldb.eStateRunning: os._exit(state)
 * else: print('\nApplication has not been launched\n'); os._exit(1)
 * ```
 *
 * On the iPhone X (iPhone10,3, iOS 16.7.12) that exposed this, a `--justlaunch` run
 * is: `(lldb) run` → `success` → `(lldb) safequit` → **nothing**, exit **1**. The
 * process was never in `eStateRunning`, and the message naming that is written but
 * never arrives — Python block-buffers stdout when it is a pipe and `os._exit`
 * discards the buffer:
 *
 * ```console
 * $ python3 -c "print('Application has not been launched'); import os; os._exit(1)" | cat
 * $ echo $?
 * 1                       # zero bytes captured
 * ```
 *
 * The old `&&` test let the `success` line veto that non-zero exit, so every iPhone X
 * run ended as `succeeded` with no app on the device.
 *
 * **Why `--justlaunch` is gone entirely.** It implies `--debug`
 * (ios-deploy.m:3688-3692) and makes the attached path unreachable (:3400-3401): lldb
 * `run`s the app, `safequit` detaches, the CLI returns — and on the real device the
 * app is interrupted and closed as that happens. Measured on the iPhone X with
 * `Demo-Dev`:
 *
 * - `--justlaunch` returns after **~43s** with exit **1**, stdout ending
 *   `(lldb) run` → `success` → `(lldb) safequit`, and no new app log.
 * - An attached session (no `--justlaunch`) has the app at **~45s** — a new
 *   `Documents/PPCrashLog/log_<ts>.log`, and `idevicesyslog` shows it running. Both
 *   `--debug` and `--noninteractive` were measured to do this; `--noninteractive` is
 *   what ships, because it needs no stdin and reports the app's death itself.
 * - Killing that debugger ends the app: the log stops growing and syslog goes quiet.
 *
 * So an attached session is not a leftover: it is the only thing that keeps the app
 * up on this channel, and the run stays `running` for as long as it is attached.
 * `-O/--output` is still not passed, because that file is opened only by `autoexit`
 * (lldb.py:103-106, ios-deploy.m:1143-1156) and would be an inert flag pretending to
 * capture a console — the plugin redirects the child's own stdout and stderr to a
 * file instead, and reads it back with `lib/log-tap.js`.
 *
 * Killing an attached ios-deploy is therefore how Stop ends a session, and it is
 * deliberately a group kill: SIGTERM/SIGINT/SIGHUP fire `kill(0, SIGKILL)` at its own
 * process group (:1460-1464), which is why the child is spawned detached — its group
 * is the debug session, not this host.
 *
 * **What decides it here.** The app's own new log file is the launch witness: an
 * iOS 16 device writes `Documents/PPCrashLog/log_<timestamp>.log` as the process
 * starts, which is a device fact rather than anything the toolchain says, and it does
 * not depend on the toolchain answering a question at all. A session that ends before
 * that witness is what `legacyLaunchFailure` explains.
 *
 * The exit code is no longer a verdict on its own: an attached session that is
 * stopped, or whose app quits, exits non-zero for reasons that have nothing to do
 * with whether the launch happened. It is used only when the session died before the
 * witness appeared.
 *
 * **What does not decide it.** The process id, deliberately. `ios-deploy --get_pid`
 * answers with nothing for `com.apple.springboard` on this very device, so silence
 * would turn every real launch into a false negative — and, on this channel, asking
 * means starting a SECOND ios-deploy against a device whose debug session the
 * attached launch is already holding. The probe is not run at all while attached.
 * See `lib/legacy-applog.js` for the witness.
 *
 * @module dsh-xcodebuild/legacy-launch
 */

import { APP_LOG_DIR } from './legacy-applog.js'
import { syslogLineKind } from './syslog.js'

/** Lines of ios-deploy output a failure message carries. */
const TAIL_LINES = 12

function tailOf(text, lines) {
  const parts = String(text ?? '').split('\n')
  return parts.slice(Math.max(0, parts.length - lines)).join('\n').trim()
}

/**
 * What a line of an attached session's console is, when the text already says.
 *
 * A noninteractive session prints machine-readable lifecycle markers from
 * `autoexit_command` — `PROCESS_EXITED`, `PROCESS_CRASHED`, `PROCESS_STOPPED`,
 * `PROCESS_DETACHED`, `PROCESS_NOT_STARTED` — and the ones that mean the app died
 * should not read as ordinary prose in the panel: a crash is an error, and it
 * usually has a stack trace printed under it.
 *
 * @param {string} line - one line of ios-deploy's own output.
 * @returns {string|undefined} the panel kind, or undefined to let the text decide.
 */
export function consoleLineKind(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  if (text === 'PROCESS_CRASHED' || text === 'PROCESS_STOPPED' || text === 'PROCESS_NOT_STARTED') return 'error'
  if (text === 'PROCESS_EXITED' || text === 'PROCESS_DETACHED') return 'note'
  // The app's own lines come down this console on both channels, and they declare their
  // level twice over: `[W]`-style markers of its own, and — on the relay — the device's
  // `<Notice>:` token. Both spellings are read in one place, so a warning is a warning
  // whichever channel carried it.
  return syslogLineKind(text)
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
 * @param {{timedOut?: boolean, exitCode?: number|null, output?: string, pid?: number|null, appLogStarted?: boolean, locked?: boolean|null}} facts
 *   what the launch, the liveness probe, the app's own log, and the device's own
 *   lock report observed.
 * @returns {string|null} a sentence naming the cause, or null for a real launch.
 */
export function legacyLaunchFailure(facts) {
  const output = String(facts?.output ?? '')
  const tail = tailOf(output, TAIL_LINES)
  const withTail = tail === '' ? '(ios-deploy printed nothing)' : `ios-deploy's last output:\n${tail}`
  const noLaunchLog = facts?.appLogStarted === false
    ? ` No new file appeared in ${APP_LOG_DIR} either, which is the app's own record of a launch.`
    : ''

  // A launch that never returned is a failure even if a pid was seen on the way:
  // `captureTee` settles it with SIGKILL, and ios-deploy's SIGTERM/SIGKILL
  // handling fires `kill(0, SIGKILL)` at its own process group without ever
  // detaching (src/ios-deploy/ios-deploy.m:1460-1464) — so the debug session, and
  // with it the transport the app was launched through, is torn down rather than
  // left running. Reporting `succeeded` there is how a five-minute hang came to
  // look like a clean run.
  //
  // This is NOT the locked-device case, which is measured to return at ~43s with
  // exit 1 and lands in the branch below. `-L` disables ios-deploy's own
  // `-t/--timeout` (:3472-3476), so only the caller's cap bounds it, and against a
  // measured ~43s launch a timeout means the device or its debug session is stuck
  // rather than slow.
  if (facts?.timedOut === true) {
    return `ios-deploy never returned and was killed after the timeout: lldb's \`run\` never got far enough to `
      + `start the app. An attached session takes about 45s to bring one up on this device when it is working, so `
      + `a timeout is not the ordinary slow start — it is a device or a debug session that is stuck, which a `
      + `session another process still holds will do. Check that no ios-deploy or lldb is still attached, and `
      + `retry.${noLaunchLog} ${withTail}`
  }

  // Two claims are strong enough to end the question, when the device makes them:
  // a pid the tool actually saw, and the app's own log file for this launch.
  if (isPid(facts?.pid)) return null
  if (facts?.appLogStarted === true) return null

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
    //
    // A session that ends non-zero here ended BEFORE the app wrote its launch
    // witness, so it never got the app up — the caller only asks when there is no
    // witness. There is no `success` line to argue with: an attached session prints
    // lldb's own progress, and the interesting part is what the last lines say.
    //
    // The lock is reported only as the device itself reported it. `PasswordProtected`
    // is a real oracle — but the launch already stopped on `true` before getting
    // here, so `false` is what usually arrives, and it means "not asking for a
    // passcode", not "the screen is on".
    const lockSaid = facts?.locked === true
      ? ' The device reports PasswordProtected=true, so its screen is locked: unlock the iPhone and retry.'
      : facts?.locked === false
        ? ' The device reports PasswordProtected=false — no passcode is being asked for — so a lock screen is '
          + 'not the explanation here.'
        : ''
    return `the attached debug session exited ${exitCode} before the app wrote a launch log, so the app never `
      + `came up. lldb's own last words are below; a session another process still holds will also fail like `
      + `this, so check that no ios-deploy or lldb is already attached, then retry.${lockSaid}${noLaunchLog} ${withTail}`
  }
  // Exit 0 is safequit saying it detached a running process. The probe's silence
  // must not be allowed to overrule the tool that actually did the launching.
  return null
}
