/**
 * Why an attach failed, and what can actually be done about it.
 *
 * Two failures look identical from the outside and have opposite remedies:
 *
 * - the app is fine, but the run that launched it still holds its console session, so a second
 *   debugger is turned away — stop that run, or take the app over;
 * - the app refuses debuggers outright, with `ptrace(PT_DENY_ATTACH)` or a check of its own —
 *   nothing can be done from here, and **taking it over cannot help either**, because the guard
 *   turns away the debugger that launches it just as firmly.
 *
 * Both were once offered as the same three suggestions, which is how a message came to say "this
 * app cannot be attached to at all" and "pass mode=launch to take it over" in the same breath. The
 * measured difference is silence: a slow attach says something eventually (a known-good app
 * attached in 8.5 s), while a refused one says nothing at all for as long as you wait (46 s, and
 * again 90 s on a build of 蜜语-Dev).
 *
 * @param {{note: string, quiet: boolean, kind: string, heldByRun: boolean, pid: number|null, name: string, released?: boolean}} failure
 *   `released` says the stuck debugger has already been ended by the time this is composed, which
 *   is the difference between "try again" being hopeful advice and being true.
 * @returns {{refused: boolean, note: string, remedies: string[]}}
 */
/**
 * Said only when the debugger that was holding the device has already been ended. Without it "try
 * again" is wishful: the same stuck child would be waiting, which is how a working route looked
 * broken for an hour.
 */
const RELEASED = ' The debugger that was holding the device has been ended, so a retry has a free '
  + 'device: attach again, and it should stop the app this time'

export function attachFailure(failure) {
  const note = typeof failure?.note === 'string' ? failure.note : 'the app could not be attached to'
  const app = typeof failure?.name === 'string' && failure.name !== '' ? failure.name : 'the app'
  const refused = failure?.quiet === true && failure?.kind === 'device' && failure?.pid !== null
  if (refused) {
    return {
      refused: true,
      note: `${note}. LLDB said nothing at all, which is what an app that refuses a debugger looks `
        + `like: a build with an anti-debugging guard (ptrace PT_DENY_ATTACH, or a check of its own) `
        + `cannot be attached to at all — and taking it over with mode=launch cannot help either, `
        + `because the guard turns away the debugger that launches it just as firmly. Read the tree `
        + `by a route that needs no debugger: Lookin inside the app, or the app logging its own `
        + `hierarchy. ${app} is not the plugin failing to read it`
        + (failure?.released === true ? RELEASED : ''),
      // Ordered by what actually works. Takeover is deliberately absent.
      remedies: [
        'build without the guard, and debug that build',
        'read the tree from inside the app: LookinServer, or a debug-only hook that logs recursiveDescription',
      ],
    }
  }
  const held = failure?.heldByRun === true && failure?.kind === 'device'
  const released = failure?.released === true ? RELEASED : ''
  return {
    refused: false,
    note: (held
      ? `${note}. The run that launched this app still holds it: its console session (ios-deploy) is `
        + `attached, so a second debugger can fail to inspect it. Stop that run, or pass mode=launch to `
        + `take the app over instead`
      : note) + released,
    remedies: held ? ['stop the run that holds it', 'pass mode=launch to take the app over'] : [],
  }
}
