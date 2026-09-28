/**
 * What an attached launch's console says about the app that was launched.
 *
 * This module exists for one bug: an app that died on the phone settled as a
 * GREEN run. The launch is an attached session — `ios-deploy --noninteractive`
 * on iOS 16 and earlier, `devicectl device process launch --console` on newer
 * devices — and when the session ended, the only question asked was "did the
 * app ever come up?". A crash and the user quitting the app are the same answer
 * to that question, so both read as success, with a note still claiming the app
 * was up. The panel's status contradicted the phone.
 *
 * The evidence was already arriving. A noninteractive `ios-deploy` session
 * prints machine-readable outcomes from `autoexit_command` — `PROCESS_CRASHED`,
 * `PROCESS_STOPPED`, `PROCESS_NOT_STARTED`, `PROCESS_EXITED`, `PROCESS_DETACHED`
 * — with the stack trace under the bad ones, and an app that dies prints its own
 * verdict on stderr (`*** Terminating app due to uncaught exception …`,
 * `Fatal error: …`) on both channels. What was missing was a reader.
 *
 * Two rules keep the reader honest:
 *
 * - **Presence decides, silence never does.** A console that says nothing about
 *   the app's end yields `null`, which the caller reads as "no evidence", not as
 *   "it died". A phone that is unplugged, a session that is killed, an app the
 *   system suspended: none of them are a crash, and none of them may be called
 *   one.
 * - **The strongest evidence wins.** A crash dump is often followed by
 *   `PROCESS_EXITED` (`autoexit_command` reports whichever it saw last), so a
 *   crash may never be downgraded by a later, quieter line.
 *
 * @module dsh-xcodebuild/app-death
 */

/**
 * The outcomes an attached session can report for the app.
 *
 * `crashed`, `stopped` and `not-started` are deaths: the app is gone, and it went
 * badly. `exited` is the app ending on its own terms — the user quit it, or it
 * finished — and `detached` is the debugger letting go, which says nothing about
 * the app at all.
 */
export const DEATH_OUTCOMES = ['crashed', 'stopped', 'not-started', 'exited', 'detached']

/** The outcomes that mean the app died rather than ended. */
const DIED = new Set(['crashed', 'stopped', 'not-started'])

/**
 * The `autoexit_command` markers ios-deploy prints, exactly as it prints them.
 *
 * Matched as the WHOLE line, like `consoleLineKind` does, because these words are
 * also ordinary prose: an app logging "PROCESS_CRASHED because of reasons" is
 * telling its own story, not reporting its death.
 *
 * What each one means is not a guess — it is ios-deploy 1.12.2's own generated lldb
 * script (`autoexit_command`, the loop printed into the script it runs), read out of
 * the installed binary:
 *
 * - `PROCESS_EXITED` on `eStateExited`, then `os._exit(process.GetExitStatus())`.
 * - `PROCESS_STOPPED` on `eStateStopped` **whose selected thread has a stop reason**,
 *   with a stack trace and `os._exit(<crash code>)`. Stops with `eStopReasonNone` are
 *   skipped on purpose ("during startup there are some stops for lldb to setup
 *   properly; on iOS-16 we receive them with stop reason none"), which is what keeps
 *   an app the system merely suspended out of this set: a suspension arrives with no
 *   reason, a kill arrives with a signal.
 * - `PROCESS_CRASHED` on `eStateCrashed`, `PROCESS_NOT_STARTED` when the launch itself
 *   failed, `PROCESS_DETACHED` on `eStateDetached`.
 *
 * So the four it exits the crash code for are the four this module calls deaths, and
 * `detached` is the one it exits that code for anyway — the debugger letting go says
 * nothing about the app, so it is not read as one.
 */
const MARKERS = new Map([
  ['PROCESS_CRASHED', 'crashed'],
  ['PROCESS_STOPPED', 'stopped'],
  ['PROCESS_NOT_STARTED', 'not-started'],
  ['PROCESS_EXITED', 'exited'],
  ['PROCESS_DETACHED', 'detached'],
])

/**
 * What the app itself prints on the way out, on either channel.
 *
 * These are runtime verdicts rather than words that might appear in a log line:
 * ObjC's uncaught-exception banner, the Swift runtime's fatal errors, libc++abi
 * unwinding, a C assertion, and dyld refusing to bind. Each one means the process
 * is terminating, so each is a crash even when no life-cycle marker follows.
 */
const SIGNATURES = [
  /^\*\*\* Terminating app due to uncaught exception/,
  /^\*\*\* Terminating due to uncaught exception/,
  /^Fatal error: /,
  /^Swift runtime failure: /,
  /^libc\+\+abi(\.dylib)?: terminating/,
  /^Assertion failed: /,
  /^dyld(\[\d+\])?: (Symbol not found|Library not loaded)/,
]

/**
 * A debugger stopping the app somewhere it cannot continue.
 *
 * `stop reason = EXC_BAD_ACCESS …` is a crash — and it arrives on the frame line
 * that follows `Process 29303 stopped`, not on that line itself. `stop reason =
 * breakpoint 1.1` is the app doing exactly what the developer asked, so treating a
 * stop as a death would fail every run that hits a breakpoint.
 */
const STOP_REASON = /\bstop reason = (EXC_|signal SIG)/

/** How many characters of the offending line a note carries. */
const EVIDENCE_CAP = 200

/**
 * What one line of an attached session's console says about the app.
 *
 * @param {string} line - one line, from either channel.
 * @returns {string|null} an outcome from {@link DEATH_OUTCOMES}, or null when the
 *   line says nothing about the app's life.
 */
export function appOutcomeOfLine(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  if (text === '') return null
  const marker = MARKERS.get(text)
  if (marker !== undefined) return marker
  if (STOP_REASON.test(text)) return 'crashed'
  for (const pattern of SIGNATURES) {
    if (pattern.test(text)) return 'crashed'
  }
  return null
}

/**
 * How the app ended, read from everything a session printed.
 *
 * @param {string} text - the console's whole tapped text.
 * @returns {{outcome: string, evidence: string, line: number}|null} the verdict, or
 *   null when nothing in the console says the app ended.
 */
export function appOutcomeOfSession(text) {
  const lines = String(text ?? '').split('\n')
  let found = null
  for (let index = 0; index < lines.length; index += 1) {
    const outcome = appOutcomeOfLine(lines[index])
    if (outcome === null) continue
    const candidate = {
      outcome,
      evidence: lines[index].trim().slice(0, EVIDENCE_CAP),
      line: index + 1,
      // Carried rather than left to each caller: "is this the app dying or the app
      // ending" is the one question every consumer asks, and two copies of the answer
      // would eventually disagree.
      fatal: DIED.has(outcome),
    }
    // A death outranks everything already seen, and nothing outranks a death.
    if (found === null || (DIED.has(outcome) && !DIED.has(found.outcome))) found = candidate
  }
  return found
}

/**
 * Whether an outcome means the app died rather than ended.
 *
 * @param {string|null} outcome - an outcome from {@link DEATH_OUTCOMES}.
 * @returns {boolean} true when the app is gone and it went badly.
 */
export function isDeath(outcome) {
  return outcome !== null && DIED.has(outcome)
}

/**
 * How to say an outcome in a sentence.
 *
 * @param {string} outcome - an outcome from {@link DEATH_OUTCOMES}.
 * @returns {string} the phrase, without a leading "the app".
 */
export function outcomePhrase(outcome) {
  if (outcome === 'crashed') return 'crashed'
  if (outcome === 'stopped') return 'was stopped by a signal'
  if (outcome === 'not-started') return 'never started'
  if (outcome === 'exited') return 'exited'
  if (outcome === 'detached') return 'was left by the debugger'
  return 'ended'
}
