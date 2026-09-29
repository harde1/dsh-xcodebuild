// Which process is the app, right now?
//
// `device process attach -n <name>` does not mean "attach to the process with this
// name" — it means "wait for a process with this name to appear", and it blocks
// LLDB's command interpreter while it waits. Measured: a View Hierarchy press for an
// app that was not running left `device process attach -n 蜜语-Dev` in the transcript
// with no answer at all, not even to the `process status` probe sent eight seconds
// later, because the probe was queued behind it. The drawer simply never filled in.
//
// So the pid is resolved FIRST, from a list of what is actually running, and the
// attach is by pid. A target that is not running becomes one sentence naming what is
// missing instead of a session that waits forever.
//
// Both lists are parsed here rather than in the host half, so the shapes can be
// pinned by a test without a device or a booted simulator: devicectl's JSON for
// hardware, and `simctl spawn launchctl list` for a simulator.

/** A `file://` URL's last path component, which is the executable's own name. */
function executableName(executable) {
  const text = String(executable ?? '')
  const withoutScheme = text.startsWith('file://') ? text.slice('file://'.length) : text
  const cut = withoutScheme.split('/')
  return cut[cut.length - 1] ?? ''
}

/**
 * The processes devicectl reported.
 *
 * @param {string} text - the JSON `devicectl device info processes --json-output` wrote.
 * @returns {Array<{pid: number, executable: string, name: string}>} every process it named.
 */
export function parseProcessList(text) {
  let payload = null
  try {
    payload = JSON.parse(String(text ?? ''))
  } catch {
    return []
  }
  const processes = payload?.result?.runningProcesses
  if (!Array.isArray(processes)) return []
  const out = []
  for (const entry of processes) {
    const pid = Number(entry?.processIdentifier)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const executable = String(entry?.executable ?? '')
    out.push({ pid, executable, name: executableName(executable) })
  }
  return out
}

/**
 * The running process whose bundle is `name`.
 *
 * Matched on the bundle directory rather than the executable's own name, because the
 * two can differ and the bundle is what the caller has: the app path Xcode built is
 * `<name>.app`, and a process started from it runs `.../<name>.app/<executable>`.
 * A bare executable-name match is the fallback for a process started from somewhere
 * else — a debugger's own launch, for instance.
 *
 * @param {Array<{pid: number, executable: string, name: string}>} processes - from `parseProcessList`.
 * @param {string} name - the app's name, i.e. its `.app` directory without the extension.
 * @returns {{pid: number, executable: string, name: string}|null} the match, or null.
 */
export function findAppProcess(processes, name) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return null
  const list = Array.isArray(processes) ? processes : []
  const inBundle = list.find((entry) => String(entry.executable).includes(`/${wanted}.app/`))
  if (inBundle !== undefined) return inBundle
  return list.find((entry) => entry.name === wanted) ?? null
}

/**
 * The pid of the app with `bundleId`, from `simctl spawn <udid> launchctl list`.
 *
 * A simulator's apps appear as services labelled `UIKitApplication:<bundleId>[…]`,
 * which is the only place the bundle id and the pid are on the same line. The output
 * is `PID Status Label` per line, with `-` for a service that is loaded but not
 * running — the pid column is what separates the two.
 *
 * The bundle id is compared exactly, cut at the label's first `[`: a prefix match would
 * make `com.example.App` find `com.example.AppExtension`, and attaching to the wrong
 * process is worse than not attaching.
 *
 * @param {string} text - launchctl's output.
 * @param {string} bundleId - the app's bundle id.
 * @returns {number|null} the pid, or null when that app is not running.
 */
export function parseLaunchctlList(text, bundleId) {
  const wanted = String(bundleId ?? '').trim()
  if (wanted === '') return null
  for (const line of String(text ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) continue
    if (!/^\d+$/.test(fields[0])) continue
    const marker = 'UIKitApplication:'
    const label = fields.slice(2).join(' ')
    const at = label.indexOf(marker)
    if (at < 0) continue
    const rest = label.slice(at + marker.length)
    const cut = rest.indexOf('[')
    if ((cut < 0 ? rest : rest.slice(0, cut)) !== wanted) continue
    const pid = Number(fields[0])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}
