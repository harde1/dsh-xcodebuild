// A live LLDB session, driven the way a program has to drive it.
//
// Everything here exists because of how `xcrun lldb` actually behaves when its stdin is
// a pipe rather than a terminal — each fact measured on this machine (Xcode 26.0.1,
// lldb-1703.0.31.2) while building the view-hierarchy feature, not assumed:
//
//   * Output is flushed per command even without a pty. `version` came back at once and
//     `quit`, four seconds later, produced nothing further — so a long-lived pipe session
//     can stream, and no pty is needed for that. (A pty would still be needed for `^C`;
//     interrupts are sent as signals instead, see `interrupt()`.)
//   * LLDB echoes each command it reads when stdin is not a tty, so a command's output
//     slice starts with `(lldb) <the command>`. That echo is stripped from what callers
//     get back, or every result would open with its own question.
//   * A command is over when a SENTINEL prints, not when a prompt appears: the prompt is
//     printed before reading too, so it appears twice per command. Each `send()` appends
//     `script print("<sentinel>")`, which is also why an expression evaluated against a
//     running process needs no special case — the sentinel simply arrives late, and
//     `send()` reports `completed: false` instead of guessing.
//   * `device process attach -p <pid>` RETURNS IMMEDIATELY and the process stops ~10–25 s
//     later, with the stop arriving as an asynchronous message. Sending `po` in between
//     fails with "the process must be stopped because the expression might require
//     allocating memory", and the error names the state it was in: `attaching`. So
//     attaching is a wait for an event (`waitForStopped`), never a fixed sleep.
//
// The module takes its `spawn` by injection so the whole state machine can be tested
// against a scripted child — no device, no Xcode, no timing.

import { spawn as nodeSpawn } from 'node:child_process'

/**
 * An asynchronous line that ends an attach. Deliberately narrower than every `error:`: while a
 * device attach is still settling, the `process status` probes can be answered with errors that
 * only mean "not yet", and failing on those would cut short an attach that was merely slow
 * (10–25 s is normal, 40.7 s measured cold).
 */
const ATTACH_ERROR = /^error:.*(attach|no such process|not permitted|denied|unable to|could not|failed)/i

/** Lines kept per session. A dump of a real app can be thousands of lines. */
const LINE_CAP = 4000

/** The states a session reports, and the same strings the panel displays. */
/**
 * What this line says about the debug session, if anything.
 *
 * LLDB announces a stop asynchronously and in two shapes — `Process 1234 stopped` when it
 * interrupts one, `Target 0: (HIDProbe) stopped.` when a stop settles — and both are the
 * signal that expressions may be evaluated. `is running` and `is attaching` are the two
 * states that forbid it, and they are why this parser exists rather than a boolean.
 *
 * @param {string} line - one line of LLDB output.
 * @returns {{state: string, pid?: number, target?: string}|null} what it says, or null.
 */
export function readLldbState(line) {
  const text = String(line ?? '')
  const stopped = /^Process (\d+) stopped\b/.exec(text)
  if (stopped !== null) return { state: 'stopped', pid: Number(stopped[1]) }
  const settled = /^Target \d+: \(([^)]+)\) stopped\./.exec(text)
  if (settled !== null) return { state: 'stopped', target: settled[1] }
  const running = /^Process (\d+) is running\./.exec(text)
  if (running !== null) return { state: 'running', pid: Number(running[1]) }
  // `continue` answers with `Process 1234 resuming`, and missing it would leave the
  // session claiming to be stopped while the app runs — the one mistake that makes an
  // expression fail with LLDB's own error instead of this plugin's clearer one.
  const resuming = /^Process (\d+) resuming\b/.exec(text)
  if (resuming !== null) return { state: 'running', pid: Number(resuming[1]) }
  const exited = /^Process (\d+) exited\b/.exec(text)
  if (exited !== null) return { state: 'exited', pid: Number(exited[1]) }
  // A thread stopped by SIGKILL is the system ending the app (measured on 蜜语-Dev: the watchdog
  // killed it after a long stop, lldb printed `Process N stopped` then this). Nothing can run in a
  // process the kernel is tearing down, so it is reported as gone even though the word was `stopped`.
  if (/stop reason = signal SIGKILL\b/.test(text)) return { state: 'exited', detail: 'the system killed the app (SIGKILL)' }
  // The state name appears inside the error LLDB raises when a command asks too early:
  // "unable to evaluate expression while the process is attaching|is connected ...".
  if (/while the process is attaching\b/.test(text)) return { state: 'attaching' }
  if (/\bProcess \d+ detached\b/.test(text)) return { state: 'idle' }
  // A thread's `stop reason = …` line is NOT taken as the process being stopped. LLDB
  // prints one while it still reports `Process N is running` — measured against an app a
  // second debugger was holding, where the two lines arrived together and treating the
  // stop reason as the process's state made the session claim it could run expressions
  // when every one of them was refused. Only `Process N stopped` and a settled
  // `Target 0: (name) stopped.` mean the process is stopped.
  return null
}

/**
 * How LLDB itself names the state of its process, asked in a way that cannot be refused.
 *
 * `process status` and `process interrupt` both need a process LLDB has already LAUNCHED, and while
 * a phone attach is still settling — `device process attach` answers in 1 s, the stop arrives at
 * 22 s — every ask is answered `error: Process must be launched.`. The wait asked once every 3 s, so
 * one attach printed seven of them, for a nudge that changes nothing: LLDB's own attach has already
 * sent the app SIGSTOP, and the stop arrives on its own. A `script` command is not a process
 * command, so it is answered whatever the process is doing — including `0`, no process at all.
 *
 * @see https://lldb.llvm.org/python_api/lldb.SBProcess.html (SBProcessState)
 */
export const PROCESS_STATE_COMMAND = 'script print("xcb-lldb-state=" + str(lldb.debugger.GetSelectedTarget().GetProcess().GetState()))'

/** The prefix the answer above carries, so it is recognised and kept out of everything. */
export const PROCESS_STATE_PREFIX = 'xcb-lldb-state='

/**
 * `SBProcessState` as a word.
 *
 * @param {number} value - the number LLDB printed.
 * @returns {string} the state, or `unknown` for a number this plugin has no name for.
 */
export function processStateName(value) {
  const names = {
    0: 'invalid',
    1: 'unloaded',
    2: 'connected',
    3: 'attaching',
    4: 'launching',
    5: 'stopped',
    6: 'running',
    7: 'stepping',
    8: 'crashed',
    9: 'detached',
    10: 'exited',
    11: 'suspended',
  }
  return names[value] ?? 'unknown'
}

/**
 * The LLDB commands that attach to (or launch under) a target.
 *
 * Kept pure and exported because the recipe IS the policy: a device is reached through
 * LLDB's `device` commands (the CoreDevice integration Apple documents in
 * `devicectl device process launch --help`), a simulator through the platform plug-in
 * named `ios-simulator`. The two differ in every command, so a test asserts both rather
 * than trusting a live device to notice a regression.
 *
 * `device process attach` takes `-p <pid>` or `-n <process-name>`; the process name is
 * the executable's, not the bundle id, which is why the caller passes `name`.
 *
 * @param {{kind?: string, id?: string, name?: string, pid?: number|null, mode?: string, appPath?: string}} target - what to debug.
 * @returns {Array<string>} commands, in order.
 */
export function attachCommands(target) {
  const kind = target?.kind === 'device' ? 'device' : 'simulator'
  const mode = target?.mode === 'launch' ? 'launch' : 'attach'
  const cmds = []
  if (kind === 'device') {
    // The udid is what `xcodebuild -destination` and `devicectl` both accept, and LLDB's
    // `device select` takes it too — verified with `device list` on the bench.
    if (target?.id) cmds.push(`device select ${target.id}`)
  } else {
    cmds.push('platform select ios-simulator')
  }
  if (mode === 'launch' && typeof target?.appPath === 'string' && target.appPath !== '') {
    if (kind === 'simulator') {
      cmds.push(`target create "${target.appPath}"`, 'process launch')
      return cmds
    }
    // On a device, launching is `devicectl`'s job (`--start-stopped` suspends the app
    // waiting for a debugger) and LLDB then attaches to the suspended process. The host
    // performs the launch and passes the pid in.
  }
  if (Number.isFinite(target?.pid)) {
    cmds.push(kind === 'device' ? `device process attach -p ${target.pid}` : `process attach --pid ${target.pid}`)
  } else if (typeof target?.name === 'string' && target.name !== '') {
    cmds.push(kind === 'device' ? `device process attach -n ${target.name}` : `process attach --name ${target.name}`)
  }
  return cmds
}

/**
 * Drop what LLDB echoes back and the sentinel itself, keeping the real output.
 *
 * LLDB echoes every command it reads when stdin is not a tty, so a command's slice opens
 * with its own question — and the sentinel command is echoed too. Neither belongs in a
 * result: the caller knows what it asked, and the panel shows the command it sent.
 */
function stripEcho(lines, sentinels, command) {
  const echo = typeof command === 'string' && command !== '' ? `(lldb) ${command}` : ''
  return lines.filter((line) => {
    const text = line.trim()
    if (text === '') return true
    if (sentinels.some((s) => text.includes(s))) return false
    if (/^\(lldb\) script print\(/.test(text)) return false
    if (echo !== '' && text === echo) return false
    return true
  })
}

/**
 * Create one LLDB session.
 *
 * @param {{argv?: Array<string>, cwd?: string, spawnFn?: Function, prefix?: string, now?: Function, lineCap?: number}} [options] - injection points.
 * @returns {object} the session.
 */
export function createLldbSession(options = {}) {
  const argv = Array.isArray(options.argv) && options.argv.length > 0 ? options.argv : ['xcrun', 'lldb']
  const cwd = typeof options.cwd === 'string' ? options.cwd : '/'
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : nodeSpawn
  const prefix = typeof options.prefix === 'string' ? options.prefix : '<<<xcb-lldb'
  const now = typeof options.now === 'function' ? options.now : Date.now
  const lineCap = Number.isFinite(options.lineCap) ? options.lineCap : LINE_CAP
  // Signals are injected for the same reason the spawn is: a test that drives a scripted
  // child must not be able to signal a real process because the fixture reused a pid.
  const killFn = typeof options.killFn === 'function' ? options.killFn : (pid, signal) => process.kill(pid, signal)
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 500

  let child = null
  let carry = ''
  let sentinelSeq = 0
  let status = 'idle'
  let statusDetail = ''
  let pid = null
  let targetName = ''
  let attached = null
  let exitedAt = null
  let queue = Promise.resolve()
  let closed = null
  const lines = []
  const waiters = new Set()
  let count = 0
  // While a quiet command is the one LLDB is answering, its lines are read for state but kept out
  // of the transcript. See `send({quiet})`.
  //
  // One slot is enough because `send` is serialised: only one command is ever outstanding, so its
  // sentinel is the one this holds. (A quiet command's answer can still land after its own sentinel,
  // when LLDB reports it from its event handler rather than from the command — which is why the fix
  // for a refusal in the transcript is not to ask a question that can be refused at all. See
  // `PROCESS_STATE_COMMAND`.)
  let quietUntil = ''
  // A `continue` lldb has not yet confirmed with `Process N resuming`. An interrupt sent into that gap
  // is lost — lldb has nothing running to interrupt yet — and the stop it was meant to bring never
  // comes: measured on the simulator, every second quick command in a row waited out the full 15 s.
  let continuePending = false

  /**
   * A line that is one of our sentinels, in either of its two forms: the echo of the
   * `script print("...")` we sent, and the value it printed.
   *
   * Both are dropped from the transcript rather than from a single command's slice,
   * because sentinels CROSS commands: `waitForStopped` fires `process status` probes while
   * an attach is settling, and those probes' sentinels then print in the middle of the next
   * command's output. Measured on a device — the first `po` after an attach came back with
   * a foreign `<<<xcb-lldb:4>>>` line in front of its real answer.
   */
  function isSentinel(text) {
    return text.includes(`${prefix}:`) && text.includes('>>>')
  }

  /** Append one output line, update the state it implies, and wake anyone waiting. */
  function pushLine(text) {
    // A quiet command's answer ends with its own sentinel; everything up to it is the plugin
    // asking LLDB how things stand, not something the user said or needs to read.
    const quiet = quietUntil !== ''
    if (quiet && text.includes(quietUntil)) quietUntil = ''
    if (!isSentinel(text)) {
      count += 1
      // Kept, but marked: the attach reads every line since it began to find LLDB's asynchronous
      // error, and a quiet probe's answer can be exactly that error. Only the transcript skips them.
      lines.push(quiet ? { n: count, t: text, q: true } : { n: count, t: text })
      if (lines.length > lineCap) lines.splice(0, lines.length - lineCap)
    }
    let said = readLldbState(text)
    // The settled `Target 0: (App) stopped.` that closes a SIGKILL stop is the same stop, not a new
    // one: it must not turn a killed app back into one that can run expressions.
    if (said !== null && said.state === 'stopped' && status === 'exited' && /SIGKILL/.test(statusDetail)) said = null
    if (said !== null) continuePending = false
    if (said !== null) {
      status = said.state
      statusDetail = typeof said.detail === 'string' ? said.detail : text.trim()
      if (Number.isFinite(said.pid)) pid = said.pid
      if (typeof said.target === 'string') targetName = said.target
      if (status === 'exited') exitedAt = now()
    }
    for (const waiter of [...waiters]) {
      try {
        waiter(text)
      } catch {
        /* a waiter that throws must not break the reader */
      }
    }
  }

  function onChunk(chunk) {
    carry += chunk.toString('utf8')
    // LLDB separates lines with \n; keep the remainder for the next chunk so a marker
    // split across two reads is still recognised.
    for (;;) {
      const at = carry.indexOf('\n')
      if (at < 0) break
      pushLine(carry.slice(0, at).replace(/\r$/, ''))
      carry = carry.slice(at + 1)
    }
  }

  /** Resolve when a line satisfying `test` arrives, or after `timeoutMs`. */
  function waitForLine(test, timeoutMs) {
    return new Promise((resolveWait) => {
      const waiter = (text) => {
        if (test(text)) {
          waiters.delete(waiter)
          clearTimeout(timer)
          resolveWait(true)
        }
      }
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        resolveWait(false)
      }, timeoutMs)
      waiters.add(waiter)
    })
  }

  function write(text) {
    if (child === null || child.stdin === null || child.stdin.destroyed === true) return false
    try {
      child.stdin.write(text)
      return true
    } catch {
      return false
    }
  }

  function sleep(ms) {
    // Deliberately NOT unref'd: every caller is awaiting this, and an unref'd timer that
    // is the only pending work lets Node exit with the await still unsettled.
    return new Promise((resolveSleep) => {
      setTimeout(resolveSleep, ms)
    })
  }

  function start() {
    if (child !== null) return
    status = 'starting'
    try {
      child = spawnFn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      status = 'dead'
      statusDetail = String(error?.message ?? error)
      return
    }
    closed = new Promise((resolveClose) => {
      child.on('close', () => resolveClose(true))
    })
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.stdin?.on('error', () => { /* a closed stdin is reported by the exit path */ })
    // Asynchronous mode, before anything else is read. In the default synchronous mode `continue`
    // does not return until the app stops again, so every command typed after it — `process status`,
    // `process interrupt`, the sentinel itself — queued behind a running app. Measured on the iPhone 17
    // simulator, same pid, back to back: synchronous, the interpreter went silent after `continue`;
    // asynchronous, `continue` answered at once, `process status` said `running` while it ran, and
    // `process interrupt` stopped it in 100 ms. That is what lets the session hold an app that RUNS.
    write('script lldb.debugger.SetAsync(True)\n')
    child.on('error', (error) => {
      status = 'dead'
      statusDetail = String(error?.message ?? error)
    })
    child.on('close', () => {
      if (status !== 'exited') status = 'dead'
      statusDetail = statusDetail === '' ? `lldb exited (status ${status})` : statusDetail
      exitedAt = now()
    })
    status = 'idle'
  }

  /**
   * Send one command and wait for its sentinel.
   *
   * @param {string} command - an LLDB command line.
   * @param {{timeoutMs?: number}} [opts] - how long to wait for the sentinel.
   * @returns {Promise<{command: string, lines: Array<string>, text: string, completed: boolean, note: string, state: string}>} the command's own output.
   */
  function send(command, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000
    const run = async () => {
      if (status === 'dead' || status === 'exited') {
        return { command, lines: [], text: '', completed: false, note: `the lldb session is ${status}`, state: status }
      }
      // A session is started by its first command: `xcode_lldb` may be called for a
      // status read long before anything is attached, and spawning lldb then would be a
      // process nobody asked for.
      if (child === null) start()
      sentinelSeq += 1
      const sentinel = `${prefix}:${sentinelSeq}>>>`
      const from = count
      const arrived = waitForLine((text) => text.includes(sentinel), timeoutMs)
      // Quiet: the state probes this session sends on its own. They are answered in order like any
      // command, but printing them made the transcript a wall of `(lldb) process status` and
      // `error: Process must be launched.` that buried what the user was actually doing. Their
      // lines still go through `readLldbState`, so the state light stays right.
      if (opts.quiet === true) quietUntil = sentinel
      const wrote = write(`${command}\n`) && write(`script print("${sentinel}")\n`)
      if (!wrote) {
        return { command, lines: [], text: '', completed: false, note: 'the lldb session is not accepting input', state: status }
      }
      const completed = await arrived
      const slice = lines.filter((line) => line.n > from).map((line) => line.t)
      const kept = stripEcho(slice, [sentinel], command)
      const body = kept.join('\n').replace(/\s+$/, '')
      return {
        command,
        lines: kept,
        text: body,
        completed,
        note: completed ? '' : `no answer within ${timeoutMs} ms — the process is still ${status}`,
        state: status,
      }
    }
    // Serialised: LLDB reads stdin in order, and two callers interleaving commands would
    // each get the other's output in their slice.
    const next = queue.then(run, run)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * What LLDB says its process is doing, asked with a command that cannot be refused.
   *
   * @param {number} [timeoutMs] - how long the answer is waited for. The question is answered in
   *   milliseconds when LLDB is free; a command QUEUED behind a running inferior is the case this
   *   waits out, so the caller can fall back to asking for a stop the blunt way.
   * @returns {Promise<string>} `running`, `attaching`, `stopped`… or `unknown`.
   */
  async function processStateNow(timeoutMs = 2000) {
    const answer = await send(PROCESS_STATE_COMMAND, { timeoutMs, quiet: true })
    const line = [...(answer.lines ?? [])].reverse().find((text) => text.startsWith(PROCESS_STATE_PREFIX))
    if (line === undefined) return 'unknown'
    return processStateName(Number(line.slice(PROCESS_STATE_PREFIX.length)))
  }

  /**
   * Wait for the process to be stopped, which is the only state expressions run in.
   *
   * A device attach stops the app asynchronously and slowly (10–25 s measured), and the
   * message that says so can be missed if the session was merely idle. So this polls the
   * state it has been told, and probes with `process status` — which LLDB answers even while it is
   * still attaching — rather than sleeping a fixed amount and hoping. A stop is asked for only when
   * the state `processStateNow` reads back says the process is really RUNNING; asking before that is
   * refused, and the refusal is what a user saw seven of, printed, on a single phone attach.
   *
   * `stopWhenRunning` is what makes attaching to an ALREADY RUNNING app work at all, and its
   * absence is what a 90-second silence was: measured on 蜜语-Dev, `device process attach -p 20399`
   * returned in 3 s and `process status` answered `Process 20399 is running.` — attached, and
   * running. A running process does not stop because a debugger attached; it stops when the
   * debugger asks, which is what Xcode does. Waiting for a spontaneous stop is waiting forever.
   *
   * @param {{timeoutMs?: number, probeAfterMs?: number, onTick?: Function, stopWhenRunning?: boolean}} [opts] - waiting policy.
   * @returns {Promise<{stopped: boolean, state: string, waitedMs: number, detail: string}>} outcome.
   */
  async function waitForStopped(opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 90000
    const probeAfterMs = Number.isFinite(opts.probeAfterMs) ? opts.probeAfterMs : 8000
    const probeEveryMs = Number.isFinite(opts.probeEveryMs) ? opts.probeEveryMs : 4000
    const startedAt = now()
    // Negative infinity, not zero: the first probe must happen as soon as `probeAfterMs`
    // has passed, not once the elapsed time also exceeds the probe interval.
    let lastProbe = Number.NEGATIVE_INFINITY
    let lastInterrupt = Number.NEGATIVE_INFINITY
    for (;;) {
      const waitedMs = now() - startedAt
      if (status === 'stopped') return { stopped: true, state: status, waitedMs, detail: statusDetail }
      // Asked again every few seconds, because an interrupt sent while the attach is still settling
      // can be ignored, and one lost request must not become a lost attach.
      //
      // Asked only when LLDB reports the process RUNNING. Anything else is an attach still settling,
      // where the ask is refused with `error: Process must be launched.` and does nothing but print
      // it — seven times on one phone attach, one per 3 s, while the stop lldb's own attach delivers
      // arrived at 22 s regardless. The state is read with `script`, which cannot be refused or
      // queued; a process that is really running is the only case an interrupt is for.
      if (opts.stopWhenRunning === true && waitedMs - lastInterrupt > 3000) {
        lastInterrupt = waitedMs
        if (await processStateNow() === 'running') {
          void send('process interrupt', { timeoutMs: 8000, quiet: true }).catch(() => {})
        }
      }
      if (status === 'exited' || status === 'dead') return { stopped: false, state: status, waitedMs, detail: statusDetail }
      const failedWith = typeof opts.failWhen === 'function' ? opts.failWhen() : ''
      if (typeof failedWith === 'string' && failedWith !== '') {
        return { stopped: false, state: status, waitedMs, detail: failedWith, failed: true }
      }
      // An attach that is visibly under way gets the longer budget. Measured on 蜜语-Dev (iPhone 13,
      // iOS 26.6.2), twice: `device process attach` returns in 1 s, from 3 s on every `process status`
      // answers `Process N is running.` WITH `thread #1, stop reason = signal SIGSTOP` — the kernel has
      // already paused the app and lldb is still loading its images — and the real `Process N stopped`
      // / `Target 0: (蜜语-Dev) stopped.` arrives 22 s after the attach. A flat 30 s cut that off at the
      // finish line; nothing was stale, LLDB itself said `running` until then.
      const budget = typeof opts.progressing === 'function' && opts.progressing()
        ? Math.max(timeoutMs, Number.isFinite(opts.progressTimeoutMs) ? opts.progressTimeoutMs : 90000)
        : timeoutMs
      if (waitedMs >= budget) return { stopped: false, state: status, waitedMs, detail: `still ${status} after ${waitedMs} ms` }
      if (waitedMs > probeAfterMs && waitedMs - lastProbe > probeEveryMs) {
        lastProbe = waitedMs
        void send('process status', { timeoutMs: 5000, quiet: true }).catch(() => {})
      }
      if (typeof opts.onTick === 'function') opts.onTick(status, waitedMs)
      await sleep(200)
    }
  }

  /**
   * Run `work` inside the shortest stop that allows it, and let the app go again at once.
   *
   * The unit of every read: an app that was running is interrupted, `work` runs, and it is continued
   * — so a person sees a hitch, not a freeze. An app that was already stopped (a breakpoint, a manual
   * Interrupt) is left stopped: that stop is someone's, not ours to end. Measured on the simulator in
   * async mode: interrupt 110 ms, `po` 6–80 ms once warm, continue 6 ms — a 130–200 ms pause.
   *
   * @param {Function} work - async; runs while stopped.
   * @param {{stopTimeoutMs?: number}} [opts] - how long the stop may take.
   * @returns {Promise<{ok: boolean, value?: any, pausedMs: number, resumed: boolean, note: string}>}
   */
  async function pauseFor(work, opts = {}) {
    const wasRunning = status === 'running'
    if (status !== 'stopped' && !wasRunning) {
      return { ok: false, pausedMs: 0, resumed: false, note: `the process is ${status}` }
    }
    const pausedAt = now()
    if (wasRunning) {
      // Interrupt only something that is running for lldb too: a continue it has not confirmed yet
      // is waited for first (it answers in a few ms), or the interrupt falls into the gap.
      if (continuePending) await waitForLine((text) => /^Process \d+ (resuming|is running)/.test(text.trim()), 2000)
      continuePending = false
      void send('process interrupt', { timeoutMs: 5000, quiet: true }).catch(() => {})
      const waited = await waitForStopped({ timeoutMs: Number.isFinite(opts.stopTimeoutMs) ? opts.stopTimeoutMs : 15000, probeAfterMs: 1500, probeEveryMs: 1500 })
      if (!waited.stopped) {
        return { ok: false, pausedMs: now() - pausedAt, resumed: false, note: `the app did not stop: ${waited.detail}` }
      }
    }
    let value
    let failure = ''
    try {
      value = await work()
    } catch (error) {
      failure = String(error?.message ?? error)
    }
    const resumed = wasRunning && status === 'stopped' ? resume() : false
    return { ok: failure === '', value, pausedMs: now() - pausedAt, resumed: resumed === true, note: failure }
  }

  /** Attach to (or launch under) a target, then wait for the stop that allows expressions. */
  async function attach(target, opts = {}) {
    start()
    const cmds = attachCommands(target)
    attached = { ...target, cmds }
    // Everything LLDB prints from here on, not just each command's own slice. A device attach
    // (`device process attach -p`) RETURNS at once and its outcome arrives later, asynchronously —
    // so an `error:` that explains the failure lands AFTER the command's slice has closed. Judging
    // "LLDB said nothing" from the slices alone is how a 3-second, clearly worded failure became a
    // 90-second silence that was then blamed on an anti-debugging guard the app does not have.
    const fromLine = count
    const since = () => lines
      .filter((line) => line.n > fromLine)
      .map((line) => line.t)
      .filter((text) => text.trim() !== '' && !text.trim().startsWith('(lldb)')
        && !text.trim().startsWith(PROCESS_STATE_PREFIX))
    const asyncError = () => since().find((text) => ATTACH_ERROR.test(text.trim())) ?? ''
    // The sign that the attach has reached the process and is finishing: a thread already stopped by
    // SIGSTOP while the process as a whole is still reported running.
    const progressing = () => since().some((text) => /stop reason = signal SIGSTOP\b/.test(text))
    const said = []
    for (const cmd of cmds) {
      const result = await send(cmd, { timeoutMs: Number.isFinite(opts.commandTimeoutMs) ? opts.commandTimeoutMs : 30000 })
      said.push(result)
      if (!result.completed && result.note !== '') {
        return { ok: false, state: status, says: said, note: `${cmd}: ${result.note}` }
      }
    }
    const failure = said.map((r) => r.text).join('\n').split('\n').find((line) => line.trim().startsWith('error:'))
    if (failure !== undefined) return { ok: false, state: status, says: said, note: failure }
    // `waitForStop: false` is for a recipe that LAUNCHES: a launched process is meant to be
    // running afterwards, so waiting for a stop would wait forever. The caller stops it
    // when it has had time to come up.
    if (opts.waitForStop === false && status !== 'stopped') {
      return { ok: true, state: status, says: said, note: '', waitedMs: 0 }
    }
    if (status !== 'stopped') {
      // Named before waiting, so a caller that asks for a dump while the attach is still
      // in flight is told `attaching` rather than being handed LLDB's colder wording. A state
      // LLDB has already reported is kept: overwriting `running` with `attaching` would hide the
      // one state that says the attach WORKED and the process needs interrupting.
      if (status !== 'exited' && status !== 'dead' && status !== 'running') status = 'attaching'
      // An attach to an app that is ALREADY RUNNING does not stop it, and the stop has to be ASKED
      // for: `process interrupt` is the one command LLDB answers while the inferior runs — it is what
      // stops a runaway process — while everything else, `process status` included, is queued behind
      // it. Measured on 蜜语-Dev through this very session: `device select` and `device process
      // attach -p 20399` both completed and then not one line came back for 30 s, because the probe
      // that would have reported the state was queued forever. The same attach by hand in batch mode
      // answered `Process 20399 is running.` in 3 s and refused `bt` for want of a stop. Xcode asks
      // for the stop too; this is the step whose absence was the whole 90-second silence.
      //
      // The state comes first, so the ask is not thrown at a process LLDB has not launched yet (it
      // answers `error: Process must be launched.` and nothing else). `unknown` still asks: that is
      // the one case the state question could not settle — a `script` command queued behind a running
      // inferior — and there the blunt ask is exactly what is needed, which is how the 30-second
      // silence above was ended the first time.
      if (status !== 'exited' && status !== 'dead' && opts.waitForStop !== false) {
        const state = await processStateNow()
        if (state === 'running' || state === 'unknown') {
          void send('process interrupt', { timeoutMs: Number.isFinite(opts.commandTimeoutMs) ? opts.commandTimeoutMs : 30000, quiet: true }).catch(() => {})
        }
      }
      // Probed from the first second, not from the eighth. A/B on 蜜语-Dev (iPhone 13, iOS 26.6.2),
      // same pid, back to back: probing from 8 s timed out at 30 s having heard nothing but
      // `Process must be launched.`; probing every 3 s from the start saw `stop reason = signal
      // SIGSTOP` within 3 s and the real stop at 22–23 s. The early answers are also what tell
      // `progressing` that the attach is finishing rather than stuck.
      const waited = await waitForStopped({
        probeAfterMs: 0,
        probeEveryMs: 3000,
        ...opts,
        failWhen: asyncError,
        progressing,
        stopWhenRunning: true,
      })
      if (!waited.stopped) {
        const heard = since()
        if (waited.failed === true) {
          // LLDB answered, just not inside the command's slice: report its words at once.
          return { ok: false, state: waited.state, says: said, quiet: false, heard, note: waited.detail.trim() }
        }
        // Silence is judged over EVERYTHING printed since the attach began, and whatever was
        // printed is handed back verbatim, so a failure can be read rather than guessed at.
        const quiet = heard.length === 0
        const tail = heard.slice(-6).join(' | ')
        return {
          ok: false,
          state: waited.state,
          says: said,
          quiet,
          heard,
          note: `attached but the process never stopped: ${waited.detail}`
            + (quiet ? ', and LLDB printed nothing at all' : `. LLDB printed: ${tail}`),
        }
      }
      await warmUp()
      return { ok: true, state: status, says: said, note: '', waitedMs: waited.waitedMs }
    }
    await warmUp()
    return { ok: true, state: status, says: said, note: '', waitedMs: 0 }
  }

  /**
   * Pay the expression engine's first-use cost inside the attach's stop, which the app is in anyway.
   *
   * The first Objective-C expression in a session parses the ObjC runtime and UIKit's types; every
   * later one reuses that. Measured on the simulator, same session: cold, `po 1+1` held the app 873 ms
   * and the first UIKit call 2404 ms; after one warm-up expression during the attach, each read held
   * it 124–195 ms. Quiet, and best-effort: a failure here only means the first read pays instead.
   */
  async function warmUp() {
    if (status !== 'stopped') return
    await send('expression -l objc -- (void)[UIApplication sharedApplication]', { timeoutMs: 20000, quiet: true }).catch(() => {})
  }

  /**
   * Evaluate an expression, but only while the process is stopped.
   *
   * Refusing here is the point: LLDB's own refusal ("the process must be stopped because
   * the expression might require allocating memory") arrives as an `error:` line that a
   * caller could mistake for an empty result, and an empty view hierarchy is exactly the
   * wrong conclusion to draw from a paused app.
   */
  async function evaluate(expression, opts = {}) {
    if (status === 'running' || status === 'attaching') {
      return { ok: false, text: '', error: '', note: `the process is ${status}; it must be stopped before an expression can run` }
    }
    const result = await send(expression, opts)
    // TRIMMED, because an expression's compile error is INDENTED to sit under the caret
    // LLDB draws beneath it:
    //     <source>:1:3: error: use of undeclared identifier 'UIApplication'
    //                  ^
    // Only matching column 0 made a compile failure look like an expression that
    // evaluated to nothing — which is how an empty view hierarchy got reported for a
    // command that never ran. Measured on a device.
    const error = result.lines.find((line) => line.trim().startsWith('error:')) ?? ''
    return {
      ok: error === '' && result.completed,
      text: error === '' ? result.text : '',
      error,
      note: result.completed ? (error === '' ? '' : error) : result.note,
      state: status,
      completed: result.completed,
    }
  }

  /**
   * Let the process run, without waiting for an answer.
   *
   * Deliberately not `send()`: while the inferior runs, LLDB's command interpreter has
   * nothing to say, so a sentinel would either time out or — worse — sit at the head of
   * the queue and block the very `process interrupt` that ends the wait. Measured: a
   * `continue` is followed by `process interrupt` immediately, and both are obeyed
   * (the interpreter reads stdin during a run), so nothing needs to be awaited here.
   *
   * @returns {boolean} whether the command could be written.
   */
  function resume() {
    if (child === null) start()
    // Only a stopped process is continued. A `continue` to one that already runs is not harmless on a
    // device: lldb answers it with another `Process N resuming` (or `Process must be launched.` while
    // attaching), so every mount, read and Apps pick that "made sure" the app runs printed one more
    // `resuming` line into a transcript where nothing had changed.
    if (status !== 'stopped') return true
    const wrote = write('continue\n')
    // Running from the moment it is let go, not from when lldb gets round to saying `resuming`. The
    // gap was a race: a read that came straight after a read still saw `stopped`, skipped its own
    // interrupt, and ran into a moving app — `error: Process is running.` on every second quick
    // command, measured on the simulator.
    if (wrote) {
      status = 'running'
      statusDetail = 'continued'
      continuePending = true
    }
    return wrote
  }

  /** Detach, leaving the app running — what a debugger should do when it is done. */
  async function detach() {
    if (status === 'dead' || status === 'exited') return { ok: false, note: `session is ${status}` }
    const result = await send('process detach', { timeoutMs: 15000 })
    const error = result.lines.find((line) => line.trim().startsWith('error:')) ?? ''
    if (error === '') return { ok: true, note: '' }
    // A device-attached process refuses `process detach` the same way it refuses
    // `continue` ("Process must be launched"); `quit` is what actually lets go of it.
    return { ok: false, note: error }
  }

  /** Ask the process to stop. On a device the signal is what an attached session honours. */
  async function interrupt() {
    if (status === 'stopped') return { ok: true, note: 'already stopped' }
    const result = await send('process interrupt', { timeoutMs: 5000 })
    if (result.lines.some((line) => line.trim().startsWith('error:'))) {
      // Documented fallback: a stop the command interpreter cannot request is still a
      // stop the process can be given. SIGSTOP to LLDB makes it interrupt the inferior.
      if (child !== null && Number.isFinite(child.pid)) {
        try {
          killFn(child.pid, 'SIGINT')
          const waited = await waitForStopped({ timeoutMs: 15000, probeAfterMs: 2000 })
          return { ok: waited.stopped, note: waited.stopped ? '' : `interrupt did not stop the process: ${waited.detail}` }
        } catch (error) {
          return { ok: false, note: String(error?.message ?? error) }
        }
      }
      return { ok: false, note: result.lines.find((line) => line.trim().startsWith('error:')) ?? '' }
    }
    const waited = await waitForStopped({ timeoutMs: 15000, probeAfterMs: 4000 })
    return { ok: waited.stopped, note: waited.stopped ? '' : `interrupt did not stop the process: ${waited.detail}` }
  }

  function summary() {
    return {
      state: status,
      detail: statusDetail,
      pid,
      target: targetName,
      attached: attached === null ? null : { kind: attached.kind ?? 'simulator', id: attached.id ?? '', name: attached.name ?? '', mode: attached.mode ?? 'attach' },
      lineCount: count,
      // The cursor a poller passes back as `from` for its next read. One past the last line, because
      // `readLines(from)` includes `from`: polling with `lineCount` returned the newest line on every
      // poll, and the drawer showed `device select` and `Process N resuming` two and three times.
      next: count + 1,
      firstAvailable: lines.length === 0 ? count + 1 : lines[0].n,
    }
  }

  function readLines(from) {
    const start = Number.isFinite(from) ? from : 0
    return lines.filter((line) => line.n >= start && line.q !== true).map((line) => ({ n: line.n, t: line.t }))
  }

  /**
   * End the session: ask nicely, then insist.
   *
   * `quit` is the polite request and LLDB usually obeys it under a debugger's own
   * detach. If it does not — a device attach that refuses to let go is the case seen on
   * the bench — the child is signalled, then killed. A long-lived debugger is never left
   * behind, because the next click would otherwise attach a second lldb to the same app.
   */
  async function dispose() {
    if (child === null) {
      status = 'dead'
      return
    }
    // Detach FIRST. Quitting lldb while it holds a device debug session leaves the phone believing a
    // debugger is still attached, and the cost of that is measured: the next attach answered
    // `tried to attach to process already being debugged`, and after it, even
    // `devicectl device process launch --terminate-existing` stopped returning at all — the app
    // could no longer be relaunched, which is the "always hangs" this plugin kept being blamed for.
    // Detaching hands the process back, so the next attempt starts from a free device.
    if (attached !== null && status !== 'dead' && status !== 'exited' && status !== 'idle') {
      try {
        await send('process detach', { timeoutMs: 5000 })
      } catch {
        /* the session is going away regardless */
      }
    }
    write('quit\n')
    const done = closed === null ? sleep(graceMs) : Promise.race([closed, sleep(graceMs)])
    await done
    const alive = () => child !== null && child.exitCode === null && child.signalCode === null
    if (alive()) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      const ended = closed === null ? sleep(graceMs) : Promise.race([closed, sleep(graceMs)])
      await ended
    }
    if (alive()) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    child = null
    if (status !== 'dead') status = 'dead'
  }

  return {
    start,
    send,
    resume,
    pauseFor,
    attach,
    evaluate,
    detach,
    interrupt,
    waitForStopped,
    readLines,
    summary,
    dispose,
    get state() { return status },
    get pid() { return pid },
    get exited() { return exitedAt !== null && (status === 'exited' || status === 'dead') },
  }
}
