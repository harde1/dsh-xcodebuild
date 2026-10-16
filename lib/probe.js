/**
 * The helper this plugin loads INTO the app, and how it gets there.
 *
 * The problem it solves: reading a view tree through LLDB costs an app STOP. One click on a view, one
 * stop; the app stutters, animation frames go missing, and whatever state was being looked at is
 * gone by the time it runs again. The debugger is only genuinely needed to `dlopen` a library into a
 * running process — the app can answer every question about itself afterwards, from a thread of its
 * own, without ever being stopped.
 *
 * So the helper (`probe/xcb-probe.m`) is a small Objective-C server: one loopback socket, one JSON
 * object per line, and each op answering with the SAME text the LLDB expressions print. That last
 * part is the design decision that keeps both halves small — the host parses a probe answer with the
 * parsers it already has, so there is one format and not two, and the probe path can be compared
 * against the debugger path answer for answer.
 *
 * This module is the plumbing around it: how it is compiled for the target, how it is signed and
 * copied onto a device, and the one expression that loads it. Nothing here talks to a device itself.
 *
 * @module dsh-xcodebuild/probe
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file name of the built helper, in the cache and inside the app's container. */
export const PROBE_LIB = 'xcbprobe.dylib'

/** Oldest iOS the helper is built for. The plugin's own expressions reach further back; this does not. */
export const PROBE_MIN_IOS = '15.0'

/**
 * The helper's source, and the version of the protocol it speaks.
 *
 * The version is bumped whenever the answers change shape, so a host can tell an app that is running
 * an older copy — which is exactly what happens after an upgrade while the app is still running.
 */
export const PROBE_VERSION = 1

const HERE = dirname(fileURLToPath(import.meta.url))

/** The helper's Objective-C source. */
export function probeSourcePath() {
  return join(HERE, 'probe', 'xcb-probe.m')
}

/** The SDK name for a destination: what `xcrun --sdk` expects. */
export function probeSdk({ platform }) {
  return platform === 'simulator' ? 'iphonesimulator' : 'iphoneos'
}

/** The architecture to build for. Apple silicon Macs run arm64 simulators; a device is arm64. */
export function probeArch({ platform, hostArch }) {
  if (platform !== 'simulator') return 'arm64'
  return hostArch === 'x64' ? 'x86_64' : 'arm64'
}

/**
 * The compile line, as argv.
 *
 * Deliberately plain: one translation unit, no project, no headers beyond the SDK's. A helper that
 * needed a build system would be a second build of the user's app, which is the kind of weight this
 * whole approach exists to avoid.
 *
 * @param {{platform: string, arch: string, source: string, output: string, sdkPath: string}} spec
 * @returns {{command: string, args: string[]}}
 */
export function probeBuildCommand({ platform, arch, source, output, sdkPath }) {
  return {
    command: 'xcrun',
    args: [
      '--sdk', probeSdk({ platform }), 'clang',
      '-dynamiclib',
      '-arch', arch,
      '-fobjc-arc',
      '-O1',
      '-isysroot', sdkPath,
      platform === 'simulator' ? `-mios-simulator-version-min=${PROBE_MIN_IOS}` : `-mios-version-min=${PROBE_MIN_IOS}`,
      '-framework', 'UIKit',
      '-framework', 'Foundation',
      '-framework', 'QuartzCore',
      '-framework', 'CoreGraphics',
      '-o', output,
      source,
    ],
  }
}

/**
 * The signing line for a device copy.
 *
 * A dlopen of an unsigned library is refused by iOS, and a library signed by a different team than
 * the app is refused too, so the identity has to be one the app itself would accept. Any development
 * identity on this Mac normally is.
 */
export function probeSignCommand({ identity, path }) {
  return { command: 'codesign', args: ['--force', '--sign', identity, '--timestamp=none', path] }
}

/**
 * The one expression that loads the helper and starts it listening.
 *
 * `dlopen` then `dlsym` then the call, in a single statement expression: the app is stopped for this
 * one expression and for nothing else. `port` 0 asks the helper for any free port and the actual one
 * comes back as the expression's value.
 *
 * The path is not escaped into the expression as a string literal — it is passed as a `@"…"` literal,
 * which is the only shape LLDB's parser accepts for a path here, and a path containing a quote or a
 * backslash is refused by the caller rather than mangled here.
 *
 * @param {{path: string, port: number}} spec
 * @returns {string} an expression for `evaluate`.
 */
export function probeInjectExpression({ path, port }) {
  const literal = `@"${String(path)}"`
  // The statement expression's value is its LAST EXPRESSION, which is why the port is carried in a
  // local and handed over as one: a block ending in an `if` is a `void` block, and `(int)({ … if … })`
  // is refused with `C-style cast from 'void' to 'int' is not allowed` — measured against a live app,
  // where the injection silently produced no port at all.
  //
  // Both calls go through function-pointer casts, the same way every expression in this plugin calls
  // a C function: on a target whose headers are not in scope there is no declaration to call, and an
  // implicitly declared `dlopen` returns `int` — which truncates the handle on a 64-bit device.
  return 'expr -l objc++ -- (int)({ '
    + `void *xcbProbeHandle = ((void *(*)(const char *, int))dlopen)((const char *)[${literal} UTF8String], 2); `
    + 'int xcbProbePort = 0; '
    + 'if (xcbProbeHandle != 0) { '
    + 'xcbProbePort = ((int (*)(int))((void *(*)(void *, const char *))dlsym)(xcbProbeHandle, "xcb_probe_start"))'
    + `((int)${String(port)}); `
    + '} '
    + 'xcbProbePort; })'
}

/**
 * The port the helper answered with.
 *
 * LLDB prints the expression's value the way a value is printed — `(int) 47601` — so the last integer
 * on the output is the port, and a `0` or a `-1` means the helper could not listen at all.
 *
 * @param {string} text - what the expression printed.
 * @returns {number} the port, or 0.
 */
export function probePortFromText(text) {
  const numbers = String(text ?? '').match(/-?\d+/g)
  if (numbers === null) return 0
  const port = Number(numbers[numbers.length - 1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
}

/** `devicectl` argv that copies the helper onto a device, into the app's own container. */
export function probeCopyCommand({ device, source, destination, bundleId }) {
  return {
    command: 'xcrun',
    args: [
      'devicectl', 'device', 'copy', 'to',
      '--device', String(device),
      '--domain-type', 'appDataContainer',
      '--domain-identifier', String(bundleId),
      '--source', String(source),
      '--destination', String(destination),
    ],
  }
}

/**
 * `devicectl` argv that asks where the app's container is.
 *
 * The answer is written to a file rather than read from stdout: `--json-output` is devicectl's
 * documented interface, its human output is prose a future Xcode may reword, and the same shape is
 * what every other devicectl call in this plugin already relies on.
 */
export function probeContainerCommand({ device, bundleId, out }) {
  return {
    command: 'xcrun',
    args: [
      'devicectl', 'device', 'info', 'files',
      '--device', String(device),
      '--domain-type', 'appDataContainer',
      '--domain-identifier', String(bundleId),
      '--json-output', String(out),
    ],
  }
}

/**
 * The container path out of `devicectl device info files --json-output`.
 *
 * Answers null rather than guessing: a copy with no destination would land in the wrong place, and a
 * `dlopen` of the wrong path is a confusing failure much later.
 *
 * @param {string} text - the command's stdout, as JSON.
 * @returns {string|null} the path.
 */
export function parseContainerPath(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''))
    const files = parsed?.result?.files
    if (!Array.isArray(files)) return null
    const container = files.find((entry) => typeof entry?.path === 'string' && entry.path !== '')
    return container === undefined ? null : container.path
  } catch {
    return null
  }
}

/**
 * Where a built helper is cached.
 *
 * Keyed on everything that can change the answer — the source, the SDK, the platform and the
 * architecture — so a rebuild after an edit cannot be served a stale library, and two destinations
 * cannot share one that was built for the wrong one.
 */
export function probeCacheKey({ source, sdkPath, platform, arch }) {
  return createHash('sha256')
    .update(String(source))
    .update(`\n${String(sdkPath)}\n${String(platform)}\n${String(arch)}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Build the helper for one destination, or answer with the copy built for it already.
 *
 * Synchronous on purpose: it is a one-file compile of a few hundred milliseconds that happens while
 * an attach is already under way, and making it async would buy nothing a caller could use.
 *
 * @param {{platform: string, arch: string, sdkPath: string, cacheDir: string, identity?: string,
 *   spawnFn?: Function, source?: string}} spec - `spawnFn` is `child_process.spawnSync`, injected
 *   for tests.
 * @returns {{ok: boolean, path: string, note: string, ms: number, cached: boolean}}
 */
export function buildProbe({ platform, arch, sdkPath, cacheDir, identity = '', spawnFn = spawnSync, source = '' }) {
  const started = Date.now()
  const sourcePath = source === '' ? probeSourcePath() : source
  if (!existsSync(sourcePath)) {
    return { ok: false, path: '', note: `the helper's source is missing: ${sourcePath}`, ms: 0, cached: false }
  }
  const dir = join(cacheDir, probeCacheKey({ source: sourcePath, sdkPath, platform, arch }))
  const output = join(dir, PROBE_LIB)
  if (existsSync(output)) return { ok: true, path: output, note: '', ms: 0, cached: true }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, path: '', note: String(error?.message ?? error), ms: 0, cached: false }
  }
  const built = probeBuildCommand({ platform, arch, source: sourcePath, output, sdkPath })
  const compiled = spawnFn(built.command, built.args, { encoding: 'utf8' })
  if (compiled?.status !== 0 || !existsSync(output)) {
    const why = lastLines(`${compiled?.stdout ?? ''}\n${compiled?.stderr ?? ''}`)
    return { ok: false, path: '', note: why === '' ? 'clang refused the helper' : why, ms: Date.now() - started, cached: false }
  }
  // A device refuses an unsigned library, so a device build is signed before it is copied over. A
  // simulator accepts either, which is why a Mac with no identity can still use the probe there.
  if (platform !== 'simulator' && identity !== '') {
    const sign = probeSignCommand({ identity, path: output })
    const signed = spawnFn(sign.command, sign.args, { encoding: 'utf8' })
    if (signed?.status !== 0) {
      const why = lastLines(`${signed?.stdout ?? ''}\n${signed?.stderr ?? ''}`)
      return { ok: false, path: '', note: `codesign refused it: ${why}`, ms: Date.now() - started, cached: false }
    }
  }
  return { ok: true, path: output, note: '', ms: Date.now() - started, cached: false }
}

/**
 * Which development identity can sign for a device.
 *
 * `security find-identity` is the only list of what this Mac can actually sign with, and the first
 * Apple Development identity on it is the one Xcode itself would pick. Empty means none, and a probe
 * that cannot be signed is a probe that cannot be used on a device — which the caller reports rather
 * than working around.
 *
 * @param {Function} run - `(command, args) => {status, stdout, stderr}`, injected for tests.
 * @returns {string} the identity's common name, or ''.
 */
export function developmentIdentity(run) {
  const found = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const output = `${found?.stdout ?? ''}\n${found?.stderr ?? ''}`
  const match = /"Apple Development: [^"]+"/.exec(output)
  return match === null ? '' : match[0].slice(1, -1)
}

/** The last non-empty lines of a command's output, for a message that reads like the tool's own. */
function lastLines(output) {
  return String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-3)
    .join(' / ')
}
