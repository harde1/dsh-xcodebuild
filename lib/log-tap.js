// The reader half of an attached launch.
//
// `--justlaunch` cannot be used for a Build & Run: it implies `--debug`, makes the
// attached path unreachable, runs lldb's `run`, and then `safequit` detaches — which
// on a real iPhone X interrupts the app it just started. An attached
// `--noninteractive` session is the shape that keeps the app up, but it never
// returns while the app lives, so the run cannot await it.
//
// So the launch is spawned in the background with its console redirected to a file,
// and THIS is the separate reader that pulls that file into the panel. Two things
// follow from reading a file instead of a pipe: the bytes stay on disk after the
// session ends, and the reader has to cope with a file that grows while it is being
// read — a partial line at the end, a multi-byte character split across two reads,
// and a file that shrank because something truncated it.
//
// The offset arithmetic and line assembly live here, away from the polling, so both
// can be pinned by a test.

/** How much of a line is kept. A console line longer than this is cut, not buffered forever. */
export const MAX_TAPPED_LINE = 8000

/**
 * Complete lines from what a growing file has given so far.
 *
 * The trailing fragment is carried, not emitted: half a line is not a line, and
 * printing it early would show a line that then changes under the user. The caller
 * passes the carry back on the next read, and flushes it when the writer is gone.
 *
 * @param {string} text - newly decoded text.
 * @param {string} [carry] - the fragment left over from the previous read.
 * @returns {{lines: string[], carry: string}} complete lines, and the new fragment.
 */
export function takeLines(text, carry = '') {
  const joined = carry + (typeof text === 'string' ? text : '')
  if (joined === '') return { lines: [], carry: '' }
  const parts = joined.split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  // A very long line with no newline in sight must not grow without bound.
  return { lines, carry: rest.length > MAX_TAPPED_LINE ? rest.slice(rest.length - MAX_TAPPED_LINE) : rest }
}

/**
 * Where to read from, given what the file looked like before and now.
 *
 * A file that shrank was truncated or replaced — `> file` rather than `>> file`, a
 * log rotator, or a fresh run reusing the path. Reading on from the old offset would
 * skip the beginning of the new content, so the reader starts again.
 *
 * @param {number} offset - bytes already consumed.
 * @param {number} size - the file's current size in bytes.
 * @returns {{offset: number, reset: boolean}} the offset to read from, and whether the file restarted.
 */
export function nextReadOffset(offset, size) {
  const safe = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const total = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
  if (total < safe) return { offset: 0, reset: true }
  return { offset: safe, reset: false }
}

/**
 * What to flush when the writer is gone.
 *
 * A last line without its newline — `success`, a stack trace, a prompt — is real
 * output that would otherwise stay in the carry forever.
 *
 * @param {string} carry - the fragment the last read left behind.
 * @returns {string|null} the line to emit, or null when there is nothing to say.
 */
export function flushCarry(carry) {
  if (typeof carry !== 'string' || carry === '') return null
  return carry.endsWith('\r') ? carry.slice(0, -1) : carry
}
