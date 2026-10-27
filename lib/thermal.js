/**
 * The phone's battery temperature, and what it does to a run's log.
 *
 * A run cannot report why a phone behaved the way it did without knowing how hot the phone was.
 * The device's own battery temperature is the one measurement that says so, and it is available
 * without the app being instrumented: the PMU reports it over the classic diagnostics channel, so
 * the same instrumentation that has to work on a **Release** build — where no code of the user's can
 * be inserted — reads it too.
 *
 * **Where the temperature comes from.** `pymobiledevice3 diagnostics battery monitor --udid <udid>`
 * streams one JSON object per second:
 *
 * ```json
 * {"InstantAmperage": 858, "Temperature": 3179, "Voltage": 4297, "IsCharging": true, "CurrentCapacity": 93}
 * ```
 *
 * Apple's PMU reports temperature in **0.01 °C**, which is why 3179 is 31.79 °C rather than 3179 °C —
 * and it is why this module divides by 100 and not by anything else. `xcrun devicectl device info
 * details` does not carry a battery at all (measured on an iPhone 13: no `Battery` section in the
 * whole output), so the diagnostics channel is the only source that works for every generation this
 * plugin addresses.
 *
 * **Why it is an augmentation, not a dependency.** The tool is optional and the device may refuse it.
 * A run that cannot record temperature must still build, install and launch exactly as it did before,
 * and say so rather than failing silently: the user asking "why is this line cold?" would otherwise
 * never know the temperature was never read.
 *
 * **What it is for.** Every line a run produces is tagged `[T=28.69C]` while a temperature is known,
 * so a log read after the fact answers "was the phone hot when this failed?" without opening
 * Instruments. The samples are also kept, and the same 5-minute ≥ 0.3 °C window analysis that
 * `scripts/thermal_merge.py` prints is printed at the end of the run.
 *
 * @module dsh-xcodebuild/thermal
 */

/** Apple's PMU temperature unit: 0.01 °C per count. */
export const THERMAL_TEMP_UNIT = 0.01

/** A sample is taken at most this often; the device itself streams at about 1 Hz. */
export const THERMAL_SAMPLE_INTERVAL_MS = 1000

/** The longest gap between two samples that still counts as one continuous record. */
export const THERMAL_MIN_GAP_S = 240
export const THERMAL_MAX_GAP_S = 360

/** The window the temperature is measured over, and how much warming has to happen in it. */
export const THERMAL_WINDOW_S = 300
export const THERMAL_WINDOW_THRESHOLD = 0.3

/** Bucket width for the smoothing pass; the PMU quantizes in steps that need smoothing. */
export const THERMAL_BUCKET_S = 5

/** Lines a `syslog` relay produces start with this timestamp, which is what the analysis keys on. */
const LINE_TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/

/** Numbers are replaced, so that two lines differing only in their numbers compare equal. */
const NUMBER_RE = /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g

/**
 * Ask a device for its battery, as a stream of JSON objects.
 *
 * @param {string} udid - the device identifier.
 * @param {string} pymobiledevice3 - path to the tool, or the bare name to look up on PATH.
 * @returns {string[]} argv.
 */
export function batteryMonitorArgv(udid, pymobiledevice3 = 'pymobiledevice3') {
  return [pymobiledevice3, 'diagnostics', 'battery', 'monitor', '--udid', String(udid)]
}

/**
 * Read one battery sample out of one line of the monitor's output.
 *
 * A line that is not the device's JSON answer — a connection error, a usage line, a shell warning —
 * is not a sample, and answering `null` is what keeps those out of the CSV and the analysis rather
 * than being parsed as a temperature of zero.
 *
 * @param {string} text - one line of the monitor's output.
 * @returns {{tempC: number|null, charging: boolean, currentMa: number|null,
 *   capacity: number|null}|null} the sample, or null when the line is not one.
 */
export function parseBatterySample(text) {
  const line = String(text ?? '').trim()
  if (line === '' || !line.startsWith('{')) return null
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null

  // A temperature that is not a number is not a temperature. The PMU's own unit is 0.01 °C, so
  // 3179 means 31.79 °C; a value that already looks like a whole number of degrees is what a
  // future tool would print instead, and guessing which one it is would be worse than refusing.
  let tempC = null
  if (typeof obj.Temperature === 'number' && Number.isFinite(obj.Temperature)) {
    tempC = obj.Temperature * THERMAL_TEMP_UNIT
  }
  return {
    tempC,
    charging: obj.IsCharging === true,
    currentMa: typeof obj.InstantAmperage === 'number' ? obj.InstantAmperage : null,
    capacity: typeof obj.CurrentCapacity === 'number' ? obj.CurrentCapacity : null,
  }
}

/**
 * The tag a line is given while a temperature is known.
 *
 * `[T=28.69C+]` — the plus says the phone is on charge, because charging warms a phone on its own
 * and a log that cannot tell the two apart invites the wrong conclusion. No temperature means no
 * tag at all: a tag reading `--.--C` would be noise where an absence is information.
 *
 * @param {number|null} tempC - the current temperature in °C.
 * @param {boolean} charging - whether the phone is charging.
 * @returns {string|null} the tag, or null when there is no temperature.
 */
export function thermalTag(tempC, charging) {
  if (typeof tempC !== 'number' || !Number.isFinite(tempC)) return null
  return `[T=${tempC.toFixed(2)}C${charging ? '+' : ''}]`
}

/**
 * Tag a line that a run produced, leaving the classification untouched.
 *
 * The tag is a display prefix: it must not be what `classify` sees, because `/^\s*note:/` and
 * `/^(=== |--- |\$ )/` are anchored and a `[T=…]` prefix would turn notes and sections into plain
 * lines — the temperature would then be visible in the log while every line it sat on turned a
 * different colour. So the raw text is classified and the tagged text is stored.
 *
 * @param {string} line - the line as the producer wrote it.
 * @param {number|null} tempC - the temperature at the moment the line was produced.
 * @param {boolean} charging - whether the phone was charging then.
 * @returns {string} the line, tagged, or unchanged when there is no temperature.
 */
export function tagLine(line, tempC, charging) {
  const tag = thermalTag(tempC, charging)
  return tag === null ? String(line) : `${tag} ${String(line)}`
}

/**
 * Smooth the samples into a per-bucket series.
 *
 * The PMU quantizes its own reading, so one second of samples is a step function with a jump in it
 * that says nothing about the phone. Bucketing and averaging over a few seconds is what makes a
 * window worth finding.
 *
 * @param {Array<{at: number, tempC: number}>} samples - timestamped samples in seconds.
 * @param {number} bucketS - the bucket width.
 * @returns {Array<[number, number]>} `[bucketStart, averageTemperature]`, ascending.
 */
export function smoothSeries(samples, bucketS = THERMAL_BUCKET_S) {
  const buckets = new Map()
  for (const sample of samples) {
    if (typeof sample.tempC !== 'number' || !Number.isFinite(sample.tempC)) continue
    const key = Math.floor(sample.at / bucketS) * bucketS
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [sample.tempC])
    else bucket.push(sample.tempC)
  }
  return [...buckets.entries()]
    .map(([at, values]) => [at, values.reduce((sum, v) => sum + v, 0) / values.length])
    .sort((a, b) => a[0] - b[0])
}

/**
 * The windows in which the phone warmed by at least `threshold` °C.
 *
 * For each point the nearest earlier point 240–360 s before it is taken as the window's start, which
 * is what makes the window the ~5 minutes ending at that sample rather than an arbitrary slice. Only
 * the steepest of overlapping windows is kept, so a phone that warms for twenty minutes is reported
 * as the five minutes that mattered, and the report can point at a slice of the log.
 *
 * @param {Array<{at: number, tempC: number}>} samples - timestamped samples in seconds.
 * @param {object} [options] - the window shape.
 * @returns {Array<{start: number, end: number, delta: number, from: number, to: number}>}
 *   the windows, warmest first.
 */
export function findHotWindows(samples, options = {}) {
  const minGap = options.minGap ?? THERMAL_MIN_GAP_S
  const maxGap = options.maxGap ?? THERMAL_MAX_GAP_S
  const window = options.window ?? THERMAL_WINDOW_S
  const threshold = options.threshold ?? THERMAL_WINDOW_THRESHOLD

  const series = smoothSeries(samples)
  if (series.length < 3) return []

  const raw = []
  for (let i = 0; i < series.length; i += 1) {
    const [atI, tempI] = series[i]
    let best = null
    for (let k = i - 1; k >= 0; k -= 1) {
      const gap = atI - series[k][0]
      if (gap < minGap) continue
      if (gap > maxGap) break
      if (best === null || Math.abs(gap - window) < Math.abs(atI - series[best][0] - window)) best = k
    }
    if (best === null) continue
    const [atJ, tempJ] = series[best]
    const delta = tempI - tempJ
    if (delta >= threshold) raw.push({ start: atJ, end: atI, delta, from: tempJ, to: tempI })
  }

  // Overlapping windows are the same warming seen twice: keep the steeper one, and do not extend
  // its end, because the steepest five minutes are what a log slice should show.
  raw.sort((a, b) => a.start - b.start)
  const merged = []
  for (const candidate of raw) {
    const last = merged[merged.length - 1]
    if (last !== undefined && candidate.start <= last.end + 60) {
      if (candidate.delta > last.delta) merged[merged.length - 1] = candidate
    } else {
      merged.push(candidate)
    }
  }
  return merged.sort((a, b) => b.delta - a.delta)
}

/**
 * Normalize a log line so that lines differing only in their numbers compare equal.
 *
 * `TimeStamp 0x7f1234` and `TimeStamp 0x7f5678` are the same message at different moments, and a
 * window's "what fired here" is a count of messages, not of lines.
 *
 * @param {string} line - the raw log line.
 * @returns {string} the normalized line, capped so one huge line cannot dominate the report.
 */
export function normalizeLine(line) {
  let text = String(line ?? '')
  const match = LINE_TS_RE.exec(text)
  if (match !== null) text = text.slice(match[0].length).trimStart()
  return text.replace(NUMBER_RE, '#').slice(0, 140)
}

/**
 * The messages that fired most inside a window, with how often each fired outside it.
 *
 * The outside count is what makes the list useful: a message that fires equally often inside and
 * outside the window was doing its normal work and says nothing about the warming, while one that
 * only fires inside it is what the window is about.
 *
 * @param {Array<{at: number, line: string}>} records - timestamped log lines.
 * @param {number} start - the window's start, in seconds.
 * @param {number} end - the window's end, in seconds.
 * @param {number} topN - how many messages to return.
 * @returns {Array<{count: number, outside: number, message: string}>} the messages, busiest first.
 */
export function topMessages(records, start, end, topN) {
  const inside = new Map()
  const outside = new Map()
  for (const record of records) {
    const message = normalizeLine(record.line)
    const bucket = start <= record.at && record.at <= end ? inside : outside
    bucket.set(message, (bucket.get(message) ?? 0) + 1)
  }
  return [...inside.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([message, count]) => ({ count, outside: outside.get(message) ?? 0, message }))
}

/**
 * Format a timestamp the way the report writes windows.
 *
 * @param {number} epoch - seconds since the epoch.
 * @returns {string} `HH:MM:SS`.
 */
export function formatClock(epoch) {
  return new Date(epoch * 1000).toTimeString().slice(0, 8)
}

/**
 * The report a run prints at the end: the windows that warmed, and what fired inside them.
 *
 * It is written from the samples and the tagged lines the run already kept, so it costs nothing at
 * the time the lines were produced, and it is a slice of the run's own log — the same file the user
 * was reading when they asked what the temperature was doing.
 *
 * @param {object} input - what to report.
 * @param {Array<{at: number, tempC: number}>} input.samples - the samples, in seconds.
 * @param {Array<{at: number, line: string}>} input.records - the tagged lines, in seconds.
 * @param {string} [input.logPath] - the run log, for the `sed` command it prints.
 * @param {number} [input.topN] - how many messages per window.
 * @returns {{text: string, windows: number}} the report text and how many windows it found.
 */
export function thermalSummary({ samples, records, logPath = '', topN = 8 }) {
  const windows = findHotWindows(samples)
  const lines = ['', '==== 温度窗口分析（5 分钟升温 >= 0.3°C）====']
  if (windows.length === 0) {
    lines.push('没有找到明显升温窗口。可能原因：')
    lines.push('  · 本次运行太短（< 6 分钟）或温度平稳；')
    lines.push('  · 充电/环境温度干扰；')
    lines.push('  · 电池温度本身有 30~60 秒滞后，短时爆发看不出来。')
  } else {
    windows.slice(0, 5).forEach((w, index) => {
      const from = formatClock(w.start)
      const to = formatClock(w.end)
      lines.push('')
      lines.push(`#${index + 1}  ${from} → ${to}   +${w.delta.toFixed(2)}°C  (${w.from.toFixed(2)} → ${w.to.toFixed(2)})`)
      if (logPath !== '') lines.push(`    回看日志：sed -n '/${from}/,/${to}/p' ${logPath}`)
      const messages = topMessages(records, w.start, w.end, topN)
      if (messages.length > 0) {
        lines.push('    该窗口高频日志（次数 / 窗口外同款次数）：')
        for (const message of messages) lines.push(`      ${String(message.count).padStart(5)}x / ${String(message.outside).padStart(5)}x  ${message.message}`)
      }
      lines.push('    下一步：把这段窗口的时间戳对到 Instruments 的 Time Profiler /')
      lines.push('    Power Profiler 上，用 Invert Call Tree + Hide System Libraries 看热点符号。')
    })
  }
  return { text: lines.join('\n'), windows: windows.length }
}
