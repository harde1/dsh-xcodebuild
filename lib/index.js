/**
 * dsh-xcodebuild — host half.
 *
 * An Xcode build/development loop for the harness: project discovery, scheme and
 * destination resolution, build/test/clean/archive/run, a live log stream, and a
 * simulator `os_log` reader. Five model-facing tools share one run registry with
 * the browser panel, which reaches it over three-and-a-bit JSON routes.
 *
 * Design notes worth knowing before editing:
 *
 * - **Derived data is Xcode's own by default.** The plugin runs as the user, so
 *   it can write `~/Library/Developer/Xcode/DerivedData`; sharing that directory
 *   with Xcode.app keeps incremental builds warm for both. The earlier
 *   sandboxed prototype had to redirect it, which silently doubled every build.
 *   `-derivedDataPath` is only passed when a caller asks for it.
 * - **The built product is located via `-showBuildSettings`, not guessed.** With
 *   the default derived data the product path contains a per-project hash, so
 *   `Build/Products/<Config>-iphonesimulator` cannot be constructed. Asking
 *   xcodebuild for `BUILT_PRODUCTS_DIR` is the only correct answer.
 * - **Log lines are classified in-process** rather than piped through xcbeautify:
 *   the panel colours errors, warnings and tasks, and that needs the kind attached
 *   to the line as it arrives, not a pretty-printed string to re-parse.
 *
 * @module dsh-xcodebuild
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { classify } from './classify.js'
import {
  APP_LOG_DIR,
  APP_LOG_TAIL_BYTES,
  appLogPullArgv,
  appLogStamp,
  downloadedPathFor,
  isAppLogName,
  newLaunchLog,
  newLinesSince,
  pickLatestAppLog,
  rankAppLogs,
  tailOfAppLog,
} from './legacy-applog.js'
import { consoleLineKind, legacyLaunchFailure } from './legacy-launch.js'
import { flushCarry, nextReadOffset, takeLines } from './log-tap.js'
import { lockedDeviceNotice, parseDevicectlLockState, parsePasswordProtected } from './lock-state.js'
import { modernCopyArgv, modernLaunchArgv, modernLaunchWitness } from './modern-launch.js'
import { beautifyDisabled, beautifyPipelineLine, stripAnsi, supportedBeautifyFlags } from './beautify.js'
import { decodeSyslogEscapes, syslogFeedArgv, syslogLineKind, syslogProcessName } from './syslog.js'
import {
  APP_LOG_PREFIX,
  consoleLogStamp,
  isFruitstrapDirFor,
  isSessionTempDir,
  isStaleLeftover,
  prunableConsoleLogs,
} from './session-files.js'
import { mergeListings } from './listing.js'
import { PROJECT_FILE, findProjects } from './projects.js'
import { destinationKindOf, destinationString, parseDestinations, pickDefaultDestination, sortDestinations } from './parse-destinations.js'
import { createRing, ringFirst, ringPush, ringSlice } from './ring.js'

export { classify } from './classify.js'
export { consoleLineKind, legacyLaunchFailure, parseLaunchedPid } from './legacy-launch.js'
export { flushCarry, nextReadOffset, takeLines } from './log-tap.js'
export { consoleLogFor, killRunChild, pruneSessionFiles, spawnAttached, startAppLogPump, startLogTap, waitForLaunchWitness }
export { lockedDeviceNotice, parseDevicectlLockState, parsePasswordProtected } from './lock-state.js'
export { decodeSyslogEscapes, syslogFeedArgv, syslogLineKind, syslogProcessName } from './syslog.js'
export { appLinePattern, modernCopyArgv, modernLaunchArgv, modernLaunchWitness } from './modern-launch.js'
export {
  consoleLogStamp,
  isFruitstrapDirFor,
  isSessionTempDir,
  isStaleLeftover,
  prunableConsoleLogs,
} from './session-files.js'
export {
  APP_LOG_DIR,
  appLogPullArgv,
  appLogStamp,
  downloadedPathFor,
  isAppLogName,
  newLaunchLog,
  newLinesSince,
  pickLatestAppLog,
  rankAppLogs,
  tailOfAppLog,
} from './legacy-applog.js'
export { destinationKindOf, destinationString, parseDestinations, pickDefaultDestination, sortDestinations, variantForDestination } from './parse-destinations.js'
export { mergeListings } from './listing.js'

/**
 * When this file was last written, as an ISO instant.
 *
 * The profile mounts the host half once at boot and keeps it in memory, so an edit
 * on disk is invisible until DSH restarts. That failure is otherwise completely
 * silent and looks exactly like a broken fix — three separate reports in one
 * sitting were all the same stale process, each diagnosed by comparing file
 * timestamps against the harness log by hand. Logging the revision turns that into
 * one grep.
 */
const LOADED_REVISION = (() => {
  try {
    return `${new Date(statSync(fileURLToPath(import.meta.url)).mtimeMs).toISOString().slice(0, 19)}Z`
  } catch {
    return 'unknown'
  }
})()

/** Stable plugin name; must match the `cordis.patch.yml` row id. */
export const name = 'xcodebuild'

/** Services the plugin cannot work without. */
export const inject = ['tools']

/** Retained log lines per run. */
const MAX_LINES = 20000

/**
 * How long an attached launch is given to show that the app came up.
 *
 * Measured on an iPhone X: an attached session has the app running about 45s after it
 * starts (75s in the last live run, which included the device's own slow start), so
 * this is that with room for a slower device — and it is a deadline, not a timeout
 * that kills anything: the session is left running either way, because the app's log
 * lags the process it describes.
 */
const LEGACY_ATTACH_WINDOW_MS = 120000
/** Finished runs kept for the panel's history before the oldest is dropped. */
const MAX_RUNS = 6
/** Ceiling on a JSON request body; every route body here is a small object. */
const MAX_BODY_BYTES = 64 * 1024
/** Route prefix shared by the panel transport. */
const ROUTE_PREFIX = '/_dsh/dsh-xcodebuild/'


// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function projectNameOf(project) {
  if (project.kind === 'package') return sanitizeName(basename(project.root))
  return sanitizeName(basename(project.location).replace(PROJECT_FILE, ''))
}

function sanitizeName(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'project'
}

function tailOf(text, lines) {
  const parts = String(text ?? '').split('\n')
  return parts.slice(Math.max(0, parts.length - (lines ?? 40))).join('\n')
}

/** Collapse an empty-but-present value so JSON stays tidy. */
function optional(key, value) {
  return value === undefined || value === null || value === '' ? {} : { [key]: value }
}

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------

/**
 * A reader that turns chunks into complete lines, holding the partial one.
 *
 * Four streams are read this way in a piped run — the formatter's output and error, and
 * the producer's own — so the carry logic lives here rather than being copied.
 *
 * @param {(line: string) => void} emit - called once per complete line.
 * @returns {{feed: (chunk: Buffer) => void, rest: () => string}} the reader.
 */
function lineReader(emit) {
  let carry = ''
  return {
    feed(chunk) {
      carry += chunk.toString('utf8')
      let index
      while ((index = carry.indexOf('\n')) >= 0) {
        emit(carry.slice(0, index))
        carry = carry.slice(index + 1)
      }
      // A pathological no-newline stream must not grow without bound.
      if (carry.length > 262144) {
        emit(carry)
        carry = ''
      }
    },
    rest() {
      const left = carry
      carry = ''
      return left
    },
  }
}

/**
 * Spawn a child and stream stdout/stderr line by line.
 *
 * `options.formatter` adds a second stage: the child's stdout is piped into it and the
 * lines that reach `onLine` are the formatter's, which is how `xcodebuild … | xcbeautify`
 * is used by hand. Only stdout is piped — xcodebuild's stderr carries its own
 * `xcodebuild: error:` lines and is passed through as it is, because merging two pipes
 * into one stdin can split a line across them. The exit code stays the FIRST child's:
 * the pipeline reports what the build did, not what the formatter did.
 *
 * @param {string[]} argv - command and arguments.
 * @param {string} cwd - working directory.
 * @param {(line: string) => void} onLine - one complete line (no trailing newline).
 * @param {{onChild?: (child: import('node:child_process').ChildProcess) => void, formatter?: string[]}} [options] - spawn hook and second stage.
 * @returns {Promise<{exitCode: number, signal: string | null}>} exit facts.
 */
export function spawnStreaming(argv, cwd, onLine, options = {}) {
  return new Promise((resolveSpawn) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      onLine(`spawn failed: ${messageOf(error)}`)
      resolveSpawn({ exitCode: -1, signal: null })
      return
    }
    options.onChild?.(child)

    // The second stage, when one was asked for. A spawn that throws is not fatal: the
    // build must run whatever the formatter does, so the failure is reported and the
    // output is shown raw.
    let formatter = null
    if (Array.isArray(options.formatter) && options.formatter.length > 0) {
      try {
        formatter = spawn(options.formatter[0], options.formatter.slice(1), {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Measured, and load-bearing: xcbeautify's own output is BLOCK buffered when
          // stdout is a pipe rather than a terminal, so without this the panel receives
          // the entire build log at the moment the build ends — no progress, and no
          // errors while they still matter. With `NSUnbufferedIO` its lines arrive as the
          // build produces them (measured against a producer printing every 0.7s: 0.8s /
          // 1.5s / 2.2s, versus one 6000-byte burst at the end without it).
          env: { ...process.env, NSUnbufferedIO: 'YES' },
        })
      } catch (error) {
        onLine(`${options.formatter[0]} could not be started (${messageOf(error)}); showing xcodebuild's own output`)
      }
    }

    let settled = false
    let producerClose = null
    let formatterAlive = formatter !== null
    // Whether the child is being read directly rather than through the formatter; the
    // completion paths hang off this and `formatterAlive`.
    let rawMode = formatter === null
    let drainTimer = null
    // Every line enters the run through `stripAnsi`: the panel colours lines itself, so
    // an escape sequence is at best unreadable and at worst defeats classification.
    const out = lineReader((line) => onLine(stripAnsi(line)))
    const err = lineReader((line) => onLine(stripAnsi(line)))
    const formatterOut = lineReader((line) => onLine(stripAnsi(line)))
    const formatterErr = lineReader((line) => onLine(stripAnsi(line)))

    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      if (drainTimer !== null) clearTimeout(drainTimer)
      for (const reader of [out, err, formatterOut, formatterErr]) {
        const left = reader.rest()
        if (left !== '') onLine(stripAnsi(left))
      }
      resolveSpawn({ exitCode, signal: signal ?? null })
    }

    /** Stop formatting and read the build's own text, from here on. */
    const switchToRaw = (why) => {
      if (rawMode) return
      rawMode = true
      onLine(`${why}; showing xcodebuild's own output`)
      child.stdout?.unpipe?.()
      child.stdout?.on('data', (chunk) => out.feed(chunk))
    }

    const stopFormatter = () => {
      try {
        formatter?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    if (rawMode) {
      child.stdout?.on('data', (chunk) => out.feed(chunk))
    } else {
      child.stdout?.pipe(formatter.stdin)
      // A dead formatter makes its stdin fail; that is the fallback's business, not an
      // unhandled error event that would take the whole plugin down.
      formatter.stdin.on('error', () => {})
      formatter.stdout?.on('data', (chunk) => formatterOut.feed(chunk))
      formatter.stderr?.on('data', (chunk) => formatterErr.feed(chunk))
      formatter.on('error', (error) => {
        formatterAlive = false
        if (rawMode) return
        if (producerClose !== null) {
          finish(producerClose.code, producerClose.signal)
          return
        }
        switchToRaw(`${options.formatter[0]} failed (${messageOf(error)})`)
      })
      formatter.on('close', () => {
        formatterAlive = false
        if (rawMode) return
        if (producerClose !== null) {
          finish(producerClose.code, producerClose.signal)
          return
        }
        // A formatter that dies in the middle of a build. What it has already swallowed is
        // gone and the rest is shown raw; `beautifyTool` runs a formatter through this
        // exact argv before any build relies on it, so this is the rare case of a binary
        // that died anyway.
        switchToRaw(`${options.formatter[0]} exited early`)
      })
    }

    child.stderr?.on('data', (chunk) => err.feed(chunk))
    child.on('error', (error) => {
      onLine(`process error: ${messageOf(error)}`)
      stopFormatter()
      finish(-1, null)
    })
    child.on('close', (code, signal) => {
      producerClose = { code: code === null ? -1 : code, signal }
      // Read straight through when there is no formatter, and when one has been given up
      // on: in both cases there is nothing left to drain.
      if (rawMode || !formatterAlive) {
        finish(producerClose.code, producerClose.signal)
        return
      }
      // Let the formatter drain what is left and exit on its own; the exit code is
      // already decided by the build above.
      formatter.stdin.end()
      drainTimer = setTimeout(() => {
        stopFormatter()
        finish(producerClose.code, producerClose.signal)
      }, FORMATTER_DRAIN_MS)
    })
  })
}

/** The installed formatter, re-probed only when the path it resolved to changes. */
let beautifyCache = null

/** The group name for everything the pre-CoreDevice channel needs. */
export const LEGACY_GROUP = 'iOS 16 and earlier devices'

/**
 * The group for what only changes how a log READS.
 *
 * Kept apart from the classic channel's group because the doctor's optional-tool line
 * names one install command for one purpose, and "you are missing xcbeautify" is not
 * something a user with a working build needs to be told to fix.
 */
export const READABILITY_GROUP = 'Reading the log'

/**
 * Every external command this plugin runs, what it is for, and how to get it.
 *
 * Kept as data because the audience is somebody else's machine. The classic
 * channel is THREE separate Homebrew formulae: `brew install libimobiledevice`
 * provides neither `ideviceinstaller` nor `ios-deploy`, so the obvious
 * "install libimobiledevice" leaves both install and launch broken — with the
 * failure landing on a plugged-in phone at the worst possible moment.
 */
export const DEPENDENCIES = [
  {
    command: 'xcodebuild',
    group: 'Xcode',
    required: true,
    purpose: 'build, test, archive, and list schemes and destinations',
    install: 'install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app',
  },
  {
    command: 'xcrun',
    group: 'Xcode',
    required: true,
    purpose: 'simctl for simulators, devicectl for iOS 17 and later devices',
    install: 'ships with Xcode; sudo xcode-select -s /Applications/Xcode.app points at it',
  },
  {
    command: 'xcode-select',
    group: 'Xcode',
    required: true,
    purpose: 'report and select the active Xcode',
    install: 'ships with the Xcode command line tools: xcode-select --install',
  },
  {
    command: 'plutil',
    group: 'macOS',
    required: true,
    purpose: "read the built app's bundle identifier",
    install: 'ships with macOS',
  },
  {
    command: 'idevice_id',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'list devices that predate CoreDevice, which xcodebuild omits',
    install: 'brew install libimobiledevice',
  },
  {
    command: 'ideviceinfo',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'ask a device its iOS version, which decides the install channel',
    install: 'brew install libimobiledevice',
  },
  {
    command: 'idevicesyslog',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'relay the live log of that hardware',
    install: 'brew install libimobiledevice',
  },
  {
    command: 'ideviceinstaller',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'install a built app onto that hardware',
    install: 'brew install ideviceinstaller',
  },
  {
    command: 'ios-deploy',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'launch the app on that hardware, and read its log out of the app container',
    install: 'brew install ios-deploy',
  },
  {
    command: 'xcbeautify',
    group: READABILITY_GROUP,
    required: false,
    purpose: 'beautify build output into one line per task, with warnings and errors marked',
    install: 'brew install xcbeautify',
  },
]

/** The whole classic channel in one command. */
export const LEGACY_TOOLCHAIN_INSTALL = 'brew install libimobiledevice ideviceinstaller ios-deploy'

/**
 * Where to look for a command.
 *
 * PATH first, then the prefixes a Finder-launched app does not inherit: a GUI app
 * gets a minimal PATH that usually omits Homebrew, which is why these were
 * resolved by hand in the first place. MacPorts is included because it is the
 * other common way to end up with libimobiledevice.
 */
function toolSearchDirs() {
  const seen = new Set()
  const dirs = []
  const fromPath = (process.env.PATH ?? '').split(':')
  for (const dir of [...fromPath, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * The absolute path of a command, or null when it is nowhere to be found.
 *
 * @param {string} command - a bare command name, or a path.
 * @returns {string|null} a path that exists, or null.
 */
export function resolveTool(command) {
  const name = String(command ?? '')
  if (name === '') return null
  if (name.includes('/')) return existsSync(name) ? name : null
  for (const dir of toolSearchDirs()) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The installed `xcbeautify`, when there is one, and how to invoke it.
 *
 * Exported so the suite can assert the policy the user asked for — installed means used,
 * and nothing has to be configured — and the probe-once caching behind it.
 *
 * Auto-detected rather than configured: the user asked for the formatter to be used
 * when the machine has it, and the two things that decide it are both facts about the
 * machine. Installing it turns beautifying on; uninstalling it turns it off; and
 * `DSH_XCODEBUILD_NO_BEAUTIFY` is the third answer, for wanting xcodebuild's own text
 * back without uninstalling anything.
 *
 * The answer is cached, but only the expensive half: existence is re-checked on every
 * run (a handful of `stat` calls, no process), so installing xcbeautify takes effect on
 * the next build instead of waiting for a restart, while `--version` and `--help` — the
 * two spawns that read the flags — are asked once per path.
 *
 * @returns {Promise<{path: string, version: string, flags: string[]}|null>} the formatter, or null.
 */
export async function beautifyTool() {
  if (beautifyDisabled(process.env.DSH_XCODEBUILD_NO_BEAUTIFY)) return null
  const path = resolveTool('xcbeautify')
  if (path === null) {
    beautifyCache = null
    return null
  }
  // Same path as last time: keep what was read from it. A different path is a
  // different install (an upgrade, a second copy on PATH) and is read again.
  if (beautifyCache !== null && beautifyCache.path === path) return beautifyCache
  const version = await capture([path, '--version'], '/', 15000)
  if (version.exitCode !== 0) return null
  const help = await capture([path, '--help'], '/', 15000)
  // An older xcbeautify that does not know a flag exits with a usage error instead of
  // building, so only the flags it lists are passed.
  const flags = supportedBeautifyFlags(help.stdout + help.stderr)
  // And the flags that were chosen are then RUN once, on one line of nothing, before any
  // build relies on them. Being listed in a help text and being accepted are not the same
  // thing, and the failure this prevents is the expensive one: a formatter that rejects
  // its argv exits immediately and leaves the build writing into a pipe nobody drains.
  // A log formatter must never be able to break the build it is only supposed to read.
  if (!await formatterAcceptsFlags(path, flags)) return null
  beautifyCache = {
    path,
    version: version.stdout.trim().split('\n')[0] ?? '',
    flags,
  }
  return beautifyCache
}

/**
 * Whether a formatter runs, and exits cleanly, with exactly these flags.
 *
 * This is what makes a formatter safe to pipe a build into. A formatter that rejects its
 * argv exits at once, and leaves the build writing into a pipe nobody drains — a stalled
 * or signal-killed build caused by the thing that was supposed to make the log readable,
 * which is never the answer. Being listed in a help text and being accepted are not the
 * same thing, so the flags are run once before any build relies on them.
 *
 * @param {string} path - the formatter.
 * @param {string[]} flags - the flags it will be passed.
 * @returns {Promise<boolean>} true when a trivial run succeeds.
 */
export function formatterAcceptsFlags(path, flags) {
  return new Promise((resolveProbe) => {
    let child
    try {
      child = spawn(path, flags, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolveProbe(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolveProbe(false)
    }, 15000)
    child.on('error', () => {
      clearTimeout(timer)
      resolveProbe(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveProbe(code === 0)
    })
    child.stdin?.end('note: dsh-xcodebuild probing the formatter\n')
  })
}

/**
 * A message naming a missing tool and how to install it.
 *
 * Without this the user reads `spawn ideviceinstaller ENOENT`, which says what
 * broke and nothing at all about what to do about it.
 *
 * @param {string} command - the missing command.
 * @returns {string} a sentence carrying the install command.
 */
export function missingToolNotice(command) {
  const entry = DEPENDENCIES.find((dependent) => dependent.command === command)
  if (entry === undefined) return `${command} is not installed or not on PATH`
  return `${command} is not installed or not on PATH — ${entry.install}`
}

/**
 * Is this iOS too old for CoreDevice?
 *
 * `devicectl` speaks to iOS 17 and later. An iPhone X on iOS 16 is not merely
 * refused there — it is absent from `devicectl list devices` altogether, so an
 * install against it failed as a device that does not exist. Those devices are
 * still reachable over the classic lockdown protocol, and this is the line
 * between the two worlds.
 *
 * @param {string} productVersion - `ideviceinfo -k ProductVersion`, e.g. "16.7.12".
 * @returns {boolean} true when the device needs the libimobiledevice channel.
 */
export function needsLegacyChannel(productVersion) {
  const major = Number.parseInt(String(productVersion ?? '').trim().split('.')[0], 10)
  return Number.isFinite(major) && major < 17
}

/**
 * Does the device need its passcode right now — i.e. is it locked?
 *
 * Asked of the device over the classic channel: `ideviceinfo -k PasswordProtected`
 * answers `true` when a passcode is required, which on an iOS 16 and earlier device
 * is the lock screen. It needs no developer image and no pairing session, unlike a
 * screenshot, whose failure means something a launch repairs by itself.
 *
 * The three states are kept apart: `true` is a lock, `false` is the device saying
 * no passcode is being asked for, and null is the question not being answered at
 * all — a missing tool or a failed read, which is never evidence of a lock. Only
 * `true` may stop a launch.
 *
 * @param {string} udid - device id to ask.
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<boolean|null>} true, false, or null when it did not say.
 */
async function devicePasscodeRequired(udid, cwd) {
  const info = await capture([legacyTool('ideviceinfo'), '-u', udid, '-k', 'PasswordProtected'], cwd, 20000)
  if (info.exitCode === 0) return parsePasswordProtected(info.stdout)
  // A device CoreDevice reaches over the network is listed by libimobiledevice only
  // with `-n`; without it the same id answers "Device not found". Measured on a
  // 00008110-... device, which answers `PasswordProtected` this way.
  const networked = await capture([legacyTool('ideviceinfo'), '-n', '-u', udid, '-k', 'PasswordProtected'], cwd, 20000)
  if (networked.exitCode !== 0) return null
  return parsePasswordProtected(networked.stdout)
}

/**
 * The modern channel's own lock answer: `passcodeRequired` from `devicectl`.
 *
 * devicectl documents its `--json-output` file as the only interface meant for a
 * program, so that file is what gets read — the human listing is prose a future Xcode
 * may reword or translate. `unlockedSinceBoot` sits beside it and is deliberately not
 * used: the question is whether a passcode is required *now*.
 *
 * The answer is deleted with the file, and a missing or unparsable file is null —
 * never a lock, so a launch is never stopped by a question that went unanswered.
 *
 * @param {string} udid - CoreDevice identifier of the device.
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<boolean|null>} true, false, or null when it did not say.
 */
async function deviceLockState(udid, cwd) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-lock-'))
  const answer = join(root, 'lockstate.json')
  try {
    const probe = await capture(
      ['xcrun', 'devicectl', 'device', 'info', 'lockState', '--device', udid, '--json-output', answer],
      cwd,
      120000,
    )
    if (probe.exitCode !== 0) return null
    return parseDevicectlLockState(await readFile(answer, 'utf8'))
  } catch {
    return null
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The device's iOS version, or an empty string when it does not answer.
 *
 * One probe answers both questions the hardware paths ask — whether this is
 * hardware at all (`ideviceinfo` answers only for a physical device; a simulator
 * udid never does) and which channel it needs — so both come from this call
 * rather than two round trips to the same service. This replaced a separate
 * `isPhysicalDevice` probe that asked the same service the same question.
 *
 * @param {string} udid - device id to ask about.
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<string>} e.g. "16.7.12", or "" when there is no answer.
 */
async function deviceProductVersion(udid, cwd) {
  const info = await capture([legacyTool('ideviceinfo'), '-u', udid, '-k', 'ProductVersion'], cwd, 20000)
  return info.exitCode === 0 ? info.stdout.trim() : ''
}

/**
 * Absolute path of a legacy device tool.
 *
 * `ideviceinstaller` and `ios-deploy` come from Homebrew, so they are not
 * necessarily on the PATH the harness itself was launched with. Probing the two
 * Homebrew prefixes costs a couple of stats and turns a bare `spawn ENOENT` into
 * a working command. An unknown name is returned untouched, so the error the
 * caller finally sees still names the tool it wanted.
 *
 * @param {string} name - tool name, e.g. "ideviceinstaller".
 * @returns {string} a path to use as argv[0].
 */
export function legacyTool(name) {
  // Falls back to the bare name, so `spawn` still gets its own PATH lookup for
  // anything this search missed.
  return resolveTool(name) ?? name
}

/**
 * What this machine has, what it lacks, and what to do about it.
 *
 * The plugin is meant to be handed to somebody else, and half of what it needs is
 * not part of macOS or Xcode. A tool that is missing and never named turns into a
 * device-not-found or an ENOENT at the moment the user is standing there with a
 * phone in their hand.
 *
 * @returns {Promise<object>} one record per dependency, plus the Xcode in use.
 */
export async function doctorReport() {
  const tools = DEPENDENCIES.map((entry) => {
    const found = resolveTool(entry.command)
    return {
      command: entry.command,
      group: entry.group,
      required: entry.required,
      purpose: entry.purpose,
      install: entry.install,
      found,
      ready: found !== null,
    }
  })
  let xcodePath = ''
  let xcodeVersion = ''
  if (tools.some((tool) => tool.command === 'xcodebuild' && tool.ready)) {
    const selected = await capture(['xcode-select', '-p'], '/', 15000)
    if (selected.exitCode === 0) xcodePath = selected.stdout.trim()
    const version = await capture(['xcodebuild', '-version'], '/', 30000)
    if (version.exitCode === 0) xcodeVersion = (version.stdout.trim().split('\n')[0] ?? '')
  }
  const missingRequired = tools.filter((tool) => tool.required && !tool.ready).map((tool) => tool.command)
  // Only the classic channel's tools are an "optional gap" with one install command
  // behind it. A missing readability tool is not a gap in anything: the build works,
  // and the panel already says whether this log is beautified.
  const missingOptional = tools
    .filter((tool) => !tool.required && !tool.ready && tool.group === LEGACY_GROUP)
    .map((tool) => tool.command)
  return {
    ready: missingRequired.length === 0,
    tools,
    xcodePath,
    xcodeVersion,
    missingRequired,
    missingOptional,
    // What closes the optional gap, or '' when there is no gap to close.
    legacyInstall: missingOptional.length > 0 ? LEGACY_TOOLCHAIN_INSTALL : '',
  }
}

/**
 * Decide the channel by asking the device, not by guessing from its UDID.
 *
 * A legacy device answers `ideviceinfo` when nothing else can see it at all; a
 * CoreDevice-era device either does not answer on the classic channel or answers
 * with a version this returns false for. Both outcomes route correctly.
 *
 * @param {string} udid - device id from the destination string.
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<boolean>} true when the legacy toolchain must be used.
 */
async function isLegacyDevice(udid, cwd) {
  const info = await capture([legacyTool('ideviceinfo'), '-u', udid, '-k', 'ProductVersion'], cwd, 30000)
  if (info.exitCode !== 0) return false
  return needsLegacyChannel(info.stdout)
}

/**
 * Run a child to completion and collect its output.
 * @param {string[]} argv - command and arguments.
 * @param {string} cwd - working directory.
 * @param {number} [timeoutMs] - kill the child after this long.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>} captured result.
 */
/**
 * Run a child to completion, teeing its output into the run log as it arrives.
 *
 * `capture` says nothing until the child exits, which is the wrong trade for a
 * step the user is visibly waiting on. `devicectl` reports "App installed:" and
 * streams install progress line by line; collected silently, the log showed the
 * command and then nothing for a minute, which reads as a hang. The output is
 * still accumulated, so a failure message is unchanged.
 *
 * @param {string[]} argv - command and arguments.
 * @param {string} cwd - working directory.
 * @param {number} timeoutMs - kill the child after this long.
 * @param {(line: string) => void} onLine - receives each completed line.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>} captured result.
 */
function captureTee(argv, cwd, timeoutMs, onLine) {
  return new Promise((resolveTee) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveTee({ exitCode: -1, stdout: '', stderr: messageOf(error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let outDone = 0
    let errDone = 0
    let timedOut = false
    let settled = false
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveTee({ exitCode, stdout, stderr, timedOut })
    }
    // Emit whole lines, and hold back the partial tail until more arrives: a
    // chunk boundary is not a line boundary.
    const flush = (which) => {
      const text = which === 'out' ? stdout : stderr
      let start = which === 'out' ? outDone : errDone
      let index
      while ((index = text.indexOf('\n', start)) >= 0) {
        onLine(text.slice(start, index))
        start = index + 1
      }
      if (text.length - start > 262144) {
        onLine(text.slice(start))
        start = text.length
      }
      if (which === 'out') outDone = start
      else errDone = start
    }
    const take = (which, chunk) => {
      if (which === 'out') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      flush(which)
    }
    child.stdout?.on('data', (chunk) => take('out', chunk))
    child.stderr?.on('data', (chunk) => take('err', chunk))
    child.on('error', (error) => {
      stderr += messageOf(error)
      flush('err')
      finish(-1)
    })
    child.on('close', (code) => {
      // A last line with no trailing newline is still output the user wants.
      flush('out')
      flush('err')
      if (outDone < stdout.length) { onLine(stdout.slice(outDone)); outDone = stdout.length }
      if (errDone < stderr.length) { onLine(stderr.slice(errDone)); errDone = stderr.length }
      finish(code === null ? -1 : code)
    })
  })
}

/** How many tapped console lines are kept for a failure message. */
const TAP_KEEP_LINES = 400

/**
 * Read a file that is being written to, line by line, as it grows.
 *
 * This is the reader half of an attached launch: the launch owns the console, and
 * this pulls it into the panel. Polling a file is cruder than piping a child's
 * stdout, and it buys the two things that matter here — the console text stays on
 * disk after the session, and reading it can neither block the launch nor lose the
 * output when the pipe would have been closed.
 *
 * @param {string} path - the file to read.
 * @param {(line: string) => void} onLine - called once per complete line, in order.
 * @param {number} [intervalMs] - poll cadence.
 * @returns {{text: () => string, stop: () => Promise<void>}} the reader.
 */
function startLogTap(path, onLine, intervalMs = 300) {
  let offset = 0
  let carry = ''
  let decoder = new TextDecoder()
  let timer = null
  let stopped = false
  const seen = []
  const emit = (line) => {
    seen.push(line)
    if (seen.length > TAP_KEEP_LINES) seen.shift()
    onLine(line)
  }
  const readOnce = async () => {
    const size = await stat(path).then((info) => info.size).catch(() => 0)
    const next = nextReadOffset(offset, size)
    if (next.reset) {
      // The file was truncated — `> file` rather than `>> file`, or a fresh run
      // reusing the path. Read it again from the start, and drop the half-decoded
      // character that belonged to the content which is gone.
      carry = ''
      decoder = new TextDecoder()
    }
    offset = next.offset
    if (size <= offset) return
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead <= 0) return
      offset += bytesRead
      const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      const taken = takeLines(chunk, carry)
      carry = taken.carry
      for (const line of taken.lines) emit(line)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  const tick = () => {
    if (stopped) return
    void readOnce()
      .catch(() => undefined)
      .then(() => {
        if (stopped) return
        timer = setTimeout(tick, intervalMs)
        // A reader must never be the reason the host cannot exit.
        timer.unref?.()
      })
  }
  timer = setTimeout(tick, intervalMs)
  timer.unref?.()
  return {
    /** Everything tapped so far, oldest first — the evidence a failure message quotes. */
    text: () => seen.join('\n'),
    /**
     * Stop polling, after one last read and a flush of the final unterminated line:
     * `success` with no newline after it is still output the user should see.
     */
    stop: async () => {
      if (stopped) return
      stopped = true
      if (timer !== null) clearTimeout(timer)
      await readOnce().catch(() => undefined)
      const last = flushCarry(carry)
      carry = ''
      if (last !== null) emit(last)
    },
  }
}

/** Lines of the app's own log pushed per pump tick, so a burst cannot flood the panel. */
const APP_PUMP_BURST = 400
/** Lines of an already-existing log shown when the pump first looks at it. */
const APP_PUMP_FIRST_LINES = 40

/**
 * Keep the app's own log flowing into the panel while a session is attached.
 *
 * This is the second reader, and on the classic channel it is the one that matters:
 * the app writes its log inside its own container as it runs, so a fresh download of
 * that file is a live view of the app, while anything lldb prints arrives through a
 * block-buffered pipe in kilobyte lumps — and `-O/--output` is written by a Python
 * loop that only flushes when the process ends.
 *
 * Each tick downloads the log directory again (`readLegacyAppLog`), so the pump is
 * deliberately slower than the console tap: it is a device round trip, not a file
 * read, and it must not queue work against a device that is already running a debug
 * session. Ticks never overlap — each one awaits the previous — and every failure is
 * reported once rather than every tick.
 *
 * @param {{udid: string, bundleId: string, cwd: string, file: string|null, onLine: (line: string) => void, intervalMs?: number}} spec - what to watch.
 * @returns {{stop: () => void, ticks: () => number}} the pump.
 */
function startAppLogPump(spec) {
  let timer = null
  let stopped = false
  let ticks = 0
  let file = spec.file ?? null
  let marker = null
  let reportedError = null
  // The fallback sleeps only this long between downloads, on top of a fetch that takes
  // tens of seconds on its own: the cadence is dominated by the download, so adding a
  // long pause to it buys nothing and delays the lines by exactly that pause.
  const pollMs = spec.intervalMs ?? 1000
  const tick = async () => {
    ticks += 1
    try {
      // Which channel's reader to use is the caller's choice: the two differ only in the
      // tool that fetches the container, not in what they do with it.
      const read = spec.read ?? readLegacyAppLog
      const log = await read(spec.udid, spec.bundleId, spec.cwd)
      if (log.file !== file) {
        // A newer launch log: either the app was restarted, or the first look landed
        // on the file the launch witness named. Either way the marker belongs to the
        // old file and is dropped with it.
        if (file !== null) spec.onLine(`the app is writing a newer launch log: ${log.file}`)
        file = log.file
        marker = null
      }
      let lines = newLinesSince(log.text, marker)
      if (lines === null) {
        // The marker scrolled out of the tail window. Say so instead of reprinting a
        // tail as if it were new, and re-anchor to the newest lines.
        spec.onLine(`the app's log grew past the ${String(Math.round(APP_LOG_TAIL_BYTES / 1024))}KB tail window; showing the newest lines`)
        const all = log.text.split('\n').filter((line) => line !== '')
        lines = all.slice(Math.max(0, all.length - APP_PUMP_FIRST_LINES))
      } else if (marker === null) {
        // First look at this file: the log already existed, so its beginning is not
        // this launch's news. Enough of the end to see where the app is at — and a
        // header saying so, because these lines are older than the launch and would
        // otherwise read as output the launch just produced.
        lines = lines.filter((line) => line !== '')
        spec.onLine(`the app's own log so far: ${log.file}`)
        lines = lines.slice(Math.max(0, lines.length - APP_PUMP_FIRST_LINES))
      }
      const shown = lines.filter((line) => line !== '')
      if (shown.length > APP_PUMP_BURST) {
        spec.onLine(`(${String(shown.length - APP_PUMP_BURST)} older lines of the app's log skipped)`)
      }
      for (const line of shown.slice(Math.max(0, shown.length - APP_PUMP_BURST))) spec.onLine(line)
      const newest = shown[shown.length - 1]
      if (typeof newest === 'string' && newest !== '') marker = newest
      reportedError = null
    } catch (error) {
      const message = messageOf(error)
      if (message !== reportedError) {
        reportedError = message
        spec.onLine(`could not read the app's own log at ${APP_LOG_DIR}: ${message}`)
      }
    }
    if (stopped) return
    // A failed fetch retries slowly. The download is tens of seconds when it works, so a
    // fast retry buys nothing there — but when the device is gone it fails in a second,
    // and without this the fallback would spin against a disconnected phone.
    timer = setTimeout(() => { void tick() }, reportedError === null ? pollMs : FOLLOW_FAIL_MS)
    timer.unref?.()
  }
  timer = setTimeout(() => { void tick() }, pollMs)
  timer.unref?.()
  return {
    ticks: () => ticks,
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}

/** How long the fallback waits after a failed fetch before trying the device again. */
const FOLLOW_FAIL_MS = 5000

/** How long a formatter may take to drain and exit after the build it was reading. */
const FORMATTER_DRAIN_MS = 3000

/** How long a stopped session may take to end on its own before it is killed outright. */
const STOP_ESCALATE_MS = 5000

/** How long a witnessed modern launch may keep its console silent before the container copy takes over. */
const MODERN_CONSOLE_SILENCE_MS = 15000

/** How many times a dropped device-log stream is reconnected before giving up on it. */
const SYSLOG_FEED_RESTARTS = 3

/**
 * Stream a running app's own log off the device for the panel.
 *
 * This is the panel's live reader on the classic channel, and it exists because the
 * container-file alternative cannot be fast: `ios-deploy --download` moves the whole
 * file, and a two-megabyte launch log took 50 seconds to fetch. The device's log relay
 * instead pushes lines as the app writes them, which is the difference between a panel
 * that lags a minute and one that keeps up.
 *
 * It is a pipe, not a redirected file, so there is no buffering to defeat: the lines are
 * read from the child's stdout as they arrive. `-x` ends the stream when the phone goes
 * away, which turns "device disconnected" into an ended reader rather than a process
 * that looks alive and delivers nothing; a dropped stream is reconnected a few times
 * before `onUnavailable` hands the job to the container-file reader, so the panel has a
 * live feed when one is possible and a slower complete record when it is not.
 *
 * @param {object} spec - what to stream.
 * @param {string} spec.udid - the device.
 * @param {string|null} spec.processName - the app's process name, or null when unknown.
 * @param {string} spec.cwd - working directory for the child.
 * @param {(line: string, kind?: string) => void} spec.onLine - called per decoded line.
 * @param {() => void} [spec.onUnavailable] - called once when the feed cannot deliver.
 * @returns {{started: boolean, stop: () => void, lines: () => number}} the feed.
 */
function startSyslogFeed(spec) {
  let stopped = false
  let child = null
  let restarts = 0
  let lines = 0
  let carry = ''
  let timer = null
  if (spec.processName === null || spec.processName === undefined) {
    // Nothing to filter by, and streaming every process on the phone into the panel is
    // not a fallback anyone asked for.
    spec.onUnavailable?.()
    return { started: false, stop: () => undefined, lines: () => lines }
  }
  const launcher = legacyTool('idevicesyslog')
  const argv = syslogFeedArgv({ launcher, udid: spec.udid, processName: spec.processName })
  const consume = (stream, kind) => {
    let decoder = new TextDecoder()
    stream.on('data', (chunk) => {
      carry += decoder.decode(chunk, { stream: true })
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      for (const raw of parts) {
        const line = decodeSyslogEscapes(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
        if (line.trim() === '') continue
        lines += 1
        spec.onLine(line, kind === 'error' ? 'note' : syslogLineKind(line))
      }
    })
    stream.on('error', () => undefined)
  }
  const start = () => {
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      spec.onLine(`could not start the live device log stream: ${messageOf(error)}`)
      spec.onUnavailable?.()
      return
    }
    consume(child.stdout, 'out')
    consume(child.stderr, 'error')
    child.on('error', (error) => {
      if (stopped) return
      spec.onLine(`the live device log stream failed: ${messageOf(error)}`)
    })
    child.on('close', (code) => {
      child = null
      if (stopped) return
      // A stream that never delivered a line is not a dropped connection to retry: it
      // is a relay that will not serve this device, which is what a newer iOS does —
      // measured, `idevicesyslog` connects and exits immediately on an iPhone 12 running
      // iOS 26.6.2, the same version split that routes that device to `devicectl`. One
      // attempt is enough to learn that; a stream that HAD been delivering, by contrast,
      // is worth reconnecting, because that is a cable or a lock screen.
      const allowed = lines > 0 ? SYSLOG_FEED_RESTARTS : 1
      if (restarts < allowed) {
        restarts += 1
        spec.onLine(`the live device log stream ended (exit ${String(code)}); reconnecting (${String(restarts)}/${String(allowed)})`)
        timer = setTimeout(start, 500)
        timer.unref?.()
        return
      }
      spec.onLine('the live device log stream could not be kept open; reading the app\'s own log file instead')
      spec.onUnavailable?.()
    })
  }
  start()
  return {
    started: true,
    lines: () => lines,
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (child !== null) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        child = null
      }
    },
  }
}

/**
 * Delete what previous launches left in the temporary directories.
 *
 * Nothing here is cleaned by whoever wrote it: this plugin writes a console file per
 * attached launch, ios-deploy writes a `<tmp>/<UUID>/` per launch, and an app-log
 * download directory survives only if the host was killed mid-read. All three
 * accumulate where nobody looks, so every new launch tidies up before adding to the
 * pile.
 *
 * ios-deploy's litter is in `/tmp` specifically — its prep-cmds path is a hard-coded
 * `#define PREP_CMDS_PATH @"/tmp/%@"` (src/ios-deploy/ios-deploy.m:29) — while this
 * plugin's own files go to the host's temporary root. Both are swept, and only paths
 * this plugin or ios-deploy could have written are considered at all.
 *
 * The rule that makes it safe is time, not ownership: this only touches entries that
 * have not been written to for an hour, and a session being started writes its files
 * within seconds. Best-effort throughout — cleanup that can fail a launch would be
 * worse than the litter.
 *
 * @param {string} udid - the device this launch is for.
 * @param {string[]} [roots] - the temporary roots to tidy; defaults to the host's and `/tmp`.
 */
async function pruneSessionFiles(udid, roots) {
  for (const root of roots ?? [tmpdir(), '/tmp']) {
    // Our own console files, newest kept so the last few sessions stay readable.
    try {
      const dir = join(root, 'dsh-xcodebuild')
      const entries = await readdir(dir, { withFileTypes: true })
      const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
        const info = await stat(join(dir, entry.name)).catch(() => null)
        return { name: entry.name, mtimeMs: info?.mtimeMs ?? Number.NaN }
      }))
      for (const name of prunableConsoleLogs(files)) {
        await rm(join(dir, name), { force: true }).catch(() => undefined)
      }
    } catch {
      /* no console directory here, which is the normal case outside the host's root */
    }
    // ios-deploy's own litter, and downloads abandoned by a host that died mid-read.
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSessionTempDir(entry.name)) continue
      const path = join(root, entry.name)
      const info = await stat(path).catch(() => null)
      if (info === null || !isStaleLeftover(info.mtimeMs)) continue
      if (entry.name.startsWith(APP_LOG_PREFIX)) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      const inside = await readdir(path).catch(() => [])
      if (isFruitstrapDirFor(inside, udid)) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

/**
 * Where one attached launch's console is redirected to.
 *
 * A per-run file under the system temporary directory: the plugin has no business
 * writing inside the project it builds, and naming the run AND the start time keeps
 * a restart from appending this session's console to the last one's.
 *
 * @param {object} run - the run.
 * @returns {string} absolute path of the console file.
 */
function consoleLogFor(run) {
  return join(tmpdir(), 'dsh-xcodebuild', `${run.id}-${run.startedAt}-ios-deploy.log`)
}

/**
 * Spawn a launch that is meant to keep running, with its console on disk.
 *
 * `detached: true` is not decoration. ios-deploy answers SIGINT/SIGTERM/SIGHUP by
 * SIGKILLing its own process group (ios-deploy.m:1460-1464); a child sharing this
 * host's process group would take the host down with it. Detached gives it a group
 * of its own, so that blast radius is the debug session — which is the unit Stop
 * wants to end anyway.
 *
 * The console is a file rather than a pipe because this child outlives the call that
 * started it: the file is what the tap reads, and it is still there afterwards.
 *
 * @param {string[]} argv - command to run.
 * @param {string} cwd - working directory.
 * @param {string} consolePath - file the child's stdout and stderr are redirected to.
 * @param {(line: string) => void} onLine - sink for the tapped console.
 * @returns {Promise<{child: object, exited: Promise<object>, tap: object}>} child, its exit, its reader.
 */
async function spawnAttached(argv, cwd, consolePath, onLine) {
  await mkdir(dirname(consolePath), { recursive: true })
  const handle = await open(consolePath, 'a')
  let child
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
      // lldb's own output goes through an embedded Python, which block-buffers stdout
      // when it is a file: measured, the console file sat at a half-written line for six
      // minutes while the app logged. `PYTHONUNBUFFERED` is the supported way to ask for
      // line buffering without a pty — and a pty is not available here anyway (the
      // sandbox refuses `openpty`, which is what `script` needs).
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
  } finally {
    await handle.close().catch(() => undefined)
  }
  const tap = startLogTap(consolePath, onLine)
  const exited = new Promise((resolveExit) => {
    child.on('error', (error) => resolveExit({ code: -1, signal: null, error }))
    child.on('close', (code, signal) => resolveExit({ code: code === null ? -1 : code, signal }))
  })
  return { child, exited, tap }
}

/**
 * Wait for an attached console session to say that the app came up.
 *
 * The modern channel's counterpart of `waitForLaunchWitness`, and it reads the console
 * rather than the device: with `--console` the launcher reports the launch on the same
 * stream the app's own logging arrives on, so there is nothing else to poll.
 *
 * The distinction that matters is between the three endings, because they are three
 * different things: a witness (the app is up, whoever said so), an exit (the session
 * ended before anything could be witnessed — a real failure), and neither within the
 * window (still attached, still waiting — not a failure).
 *
 * @param {object} spec - what to watch.
 * @param {{text: () => string}} spec.tap - the console reader.
 * @param {string|null} spec.processName - the app's process name.
 * @param {Promise<object>} spec.exited - resolves when the console child ends.
 * @param {number} spec.windowMs - how long to wait for a witness.
 * @param {number} [spec.pollMs] - cadence.
 * @returns {Promise<{launched: boolean, pid: number|null, evidence: string|null, exit: object|null}>} the verdict.
 */
async function waitForConsoleWitness(spec) {
  const deadline = Date.now() + spec.windowMs
  const pollMs = spec.pollMs ?? 1000
  let exit = null
  void spec.exited.then((result) => { exit = result })
  for (;;) {
    const said = modernLaunchWitness(spec.tap.text(), spec.processName)
    if (said.launched) return { ...said, exit: null }
    if (exit !== null) return { launched: false, pid: null, evidence: null, exit }
    if (Date.now() >= deadline) return { launched: false, pid: null, evidence: null, exit: null }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
}

/**
 * End whatever is running for a run, whole process group first.
 *
 * A detached child leads its own group, so signalling the group is what actually
 * ends the debug session — lldb is a grandchild — and it cannot reach this host,
 * because that group was made for this child alone.
 *
 * SIGTERM is the default because it is the one signal that means the same thing on both
 * channels: devicectl terminates the app with it and then exits, and ios-deploy's handler
 * treats it like SIGINT and kills its own group with it.
 *
 * @param {object} run - the run whose child should end.
 * @param {string} [signal] - signal to send; defaults to SIGTERM.
 */
function killRunChild(run, signal = 'SIGTERM') {
  const child = run.child
  if (child === null || typeof child?.pid !== 'number') return
  // Only a detached child leads a process group, and only then is `-pid` its own
  // group. A non-detached child shares this host's group, so `kill(-pid)` would
  // name whatever group happens to carry that id — a signal aimed at an unrelated
  // process, which is not a risk worth taking for a build.
  if (run.detachedChild === true) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      /* the group is already gone — fall through to the child itself */
    }
  }
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}

/**
 * Wait for the app's own new launch log — the witness that the app came up.
 *
 * This is the launch verdict for an attached session, and it is a device fact: an
 * iOS 16 app writes `Documents/PPCrashLog/log_<timestamp>.log` as its process
 * starts. Nothing ios-deploy prints can be used instead — its `success` line is
 * printed when `Launch()` returns without error, before the process is known to be
 * alive, and the message that would contradict it is discarded by `os._exit`.
 *
 * The wait ends early when the session dies, so a debugger that never brought the
 * app up does not sit out the whole window before saying so.
 *
 * @param {{udid: string, bundleId: string, cwd: string, before: string|null, exited: Promise<object>, windowMs: number}} spec - what to watch.
 * @returns {Promise<{file: string|null, stamp: string|null, error: string|null, exit: object|null, timedOut: boolean}>} the witness.
 */
async function waitForLaunchWitness(spec) {
  const deadline = Date.now() + spec.windowMs
  const pollMs = spec.pollMs ?? 2000
  let exit = null
  void spec.exited.then((result) => { exit = result })
  for (;;) {
    if (exit !== null) return { file: null, stamp: null, error: null, exit, timedOut: false }
    const after = await peekLegacyAppLog(spec.udid, spec.bundleId, spec.cwd)
    const fresh = newLaunchLog(spec.before, after.file)
    if (fresh !== null) return { file: fresh, stamp: after.stamp, error: null, exit: null, timedOut: false }
    if (Date.now() >= deadline) return { file: null, stamp: null, error: after.error, exit: null, timedOut: true }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
}

function capture(argv, cwd, timeoutMs) {
  return new Promise((resolveCapture) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveCapture({ exitCode: -1, stdout: '', stderr: messageOf(error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveCapture({ exitCode, stdout, stderr, timedOut })
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      stderr += messageOf(error)
      finish(-1)
    })
    child.on('close', (code) => finish(code === null ? -1 : code))
  })
}

// ---------------------------------------------------------------------------
// the app's own log, on the older channel
// ---------------------------------------------------------------------------

/**
 * Pull the app's own per-launch log out of its container and return its tail.
 *
 * The route matters more than the code. On an iOS 16 or earlier device there is no
 * CoreDevice, so `xcrun devicectl device copy from` — what the modern channel uses
 * to move files — does not exist. What does exist is ios-deploy's AFC download,
 * which addresses the app container through `--bundle_id`:
 *
 * ```
 * ios-deploy --id <udid> --bundle_id <id> --download=Documents/PPCrashLog --to <dir> --non-recursively
 * ```
 *
 * Two device facts pin this implementation, both measured while the device was
 * locked: `--list` is a silent no-op on this toolchain (exit 0, zero bytes, even
 * for a path that does not exist), so the directory is downloaded and enumerated
 * locally instead; and the download does not preserve the device mtime, so the
 * file NAME — which the app stamps with its own launch instant — is the ordering
 * key. `lib/legacy-applog.js` carries the details.
 *
 * The whole log directory comes down rather than one file, because without `--list`
 * there is no way to ask which file is newest. It is bounded by being flat and
 * small (four files, 420 KB, 3.4s on the device that exposed the original bug).
 *
 * @param {string} udid - device id.
 * @param {string} bundleId - app bundle id; it is what selects the app container.
 * @param {string} cwd - working directory for the transfer.
 * @param {string} [wanted] - a specific log file name to read instead of the newest.
 * @returns {Promise<{file: string, stamp: string|null, available: string[], bytes: number, text: string}>} the log and its neighbours.
 */
export async function readLegacyAppLog(udid, bundleId, cwd, wanted) {
  const launcher = resolveTool('ios-deploy')
  if (launcher === null) throw new Error(missingToolNotice('ios-deploy'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-applog-'))
  try {
    const argv = appLogPullArgv({
      launcher,
      udid,
      bundleId,
      devicePath: APP_LOG_DIR,
      toDir: root,
      directory: true,
    })
    const pull = await capture(argv, cwd, 180000)
    const downloaded = downloadedPathFor(root, APP_LOG_DIR)
    let names = []
    try {
      names = await readdir(downloaded)
    } catch {
      names = []
    }
    const available = rankAppLogs(names)
    if (available.length === 0) {
      const said = tailOf((pull.stdout + pull.stderr).trim(), 12)
      throw new Error(pull.timedOut
        ? `reading ${APP_LOG_DIR} from ${bundleId} did not finish within 180s: the device stopped answering mid-transfer`
        : `no launch log came out of ${bundleId} at ${APP_LOG_DIR}`
          + `${said === '' ? '' : `; ios-deploy said: ${said}`}`
          + ` — if the app has never run on this device it has not written one yet, and if it was installed from the store rather than signed for development the container cannot be opened at all`)
    }
    const named = typeof wanted === 'string' && wanted.trim() !== ''
    if (named && !available.includes(basename(wanted.trim()))) {
      throw new Error(`${basename(wanted.trim())} is not one of this app's launch logs; available, newest first: ${available.join(', ')}`)
    }
    const file = named ? basename(wanted.trim()) : pickLatestAppLog(names)
    const local = join(downloaded, file)
    const info = await stat(local)
    // A long-running app can leave a multi-megabyte log behind, and the interesting
    // part is the end. Reading only the tail keeps a large file from being loaded
    // whole just to be cut.
    let text
    if (info.size > APP_LOG_TAIL_BYTES) {
      const handle = await open(local, 'r')
      try {
        const buffer = Buffer.alloc(APP_LOG_TAIL_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, APP_LOG_TAIL_BYTES, info.size - APP_LOG_TAIL_BYTES)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    } else {
      text = await readFile(local, 'utf8')
    }
    return { file, stamp: appLogStamp(file), available, bytes: info.size, text }
  } finally {
    // The download is a temporary copy of the device's own file; leaving it behind
    // would accumulate one log directory per call.
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Read the app's own newest launch log out of its data container on iOS 17 or later.
 *
 * This is the modern counterpart of `readLegacyAppLog`, and it is a different tool rather
 * than a different flag: CoreDevice reaches the container through
 * `devicectl device copy from --domain-type appDataContainer`, which needs no debug
 * session and no developer disk image. Measured on the iPhone 12, the whole log directory
 * — four files, 348 KB — arrived in **0.9 seconds**, against 50 seconds for the classic
 * download of 2.4 MB. That is what makes this cheap enough to be a fallback rather than a
 * last resort.
 *
 * The ordering key is the same as the classic channel's, and for the same reason: the
 * transfer does not preserve device mtimes, so the file NAME — which the app stamps with
 * its own launch instant — is what orders them. `lib/legacy-applog.js` holds those
 * helpers, because both channels read the same app writing the same file.
 *
 * @param {string} udid - device id.
 * @param {string} bundleId - app bundle id; it selects the container.
 * @param {string} cwd - working directory for the transfer.
 * @param {string} [wanted] - a specific log file name to read instead of the newest.
 * @returns {Promise<{file: string, stamp: string|null, available: string[], bytes: number, text: string}>} the log and its neighbours.
 */
export async function readModernAppLog(udid, bundleId, cwd, wanted) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-applog-'))
  try {
    const argv = modernCopyArgv({ udid, bundleId, source: APP_LOG_DIR, toDir: root })
    const pull = await capture(argv, cwd, 180000)
    // Measured: the copied items land directly in the destination, not under a directory
    // named after the source path.
    const names = await readdir(root).catch(() => [])
    const available = rankAppLogs(names)
    if (available.length === 0) {
      const said = tailOf((pull.stdout + pull.stderr).trim(), 12)
      throw new Error(pull.timedOut
        ? `copying ${APP_LOG_DIR} out of ${bundleId} did not finish within 180s: the device stopped answering mid-transfer`
        : `no launch log came out of ${bundleId} at ${APP_LOG_DIR}`
          + `${said === '' ? '' : `; devicectl said: ${said}`}`
          + ` — if the app has never run on this device it has not written one yet`)
    }
    const named = typeof wanted === 'string' && wanted.trim() !== ''
    if (named && !available.includes(basename(wanted.trim()))) {
      throw new Error(`${basename(wanted.trim())} is not one of this app's launch logs; available, newest first: ${available.join(', ')}`)
    }
    const file = named ? basename(wanted.trim()) : pickLatestAppLog(names)
    const local = join(root, file)
    const info = await stat(local)
    let text
    if (info.size > APP_LOG_TAIL_BYTES) {
      const handle = await open(local, 'r')
      try {
        const buffer = Buffer.alloc(APP_LOG_TAIL_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, APP_LOG_TAIL_BYTES, info.size - APP_LOG_TAIL_BYTES)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    } else {
      text = await readFile(local, 'utf8')
    }
    return { file, stamp: appLogStamp(file), available, bytes: info.size, text }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Which log file the app has for its most recent launch, without reading it.
 *
 * Used on both sides of a launch: the name before and the name after are what
 * turn "ios-deploy said it launched" into "the app wrote a new file for this
 * launch". It never throws — a launch must not be failed by an unreadable log
 * directory, for the same reason a silent pid probe must not fail one.
 *
 * @param {string} udid - device id.
 * @param {string} bundleId - app bundle id.
 * @param {string} cwd - working directory for the transfer.
 * @returns {Promise<{file: string|null, stamp: string|null, error: string|null}>} the newest log, or why there is none.
 */
export async function peekLegacyAppLog(udid, bundleId, cwd) {
  try {
    const log = await readLegacyAppLog(udid, bundleId, cwd)
    return { file: log.file, stamp: log.stamp, error: null }
  } catch (error) {
    return { file: null, stamp: null, error: messageOf(error) }
  }
}

/**
 * Shape the app log for the tool result.
 *
 * Capped exactly like every other log this plugin returns — the newest 300 lines,
 * and 30000 characters when those lines are long — so a caller cannot tell which
 * channel produced a result by how much of it arrived.
 *
 * @param {string} udid - device id.
 * @param {string} productVersion - the device's iOS version, as reported.
 * @param {string} bundleId - app bundle id.
 * @param {{file: string, stamp: string|null, available: string[], bytes: number, text: string}} appLog - the read result.
 * @param {string} [grep] - regular expression each line must match.
 * @returns {object} the tool result.
 */
function shapeAppLogResult(udid, productVersion, bundleId, appLog, grep) {
  let lines = String(appLog.text ?? '').split('\n')
  if (grep) {
    const pattern = new RegExp(grep)
    lines = lines.filter((line) => pattern.test(line))
  }
  const returned = lines.length
  let joined = lines.length > 300 ? lines.slice(lines.length - 300).join('\n') : lines.join('\n')
  if (joined.length > 30000) joined = joined.slice(joined.length - 30000)
  return {
    udid,
    mode: 'app',
    iosVersion: productVersion,
    bundleId,
    file: appLog.file,
    launchedAt: appLog.stamp,
    bytes: appLog.bytes,
    returned,
    lines: joined,
    // The other launches are named because the one asked for is often not the one
    // that failed: the app writes a new file per launch, and the crash lands in the
    // previous one.
    otherLogs: appLog.available.filter((name) => name !== appLog.file),
    note: `the app's own log, read from its sandbox at ${APP_LOG_DIR} — one file per launch, so this is the `
      + `newest one (${appLog.stamp ?? 'unknown launch time'}); pass file to read an earlier launch instead. `
      + `This survives a crash and is readable while the device is locked.`,
  }
}

// ---------------------------------------------------------------------------
// project inspection
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path to a concrete Xcode project.
 * @param {string} input - a `.xcworkspace`, `.xcodeproj`, or a containing directory.
 * @returns {Promise<{kind: 'workspace'|'project'|'package', root: string, location: string}>} project facts.
 */
export async function detectProject(input) {
  if (typeof input !== 'string' || input === '') throw new Error('path is required')
  const abs = resolvePath(isAbsolute(input) ? input : resolvePath(process.cwd(), input))
  if (/\.xcworkspace$/i.test(abs)) return { kind: 'workspace', root: dirname(abs), location: abs }
  if (/\.xcodeproj$/i.test(abs)) return { kind: 'project', root: dirname(abs), location: abs }

  let info
  try {
    info = await stat(abs)
  } catch {
    throw new Error(`path does not exist: ${abs}`)
  }
  if (!info.isDirectory()) throw new Error(`expected a directory, .xcodeproj, or .xcworkspace: ${abs}`)

  const entries = await readdir(abs, { withFileTypes: true })
  let workspace = null
  let project = null
  let hasPackage = false
  for (const entry of entries) {
    if (entry.isDirectory() && PROJECT_FILE.test(entry.name)) {
      if (/\.xcworkspace$/i.test(entry.name)) workspace ??= entry.name
      else project ??= entry.name
    } else if (entry.isFile() && entry.name === 'Package.swift') {
      hasPackage = true
    }
  }
  if (workspace !== null) return { kind: 'workspace', root: abs, location: join(abs, workspace) }
  if (project !== null) return { kind: 'project', root: abs, location: join(abs, project) }
  if (hasPackage) return { kind: 'package', root: abs, location: abs }
  throw new Error(`no .xcworkspace, .xcodeproj, or Package.swift under ${abs}`)
}

/** `-workspace` / `-project` selector for one project. */
function projectArgs(project) {
  if (project.kind === 'workspace') return ['-workspace', project.location]
  if (project.kind === 'project') return ['-project', project.location]
  return []
}

/** `xcodebuild -list -json` for one selector, as parsed JSON. */
async function listJson(args, cwd) {
  const result = await capture(['xcodebuild', '-list', '-json', ...args], cwd, 180000)
  if (result.exitCode !== 0) {
    throw new Error(`xcodebuild -list failed (exit ${result.exitCode}): ${tailOf(result.stdout + result.stderr, 40)}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`cannot parse xcodebuild -list output: ${tailOf(result.stdout, 40)}`)
  }
}

/**
 * The `.xcodeproj` a workspace wraps, when there is one worth asking.
 *
 * This exists because `-list -json -workspace X.xcworkspace` reports ONLY
 * `{ workspace: { name, schemes } }` — no configurations at all. The
 * configurations live on the project inside, so a workspace has to be asked
 * twice or every project looks like it has nothing but Debug and Release.
 * A real project here has `Debug`, `Release` and `Test-Release`.
 *
 * A single-project workspace almost always references a project of its own name
 * beside it, so that is tried first; otherwise the directory's only `.xcodeproj`
 * is used, and an ambiguous directory answers `null` rather than a guess.
 */
async function projectInsideWorkspace(project) {
  const named = project.location.replace(/\.xcworkspace$/i, '.xcodeproj')
  try {
    if ((await stat(named)).isDirectory()) return named
  } catch {
    /* fall through to scanning */
  }
  let entries
  try {
    entries = await readdir(project.root, { withFileTypes: true })
  } catch {
    return null
  }
  const projects = entries
    .filter((entry) => entry.isDirectory() && /\.xcodeproj$/i.test(entry.name))
    .map((entry) => join(project.root, entry.name))
  return projects.length === 1 ? projects[0] : null
}

/**
 * List the schemes and configurations of a project.
 *
 * A workspace needs asking twice. `-list -json -workspace X.xcworkspace` reports
 * only `{ workspace: { name, schemes } }` — no configurations at all — so a
 * workspace that is asked once makes every project look like it has nothing but
 * Debug and Release. A real project here also builds `Test-Release`.
 * @param {{kind: string, root: string, location: string}} project - detected project.
 * @returns {Promise<{name: string, schemes: string[], configurations: string[], targets: string[]}>} listing.
 */
export async function listSchemes(project) {
  const parsed = await listJson(projectArgs(project), project.root)
  let merged = mergeListings(parsed)
  if (project.kind === 'workspace' && merged.configurations.length === 0) {
    const inner = await projectInsideWorkspace(project)
    if (inner !== null) merged = mergeListings(parsed, await listJson(['-project', inner], project.root))
  }
  return { ...merged, name: merged.name === '' ? projectNameOf(project) : merged.name }
}

/**
 * List the destinations a scheme can build for, via `-showdestinations`.
 *
 * The parsing itself lives in `./parse-destinations.js`, where it is testable
 * against captured real output. It exists because a naive `field:([^,]*)` split
 * cannot tell a comma that separates fields from one inside a value, which is
 * how `variant:Designed for [iPad,iPhone]` used to arrive truncated.
 * @param {{kind: string, root: string, location: string}} project - detected project.
 * @param {string} scheme - scheme name.
 * @returns {Promise<Array<object>>} destinations with a ready `destination` string.
 */
export async function showDestinations(project, scheme) {
  if (!scheme) return []
  const result = await capture(
    ['xcodebuild', '-showdestinations', ...projectArgs(project), '-scheme', scheme],
    project.root,
    180000,
  )
  const listed = parseDestinations(result.stdout)
  // `-showdestinations` mentions only the devices Xcode manages through
  // CoreDevice, so it omits every iOS 16 device — while `-destination
  // platform=iOS,id=<udid>` builds for one perfectly well. Left unsaid, a
  // plugged-in iPhone X could not be chosen from the panel at all.
  const known = new Set(listed.map((entry) => entry.id))
  // Sorted here, once, so the panel and the tool cannot disagree about the order — and
  // so a device plugged in a moment ago takes its place among the hardware instead of
  // being appended below every simulator, which is where xcodebuild leaves anything it
  // does not manage itself.
  return sortDestinations(listed.concat(await legacyDevices(known, project.root)))
}

/**
 * Physical devices missing from Xcode's destination list.
 *
 * Records are shaped like the parsed ones so callers cannot tell them apart, with
 * two additions: `legacy` marks the channel, and `model` carries the product type
 * the device reports (e.g. iPhone10,3).
 *
 * @param {Set<string>} known - ids `-showdestinations` already reported.
 * @param {string} cwd - working directory for the probes.
 * @returns {Promise<Array<object>>} destination records.
 */
async function legacyDevices(known, cwd) {
  const listed = await capture([legacyTool('idevice_id'), '-l'], cwd, 20000)
  if (listed.exitCode !== 0) return []
  const out = []
  const ids = String(listed.stdout).split('\n').map((line) => line.trim()).filter((line) => line !== '')
  for (const id of ids) {
    if (known.has(id)) continue
    const version = await capture([legacyTool('ideviceinfo'), '-u', id, '-k', 'ProductVersion'], cwd, 20000)
    if (version.exitCode !== 0) continue
    const productVersion = version.stdout.trim()
    // A device that answers on the classic channel is not automatically legacy;
    // its version decides, exactly as it does for the install path.
    if (!needsLegacyChannel(productVersion)) continue
    const name = await capture([legacyTool('ideviceinfo'), '-u', id, '-k', 'DeviceName'], cwd, 20000)
    const model = await capture([legacyTool('ideviceinfo'), '-u', id, '-k', 'ProductType'], cwd, 20000)
    out.push({
      platform: 'iOS',
      id,
      name: name.stdout.trim() !== '' ? name.stdout.trim() : id,
      os: productVersion,
      arch: 'arm64',
      variant: '',
      kind: 'device',
      placeholder: false,
      legacy: true,
      model: model.stdout.trim(),
    })
  }
  return out
}

/** The udid embedded in a destination string, or ''. */
function destinationIdOf(destination) {
  const match = /id=([^,]+)/.exec(String(destination ?? ''))
  return match === null ? '' : match[1]
}

/** SweetPad-compatible defaults from `.vscode/settings.json`, when present. */
async function sweetpadDefaults(project) {
  let raw
  try {
    raw = await readFile(join(project.root, '.vscode/settings.json'), 'utf8')
  } catch {
    return null
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const out = {}
  if (typeof json['sweetpad.build.xcodeWorkspacePath'] === 'string') out.workspacePath = json['sweetpad.build.xcodeWorkspacePath']
  if (typeof json['sweetpad.build.scheme'] === 'string') out.scheme = json['sweetpad.build.scheme']
  const destination = json['sweetpad.build.destination']
  if (destination && typeof destination === 'object' && typeof destination.id === 'string') out.destinationId = destination.id
  return Object.keys(out).length === 0 ? null : out
}

// ---------------------------------------------------------------------------
// plugin body
// ---------------------------------------------------------------------------

/**
 * Mount the xcodebuild tools and the panel's transport routes.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  // Which revision this process actually loaded. Grep the harness log for
  // `dsh-xcodebuild: host half mounted` to answer it without guesswork.
  ctx.logger?.info?.(`dsh-xcodebuild: host half mounted (source written ${LOADED_REVISION})`)

  /** @type {Map<string, object>} run id -> run record. */
  const runs = new Map()
  let seq = 0
  const disposers = []

  // -- run registry --------------------------------------------------------

  function pruneRuns() {
    if (runs.size <= MAX_RUNS) return
    const finished = [...runs.values()].filter((run) => run.status !== 'running')
    finished.sort((a, b) => a.startedAt - b.startedAt)
    while (runs.size > MAX_RUNS && finished.length > 0) runs.delete(finished.shift().id)
  }

  function pushLine(run, text, kind) {
    const line = String(text)
    // A caller that already knows what a line is says so; everything else is
    // classified from the text, which is what colours the panel.
    const k = kind ?? classify(line)
    ringPush(run.ring, { t: line.length > 4000 ? line.slice(0, 4000) : line, k: k })
    if (k === 'error' && run.errors.length < 100) run.errors.push(line.slice(0, 400))
    if (k === 'warning') run.warningCount += 1
  }

  /** Retained lines as `{n, k, t}`, ascending, from line `fromN` on. */
  function readLines(run, fromN) {
    return ringSlice(run.ring, fromN).map((entry) => ({ n: entry.n, k: entry.value.k, t: entry.value.t }))
  }

  function newRun(spec) {
    seq += 1
    const run = {
      id: `xr${seq}`,
      ...spec,
      status: 'running',
      ring: createRing(MAX_LINES),
      errors: [],
      warningCount: 0,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      aborted: false,
      stopped: false,
      // An attached launch is a session, not a process that ends: these two say what
      // it achieved and whether the run is still living in it.
      attached: false,
      launched: false,
      consoleTap: null,
      appLogPump: null,
      syslogFeed: null,
      detachedChild: false,
      child: null,
      artifact: null,
      note: '',
    }
    // `...spec` is spread ABOVE, so a default placed in the literal would lose to
    // it; this is set after, where it wins only when the spec said nothing.
    run.workspace = typeof spec.workspace === 'string' ? spec.workspace : null
    runs.set(run.id, run)
    pruneRuns()
    return run
  }

  function runSummary(run) {
    return {
      runId: run.id,
      action: run.action,
      scheme: run.scheme,
      configuration: run.configuration,
      destination: run.destination,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      lineCount: run.ring.count,
      warningCount: run.warningCount,
      errors: run.errors.slice(0, 40),
      artifact: run.artifact,
      note: run.note,
      projectPath: run.project.location,
    }
  }

  // -- invocation ----------------------------------------------------------

  function buildArgv(spec) {
    const argv = ['xcodebuild', ...projectArgs(spec.project)]
    if (spec.scheme) argv.push('-scheme', spec.scheme)
    if (spec.configuration) argv.push('-configuration', spec.configuration)
    if (spec.action === 'archive') argv.push('-destination', spec.destination || 'generic/platform=iOS')
    else if (spec.destination) argv.push('-destination', spec.destination)
    if (spec.derivedDataPath) argv.push('-derivedDataPath', spec.derivedDataPath)
    if (spec.action === 'archive') argv.push('-archivePath', spec.archivePath)
    if (spec.resultBundlePath) argv.push('-resultBundlePath', spec.resultBundlePath)
    if (spec.action === 'clean') argv.push('clean')
    else if (spec.action === 'archive') argv.push('-allowProvisioningUpdates', 'archive')
    else if (spec.action === 'test') argv.push('-allowProvisioningUpdates', 'test')
    else argv.push('-allowProvisioningUpdates', 'build')
    return argv
  }

  /** Archive next to Xcode's own, so the Organizer still lists it. */
  function defaultArchivePath(project) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    return join(homedir(), 'Library/Developer/Xcode/Archives', `${stamp} ${projectNameOf(project)}.xcarchive`)
  }

  /**
   * The workspace root the panel should start from, or '' when none can be named.
   *
   * The session's own header carries the directory the user opened, and that is
   * the only honest answer here. `process.cwd()` is emphatically not: it is the
   * harness's own launch directory, so answering with it aimed the panel at
   * `.../dsh-desktop/launch-root`, searched it, and reported "No .xcworkspace or
   * .xcodeproj under launch-root" — an error about a directory the user never
   * chose, which is worse than saying nothing.
   *
   * '' means "unknown", and the panel treats it as such: it leaves the path field
   * empty instead of filling it with a directory that is not the user's. A panel
   * that cannot name a session must not be handed an invented one.
   */
  function workspaceFor(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        // `header.cwd` is optional on a session, so an absent one is a normal
        // outcome here rather than an error.
        const cwd = ctx.get('sessions')?.get(sessionId)?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        /* an unresolvable session is not an error worth failing the route over */
      }
    }
    return ''
  }

  async function resolveDefaultDestination(project, scheme, preferred) {
    // `pickDefaultDestination` prefers connected hardware. The old "first entry
    // wins" here returned macOS, because `-showdestinations` prints
    // `platform:macOS` first — silently targeting "My Mac" for an iOS app.
    return pickDefaultDestination(await showDestinations(project, scheme), preferred)
  }

  /**
   * Start a run and return it at once, without waiting for it to finish.
   *
   * The panel's `/start` must answer immediately. Awaiting the run there held one
   * HTTP request open for the whole build, and — because the run was tagged with
   * its workspace only after that await — left the panel with no run to poll while
   * the build was happening. `run.done` settles when the build has finished and,
   * for `run`, when the product is on the destination too. Callers that need the
   * end await it; `xcode_run` watches `run.status` through `waitForRun`.
   *
   * @param {object} request - panel or tool arguments.
   * @param {AbortSignal} [signal] - cancels the child when the tool call is cancelled.
   * @param {string} [workspace] - owning workspace, tagged at creation so the panel
   *   can find the run while it is still working.
   * @returns {Promise<object>} the running run.
   */
  async function startRun(request, signal, workspace) {
    const project = await detectProject(request.path)
    const scheme = request.scheme ?? ''
    const destination = request.destination || await resolveDefaultDestination(project, scheme)
    const spec = {
      action: request.action ?? 'build',
      project,
      scheme,
      configuration: request.configuration ?? 'Debug',
      destination,
      derivedDataPath: request.derivedDataPath ? resolvePath(request.derivedDataPath) : undefined,
      archivePath: request.action === 'archive' ? defaultArchivePath(project) : undefined,
      resultBundlePath: request.resultBundlePath ? resolvePath(request.resultBundlePath) : undefined,
    }
    const argv = buildArgv(spec)
    const run = newRun({ ...spec, workspace, argv })
    // Read once per run, before the command line is printed, so the panel shows the
    // pipeline it is actually running.
    const beautify = await beautifyTool()

    pushLine(run, beautify === null
      ? `$ ${argv.join(' ')}`
      : `$ ${beautifyPipelineLine(argv, beautify.path, beautify.flags)}`)
    if (beautify !== null) {
      pushLine(run, `this log is beautified with xcbeautify${beautify.version === '' ? '' : ` ${beautify.version}`}`
        + `${beautify.flags.includes('--preserve-unbeautified') ? '' : ' (this build may hide task lines: this xcbeautify has no --preserve-unbeautified)'}`)
    }
    run.done = runBuild(run, signal, beautify).catch((error) => {
      // Nothing else awaits `run.done`, so a rejection here would be unhandled.
      pushLine(run, `run failed: ${messageOf(error)}`)
      run.status = 'failed'
      if (run.exitCode === null) run.exitCode = -1
    })
    return run
  }

  /** The build itself, followed by the install and launch that `run` adds. */
  async function runBuild(run, signal, beautify) {
    const exit = await spawnStreaming(run.argv, run.project.root, (line) => pushLine(run, line), {
      formatter: beautify === null ? undefined : [beautify.path, ...beautify.flags],
      onChild: (child) => {
        run.child = child
        // A cancelled tool call must not leave xcodebuild running: it holds the
        // build lock and the derived-data arena, so the next attempt would fail
        // on a project the user believes is idle. Marking the run aborted is what
        // makes the status settle as `cancelled` rather than `failed`.
        if (signal === undefined) return
        const abort = () => {
          run.aborted = true
          try {
            child.kill('SIGINT')
          } catch {
            /* already gone */
          }
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      },
    })
    run.exitCode = exit.exitCode
    run.signal = exit.signal
    if (run.aborted) {
      run.status = 'cancelled'
      run.endedAt = Date.now()
      return run
    }
    if (run.exitCode !== 0) {
      run.status = 'failed'
      run.endedAt = Date.now()
      return run
    }
    // The run is not over until the product is on the destination. Publishing
    // `succeeded` before this point made every poller stop — the client drops its
    // `activeRunId` on any non-running status — so the install and launch lines
    // were written into a log nobody was reading any more. That is exactly why a
    // successful Build & Run showed neither an install nor a launch.
    //
    // A failed install or launch fails the RUN. `run.exitCode` stays 0 because it
    // is `xcodebuild`'s — but the action is `run`, not `build`, and answering
    // `succeeded` for the half that did not happen is what let an iPhone X
    // "launch" that never launched read as a clean run.
    //
    // `endedAt` moves past both steps: it used to be stamped here, so a launch
    // that hung for five minutes was reported as a 9-second run.
    if (run.action === 'run') {
      try {
        await installAndLaunch(run)
      } catch (error) {
        const reason = messageOf(error)
        pushLine(run, `launch failed: ${reason}`)
        run.errors.push(`launch failed: ${reason}`)
        run.note = `built, but installing/launching failed: ${reason}`
        run.status = 'failed'
        run.endedAt = Date.now()
        return run
      }
    }
    // An attached launch is still running when `installAndLaunch` returns, and
    // settling it here would end the run the panel is streaming — the whole point of
    // keeping the session in the background. `settleAttachedRun` ends it when the
    // session does.
    if (run.attached === true) return run
    run.status = 'succeeded'
    run.endedAt = Date.now()
    return run
  }

  /**
   * Settle a run whose attached debug session has ended.
   *
   * Reaching here at all means the launch was witnessed by the app's own log, so the
   * session ending is not a failure — the user pressed Stop, the app quit, or the
   * phone was unplugged; either way the run delivered what its action promised.
   * Ending *before* that witness is the other case, and that one failed.
   *
   * @param {object} run - the run.
   * @param {{code?: number, signal?: string|null}} result - how the child ended.
   */
  function settleAttachedRun(run, result) {
    if (run.status !== 'running') return
    // The session is over, so nothing is attached any more. This also stands down the
    // armed container reader on the modern channel, which asks before it starts.
    run.attached = false
    // Both readers belong to the session: the console file stops growing when the
    // session does, and the app is no longer running to append to its own log.
    run.appLogPump?.stop()
    run.appLogPump = null
    run.syslogFeed?.stop()
    run.syslogFeed = null
    void run.consoleTap?.stop()
    run.consoleTap = null
    run.exitCode = typeof result?.code === 'number' ? result.code : -1
    run.signal = result?.signal ?? null
    run.endedAt = Date.now()
    if (run.launched === true) {
      run.status = 'succeeded'
      return
    }
    run.status = run.stopped === true ? 'cancelled' : 'failed'
    if (run.status === 'failed' && run.note === '') {
      run.note = `the attached session ended (exit ${run.exitCode}) before the app reported itself`
    }
  }

  /**
   * Ask xcodebuild where the product landed, then install and launch it.
   * The path cannot be constructed: with Xcode's own derived data the product
   * directory carries a per-project hash.
   */
  async function installAndLaunch(run) {
    const argv = [
      'xcodebuild', ...projectArgs(run.project),
      ...(run.scheme ? ['-scheme', run.scheme] : []),
      '-configuration', run.configuration,
      ...(run.destination ? ['-destination', run.destination] : []),
      ...(run.derivedDataPath ? ['-derivedDataPath', run.derivedDataPath] : []),
      '-showBuildSettings', '-json',
    ]
    const settings = await capture(argv, run.project.root, 300000)
    if (settings.exitCode !== 0) {
      run.note = 'built, but -showBuildSettings failed so the .app could not be located'
      return
    }
    let productsDir = ''
    let productName = ''
    try {
      const parsed = JSON.parse(settings.stdout)
      const buildSettings = parsed?.[0]?.buildSettings ?? {}
      productsDir = buildSettings.BUILT_PRODUCTS_DIR ?? ''
      productName = buildSettings.FULL_PRODUCT_NAME ?? ''
    } catch (error) {
      run.note = `built, but -showBuildSettings output was unreadable: ${messageOf(error)}`
      return
    }
    if (productsDir === '' || productName === '') {
      run.note = 'built, but BUILT_PRODUCTS_DIR/FULL_PRODUCT_NAME were absent'
      return
    }
    const appPath = join(productsDir, productName)
    const identifier = await capture(['plutil', '-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Info.plist')], run.project.root, 30000)
    const bundleId = identifier.stdout.trim()
    if (bundleId === '') {
      run.note = `built ${appPath}, but its Info.plist carried no CFBundleIdentifier`
      return
    }
    const kind = destinationKindOf(run.destination)

    // A macOS build IS the runnable artifact: there is no target to install onto.
    if (kind === 'macos') {
      run.artifact = { appPath, bundleId, pid: null }
      pushLine(run, `built ${appPath} — a macOS app, so nothing to install`)
      return
    }

    const udid = destinationIdOf(run.destination)
    if (udid === '') {
      run.note = `built ${appPath}, but the destination named no device id: ${run.destination || '(none)'}`
      return
    }
    // "Any iOS Device" is Xcode's build-only placeholder: it names no hardware.
    // Handed to devicectl it fails as a device-not-found, which says nothing
    // about the real cause — the user has to pick the phone they meant.
    if (udid.indexOf('placeholder') >= 0) {
      run.note = `built ${appPath}, but "${run.destination}" is Xcode's generic placeholder, which names no device; choose a connected device to install onto`
      return
    }

    // A physical device is not a simulator. `simctl` cannot see hardware at all
    // and answers `Invalid device: <udid>` — which is how a `run` against a
    // plugged-in iPhone reported failure even though the build had succeeded.
    // `devicectl` is the command that talks to the device.
    if (kind === 'device') {
      // A device older than iOS 17 is invisible to `devicectl`, and with the
      // classic channel absent that surfaces as a bare device-not-found — which
      // points at the phone rather than at the tools that are not installed.
      const channelHint = () => {
        const missing = DEPENDENCIES
          .filter((entry) => entry.group === LEGACY_GROUP && resolveTool(entry.command) === null)
          .map((entry) => entry.command)
        if (missing.length === 0) return ''
        return `\n(the classic device channel is not installed: ${missing.join(', ')} missing. `
          + `An iPhone on iOS 16 or earlier needs it: ${LEGACY_TOOLCHAIN_INSTALL})`
      }
      // iOS 16 and earlier are not CoreDevice at all. `devicectl` cannot see them
      // and reports the device as missing, which is how a plugged-in iPhone X
      // failed to install while the build itself had succeeded. That generation
      // is still reachable over the classic lockdown protocol, which is an
      // entirely different toolchain.
      if (await isLegacyDevice(udid, run.project.root)) {
        // Name the missing tool now, rather than letting the spawn fail as an
        // ENOENT that says nothing about `brew install`.
        const installer = resolveTool('ideviceinstaller')
        if (installer === null) throw new Error(missingToolNotice('ideviceinstaller'))
        const launcher = resolveTool('ios-deploy')
        if (launcher === null) throw new Error(missingToolNotice('ios-deploy'))
        const install = [installer, '-u', udid, '-i', appPath]
        pushLine(run, `$ ${install.join(' ')}`)
        const installedLegacy = await captureTee(install, run.project.root, 600000, (line) => pushLine(run, line))
        if (installedLegacy.exitCode !== 0) throw new Error(tailOf(installedLegacy.stdout + installedLegacy.stderr, 20))
        // Is the device demanding a passcode? `PasswordProtected` is the device's own
        // answer over the classic channel, and `true` means it needs the passcode —
        // i.e. its screen is locked — in which case the launch cannot bring the app to
        // the foreground and would fail ~43s later with a bare exit 1.
        //
        // This replaced a probe on `idevicescreenshot`, which is not an oracle: it
        // reports `Could not connect to screenshotr!` when the developer disk image is
        // not mounted, and MOUNTING THAT IMAGE is something ios-deploy's launch flow
        // does itself. That probe refused launches that would have worked.
        //
        // `ideviceinfo` needs no image and no pairing session. Only a `true` answer
        // stops the run; `false` and an unreadable answer both launch, because a
        // question that went unanswered is not evidence of a lock.
        const passcodeRequired = await devicePasscodeRequired(udid, run.project.root)
        if (passcodeRequired === true) {
          pushLine(run, `$ ${legacyTool('ideviceinfo')} -u ${udid} -k PasswordProtected`)
          pushLine(run, 'true')
          throw new Error(lockedDeviceNotice('classic'))
        }
        if (passcodeRequired === false) {
          pushLine(run, 'the device is not asking for a passcode (PasswordProtected=false)')
        }
        // `--noinstall` is the point of this pairing: ios-deploy's own install
        // path fails against this generation of AMDevice with 0xe8000067, while
        // its lldb-driven launch works. Install with ideviceinstaller, launch
        // with ios-deploy.
        //
        // `--justlaunch` is NOT passed, and that is the correction this branch is
        // built around: it implies `--debug` (ios-deploy.m:3688-3692), makes the
        // attached path unreachable (:3400-3401), lets lldb `run` the app and then
        // has `safequit` detach — and on a real iPhone X the app it just started is
        // interrupted and closed the moment that happens. An attached session is what
        // actually keeps the app up, and it is `--noninteractive`, not `--debug`:
        // `-I` needs no stdin (a detached child has none), it prints the lifecycle
        // markers `autoexit_command` emits — `PROCESS_CRASHED`, `PROCESS_STOPPED`,
        // `PROCESS_EXITED` — with a stack trace under the bad ones, and it quits by
        // itself when the app does.
        //
        // So the launch is a long-lived background process: spawned detached, its
        // console redirected to a file, and read back by `startLogTap`. The run
        // stays `running` while the session is up, and Stop ends it by signalling
        // the child's process group.
        //
        // `--unbuffered` unbuffers ios-deploy's OWN stdout (`setbuf(stdout, NULL)`,
        // ios-deploy.m:3857). It does not reach lldb, whose output goes through an
        // embedded Python that block-buffers when stdout is a file — measured, the
        // console file sat at a half-written line for six minutes. The child is
        // therefore given `PYTHONUNBUFFERED` (see `spawnAttached`), and the panel's live
        // log comes from the device's relay rather than from this console at all.
        const launch = [launcher, '--id', udid, '--bundle', appPath, '--noinstall', '--no-wifi', '--noninteractive', '--unbuffered']
        // The app's own log, sampled before the launch: the name that appears after
        // it is the witness that the app came up, and it is a device fact rather
        // than anything the toolchain printed.
        const appLogBefore = await peekLegacyAppLog(udid, bundleId, run.project.root)
        // The previous sessions' files are cleaned here, before this one adds its own.
        await pruneSessionFiles(udid)
        const consoleLog = consoleLogFor(run)
        pushLine(run, `$ ${launch.join(' ')} > ${consoleLog} 2>&1`)
        pushLine(run, 'the session is attached and stays in the background; Stop ends it')
        const attached = await spawnAttached(
          launch,
          run.project.root,
          consoleLog,
          (line) => pushLine(run, line, consoleLineKind(line)),
        )
        run.child = attached.child
        run.detachedChild = true
        run.consoleTap = attached.tap
        // Two readers feed the panel, and only one of them runs at a time, because they
        // carry the same lines in different formats and showing both would double every
        // line. The live one is the device's log relay: it pushes the app's lines as they
        // are written. The container-file pump is the fallback for when that stream
        // cannot be had (an older toolchain, a device whose relay refuses, a phone that
        // keeps disconnecting), and it is started only when the feed gives up — never
        // alongside it.
        const startFallbackPump = () => {
          if (run.appLogPump !== null || run.stopped === true) return
          run.appLogPump = startAppLogPump({
            udid,
            bundleId,
            cwd: run.project.root,
            file: appLogBefore.file,
            // The file carries the same lines the relay does, level marks and all, so the
            // app's own severity is read here the same way (`lib/syslog.js`): a warning in
            // the file is a warning in the panel, not a line whose text has to say so.
            onLine: (line) => pushLine(run, line, syslogLineKind(line)),
          })
        }
        run.syslogFeed = startSyslogFeed({
          udid,
          cwd: run.project.root,
          processName: syslogProcessName(appPath),
          onLine: (line, kind) => pushLine(run, line, kind),
          onUnavailable: startFallbackPump,
        })
        if (run.syslogFeed.started === true) {
          pushLine(run, `streaming ${String(syslogProcessName(appPath))}'s own log from the device`)
        }
        // The verdict is this witness. Nothing ios-deploy prints can be one: its
        // `success` line comes from `str(startup_error)` as soon as `Launch()`
        // returns, which is before the process is known to be alive, and safequit's
        // contradicting message never arrives (Python block-buffers stdout and
        // `os._exit` discards it). `lib/legacy-launch.js` carries the full trace.
        const witness = await waitForLaunchWitness({
          udid,
          bundleId,
          cwd: run.project.root,
          before: appLogBefore.file,
          exited: attached.exited,
          windowMs: LEGACY_ATTACH_WINDOW_MS,
        })
        if (witness.file !== null) {
          run.attached = true
          run.launched = true
          run.artifact = { appPath, bundleId, pid: null, appLog: witness.file, consoleLog, attached: true }
          // The run stays `running` on purpose, so both the panel and a tool result
          // have to say why — otherwise a live session reads as a hung build.
          run.note = `the debug session is attached to ${bundleId}; the app stays up and its log keeps streaming until Stop ends the session`
          pushLine(run, `the app wrote a new launch log: ${witness.file}${witness.stamp === null ? '' : ` (${witness.stamp})`}`)
          pushLine(run, `launched ${bundleId} on legacy device ${udid} with the debugger attached — the app stays up while this session is, and Stop ends both`)
          // The session outlives this call. When it ends — Stop, the app dying, the
          // phone being unplugged — the run settles on what it actually did.
          void attached.exited.then((result) => settleAttachedRun(run, result))
          return
        }
        if (witness.exit !== null) {
          const tapped = await attached.tap.stop().then(() => attached.tap.text())
          const failure = legacyLaunchFailure({
            timedOut: false,
            exitCode: witness.exit.code,
            output: tapped,
            pid: null,
            appLogStarted: false,
            locked: passcodeRequired,
          })
          throw new Error(failure ?? `the attached debug session ended (exit ${witness.exit.code}) before the app wrote its launch log in ${APP_LOG_DIR}`)
        }
        // Still attached, but the app has not written its log yet. That is not a
        // failure — the file lags the process — so the session is left running and
        // says where it stands rather than guessing.
        run.attached = true
        run.artifact = { appPath, bundleId, pid: null, appLog: null, consoleLog, attached: true }
        run.note = `built and installed, and the debug session is attached to ${bundleId}, but no launch log has appeared in ${APP_LOG_DIR} yet`
        pushLine(run, `no launch log in ${APP_LOG_DIR} yet${witness.error === null ? '' : ` (${witness.error})`} — the session stays attached; the app's log is written as it starts`)
        void attached.exited.then((result) => settleAttachedRun(run, result))
        return
      }
      const install = ['xcrun', 'devicectl', 'device', 'install', 'app', '--device', udid, appPath]
      pushLine(run, `$ ${install.join(' ')}`)
      const installed = await captureTee(install, run.project.root, 600000, (line) => pushLine(run, line))
      if (installed.exitCode !== 0) throw new Error(tailOf(installed.stdout + installed.stderr, 20) + channelHint())
      // The same question as on the classic channel, asked of the modern one: does the
      // device need its passcode? `devicectl device info lockState` answers with
      // `passcodeRequired`, and a locked screen cannot bring an app to the foreground —
      // so asking now saves a launch that would fail with a less specific message.
      //
      // One question, one oracle per channel. The classic key (`PasswordProtected`)
      // was measured to answer for a modern device as well, but only by its classic
      // id, and this branch is handed the CoreDevice identifier — where `devicectl`
      // itself is the only thing that can answer.
      const lockState = await deviceLockState(udid, run.project.root)
      if (lockState === true) {
        pushLine(run, `$ xcrun devicectl device info lockState --device ${udid}`)
        pushLine(run, 'passcodeRequired: true')
        throw new Error(lockedDeviceNotice('coredevice'))
      }
      if (lockState === false) pushLine(run, 'the device is not asking for a passcode (passcodeRequired=false)')
      // The launch is an attached session here too, and for the same reason as on the
      // classic channel: a one-shot launch leaves the panel with nothing to read, and the
      // app's own logging only exists while something is connected to it. `--console`
      // connects the app's standard streams and waits for it to exit, so the console file
      // carries the app's log live — measured, 128 KB in the first twelve seconds on the
      // iPhone 12 — and a signal sent to this session is forwarded to the app, which is
      // what Stop means.
      const launch = modernLaunchArgv({ udid, bundleId })
      const consoleLog = consoleLogFor(run)
      pushLine(run, `$ ${launch.join(' ')} > ${consoleLog} 2>&1`)
      pushLine(run, 'the session is attached and stays in the background; Stop ends it')
      const attached = await spawnAttached(
        launch,
        run.project.root,
        consoleLog,
        (line) => pushLine(run, line, consoleLineKind(line)),
      )
      run.child = attached.child
      run.detachedChild = true
      run.consoleTap = attached.tap
      const processName = syslogProcessName(appPath)
      // The fallback for an app that logs only to its own file: the console would then
      // stay silent and the container copy is the only source. It is armed only after the
      // launch is witnessed, so a launch that never happens does not start reading a log
      // that is not being written.
      const startContainerPump = () => {
        if (run.appLogPump !== null || run.stopped === true) return
        run.appLogPump = startAppLogPump({
          udid,
          bundleId,
          cwd: run.project.root,
          read: readModernAppLog,
          onLine: (line) => pushLine(run, line, syslogLineKind(line)),
        })
        pushLine(run, "reading the app's own log out of its container instead")
      }
      const witness = await waitForConsoleWitness({
        tap: attached.tap,
        processName,
        exited: attached.exited,
        windowMs: LEGACY_ATTACH_WINDOW_MS,
      })
      if (witness.launched === true) {
        run.attached = true
        run.launched = true
        run.artifact = { appPath, bundleId, pid: witness.pid, appLog: null, consoleLog, attached: true }
        run.note = `the console is attached to ${bundleId}; the app stays up and its log keeps streaming until Stop ends the session`
        pushLine(run, `launched ${bundleId} on device ${udid} (${witness.evidence ?? 'witnessed'})`)
        // An app whose logging never reaches the console is the one case the container
        // copy exists for. The app logging is the proof that the console is a live source,
        // so its silence after a witnessed launch is what arms the second reader.
        if (witness.pid === null) {
          const arm = setTimeout(() => {
            if (run.appLogPump !== null || run.stopped === true || run.attached !== true) return
            // The app's own line is the proof that the console is carrying its logging —
            // devicectl's statement alone is not, since that arrives first whether or not
            // the app ever writes. Only continued silence justifies the second reader,
            // because running both would put every line in the panel twice.
            if (modernLaunchWitness(attached.tap.text(), processName).pid !== null) return
            startContainerPump()
          }, MODERN_CONSOLE_SILENCE_MS)
          arm.unref?.()
        }
        void attached.exited.then((result) => settleAttachedRun(run, result))
        return
      }
      if (witness.exit !== null) {
        const tapped = await attached.tap.stop().then(() => attached.tap.text())
        throw new Error(`the attached console session ended (exit ${String(witness.exit.code)}) before ${bundleId} came up`
          + `${tapped.trim() === '' ? '' : ` — the last thing it said was:\n${tailOf(tapped, 12)}`}`)
      }
      // Still attached without a witness: the launch has not been reported yet. Kept
      // running rather than failed, because a device that is merely slow to start the app
      // looks exactly like this, and Stop can still end it.
      run.attached = true
      run.artifact = { appPath, bundleId, pid: null, appLog: null, consoleLog, attached: true }
      run.note = `the console session is attached to ${bundleId}, but the app has not reported itself yet`
      pushLine(run, `the console session is attached, but ${bundleId} has not reported itself yet — it stays attached; Stop ends it`)
      void attached.exited.then((result) => settleAttachedRun(run, result))
      return
    }

    pushLine(run, `$ xcrun simctl install ${udid} ${appPath}`)
    const installed = await captureTee(['xcrun', 'simctl', 'install', udid, appPath], run.project.root, 180000, (line) => pushLine(run, line))
    if (installed.exitCode !== 0) throw new Error(tailOf(installed.stdout + installed.stderr, 20))
    pushLine(run, `$ xcrun simctl launch ${udid} ${bundleId}`)
    const launched = await captureTee(['xcrun', 'simctl', 'launch', udid, bundleId], run.project.root, 120000, (line) => pushLine(run, line))
    if (launched.exitCode !== 0) throw new Error(tailOf(launched.stdout + launched.stderr, 20))
    run.artifact = { appPath, bundleId, pid: launched.stdout.trim() }
    pushLine(run, `launched ${bundleId} on ${udid}`)
  }

  async function waitForRun(run, seconds) {
    const deadline = Date.now() + Math.max(1, Math.min(seconds ?? 180, 900)) * 1000
    while (run.status === 'running' && Date.now() < deadline) {
      // An attached launch is a session, not a step that finishes: waiting out the
      // whole window would hold every `xcode_run` call for three minutes after the
      // app is already up and streaming. The call returns as soon as the run has
      // something to report — the launch witness — and the session keeps running,
      // which is what the panel's Stop button is for.
      if (run.launched === true) break
      await new Promise((r) => setTimeout(r, 400))
    }
    return run
  }

  /** Tail / incremental / regex-filtered view of one run's log. */
  function readLog(run, options = {}) {
    const from = typeof options.from === 'number' ? options.from : null
    const tailLines = typeof options.tailLines === 'number' ? options.tailLines : 120
    const limit = typeof options.limit === 'number' ? options.limit : null
    const first = ringFirst(run.ring)
    let lines = readLines(run, from === null ? undefined : from)
    if (options.grep) {
      const pattern = new RegExp(options.grep)
      lines = lines.filter((line) => pattern.test(line.t))
    }
    const tailed = from === null ? lines.slice(Math.max(0, lines.length - tailLines)) : lines
    // `limit` caps whichever branch produced the selection. A search anchored to
    // a baseline takes the second branch, which is otherwise unbounded.
    const selected = limit === null ? tailed : tailed.slice(Math.max(0, tailed.length - limit))
    return {
      runId: run.id,
      status: run.status,
      exitCode: run.exitCode,
      totalLines: run.ring.count,
      firstAvailable: first,
      nextLine: run.ring.count,
      returned: selected.length,
      truncated: first > 0,
      lines: selected,
    }
  }

  // -- tools ---------------------------------------------------------------

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const looseOutput = { schema: { type: 'json' }, render: renderJson }

  function renderRun(_args, value) {
    const badge = value.status === 'succeeded' ? '✓' : (value.status === 'running' ? '…' : '✗')
    const body = [
      `${badge} ${value.action}${value.scheme ? ` ${value.scheme}` : ''} — ${value.status} `
        + `(exit ${value.exitCode}, ${Math.round((value.durationMs ?? 0) / 1000)}s, ${value.lineCount} lines`
        + `${value.warningCount ? `, ${value.warningCount} warnings` : ''})`,
    ]
    if (value.destination) body.push(`destination: ${value.destination}`)
    if (value.artifact) body.push(`launched ${value.artifact.bundleId} → ${value.artifact.pid}`)
    if (value.note) body.push(`note: ${value.note}`)
    if (value.errors?.length > 0) {
      body.push('', `errors (${value.errors.length}):`)
      for (const line of value.errors.slice(0, 20)) body.push(`  ${line}`)
    }
    if (value.status === 'running') body.push('', `still running — read more with xcode_log runId=${value.runId}`)
    else if (value.logTail) body.push('', '--- log tail ---', value.logTail)
    return [{ type: 'text', text: body.join('\n') }]
  }

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_project',
    description: 'Detect an Xcode project (.xcworkspace/.xcodeproj) or Swift package and return its schemes, '
      + 'configurations, and targets via `xcodebuild -list -json`. Also reports SweetPad defaults found in '
      + '.vscode/settings.json. Start here: every other xcode_* tool needs the project path and usually a scheme.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a .xcworkspace, .xcodeproj, or a directory containing one (or Package.swift).' },
    },
    output: looseOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      const project = await detectProject(args.path)
      const listed = await listSchemes(project)
      return {
        kind: project.kind,
        root: project.root,
        location: project.location,
        name: listed.name,
        schemes: listed.schemes,
        configurations: listed.configurations,
        targets: listed.targets,
        sweetpadDefaults: await sweetpadDefaults(project),
      }
    },
  })), 'dsh-xcodebuild:xcode_project'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_doctor',
    description: 'Report what this plugin needs from the machine and what is missing, with the install '
      + 'command for each gap. Xcode provides xcodebuild, xcrun, xcode-select and plutil. The channel for '
      + 'iOS 16 and earlier devices needs three SEPARATE Homebrew formulae — libimobiledevice, '
      + 'ideviceinstaller and ios-deploy — and installing only libimobiledevice leaves both install and '
      + 'launch broken. Run this before diagnosing a device problem: a missing tool otherwise surfaces as '
      + '`spawn ... ENOENT` or as a device-not-found that blames the phone.',
    parameters: {},
    output: looseOutput,
    isConcurrencySafe: () => true,
    async execute() {
      return doctorReport()
    },
  })), 'dsh-xcodebuild:xcode_doctor'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_destinations',
    description: 'List the destinations an Xcode scheme can build for, using `xcodebuild -showdestinations` — '
      + 'the authoritative source (simulators, USB devices, and My Mac), each with the exact id to pass to '
      + 'xcode_run. Returns a ready-to-use `destination` string for every entry plus a `recommended` default.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a .xcworkspace, .xcodeproj, or containing directory.' },
      scheme: { type: 'string', description: 'Scheme name (from xcode_project). Defaults to the first scheme.' },
    },
    output: looseOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      const project = await detectProject(args.path)
      let scheme = args.scheme
      if (!scheme) scheme = (await listSchemes(project)).schemes[0] ?? ''
      const list = await showDestinations(project, scheme)
      const destinations = list.map((entry) => ({ ...entry, destination: destinationString(entry) }))
      // `pickDefaultDestination` answers with the destination STRING, not a
      // record: this field used to be read as `.destination` off a record, and
      // reading it off a string yields undefined, i.e. always empty.
      const recommended = pickDefaultDestination(destinations)
      return { scheme, count: destinations.length, recommended, destinations }
    },
  })), 'dsh-xcodebuild:xcode_destinations'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_run',
    description: 'Run xcodebuild for an Xcode scheme/project: build, test, clean, archive, or run '
      + '(build, then put the product on the destination: a simulator via simctl, a physical device via '
      + 'devicectl, an iOS 16 or earlier device via ideviceinstaller + ios-deploy, and for macOS nothing, '
      + 'since the built .app is already runnable). The full log streams into a background '
      + 'run you can read with xcode_log — including mid-build, while this call is still waiting. Derived data '
      + 'defaults to Xcode\'s own, so builds stay warm for Xcode.app too. On a non-zero exit the result carries '
      + 'the collected compiler errors. A `run` is only `succeeded` once the product is actually on the '
      + 'destination: if the install or the launch fails, the run reports `failed` and `note` names the reason, '
      + 'even though the build itself exited 0.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a .xcworkspace, .xcodeproj, or containing directory.' },
      action: { type: 'string', enum: ['build', 'test', 'clean', 'archive', 'run'], description: 'xcodebuild action. run = build then install+launch on the destination (simulator, physical device, or a macOS app that needs neither).' },
      scheme: { type: 'string', description: 'Scheme name. Defaults to the project name.' },
      destination: { type: 'string', description: 'Full xcodebuild destination string, e.g. platform=iOS Simulator,id=<UDID>. Get one from xcode_destinations.' },
      configuration: { type: 'string', description: 'Build configuration. Defaults to Debug.' },
      waitSeconds: { type: 'integer', description: 'How long to wait before returning a still-running result (1-900, default 180).' },
      derivedDataPath: { type: 'string', description: 'Override the derived data directory (defaults to Xcode\'s own).' },
      resultBundlePath: { type: 'string', description: 'Where to write the .xcresult bundle when action is test.' },
    },
    output: { schema: { type: 'json' }, render: renderRun },
    timeoutMs: 1800000,
    async execute(args, exec) {
      const run = await startRun(args, exec?.signal)
      await waitForRun(run, args.waitSeconds ?? 180)
      const summary = runSummary(run)
      summary.logTail = readLines(run).slice(-25).map((line) => `${line.n}\t${line.k}\t${line.t}`).join('\n')
      return summary
    },
  })), 'dsh-xcodebuild:xcode_run'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_log',
    description: 'Read the log of an xcodebuild run started by xcode_run: the buffered tail, an incremental '
      + 'slice by line number, or a regex-filtered view. Each line carries its number and kind, so filtering to '
      + 'errors or warnings is cheap. Safe to call while the build is still running.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Run id returned by xcode_run (e.g. xr1).' },
      tailLines: { type: 'integer', description: 'When from is omitted, return only the last N lines (default 120).' },
      from: { type: 'integer', description: 'Return lines numbered >= from (incremental polling).' },
      grep: { type: 'string', description: 'Regular expression; only matching lines are returned.' },
    },
    output: looseOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      const run = runs.get(args.runId)
      if (run === undefined) {
        throw new Error(`unknown runId: ${args.runId} (known: ${[...runs.keys()].join(', ') || 'none'})`)
      }
      return readLog(run, { from: args.from, tailLines: args.tailLines, grep: args.grep })
    },
  })), 'dsh-xcodebuild:xcode_log'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_device_log',
    description: 'Read the log of a booted iOS Simulator or a connected physical device, always as a bounded '
      + 'capture that returns rather than hanging. On a simulator: snapshot (recent persisted lines via `log show '
      + '--last <duration>`) or follow (a live `log stream` window). On hardware there is no `simctl` and no '
      + 'queryable history. An iOS 16 and earlier device is absent from CoreDevice, so pass bundleId and the app\'s '
      + 'OWN per-launch log is read out of its sandbox (`Documents/PPCrashLog/log_<timestamp>.log`, newest by '
      + 'name) — that file survives a crash and is readable while the device is locked, and it is where a failed '
      + 'launch leaves its evidence. mode "syslog" gives the live `idevicesyslog` window instead. Output is capped '
      + 'to the tail of ~300 lines.',
    parameters: {
      udid: { type: 'string', description: 'Simulator udid, or a physical device udid. Defaults to the first booted simulator.' },
      mode: { type: 'string', enum: ['app', 'snapshot', 'follow', 'syslog'], description: 'app (default on an iOS 16 or earlier device, and requires bundleId): the app\'s own sandbox log. syslog: the live system log window. On a simulator: snapshot (default) or follow.' },
      bundleId: { type: 'string', description: 'App bundle id, e.g. com.example.app. Required to read the app\'s own log on an iOS 16 or earlier device: it selects the app container.' },
      file: { type: 'string', description: 'Read this exact log file instead of the newest one, e.g. log_2026-09-22-22-09-45.462.log (an earlier launch, or a name the previous result listed).' },
      duration: { type: 'string', description: 'Snapshot window, e.g. 2m or 30s (default 2m).' },
      durationSeconds: { type: 'integer', description: 'Follow capture window in seconds (1-60, default 10).' },
      predicate: { type: 'string', description: 'Raw NSPredicate, e.g. process == "MyApp".' },
      grep: { type: 'string', description: 'Regular expression applied to each captured line.' },
    },
    output: looseOutput,
    timeoutMs: 300000,
    async execute(args) {
      let udid = args.udid
      if (!udid) {
        const listed = await capture(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], '/', 60000)
        try {
          const parsed = JSON.parse(listed.stdout)
          for (const deviceList of Object.values(parsed.devices ?? {})) {
            if (Array.isArray(deviceList) && deviceList.length > 0) {
              udid = deviceList[0].udid
              break
            }
          }
        } catch {
          udid = undefined
        }
        if (!udid) throw new Error('no booted simulator found; boot one first or pass udid')
      }
      // Hardware is not a simulator, and its log is a different tool entirely:
      // there is no `simctl spawn` on a real device at all. `idevicesyslog` relays
      // the device's syslog and cannot be asked for history, so both modes become
      // one bounded live window — and the result says so instead of implying a
      // snapshot the device never had.
      //
      // An iOS 16 and earlier device gets one more route, and it is the better
      // one: CoreDevice cannot reach that generation, but the app's own log can be
      // pulled straight out of its container with ios-deploy's AFC download. That
      // file is the only log that outlives the process, so it is where a launch
      // that came up and died — or never came up — leaves its evidence.
      // One probe settles both questions: `ideviceinfo` answers only for physical
      // hardware — a simulator udid never does — and its answer is also the version
      // that picks the channel.
      const productVersion = await deviceProductVersion(udid, '/')
      if (productVersion !== '') {
        const legacy = needsLegacyChannel(productVersion)
        if (legacy && args.mode !== 'syslog' && args.bundleId) {
          const appLog = await readLegacyAppLog(udid, args.bundleId, '/', args.file)
          return shapeAppLogResult(udid, productVersion, args.bundleId, appLog, args.grep)
        }
        const seconds = Math.max(1, Math.min(args.durationSeconds ?? 10, 60))
        // Not part of macOS or Xcode. Naming it turns an empty log into an
        // instruction.
        const syslog = resolveTool('idevicesyslog')
        if (syslog === null) {
          return { udid, mode: 'live', seconds, returned: 0, lines: [], note: missingToolNotice('idevicesyslog') }
        }
        let deviceOut = ''
        await captureBounded(
          [syslog, '-u', udid, '--no-colors'],
          seconds * 1000,
          (chunk) => { deviceOut += chunk },
        )
        return {
          udid,
          mode: 'live',
          seconds,
          ...tailLog(deviceOut, args.grep),
          note: legacy && !args.bundleId
            // The better route exists on this device and was not asked for. Saying
            // so here is what turns "the log is empty" into one parameter away.
            ? `this is an iOS ${productVersion} device, so it also has the older channel: pass bundleId to read the app's own sandbox log (${APP_LOG_DIR}/log_<timestamp>.log) instead of this live syslog window`
            : 'a physical device keeps no queryable log history: idevicesyslog relays the syslog live, so this is a live window, not a snapshot',
        }
      }

      const mode = args.mode === 'follow' ? 'follow' : 'snapshot'
      const argv = ['xcrun', 'simctl', 'spawn', udid, 'log', mode === 'follow' ? 'stream' : 'show']
      if (mode === 'snapshot') argv.push('--last', args.duration ?? '2m')
      argv.push('--style', 'compact')
      if (args.predicate) argv.push('--predicate', args.predicate)

      let stdout = ''
      if (mode === 'follow') {
        // Bounded capture: the stream is killed when the window closes, so this
        // always returns instead of holding the tool open forever.
        const seconds = Math.max(1, Math.min(args.durationSeconds ?? 10, 60))
        await captureBounded(argv, seconds * 1000, (chunk) => { stdout += chunk })
      } else {
        const result = await capture(argv, '/', 480000)
        stdout = result.stdout + result.stderr
      }

      return { udid, mode, ...tailLog(stdout, args.grep) }
    },
  })), 'dsh-xcodebuild:xcode_device_log'))

  /**
   * Shape a captured log for the tool result.
   *
   * Every `xcode_device_log` result goes through here, so the simulator and the
   * hardware paths cannot drift apart in how much they return.
   *
   * @param {string} text - captured output.
   * @param {string} [grep] - regular expression each line must match.
   * @returns {{returned: number, lines: string}} capped tail.
   */
  function tailLog(text, grep) {
    let lines = String(text).split('\n')
    if (grep) {
      const pattern = new RegExp(grep)
      lines = lines.filter((line) => pattern.test(line))
    }
    if (lines.length > 300) lines = lines.slice(lines.length - 300)
    let joined = lines.join('\n')
    if (joined.length > 30000) joined = joined.slice(joined.length - 30000)
    return { returned: lines.length, lines: joined }
  }

  /** Collect a child's output for a fixed window, then kill it. */
  function captureBounded(argv, windowMs, onChunk) {
    return new Promise((resolveBounded) => {
      let child
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        resolveBounded()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        resolveBounded()
      }
      child.stdout?.on('data', onChunk)
      child.stderr?.on('data', onChunk)
      child.on('error', finish)
      child.on('close', finish)
      setTimeout(finish, windowMs)
    })
  }

  // -- panel transport -----------------------------------------------------
  //
  // Deliberately not a bespoke trust fence: `connection.requestRejection` is the
  // composition's own fence (Host/Origin anti-DNS-rebinding plus the browser
  // auth cookie), so the panel inherits exactly the security the rest of the
  // GUI has, and nothing here can drift away from it.

  const api = {
    /** Workspace facts plus recent runs, for the panel's initial paint. */
    state: async (body) => {
      const workspace = workspaceFor(body?.sessionId)
      // Only this workspace's runs. A panel belongs to one project, and it must
      // not list — or silently adopt — a build that belongs to another. A run
      // started by a tool carries no workspace and so is claimed by none.
      //
      // An unnamed panel (workspace '') therefore matches only runs an unnamed
      // panel started: a session the host cannot resolve has no workspace to
      // claim, and two such panels share no project of their own to leak.
      const mine = [...runs.values()].filter((run) => run.workspace === workspace)
      const list = mine.map(runSummary)
      list.sort((a, b) => (a.runId < b.runId ? 1 : -1))
      const active = mine.find((run) => run.status === 'running')
      // The revision this process loaded, so the panel can say it out loud. The
      // profile mounts the host half once at boot; without this, a stale process
      // and a broken fix are indistinguishable from the UI.
      return { workspace, activeRunId: active?.id ?? null, runs: list, revision: LOADED_REVISION }
    },
    detect: async (body) => {
      const project = await detectProject(body?.path)
      const listed = await listSchemes(project)
      return {
        kind: project.kind,
        root: project.root,
        location: project.location,
        name: listed.name,
        schemes: listed.schemes,
        configurations: listed.configurations,
        sweetpadDefaults: await sweetpadDefaults(project),
      }
    },
    /**
     * Every project at or below a directory, so the panel can offer a choice
     * instead of asking the user to know which `.xcworkspace` is theirs.
     */
    projects: async (body) => findProjects(body?.path),
    destinations: async (body) => {
      const project = await detectProject(body?.path)
      const list = await showDestinations(project, body?.scheme)
      const destinations = list.map((entry) => ({ ...entry, destination: destinationString(entry) }))
      // The host owns this policy so the panel and the xcode_destinations tool
      // cannot disagree about what "the default" is. `preferred` is what this
      // workspace used last time.
      return { destinations, recommended: pickDefaultDestination(destinations, body?.preferred) }
    },
    /** What this machine is missing, for the panel's warning row. */
    doctor: async () => doctorReport(),
    start: async (body) => {
      // Whose workspace this belongs to, so another project's panel never sees it —
      // and tagged before the run does any work, so the panel that started it can
      // find it while it builds. The run itself carries on in the background.
      const run = await startRun(body ?? {}, undefined, workspaceFor(body?.sessionId))
      return { runId: run.id, argv: run.argv, destination: run.destination }
    },
    poll: async (body) => {
      const run = runs.get(body?.runId)
      if (run === undefined) return { missing: true, status: 'unknown' }
      const from = typeof body.from === 'number' ? body.from : 0
      const first = ringFirst(run.ring)
      return {
        runId: run.id,
        status: run.status,
        action: run.action,
        exitCode: run.exitCode,
        next: run.ring.count,
        firstAvailable: first,
        truncated: first > 0,
        warningCount: run.warningCount,
        errors: run.errors.slice(0, 20),
        artifact: run.artifact,
        note: run.note,
        durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
        lines: readLines(run, Math.max(from, first)),
      }
    },
    // The panel's text filter runs here, not in the browser: the browser holds
    // a rendering window, and a filter that only searched that window would
    // silently miss the beginning of a large build.
    search: async (body) => {
      const run = runs.get(body?.runId)
      if (run === undefined) return { missing: true }
      const limit = Math.max(1, Math.min(body?.limit ?? 1500, 4000))
      // `since` is the panel's clear baseline. A cleared panel must not have its
      // filter repopulated with the lines the user just discarded, and only the
      // host can enforce that: it owns the whole run, the browser a window.
      const since = typeof body?.since === 'number' && body.since > 0 ? body.since : 0
      return readLog(run, { from: since, grep: body?.grep, limit, tailLines: limit })
    },
    stop: async (body) => {
      const run = runs.get(body?.runId)
      if (run === undefined) return { ok: false, reason: 'unknown runId' }
      if (run.status !== 'running') return { ok: false, reason: `already ${run.status}` }
      run.aborted = true
      // Which of the two endings this is matters: an attached session the user
      // stopped after the app came up is a run that did its job, and reporting it as
      // `cancelled` would claim otherwise.
      run.stopped = true
      // SIGTERM, and measured rather than assumed: on the iPhone 12, devicectl IGNORES
      // SIGINT — it survived it, and so did the app it was attached to — while SIGTERM
      // terminated the app ("App terminated due to signal 15") and then ended devicectl by
      // itself. The classic channel takes the same signal to the same effect, because
      // ios-deploy's handler treates SIGTERM like SIGINT and SIGKILLs its own group.
      killRunChild(run, 'SIGTERM')
      // A session that does not end on its own is ended anyway. Leaving a hung devicectl
      // attached would mean a run that can never leave `running`, and the panel's Stop
      // would look broken; an abrupt kill is the lesser failure.
      const escalate = setTimeout(() => {
        if (run.status === 'running') killRunChild(run, 'SIGKILL')
      }, STOP_ESCALATE_MS)
      escalate.unref?.()
      return { ok: true }
    },
  }

  function sendJson(res, status, payload) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload ?? null))
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        req.resume()
        return null
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  }

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => {
      const registrations = Object.keys(api).map((method) => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}${method}`,
        handler: async (req, res) => {
          const rejection = webCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          let body = null
          try {
            const text = await readBody(req)
            if (text === null) {
              sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
              return
            }
            body = text === '' ? null : JSON.parse(text)
          } catch (error) {
            sendJson(res, 400, { code: 'bad-request', message: messageOf(error) })
            return
          }
          try {
            sendJson(res, 200, await api[method](body))
          } catch (error) {
            sendJson(res, 500, { code: 'failed', message: messageOf(error) })
          }
        },
      }))
      return () => {
        for (const dispose of registrations.reverse()) dispose()
      }
    }, 'dsh-xcodebuild: panel routes')
  })

  // Runs are killed on unload so a reloaded plugin never leaves an orphaned
  // xcodebuild holding a simulator or a build lock.
  ctx.effect(() => () => {
    for (const run of runs.values()) {
      run.syslogFeed?.stop()
      run.appLogPump?.stop()
      void run.consoleTap?.stop()
      killRunChild(run, 'SIGKILL')
    }
    runs.clear()
  }, 'dsh-xcodebuild: run cleanup')

  ctx.logger?.info?.(`dsh-xcodebuild mounted (${Object.keys(api).length} panel routes, ${runs.size} runs)`)

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
