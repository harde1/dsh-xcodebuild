/**
 * Debuggers left over from an earlier attempt, still holding the device.
 *
 * A failed attach does not always take its processes with it. What is left is an `lldb` and — this is
 * the one that is easy to miss — the CoreDevice helper it caused to launch
 * (`.../CoreDevice.framework/.../bin/device`), which owns the channel to the phone. Both keep the
 * device busy, so the next attempt does not fail with anything useful: it fails at the first step,
 * `device select <udid>: no answer within 30000 ms`, with no hint that the cause is a process the
 * plugin itself left behind three minutes ago.
 *
 * Only processes belonging to THIS plugin are candidates. Xcode and devicectl run the same two
 * programs, and killing theirs would break someone else's debugging session to fix ours.
 *
 * Pure: takes `ps` output and the plugin's own pid, so the rule is testable without a device.
 */

/**
 * @param {string} text - `ps -ax -o pid=,ppid=,command=`
 * @returns {Array<{pid: number, ppid: number, command: string}>}
 */
export function parseProcessTable(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (match === null) continue
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return out
}

/** Whether a command is a debugger or the device helper a debugger launches. */
export function isDebuggerProcess(command) {
  const text = String(command ?? '')
  if (/(^|\/)usr\/bin\/lldb(\s|$)/.test(text)) return 'lldb'
  if (/CoreDevice\.framework\/.*\/bin\/device(\s|$)/.test(text)) return 'device-helper'
  return ''
}

/**
 * The debugger processes this plugin left behind: its own descendants, inside our process tree.
 *
 * @param {Array<{pid: number, ppid: number, command: string}>} processes
 * @param {number} ownPid - the plugin host's pid; only its descendants count.
 * @returns {Array<{pid: number, kind: string, command: string}>}
 */
export function stuckDebuggers(processes, ownPid) {
  // pid 1 is the ancestor of everything on the machine, so "our descendants" would mean "everyone's"
  // and a leftover from another tool would be killed to fix ours. Refuse rather than guess.
  if (!Number.isInteger(ownPid) || ownPid <= 1) return []
  const mine = new Set([ownPid])
  // One pass is enough because `ps` lists parents before children, and a second pass settles any
  // ordering surprise: a child whose parent joined the set later still gets caught.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const entry of processes) if (mine.has(entry.ppid)) mine.add(entry.pid)
  }
  const out = []
  for (const entry of processes) {
    const kind = isDebuggerProcess(entry.command)
    if (kind === '' || entry.pid === ownPid || !mine.has(entry.pid)) continue
    out.push({ pid: entry.pid, kind, command: entry.command.slice(0, 200) })
  }
  return out
}

/** One sentence for a user, or '' when there is nothing to say. */
export function describeStuckDebuggers(found) {
  if (!Array.isArray(found) || found.length === 0) return ''
  const kinds = found.map((entry) => (entry.kind === 'lldb' ? 'an lldb' : 'a CoreDevice helper'))
  const unique = [...new Set(kinds)]
  return `${unique.join(' and ')} from an earlier attempt ${found.length === 1 ? 'was' : 'were'} still `
    + 'holding the device; it has been ended'
}
