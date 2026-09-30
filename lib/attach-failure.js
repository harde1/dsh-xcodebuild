/**
 * Why an attach failed, and what can actually be done about it.
 *
 * This used to diagnose silence as an anti-debugging guard, and that diagnosis was wrong for the
 * very app it was written about. 蜜语-Dev imports no `ptrace`, is signed `get-task-allow = true`
 * with a Team Provisioning profile, and the phone reported Developer Mode enabled, DDI services
 * available, paired, tunnel connected. What looked like silence was the plugin not listening: a
 * device attach returns at once and its outcome arrives asynchronously, after the command's own
 * output slice had closed, so LLDB's answer was never read. Measured by hand on the same phone:
 * lldb answered within 3 s — `error: attach failed: no such process` (debugserver `E96`).
 *
 * So this module no longer guesses at causes it cannot see. It reports what LLDB printed, names
 * the one condition that is known to be real (a run's console session still attached, verified by
 * the caller), and when LLDB truly printed nothing it says exactly that and no more.
 *
 * @param {{note: string, quiet: boolean, kind: string, heldByRun: boolean, pid: number|null,
 *   name: string, released?: boolean, stuck?: string}} failure
 *   `released` says the debugger has already been ended by the time this is composed, which is
 *   the difference between "try again" being hopeful advice and being true.
 * @returns {{refused: boolean, note: string, remedies: string[]}}
 */

/** Said only when the debugger this attempt started has already been ended. */
const RELEASED = ' The debugger this attempt started has been ended, so the app is not left frozen and '
  + 'the device is free for the next try'

/**
 * `no such process` is debugserver's `E96`, and it is misleading on its face: the process is
 * usually there — `device process list` showed it under the same pid. It means the debugserver on
 * the phone would not take that pid, which is decided on the device, not by this plugin.
 */
const NO_SUCH_PROCESS = /no such process/i

/**
 * The device's own words for a second debugger asking for an app that already has one. Measured on
 * 蜜语-Dev: `Process 1243 exited with status = -1 (0xffffffff) tried to attach to process already
 * being debugged`, while `ps -o pid,ppid,command` showed `/Applications/Xcode.app/Contents/Developer/
 * usr/bin/lldb` with Xcode as its parent — Xcode was holding the app. On iOS only one debugger can
 * own a process, and no plugin can share it, so this is not a defect to retry around: the other
 * session has to let go first, and the app itself is fine.
 */
const ALREADY_DEBUGGED = /already being debugged|being debugged/i

export function attachFailure(failure) {
  const note = typeof failure?.note === 'string' && failure.note !== '' ? failure.note : 'the app could not be attached to'
  const app = typeof failure?.name === 'string' && failure.name !== '' ? failure.name : 'the app'
  const released = failure?.released === true ? RELEASED : ''
  const stuck = typeof failure?.stuck === 'string' && failure.stuck !== '' ? ` ${failure.stuck}.` : ''
  const held = failure?.heldByRun === true && failure?.kind === 'device'

  if (held) {
    return {
      refused: false,
      note: `${note}. The run that launched this app still holds it: its console session (ios-deploy) is `
        + 'attached, so a second debugger can fail to inspect it. Stop that run, or pass mode=launch to '
        + `take the app over instead.${stuck}${released}`,
      remedies: ['stop the run that holds it', 'pass mode=launch to take the app over'],
    }
  }

  if (failure?.kind === 'device' && ALREADY_DEBUGGED.test(note)) {
    return {
      refused: false,
      note: `${note}. Another debugger already owns ${app} — on iOS exactly one can, and the device `
        + 'refused a second. Xcode is the usual one: stop its session with ⌘. and the app keeps '
        + `running, so attach again without rebuilding or relaunching anything.${stuck}${released}`,
      remedies: [
        'stop the debug session in Xcode (⌘.), then attach again',
        'or relaunch the app from the phone itself, so no debugger owns it',
      ],
    }
  }

  if (failure?.kind === 'device' && NO_SUCH_PROCESS.test(note)) {
    return {
      refused: false,
      note: `${note}. The phone's debugserver would not take ${app}'s process even though it is `
        + 'running — the refusal comes from the device, and this plugin only relays it. Relaunching '
        + `the app under the debugger (mode=launch) gives it a fresh process to attach to.${stuck}${released}`,
      remedies: ['pass mode=launch to relaunch the app under the debugger', 'check the same attach from Xcode: Debug → Attach to Process'],
    }
  }

  if (failure?.quiet === true) {
    // Silence has two causes that are told apart by ONE test, and guessing between them is how this
    // note came to assert an anti-debugging guard, then to deny one, for the same app. An app that
    // refuses debuggers answers nothing, ever; so does a device whose debug channel is wedged, and
    // measured here, `devicectl device info` kept answering in 2 s while `device process launch` and
    // `device process attach` both never returned. The test is a second opinion from Xcode.
    return {
      refused: false,
      note: `${note}. Not one line came back for the whole wait. Two causes look exactly like this `
        + 'from here and only one test separates them — attach the same app from Xcode '
        + `(Debug → Attach to Process → ${app}): if Xcode attaches, the app is turning debuggers away `
        + 'and its debugger guard has to be off in this build; if Xcode cannot attach either, the '
        + `device's debug channel is wedged, and quitting Xcode and replugging the device clears it.`
        + `${stuck}${released}`,
      remedies: [
        `attach ${app} from Xcode (Debug → Attach to Process) to tell an app-side guard from a wedged device`,
        'quit Xcode and replug the device, then retry',
        'take the tree by a route that needs no debugger if the app does carry a guard',
      ],
    }
  }

  return { refused: false, note: `${note}${stuck ? `.${stuck}` : ''}${released}`, remedies: [] }
}
