/**
 * Fixed-capacity ring buffer for one xcodebuild run's log.
 *
 * Why this exists rather than a plain array: the obvious implementation evicts
 * with `lines.splice(0, lines.length - CAP)` once the cap is reached, which
 * shifts every retained element on every single line — O(n) per push, O(n^2)
 * per run. A large iOS build emits tens of thousands of lines, and the log
 * filter has to scan the whole retained window, so the cost lands exactly where
 * the plugin is supposed to be fast. Pushing here is O(1) amortised; the O(n)
 * cost is paid once per read, on the lines actually returned.
 *
 * Entries are addressed by an absolute, never-reused line number `n`, so a
 * reader can poll incrementally (`fromN`) even after eviction has moved the
 * window. Callers must treat `n` as the identity of a line.
 *
 * @module dsh-xcodebuild/ring
 */

/**
 * Create an empty ring.
 * @param {number} capacity - maximum retained entries; must be >= 1.
 * @returns {{capacity: number, buf: Array<unknown>, head: number, len: number, count: number}}
 */
export function createRing(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`createRing: capacity must be a positive integer, got ${String(capacity)}`)
  }
  return { capacity, buf: new Array(capacity), head: 0, len: 0, count: 0 }
}

/**
 * Append one value, evicting the oldest entry once the ring is full.
 * @param {ReturnType<typeof createRing>} ring - destination ring.
 * @param {unknown} value - entry to retain.
 */
export function ringPush(ring, value) {
  ring.buf[ring.head] = { n: ring.count, value }
  ring.head = (ring.head + 1) % ring.capacity
  if (ring.len < ring.capacity) ring.len += 1
  ring.count += 1
}

/**
 * Line number of the oldest retained entry; equals `count` when empty.
 * @param {ReturnType<typeof createRing>} ring - source ring.
 * @returns {number} absolute line number of the oldest retained entry.
 */
export function ringFirst(ring) {
  return ring.count - ring.len
}

/**
 * Retained entries in ascending line order.
 * @param {ReturnType<typeof createRing>} ring - source ring.
 * @param {number} [fromN] - lowest line number to return; lower values clamp to
 *   the oldest retained entry, higher values past the end yield an empty array.
 * @returns {Array<{n: number, value: unknown}>} ordered entries.
 */
export function ringSlice(ring, fromN) {
  const out = []
  const total = ring.count
  const len = ring.len
  if (len === 0) return out
  const oldest = total - len
  let n = typeof fromN === 'number' && fromN > oldest ? fromN : oldest
  for (; n < total; n++) {
    // `n`'s slot is `head` minus its distance from the newest entry, wrapped.
    // The extra `capacity` term keeps the operand positive before the modulo.
    const idx = (ring.head - (total - n) + ring.capacity * 2) % ring.capacity
    out.push(ring.buf[idx])
  }
  return out
}
