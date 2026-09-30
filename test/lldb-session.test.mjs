// Tests for the LLDB session engine.
//
// The child process is scripted rather than real: the engine's whole job is to be right
// about ORDER and STATE — a command's output slice, an asynchronous stop, a command that
// is still running — and a live device can demonstrate none of those on demand.
//
// The timings asserted here are the ones measured against a real device (an iPhone 13,
// iOS 26.6.2, Xcode 26.0.1): `device process attach -p` returns at once and the process
// stops ~10–25 s later, with the stop arriving as an asynchronous message.
//
// Run: node test/lldb-session.test.mjs
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { attachCommands, createLldbSession, readLldbState } from '../lib/lldb-session.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}
function eq(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}
function section(name) {
  console.log(`\n# ${name}`)
}

/**
 * A scripted lldb: echoes each command, answers a `script print("…")` with its argument,
 * and lets a test supply extra output per command.
 *
 * @param {{onCommand?: Function}} [options] - extra behaviour per command line.
 * @returns {object} a child-process stand-in.
 */
function fakeLldb(options = {}) {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  child.stdin = stdin
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.kills = []
  child.written = []
  const say = (text) => child.stdout.write(`${text}\n`)
  child.say = say
  let buffer = ''
  let blocked = false
  const pending = []
  const handle = (line) => {
    child.written.push(line)
    say(`(lldb) ${line}`)
    const marker = /^script print\("(.+)"\)$/.exec(line)
    if (marker !== null) say(marker[1])
    else if (typeof options.onCommand === 'function') options.onCommand(line, child)
  }
  // A real lldb reads stdin sequentially and cannot answer while the inferior runs — the
  // sentinel of the NEXT command waits for the stop. Without this the engine's most
  // important case (a command that has not finished) could never be reproduced.
  child.block = () => { blocked = true }
  child.unblock = () => {
    blocked = false
    while (pending.length > 0) handle(pending.shift())
  }
  stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      // Measured on the device: while the inferior runs the interpreter answers
      // `process interrupt` immediately (it is what stops a runaway process), and
      // queues everything else until the stop. Modelling only the queueing would make
      // the engine's own resume/interrupt pair untestable.
      if (blocked && !line.startsWith('process interrupt')) pending.push(line)
      else handle(line)
    }
  })
  child.kill = (signal) => {
    child.kills.push(signal)
    child.signalCode = signal
    setImmediate(() => child.emit('close', null, signal))
    return true
  }
  return child
}

/** A session wired to a scripted child, plus the handle to script it. */
function sessionWith(onCommand, opts = {}) {
  const child = fakeLldb({ onCommand })
  const session = createLldbSession({
    spawnFn: () => child,
    killFn: (pid, signal) => child.kills.push(`${signal}:${pid}`),
    graceMs: 20,
    ...opts,
  })
  return { child, session }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- recipes ---------------------------------------------------------------

section('the attach recipe is the policy, so it is asserted directly')
{
  eq(
    attachCommands({ kind: 'device', id: '00008110-000078242EBB801E', pid: 12934 }),
    ['device select 00008110-000078242EBB801E', 'device process attach -p 12934'],
    'a device is reached through LLDB\'s device commands, with the hardware udid',
  )
  eq(
    attachCommands({ kind: 'device', id: '00008110-1', name: 'HIDProbe' }),
    ['device select 00008110-1', 'device process attach -n HIDProbe'],
    'and by process name when no pid is known — the executable, not the bundle id',
  )
  eq(
    attachCommands({ kind: 'simulator', pid: 987 }),
    ['platform select ios-simulator', 'process attach --pid 987'],
    'a simulator goes through its own platform plugin',
  )
  eq(
    attachCommands({ kind: 'simulator', name: 'HIDProbe' }),
    ['platform select ios-simulator', 'process attach --name HIDProbe'],
    'by name when that is what the caller has',
  )
  eq(
    attachCommands({ kind: 'simulator', mode: 'launch', appPath: '/tmp/Build/HIDProbe.app' }),
    ['platform select ios-simulator', 'target create "/tmp/Build/HIDProbe.app"', 'process launch'],
    'launching on a simulator is a target plus a launch',
  )
  eq(
    attachCommands({}),
    ['platform select ios-simulator'],
    'an empty target selects the simulator platform and attaches to nothing rather than guessing',
  )
}

section('LLDB\'s own words are read as state')
{
  eq(readLldbState('Process 13005 stopped'), { state: 'stopped', pid: 13005 }, 'a stopped process')
  eq(readLldbState('Target 0: (HIDProbe) stopped.'), { state: 'stopped', target: 'HIDProbe' }, 'a settled stop names the target')
  eq(readLldbState('Process 13005 is running.'), { state: 'running', pid: 13005 }, 'a running process')
  eq(readLldbState('Process 13005 resuming'), { state: 'running', pid: 13005 }, 'resuming is running, and missing it would make the session lie about being stopped')
  eq(readLldbState('Process 13005 exited with status 0'), { state: 'exited', pid: 13005 }, 'an exited process')
  eq(
    readLldbState('error: unable to evaluate expression while the process is attaching: the process must be stopped'),
    { state: 'attaching' },
    'the state named inside LLDB\'s refusal is still the state',
  )
  eq(readLldbState('stop reason = signal SIGSTOP'), null, 'a THREAD stop reason is not the process being stopped: lldb prints one while it still says the process is running')
  eq(readLldbState('warning: libobjc.A.dylib is being read from process memory.'), null, 'a warning says nothing about state')
  eq(readLldbState(''), null, 'and neither does silence')
}

// --- sending ---------------------------------------------------------------

section('a command\'s own output comes back without its question')
{
  const { session } = sessionWith((line, child) => {
    if (line === 'po 1 + 1') child.say('2')
  })
  const result = await session.send('po 1 + 1')
  eq(result.completed, true, 'the sentinel arrived, so the command completed')
  eq(result.lines, ['2'], 'the echoed command and the sentinel are stripped, leaving the answer')
  eq(result.text, '2', 'and the text form is the same')
  eq(result.state, 'idle', 'the state is reported alongside it')
}

section('a command that has not finished says so instead of guessing')
{
  // `continue` on a stopped process prints nothing until the process stops again; the
  // sentinel cannot arrive in between, and that is the signal, not a failure.
  const { session } = sessionWith((line, child) => {
    if (line === 'continue') {
      child.block()
      child.say('Process 13005 resuming')
      setTimeout(() => {
        child.say('Process 13005 stopped')
        child.unblock()
      }, 600)
    }
  })
  const rushed = await session.send('continue', { timeoutMs: 150 })
  eq(rushed.completed, false, 'no sentinel within the timeout')
  check(rushed.note.includes('still running'), 'and the note names the state rather than claiming an empty result', rushed.note)
  eq(session.state, 'running', 'because the session read `resuming` as running')
  await sleep(700)
  eq(session.state, 'stopped', 'the later stop is still noticed, after the command returned')
}

section('a sentinel from another command never reaches a result')
{
  // Measured on a device: the `process status` probes that `waitForStopped` fires while an
  // attach settles print their sentinels LATER, in the middle of whatever command comes
  // next — the first `po` after an attach came back with a foreign `<<<xcb-lldb:4>>>` line
  // in front of its real answer. Reproduced directly here, because the cause is a race
  // between two commands and the effect is what must never reach a caller.
  const { session } = sessionWith((line, child) => {
    if (line === 'po 2') {
      child.say('2')
      child.say('<<<xcb-lldb:99>>>')
    }
  })
  session.start()
  const result = await session.send('po 2')
  eq(result.lines, ['2'], 'only the answer, with no foreign sentinel line in front of it')
  check(
    session.readLines(0).every((line) => !line.t.includes('<<<xcb-lldb')),
    'and no sentinel is in the transcript at all',
  )
}

section('lines are numbered, and callers read forward from a cursor')
{
  const { session } = sessionWith((line, child) => {
    if (line === 'bt') { child.say('frame #0'); child.say('frame #1') }
  })
  await session.send('bt')
  const all = session.readLines(0)
  check(all.length >= 2, 'the ring holds the output')
  const after = session.readLines(all[all.length - 1].n + 1)
  eq(after.length, 0, 'reading past the end yields nothing, so a poll loop can be a no-op')
  const from = all[0].n
  eq(session.readLines(from)[0].n, from, 'and reading from a cursor starts at that line')
  const summary = session.summary()
  check(typeof summary.lineCount === 'number' && summary.lineCount > 0, 'the summary reports how much has been said')
  eq(summary.firstAvailable, 1, 'and where the window still begins')
}

// --- attaching -------------------------------------------------------------

section('attaching to a device waits for the stop that expressions need')
{
  const stops = []
  const { child, session } = sessionWith((line, c) => {
    // The real thing: `device process attach -p` returns at once, and the stop arrives
    // asynchronously seconds later. 400 ms stands in for the measured 10–25 s.
    if (line.startsWith('device process attach')) setTimeout(() => c.say('Process 77 stopped'), 400)
    if (line === 'process status') stops.push(Date.now())
  })
  session.start()
  const result = await session.attach({ kind: 'device', id: '00008110-ABC', pid: 77 }, { timeoutMs: 5000, probeAfterMs: 100, probeEveryMs: 100 })
  const commands = child.written.filter((line) => !line.startsWith('script print('))
  eq(commands[0], 'device select 00008110-ABC', 'the device is selected first')
  eq(commands[1], 'device process attach -p 77', 'then attached by pid')
  eq(result.ok, true, 'the attach succeeds once the process has stopped')
  eq(session.state, 'stopped', 'and the session says so')
  check(result.waitedMs >= 400, 'the wait is real: the async stop was awaited, not assumed', String(result.waitedMs))
  check(stops.length > 0, 'while waiting it probes `process status`, so a lost message cannot hang the click forever')
}

section('a launch recipe does not wait for a stop that is not coming')
{
  const { session } = sessionWith((line, c) => {
    if (line === 'process launch') c.say('Process 41 launched: /tmp/App.app/App')
  })
  session.start()
  const result = await session.attach(
    { kind: 'simulator', mode: 'launch', appPath: '/tmp/App.app' },
    { timeoutMs: 500, waitForStop: false },
  )
  eq(result.ok, true, 'a launched process is running, and that is the success case')
  check(result.waitedMs === 0, 'so nothing is waited for')
}

section('an attach that times out says whether LLDB said anything')
{
  // A device the attach is merely slow on eventually says something; an app that refuses
  // the debugger never does. The host turns the second into a note naming that possibility.
  const { session } = sessionWith(() => {})
  session.start()
  const quiet = await session.attach({ kind: 'device', id: 'u', pid: 42, mode: 'attach' }, { timeoutMs: 300, probeAfterMs: 100000 })
  eq(quiet.ok, false, 'a silent attach times out')
  eq(quiet.quiet, true, 'and is marked as having said nothing')
  check(quiet.note.includes('printed nothing at all'), 'which its note says', quiet.note)

  const { session: noisy } = sessionWith((line, c) => {
    if (line.startsWith('device process attach')) c.say('error: unable to attach')
  })
  noisy.start()
  const failed = await noisy.attach({ kind: 'device', id: 'u', pid: 42, mode: 'attach' }, { timeoutMs: 1000 })
  eq(failed.ok, false, 'an attach that is refused outright fails')
  check(failed.note.includes('unable to attach'), 'with LLDB\'s own reason, not a timeout', failed.note)
}

section('an error that arrives AFTER the attach command returned ends the wait at once')
{
  // `device process attach -p` returns at once and its outcome arrives afterwards, outside the
  // command's own slice. The plugin read only the slices, so an answer that DID arrive was invisible
  // and the attach was waited out as silence.
  const { session } = sessionWith((line, c) => {
    if (line.startsWith('device process attach')) {
      setTimeout(() => c.say('error: attach failed: no such process'), 150)
    }
  })
  session.start()
  const started = Date.now()
  const answer = await session.attach({ kind: 'device', id: 'u', pid: 15348, mode: 'attach' }, { timeoutMs: 5000, probeAfterMs: 100000 })
  const took = Date.now() - started
  eq(answer.ok, false, 'the attach fails')
  check(answer.note.includes('no such process'), 'with LLDB\'s own words', answer.note)
  eq(answer.quiet, false, 'and it is not reported as silence')
  check(took < 2000, 'long before the timeout', `${took} ms`)
  check(Array.isArray(answer.heard) && answer.heard.some((t) => t.includes('no such process')), 'what LLDB printed is handed back')
}

{
  // A slow attach can have its `process status` probes answered with errors that only mean "not
  // yet"; those must not cut the wait short.
  const { session } = sessionWith((line, c) => {
    if (line.startsWith('process status')) c.say('error: Process must be launched.')
    if (line.startsWith('device process attach')) setTimeout(() => c.say('Process 7 stopped'), 400)
  })
  session.start()
  const slow = await session.attach({ kind: 'device', id: 'u', pid: 7, mode: 'attach' }, { timeoutMs: 5000, probeAfterMs: 0, probeEveryMs: 50 })
  eq(slow.ok, true, 'a probe\'s "not yet" does not fail an attach that then stops')
}

{
  // A timeout after LLDB DID say something reports what it said instead of calling it silence.
  const { session } = sessionWith((line, c) => {
    if (line.startsWith('device process attach')) setTimeout(() => c.say('warning: waiting for the device to respond'), 50)
  })
  session.start()
  const said = await session.attach({ kind: 'device', id: 'u', pid: 7, mode: 'attach' }, { timeoutMs: 400, probeAfterMs: 100000 })
  eq(said.quiet, false, 'something was printed, so it is not silence')
  check(said.note.includes('waiting for the device to respond'), 'and the note quotes it', said.note)
}

section('an attach that fails reports LLDB\'s own reason')
{
  const { session } = sessionWith((line, child) => {
    if (line.startsWith('device process attach')) child.say('error: unable to find a device matching the provided destination specifier')
  })
  session.start()
  const result = await session.attach({ kind: 'device', id: 'nope', pid: 1 }, { timeoutMs: 1000 })
  eq(result.ok, false, 'a failed attach is a failure, not an empty session')
  check(result.note.includes('unable to find a device'), 'and the note carries LLDB\'s words', result.note)
}

section('a session that never stops gives up rather than hanging')
{
  const { session } = sessionWith(() => { /* the process never stops */ })
  session.start()
  const waited = await session.waitForStopped({ timeoutMs: 500, probeAfterMs: 100 })
  eq(waited.stopped, false, 'waiting ends')
  check(waited.detail.includes('after'), 'with a detail that says how long it waited', waited.detail)
}

// --- evaluating ------------------------------------------------------------

section('expressions run only while the process is stopped')
{
  const { child: scripted, session } = sessionWith((line, c) => {
    if (line.startsWith('po')) {
      if (session.state === 'stopped') c.say('<UIWindow: 0x1; frame = (0 0; 390 844)>')
      else c.say('error: unable to evaluate expression while the process is running: the process must be stopped')
    }
  })
  session.start()
  scripted.say('Process 9 resuming')
  await sleep(20)
  const refused = await session.evaluate('po 1')
  eq(refused.ok, false, 'a running process cannot be evaluated against')
  check(refused.note.includes('running'), 'and the refusal names the state', refused.note)

  scripted.say('Process 9 stopped')
  await sleep(20)
  const allowed = await session.evaluate('po 1')
  eq(allowed.ok, true, 'the same expression runs once the process stops')
  eq(allowed.text, '<UIWindow: 0x1; frame = (0 0; 390 844)>', 'and the answer is the dump')
}

section('a stopped process yields the dump, and an error is not an empty result')
{
  const { child: scripted, session } = sessionWith((line, c) => {
    if (line.includes('recursiveDescription')) {
      c.say('<UIWindow: 0x1; frame = (0 0; 390 844)>')
      c.say('   | <UIView: 0x2; frame = (0 0; 390 844)>')
    }
    if (line === 'po bad') c.say("error: use of undeclared identifier 'bad'")
  })
  session.start()
  scripted.say('Process 9 stopped')
  await sleep(20)
  const dump = await session.evaluate('po [[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]')
  eq(dump.ok, true, 'the dump arrives while stopped')
  eq(dump.text.split('\n').length, 2, 'with both of its lines, ready for the view-hierarchy parser')
  const bad = await session.evaluate('po bad')
  eq(bad.ok, false, 'an expression that fails is a failure')
  eq(bad.text, '', 'and does not masquerade as an empty hierarchy')
  check(bad.error.includes('undeclared identifier'), 'the error text is preserved rather than swallowed', bad.error)
}

section('an empty stop state is still refused with a reason, never as an empty hierarchy')
{
  const { session } = sessionWith(() => {})
  session.start()
  await sleep(20)
  const result = await session.evaluate('po anything', { timeoutMs: 200 })
  check(result.ok === false || result.text === '', 'no output is reported as no output')
  check(typeof result.note === 'string', 'with an explanation')
}

// --- lifecycle -------------------------------------------------------------

section('resume is fire-and-forget, so the interrupt that follows it is not stuck behind it')
{
  const { session } = sessionWith((line, c) => {
    if (line === 'continue') {
      // Like the real thing: the interpreter says nothing while the inferior runs.
      c.block()
      c.say('Process 12 resuming')
    }
    if (line === 'process interrupt') {
      setTimeout(() => { c.say('Process 12 stopped'); c.unblock() }, 50)
    }
  })
  session.start()
  check(session.resume() === true, 'resume writes the command')
  await sleep(20)
  eq(session.state, 'running', 'and the process is running')
  const stopped = await session.interrupt()
  eq(stopped.ok, true, 'interrupt still gets through: it is not queued behind a sentinel that cannot arrive')
  eq(session.state, 'stopped', 'and the process is stopped again')
}

section('dispose ends the child')
{
  const { child: scripted, session } = sessionWith(() => {})
  session.start()
  await session.dispose()
  check(scripted.written.includes('quit'), 'a polite quit is sent first')
  eq(session.state, 'dead', 'and the session is dead afterwards')
  const again = await session.send('po 1')
  eq(again.completed, false, 'a dead session refuses further commands instead of writing into a closed pipe')
}

section('a child that ignores quit is signalled')
{
  const { child: scripted, session } = sessionWith(() => {})
  scripted.kill = (signal) => { scripted.kills.push(signal); return true }  // never closes
  session.start()
  await session.dispose()
  check(scripted.kills.includes('SIGTERM'), 'SIGTERM is the escalation')
  check(scripted.kills.includes('SIGKILL'), 'and SIGKILL the last resort, so no debugger is left behind')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
