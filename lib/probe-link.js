/**
 * Talking to the helper inside the app.
 *
 * One request is one connection: a single `\n`-terminated JSON object out, a single one back, then
 * the socket closes. There is no session to keep, no reconnect to write, and no state to get wrong
 * when the app is relaunched — which matters, because the app is relaunched constantly and the port
 * that answered a minute ago is then nobody's.
 *
 * Every request has a deadline. That is not politeness: the helper answers on the app's MAIN thread,
 * so a request that arrives while the debugger has the app stopped does not fail, it waits — and a
 * wait with no deadline is a panel that hangs until someone kills it. A timeout here is answered as
 * "the app did not answer", and the caller falls back to reading through the debugger.
 *
 * @module dsh-xcodebuild/probe-link
 */
import { connect } from 'node:net'

/** How long one request is given by default: a tree of a large app is a second, a click is milliseconds. */
export const PROBE_TIMEOUT_MS = 8000

/** Longest reply accepted, so a runaway app cannot exhaust the host's memory. */
export const PROBE_MAX_REPLY = 32 * 1024 * 1024

/**
 * One request, one reply.
 *
 * @param {{port: number, request: object, timeoutMs?: number, host?: string}} spec
 * @returns {Promise<{ok: boolean, reply: object|null, note: string, ms: number}>}
 */
export function probeRequest({ port, request, timeoutMs = PROBE_TIMEOUT_MS, host = '127.0.0.1' }) {
  const started = Date.now()
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve({ ok: false, reply: null, note: `no probe port to talk to (${String(port)})`, ms: 0 })
      return
    }
    let socket = null
    let settled = false
    let buffer = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        /* already closed */
      }
      resolve({ ...result, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, reply: null, note: `the app did not answer within ${String(timeoutMs)} ms` }), timeoutMs)
    try {
      socket = connect({ port, host })
    } catch (error) {
      finish({ ok: false, reply: null, note: String(error?.message ?? error) })
      return
    }
    socket.setNoDelay(true)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > PROBE_MAX_REPLY) {
        finish({ ok: false, reply: null, note: 'the app sent more than this plugin is willing to read' })
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        finish({ ok: false, reply: null, note: `the app answered something that is not JSON: ${line.slice(0, 120)}` })
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        finish({ ok: false, reply: null, note: 'the app answered JSON that is not an object' })
        return
      }
      const ok = Number(parsed.ok) === 1
      finish({ ok, reply: parsed, note: ok ? '' : String(parsed.note ?? 'the app refused the request') })
    })
    socket.on('error', (error) => {
      const code = error?.code ?? ''
      const why = code === 'ECONNREFUSED'
        ? 'the app is not listening any more (it was relaunched, or the helper was unloaded)'
        : String(error?.message ?? error)
      finish({ ok: false, reply: null, note: why })
    })
    socket.on('close', () => {
      finish({ ok: false, reply: null, note: 'the app closed the connection without answering' })
    })
  })
}

/**
 * Is the helper alive in the app at this port?
 *
 * Asked before anything is read through it, because a port that answers is a port whose app is
 * running the helper — and a stale answer from the previous launch of the app is exactly what a
 * version check catches.
 *
 * @param {{port: number, timeoutMs?: number}} spec
 * @returns {Promise<{ok: boolean, version: number, pid: number, bundle: string, note: string}>}
 */
export async function probePing({ port, timeoutMs = 3000 }) {
  const answer = await probeRequest({ port, request: { op: 'ping' }, timeoutMs })
  if (!answer.ok) return { ok: false, version: 0, pid: 0, bundle: '', note: answer.note }
  return {
    ok: true,
    version: Number(answer.reply?.version ?? 0),
    pid: Number(answer.reply?.pid ?? 0),
    bundle: String(answer.reply?.bundle ?? ''),
    note: '',
  }
}

/**
 * The text one op answered with, or why it did not.
 *
 * Every op but `edit`/`ping`/`bye` answers with report text in the same shape the LLDB expression
 * printed, which is the point of the helper: the host's parsers are reused as they are.
 *
 * @param {{port: number, op: string, params?: object, timeoutMs?: number}} spec
 * @returns {Promise<{ok: boolean, text: string, value: string, note: string, ms: number}>}
 */
export async function probeText({ port, op, params = {}, timeoutMs = PROBE_TIMEOUT_MS }) {
  const answer = await probeRequest({ port, request: { op, ...params }, timeoutMs })
  return {
    ok: answer.ok,
    text: typeof answer.reply?.text === 'string' ? answer.reply.text : '',
    value: typeof answer.reply?.value === 'string' ? answer.reply.value : '',
    note: answer.note,
    ms: answer.ms,
  }
}
