// The pymobiledevice3 forwarder that gives lldb a debugserver port on an iOS 16 and earlier device.
//
// `pymobiledevice3 developer debugserver start-server --local-port <port>` never exits: it prints the
// lldb steps and `Started port forwarding. Press Ctrl-C to close this shell when done`, then serves.
// Awaited like a command it hangs forever, so these checks pin the three ways it can go: ready, dies
// first, or says nothing — each must return, and only "ready" may leave a child running.
//
// Run: node test/legacy-forwarder.test.mjs
import { EventEmitter } from 'node:events'
import { FORWARDING_READY, forwarderArgv, freePort, startForwarder } from '../lib/legacy-forwarder.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

/** A child that prints `lines` (after `delayMs`), and records the signals it is sent. */
function fakeChild({ lines = [], exitAfter = null, delayMs = 10 }) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    setTimeout(() => child.emit('close', null), 1)
    return true
  }
  setTimeout(() => {
    for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`))
    if (exitAfter !== null) child.emit('close', exitAfter)
  }, delayMs)
  return child
}

// The real output, copied from the iPhone X run.
const REAL = [
  'Follow the following connections steps from LLDB:',
  '(lldb) platform select remote-ios',
  '(lldb) process connect connect://[127.0.0.1]:12345   <-- ACTUAL CONNECTION DETAILS!',
  '(lldb) process launch',
  'Started port forwarding. Press Ctrl-C to close this shell when done',
]

check(FORWARDING_READY.test(REAL.at(-1)), 'the ready line is recognised')
check(!REAL.slice(0, -1).some((line) => FORWARDING_READY.test(line)), 'and the instructions before it are not mistaken for it')

const argv = forwarderArgv({ tool: '/opt/homebrew/bin/pymobiledevice3', udid: 'd6c2c9dd', port: 12345 })
check(argv.join(' ') === '/opt/homebrew/bin/pymobiledevice3 developer debugserver start-server --local-port 12345 --udid d6c2c9dd',
  'the argv names the port and the phone', argv.join(' '))

const port = await freePort()
check(Number.isInteger(port) && port > 0, 'a free port is chosen by the kernel', String(port))

{
  let spawned = null
  const started = await startForwarder({
    tool: 'pm3', udid: 'd6c2c9dd', port: 40001, timeoutMs: 2000,
    spawnFn: (cmd, args) => { spawned = fakeChild({ lines: REAL }); spawned.argv = [cmd, ...args]; return spawned },
  })
  check(started.ok && started.port === 40001, 'ready once it says it is forwarding', JSON.stringify(started))
  check(started.alive(), 'and it is left running for lldb to connect through')
  check(spawned.signals.length === 0, 'a ready forwarder is not killed')
  started.stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(spawned.signals[0] === 'SIGINT', 'stop() sends it Ctrl-C, which it handles', JSON.stringify(spawned.signals))
  check(!started.alive(), 'and then it is gone')
}

{
  const t0 = Date.now()
  const started = await startForwarder({
    tool: 'pm3', udid: 'x', port: 40002, timeoutMs: 2000,
    spawnFn: () => fakeChild({ lines: ['ERROR: InvalidService com.apple.debugserver.DVTSecureSocketProxy'], exitAfter: 1 }),
  })
  check(!started.ok && Date.now() - t0 < 1000, 'a forwarder that dies is reported at once, not waited on')
  check(/InvalidService/.test(started.note), 'with what it said', started.note)
}

{
  let spawned = null
  const t0 = Date.now()
  const started = await startForwarder({
    tool: 'pm3', udid: 'x', port: 40003, timeoutMs: 150,
    spawnFn: () => { spawned = fakeChild({ lines: ['Follow the following connections steps from LLDB:'] }); return spawned },
  })
  check(!started.ok && Date.now() - t0 < 1000, 'a forwarder that never gets ready is given up on within the bound')
  check(/within/.test(started.note), 'and the note says it timed out', started.note)
  check(spawned.signals.length > 0, 'and it is killed rather than left holding the phone', JSON.stringify(spawned.signals))
}

{
  const started = await startForwarder({ tool: 'pm3', udid: 'x', port: 40004, spawnFn: () => { throw new Error('spawn pm3 ENOENT') } })
  check(!started.ok && /ENOENT/.test(started.note), 'a tool that cannot start is a refusal, not a throw', started.note)
}

console.log(`${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exit(1)
console.log('legacy-forwarder OK')
