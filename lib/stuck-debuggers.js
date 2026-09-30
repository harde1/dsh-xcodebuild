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

/**
 * Who a debugger belongs to, named the way a person would name it.
 *
 * `ps` gives a path, not an owner: Xcode's debugger is
 * `/Applications/Xcode.app/Contents/Developer/usr/bin/lldb`, whose parent is
 * `/Applications/Xcode.app/Contents/MacOS/Xcode`. Naming the parent is what turns "another debugger
 * has it" into "Xcode has it", which is the sentence a user can act on without guessing.
 *
 * @param {Array<{pid: number, ppid: number, command: string}>} processes - the whole table.
 * @param {{ppid: number}} entry - the debugger in question.
 * @returns {string} `Xcode`, the parent program's name, or '' when the parent is gone.
 */
export function debuggerOwner(processes, entry) {
  const parent = processes.find((candidate) => candidate.pid === entry.ppid) ?? null
  if (parent === null) return ''
  if (/Xcode\.app\/Contents\/MacOS\/Xcode(\s|$)/.test(parent.command)) return 'Xcode'
  const name = String(parent.command).trim().split('/').pop() ?? ''
  return name === '' ? '' : name
}

/**
 * Debuggers running on this Mac that are NOT this plugin's, so they can be named as the reason an
 * attach was refused.
 *
 * The device says `tried to attach to process already being debugged`, and only the Mac can say by
 * whom: on iOS exactly one debugger can own a process, so the answer to "why was I refused" is a
 * process on this machine. Nothing is killed here — Xcode's session is someone's work, and the point
 * is to say its name, not to take it.
 *
 * @param {Array<{pid: number, ppid: number, command: string}>} processes
 * @param {number} ownPid - the plugin host's pid; its own tree is excluded.
 * @returns {Array<{pid: number, kind: string, owner: string}>}
 */
export function foreignDebuggers(processes, ownPid) {
  const mine = new Set()
  if (Number.isInteger(ownPid) && ownPid > 1) {
    mine.add(ownPid)
    for (let pass = 0; pass < 2; pass += 1) {
      for (const entry of processes) if (mine.has(entry.ppid)) mine.add(entry.pid)
    }
  }
  const out = []
  for (const entry of processes) {
    const kind = isDebuggerProcess(entry.command)
    if (kind === '' || mine.has(entry.pid)) continue
    out.push({ pid: entry.pid, kind, owner: debuggerOwner(processes, entry) })
  }
  return out
}

/** One sentence naming who is holding the app, or '' when nobody is. */
export function describeForeignDebuggers(found) {
  if (!Array.isArray(found) || found.length === 0) return ''
  const owners = [...new Set(found.map((entry) => entry.owner === '' ? 'another debugger' : entry.owner))]
  const who = owners.length === 1 ? owners[0] : `${owners.slice(0, -1).join(', ')} and ${owners[owners.length - 1]}`
  const lldb = found.filter((entry) => entry.kind === 'lldb')
  const pids = lldb.map((entry) => entry.pid)
  return `${who} is holding an app on this Mac right now (lldb pid ${pids.length === 0 ? found[0].pid : pids.join(', ')})`
}
