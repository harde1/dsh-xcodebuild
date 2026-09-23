// Reading a running app's own log off the device, live.
//
// The file the app writes into its container is the complete record, but it can only be
// fetched by downloading it whole: measured on an iPhone X, `ios-deploy --download` of
// `Documents/PPCrashLog` took **50 seconds** for 2.4 MB, and the app's current launch
// log was 2 MB of it after ten minutes. Re-downloading that on a timer is why the panel
// fell a minute behind, and no amount of tuning fixes a reader that moves the whole file
// to learn one new line.
//
// The device's own log relay has no such problem: `idevicesyslog -p <process>` streams
// lines as the app writes them. Measured on the same phone, six seconds of the app's
// runtime produced 289 lines — including every `cpu: … fps: …` line the file pump had
// been delivering a minute late.
//
// What that costs is one piece of decoding. `idevicesyslog` escapes every byte outside
// printable ASCII in the `cat -v` notation, so a log line arrives as
//
//   \M-p\M^_\M^_\M-) [D] 11:30:45.395 PPHomeRecommendCell[1264] cpu:4 …
//
// where the first four escapes are the UTF-8 bytes F0 9F 9F A9 — 🟩. Everything here
// turns that back into the text the app actually wrote, which is what makes the stream
// readable in the panel and searchable by the filter that already exists.

/**
 * One escaped byte, in either of the two forms `cat -v` uses.
 *
 * The plain form carries a dash — `\M-p` is byte 0x70 with the high bit set — while the
 * caret form does not: the real output reads `\M-p\M^_\M^_\M-)` for 🟩, so a pattern
 * that insisted on the dash would decode the lead byte and leave the other three behind.
 * The dash is accepted in both forms because that costs nothing and the notation allows
 * it.
 */
const ESCAPED = /^\\M(-?)(\^?)([\s\S])/
/** A bare `^X`, which is how a control byte is written when there is no high bit. */
const BARE_CARET = /^\^([\s\S])/

/**
 * Undo `idevicesyslog`'s escaping, one line at a time.
 *
 * The escapes are per byte, so the bytes are collected first and decoded as UTF-8
 * afterwards — decoding each escape on its own would turn a multi-byte character into
 * mojibake, which is exactly what the emoji and the Chinese in these logs are made of.
 * A byte that is not valid UTF-8 on its own reads as the replacement character rather
 * than being dropped, and an escape this function does not recognise is kept verbatim: a
 * decoder that silently loses what it does not understand is worse than no decoder.
 *
 * @param {string} line - one line of `idevicesyslog` output.
 * @returns {string} the text the device actually logged.
 */
export function decodeSyslogEscapes(line) {
  const text = String(line ?? '')
  if (!text.includes('\\') && !text.includes('^')) return text
  const bytes = []
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    if (rest.startsWith('\\\\')) {
      bytes.push(0x5c)
      index += 2
      continue
    }
    const escaped = ESCAPED.exec(rest)
    if (escaped !== null) {
      const [, dash, caret, character] = escaped
      const code = character.charCodeAt(0)
      bytes.push(caret === '^' ? ((code ^ 0x40) | 0x80) & 0xff : (code | 0x80) & 0xff)
      index += 1 + 1 + dash.length + (caret === '^' ? 2 : 1)
      continue
    }
    const control = rest[1]
    const mapped = rest[0] === '\\' && control === 'n' ? 0x0a
      : rest[0] === '\\' && control === 't' ? 0x09
        : rest[0] === '\\' && control === 'r' ? 0x0d
          : null
    if (mapped !== null) {
      bytes.push(mapped)
      index += 2
      continue
    }
    const bare = BARE_CARET.exec(rest)
    if (bare !== null) {
      bytes.push((bare[1].charCodeAt(0) ^ 0x40) & 0xff)
      index += 2
      continue
    }
    const code = text.codePointAt(index) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      index += 1
      continue
    }
    for (const byte of new TextEncoder().encode(String.fromCodePoint(code))) bytes.push(byte)
    index += code > 0xffff ? 2 : 1
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/**
 * The process name the device's log relay will report for an app.
 *
 * It is the bundle's own name: `/…/Demo-Dev.app` logs as `Demo-Dev`, which is what the
 * `--process` filter has to match. An app whose bundle cannot be read gives null, and
 * the caller falls back to the container-file reader rather than streaming every
 * process on the phone into the panel.
 *
 * @param {string} appPath - the built `.app` path.
 * @returns {string|null} the process name, or null when it cannot be known.
 */
export function syslogProcessName(appPath) {
  const path = String(appPath ?? '')
  if (path === '') return null
  const name = path.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!name.toLowerCase().endsWith('.app')) return null
  const stem = name.slice(0, -4)
  return stem === '' ? null : stem
}

/**
 * The four levels a system log line can have, in the app's own vocabulary.
 *
 * `os_log` has five types, and the app's `LogLevel` collapses onto them:
 *
 *   .verbose, .debug -> .debug   (0x02) -> `<Debug>:`
 *   .info            -> .info    (0x01) -> `<Info>:`
 *   .warning         -> .default (0x00) -> `<Notice>:`
 *   .error           -> .fault   (0x11) -> `<Fault>:`
 *
 * so reading one back off the device is the reverse of that map — and `verbose` is the
 * name of the two lowest types together, because `.verbose` and `.debug` are written
 * identically and nothing downstream can tell them apart again.
 */
export const SYSLOG_LEVELS = ['verbose', 'info', 'warning', 'error']

/**
 * What the device writes for each level, and which of the four it means.
 *
 * Measured in libimobiledevice's own source, not guessed. `idevicesyslog` prints the
 * os_trace header's raw level through a `switch`, and the numbers in it are the OSLogType
 * values above: `0` is "Notice", `0x01` "Info", `0x02` "Debug", `0x10` "Error", `0x11`
 * "Fault". The older `--syslog-relay` path does not parse the level at all — it recognizes
 * the four spellings the device sends (`<Notice>:`, `<Error>:`, `<Warning>:`, `<Debug>:`)
 * only to colour them — so `<Warning>` and `<Default>` are accepted too, and the ASL
 * severities above Error are read as errors rather than dropped.
 *
 * `<Notice>` is the one that has to be spelled out. It is the app's **warning**: written
 * as OSLogType `.default`, which the device calls Notice. Anything that knew only
 * `<Error>`/`<Fault>` would show every warning the app ever wrote as an ordinary line.
 *
 * The colon is part of the token on purpose. It is how the device writes it and how the
 * tool matches it, and requiring it keeps a message that merely mentions `<Error>` in
 * its text from being read as one.
 */
const LEVEL_TOKENS = {
  Debug: 'verbose',
  Verbose: 'verbose',
  Info: 'info',
  Notice: 'warning',
  Default: 'warning',
  Warning: 'warning',
  Error: 'error',
  Fault: 'error',
  Critical: 'error',
  Alert: 'error',
  Emergency: 'error',
}

/** One level token anywhere in a line: `<(Notice|…)>:`. */
const LEVEL_TOKEN = /<(Debug|Verbose|Info|Notice|Default|Warning|Error|Fault|Critical|Alert|Emergency)>:/

/**
 * The app's own marker for the same four levels, as its logging writes them.
 *
 * Measured on both channels, and it is the same logger in both:
 *
 *   modern console, iPhone 12 (iOS 26.6.2), 1.5s after the launch:
 *   2026-09-23 11:41:19.145 Demo-Dev[29303:4901955] 🟦 [I] 11:41:19.145 PPTaskQueue[38] cpu:7 内存:40
 *   classic relay, iPhone X (iOS 16.7.12):
 *   🟩 [D] 11:30:45.395 PPHomeRecommendCell[1264] cpu:4 …
 *
 * `[V]`, `[D]` and `[I]` are the three that were measured; `[W]` and `[E]` are their
 * `.warning` and `.error`, which the mapping above writes as `.default` and `.fault`.
 * `[D]` reads as `verbose` because that is what the four-level vocabulary has room for:
 * `.verbose` and `.debug` are written identically to the device, so a reader cannot put
 * them back apart — and the panel has no separate debug level to put it in.
 *
 * The timestamp is part of the marker on purpose. It is what the app writes next, always,
 * and requiring it is what keeps a bracketed `[E]` in somebody's prose from being read as
 * a level.
 */
const LEVEL_MARKER = /\[([VDIWE])\]\s+\d{1,2}:\d{2}:\d{2}\.\d{1,3}/
const MARKER_LEVELS = { V: 'verbose', D: 'verbose', I: 'info', W: 'warning', E: 'error' }

/** How severe each level is, for the one case where two spellings disagree. */
const LEVEL_RANK = { verbose: 0, info: 1, warning: 2, error: 3 }

/**
 * The level a streamed line declared, or null when it declared none.
 *
 * Null is not a level and never becomes one: a line the device did not tag (a continuation
 * of a multi-line message, the tool's own chatter, a raw `--syslog-relay` line whose token
 * this does not know) leaves the question open for the text classifier to answer, rather
 * than being called `verbose` on no evidence.
 *
 * @param {string} line - a decoded stream line.
 * @returns {'verbose'|'info'|'warning'|'error'|null} the declared level, or null.
 */
export function syslogLevel(line) {
  const text = String(line ?? '')
  const token = LEVEL_TOKEN.exec(text)
  const marker = LEVEL_MARKER.exec(text)
  const declared = token === null ? null : LEVEL_TOKENS[token[1]]
  const own = marker === null ? null : MARKER_LEVELS[marker[1]]
  if (declared === null) return own
  if (own === null) return declared
  // Both spellings come from the same logger, so they normally agree: `[W]` is written as
  // `.default` and the line carries `<Notice>:`. When they do not, the more severe one
  // wins — a device that says `<Fault>:` is not made harmless by a marker that says `[I]`.
  return LEVEL_RANK[own] >= LEVEL_RANK[declared] ? own : declared
}

/**
 * How a streamed line should read in the panel.
 *
 * Only the severity the device itself declared is used: guessing from the app's own text
 * would paint ordinary logging red, and would let a debug line that happens to mention an
 * error be counted as one. The four declared levels are the four kinds the panel groups
 * them by — the same four names, because they are the same four levels — so a level the
 * device stated is never given a second opinion by the text classifier.
 *
 * @param {string} line - a decoded stream line.
 * @returns {'verbose'|'info'|'warning'|'error'|undefined} the panel kind, or undefined
 *   when the line declared no level.
 */
export function syslogLineKind(line) {
  const level = syslogLevel(line)
  return level === null ? undefined : level
}

/**
 * The command that streams one app's log off the device.
 *
 * `-x` is what makes this self-limiting: the stream ends when the phone goes away, so a
 * disconnected device surfaces as an ended reader instead of a process that looks alive
 * and delivers nothing. `--no-colors` keeps ANSI escapes out of the panel, and the
 * `--process` filter keeps the rest of the phone's logging out of it.
 *
 * @param {{launcher: string, udid: string, processName: string}} spec - what to stream.
 * @returns {string[]} argv.
 */
export function syslogFeedArgv(spec) {
  return [
    spec.launcher,
    '-u', spec.udid,
    '-p', spec.processName,
    '-x',
    '--no-colors',
  ]
}
