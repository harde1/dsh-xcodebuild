/**
 * A phone's probe port, forwarded to this Mac by `iproxy`.
 *
 * A simulator shares the Mac's network stack, so its helper is reached at `127.0.0.1:<port>` with
 * nothing in between. A device does not: the helper binds loopback inside the phone, and the only way
 * to it is usbmuxd, which `iproxy` (from libusbmuxd, alongside the libimobiledevice tools this plugin
 * already needs for iOS 16 and earlier) turns into a local port. That difference is the whole content
 * of this module — everything above it talks to `127.0.0.1:<localPort>` either way.
 *
 * `iproxy` says nothing when it is ready; it binds the local port and waits. So readiness is measured
 * the way a client measures it — by connecting — rather than by reading a line that never comes.
 * Measured on an iPhone 13: the bind is immediate, and a connection without a device-side listener is
 * accepted and then closed, which is why readiness is "the port accepts", not "the app answered".
 *
 * @module dsh-xcodebuild/probe-forward
 */
import { connect } from 'node:net'

/** argv for one forward. The udid is an option; the ports are one `local:device` argument. */
export function iproxyArgv({ udid, localPort, devicePort }) {
  const spec = `${String(localPort)}:${String(devicePort)}`
  return udid === '' ? [spec] : ['-u', String(udid), spec]
}

/** Can something be connected to on this port right now? */
function portAnswers(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (answer) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

/**
 * Start `iproxy` and wait until its local port answers.
 *
 * Bounded, and a forwarder that never became ready is killed before this returns — a background
 * process left holding a port is the kind of thing that makes the next attempt fail for no visible
 * reason.
 *
 * @param {{tool: string, udid: string, localPort: number, devicePort: number, timeoutMs?: number,
 *   spawnFn: Function, probePort?: Function}} spec - `spawnFn` is `child_process.spawn`, injected for
 *   tests; `probePort` replaces the connection test.
 * @returns {Promise<{ok: boolean, localPort: number, note: string, alive: () => boolean, stop: () => void}>}
 */
export async function startIproxy({ tool, udid, localPort, devicePort, timeoutMs = 8000, spawnFn, probePort = portAnswers }) {
  const dead = { ok: false, localPort, note: '', alive: () => false, stop: () => {} }
  if (!Number.isInteger(localPort) || localPort <= 0 || !Number.isInteger(devicePort) || devicePort <= 0) {
    return { ...dead, note: 'the forward needs two ports' }
  }
  let child = null
  try {
    child = spawnFn(tool, iproxyArgv({ udid, localPort, devicePort }), { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ...dead, note: String(error?.message ?? error) }
  }
  let exited = false
  let said = ''
  const collect = (chunk) => { said += String(chunk) }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const stop = () => {
    if (exited) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (!exited) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
    }, 2000).unref?.()
  }
  const deadline = Date.now() + timeoutMs
  let ready = false
  let error = ''
  child.on('error', (reason) => { error = String(reason?.message ?? reason) })
  child.on('close', () => { exited = true })
  while (Date.now() < deadline && !exited && error === '') {
    // eslint-disable-next-line no-await-in-loop
    if (await probePort(localPort)) {
      ready = true
      break
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!ready) {
    stop()
    const why = error !== '' ? error : `iproxy did not forward within ${String(Math.round(timeoutMs / 1000))} s`
    const last = said.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-2).join(' / ')
    return { ok: false, localPort, note: last === '' ? why : `${why}: ${last}`, alive: () => false, stop }
  }
  // A forwarder must not outlive the host that started it, even when the host exits without
  // disposing the plugin.
  const onExit = () => { if (!exited) { try { child.kill('SIGKILL') } catch { /* gone */ } } }
  process.once('exit', onExit)
  child.on('close', () => process.removeListener('exit', onExit))
  return { ok: true, localPort, note: '', alive: () => !exited, stop }
}
