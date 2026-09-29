/**
 * Which lldb to run.
 *
 * The plugin used to run `xcrun lldb` and nothing else, and that is not a debugger you can rely on:
 * `xcrun` follows `xcode-select`, and when that points at the Command Line Tools the lldb it finds
 * has no iOS device support at all — it starts, cannot do the one thing it was asked for, and exits.
 * The session then reads `lldb exited (status dead)` and the whole route looks broken while a
 * perfectly good debugger — the one inside Xcode.app — sits untouched on the same disk.
 *
 * So candidates are listed and then TRIED, best first, because what is installed and what works are
 * different questions: an lldb can be present and still fail to start (a stale Xcode, a broken
 * `xcode-select` path, a quarantined copy). The first one that answers `--version` is the one that
 * gets used, and the rest are kept in the answer so a failure can say what was tried.
 *
 * Pure decisions over strings; the host supplies the facts and the runner, so this is testable
 * without an Xcode installation.
 */

/** The version out of `lldb --version` output, or ''. */
export function lldbVersion(text) {
  const match = /(lldb-[\d.]+)/.exec(String(text ?? ''))
  return match === null ? '' : match[1]
}

/**
 * The lldb commands on this machine, best first.
 *
 * @param {{developerDir?: string, xcodes?: string[]}} facts - `xcode-select -p`, and the
 *   `/Applications/Xcode*.app` paths that exist.
 * @returns {Array<{argv: string[], label: string, deviceCapable: boolean}>}
 */
export function lldbCandidates(facts) {
  const developerDir = typeof facts?.developerDir === 'string' ? facts.developerDir.replace(/\/$/, '') : ''
  const xcodes = (Array.isArray(facts?.xcodes) ? facts.xcodes : [])
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/\/$/, ''))
  // The Command Line Tools' lldb is a real lldb and cannot debug an iOS device: it is offered last,
  // and labelled, rather than hidden — a simulator-only session is still better than none.
  const tools = developerDir.includes('CommandLineTools')
  const out = []
  const add = (argv, label, deviceCapable) => {
    const key = argv.join(' ')
    if (out.some((entry) => entry.argv.join(' ') === key)) return
    out.push({ argv, label, deviceCapable })
  }
  for (const app of xcodes) add([`${app}/Contents/Developer/usr/bin/lldb`], `Xcode's own lldb (${app})`, true)
  if (!tools && developerDir !== '') add([`${developerDir}/usr/bin/lldb`], `lldb from ${developerDir}`, true)
  add(['xcrun', 'lldb'], tools ? 'xcrun lldb (Command Line Tools — simulators only)' : 'xcrun lldb', !tools)
  if (tools) add([`${developerDir}/usr/bin/lldb`], 'the Command Line Tools lldb (simulators only)', false)
  return out
}

/**
 * The first candidate that actually runs.
 *
 * @param {{run: (argv: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>,
 *   candidates: Array<object>, deviceCapableOnly?: boolean}} options
 * @returns {Promise<{argv: string[], label: string, version: string, tried: Array<{label: string, why: string}>}|null>}
 */
export async function chooseLldb(options) {
  const run = options?.run
  if (typeof run !== 'function') throw new TypeError('chooseLldb needs a runner')
  const all = Array.isArray(options?.candidates) ? options.candidates : []
  const candidates = options?.deviceCapableOnly === true
    ? all.filter((entry) => entry.deviceCapable !== false)
    : all
  const tried = []
  for (const candidate of candidates) {
    let answer
    try {
      answer = await run([...candidate.argv, '--version'])
    } catch (error) {
      tried.push({ label: candidate.label, why: error instanceof Error ? error.message : String(error) })
      continue
    }
    const text = `${answer?.stdout ?? ''}${answer?.stderr ?? ''}`
    const version = lldbVersion(text)
    if (answer?.ok === true && version !== '') {
      return { argv: candidate.argv, label: candidate.label, version, tried }
    }
    const why = text.trim().split('\n')[0] ?? ''
    tried.push({ label: candidate.label, why: why === '' ? 'it did not answer' : why.slice(0, 120) })
  }
  return null
}

/** One sentence naming what was used, or what was tried and failed. */
export function describeLldbChoice(choice) {
  if (choice === null || choice === undefined) return 'no usable lldb was found'
  const used = `${choice.label} (${choice.version})`
  if (choice.tried.length === 0) return `using ${used}`
  const failed = choice.tried.map((entry) => `${entry.label}: ${entry.why}`).join('; ')
  return `using ${used}, after ${failed}`
}
