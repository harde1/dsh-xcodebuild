/**
 * A debugserver port for an iOS 16 and earlier device, forwarded by pymobiledevice3.
 *
 * `pymobiledevice3 developer debugserver start-server --local-port <port>` starts the device's
 * debugserver over lockdown and forwards `127.0.0.1:<port>` to it — the piece libimobiledevice 1.3.0
 * could not provide (see `legacy-inspector.js`). It does not exit: it prints the lldb steps, then
 * `Started port forwarding. Press Ctrl-C to close this shell when done` and serves until killed.
 * So it is never awaited like a command. It is started in the background, judged ready by that
 * line, and owned by whoever started it until `stop()`.
 *
 * Measured on an iPhone X, iOS 16.7.12: the line arrives in about 3 s, each lldb connection gets its
 * own debugserver, and one forwarder serves one connection after another.
 *
 * @module dsh-xcodebuild/legacy-forwarder
 */

import { createServer } from 'node:net'

/** The line start-server prints once the local port is listening. */
export const FORWARDING_READY = /Started port forwarding/

/**
 * A port nothing on this Mac is listening on, chosen by the kernel.
 *
 * @returns {Promise<number>} the port.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * The argv for the forwarder.
 *
 * @param {{tool: string, udid: string, port: number}} spec - the resolved pymobiledevice3, the
 *   hardware udid, and the local port.
 * @returns {string[]} argv.
 */
export function forwarderArgv({ tool, udid, port }) {
  return [tool, 'developer', 'debugserver', 'start-server', '--local-port', String(port), '--udid', udid]
}

/**
 * Start a forwarder and wait until it says it is listening.
 *
 * Never hangs: the wait is bounded, and a forwarder that did not get ready is killed before this
 * returns. What it printed is handed back so a failure can be read.
 *
 * @param {{tool: string, udid: string, port?: number, timeoutMs?: number,
 *   spawnFn: Function}} spec - `spawnFn` is `child_process.spawn` (injected for tests).
 * @returns {Promise<{ok: boolean, port: number, note: string, alive: () => boolean, stop: () => void}>}
 */
export async function startForwarder({ tool, udid, port, timeoutMs = 20000, spawnFn }) {
  const chosen = Number.isInteger(port) && port > 0 ? port : await freePort()
  const argv = forwarderArgv({ tool, udid, port: chosen })
  let child = null
  try {
    child = spawnFn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, port: chosen, note: String(error?.message ?? error), alive: () => false, stop: () => {} }
  }
  let exited = false
  let said = ''
  const stop = () => {
    if (exited) return
    try {
      child.kill('SIGINT')
    } catch {
      /* already gone */
    }
    // start-server handles Ctrl-C; a forwarder that ignores it is not left behind.
    setTimeout(() => {
      if (!exited) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, 2000).unref?.()
  }
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    const onData = (chunk) => {
      said += String(chunk)
      if (FORWARDING_READY.test(said)) {
        clearTimeout(timer)
        resolve('ready')
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      said += `\n${String(error?.message ?? error)}`
      clearTimeout(timer)
      resolve('error')
    })
    child.on('close', () => {
      exited = true
      clearTimeout(timer)
      resolve('exited')
    })
  })
  if (ready === 'ready') {
    // A forwarder is a Python process holding a lockdown session to the phone; it must not outlive
    // the host that started it, even when the host exits without disposing the plugin.
    const onExit = () => { if (!exited) { try { child.kill('SIGKILL') } catch { /* gone */ } } }
    process.once('exit', onExit)
    child.on('close', () => process.removeListener('exit', onExit))
    return { ok: true, port: chosen, note: '', alive: () => !exited, stop }
  }
  stop()
  const last = said.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-2).join(' / ')
  const why = ready === 'timeout'
    ? `pymobiledevice3 did not start forwarding within ${String(Math.round(timeoutMs / 1000))} s`
    : 'pymobiledevice3 stopped before it started forwarding'
  return { ok: false, port: chosen, note: last === '' ? why : `${why}: ${last}`, alive: () => false, stop }
}
