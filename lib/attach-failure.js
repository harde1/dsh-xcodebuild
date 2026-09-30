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
    return {
      refused: false,
      note: `${note}. Nothing was printed by LLDB for the whole wait, so there is no reason to report `
        + `beyond the timeout itself.${stuck}${released}`,
      remedies: ['pass mode=launch to relaunch the app under the debugger', 'check the same attach from Xcode: Debug → Attach to Process'],
    }
  }

  return { refused: false, note: `${note}${stuck ? `.${stuck}` : ''}${released}`, remedies: [] }
}
