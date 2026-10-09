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
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
import { appOutcomeOfLine, appOutcomeOfSession, isDeath, outcomePhrase } from './app-death.js'
import { consoleLineKind, legacyLaunchFailure } from './legacy-launch.js'
import { flushCarry, nextReadOffset, takeLines } from './log-tap.js'
import { lockedDeviceNotice, parseDevicectlLockState, parsePasswordProtected } from './lock-state.js'
import { modernCopyArgv, modernLaunchArgv, modernLaunchWitness } from './modern-launch.js'
import { beautifyDisabled, beautifyPipelineLine, stripAnsi, supportedBeautifyFlags } from './beautify.js'
import {
  decodeSyslogEscapes,
  syslogFeedArgv,
  syslogLineKind,
  syslogProcessName,
} from './syslog.js'
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
import { annotateTransports, mergeDestinations, parseDevicectlList, parseXcdeviceList } from './device-sources.js'
import { createLldbSession } from './lldb-session.js'
import { findAppProcess, parseLaunchctlList, parseProcessList } from './running-app.js'
import {
  VIEW_HIERARCHY_EXPRESSION,
  formatViewHierarchy,
  parseViewHierarchy,
  viewHierarchyStats,
} from './view-hierarchy.js'
import { attachFailure } from './attach-failure.js'
import { chooseLldb, describeLldbChoice, lldbCandidates } from './lldb-choice.js'
import {
  describeForeignDebuggers,
  describeStuckDebuggers,
  foreignDebuggers,
  parseProcessTable,
  stuckDebuggers,
} from './stuck-debuggers.js'
import { describeConnectedDevices, parseDeviceList, resolveDeviceId, sameDeviceId } from './lldb-devices.js'
import { firstExisting, lookinAppCandidates, parseMdfindLookin } from './lookin-app.js'
import { detailRows, parseColorValue } from './view-details.js'
import {
  attributesExpression,
  constraintsExpression,
  editableDescriptor,
  editExpression,
  editSucceeded,
  parseConstraintsReport,
  parseIvarDescription,
} from './view-attributes.js'
import { SHOT_DIR_NAME, parseShotsReport, shotFileName, viewShotsExpression } from './view-shots.js'
import {
  absoluteFrames,
  buildLookinFile,
  classChainExpression,
  classChainsExpression,
  oidFromAddress,
  parseChainsReport,
  parseClassChain,
  toArchiveXml,
} from './lookin-file.js'
import {
  LOOKIN_KEEP,
  archiveNameFor,
  historyEntry,
  isArchiveName,
  jobPercent,
  metaNameFor,
  renderBatches,
  sortHistory,
  staleArchives,
} from './lookin-cache.js'
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

/** After the MCP servers section, before the tools SDK section. */
const PROMPT_ORDER = 3150

/** Always-present routing text: short, because it costs tokens on every step. */
const PROMPT_SECTION = [
  '# Xcode (dsh-xcodebuild)',
  'For any Xcode, iOS or macOS build work, use the xcode_* tools instead of running `xcodebuild`, '
    + '`xcrun simctl` or `devicectl` through the shell. Runs started with xcode_run appear live in the '
    + 'user\'s Xcode panel; shell builds do not.',
  '- Build, run, test, archive, clean: xcode_project (schemes) -> xcode_destinations (target) -> xcode_run.',
  '- A result with status "running": follow it with xcode_log runId=<id> using `from` for new lines.',
  '- Compiler errors are in the xcode_run result; use xcode_log grep="error:" for the full list.',
  '- App crashed or misbehaves after launch: xcode_device_log (pass bundleId on iOS 16 and earlier devices).',
  '- App runs but a screen looks wrong, or you need a breakpoint, a backtrace or `po`: xcode_lldb '
    + '(action=view-hierarchy dumps the running view tree; action=command runs any lldb command). It '
    + 'attaches to the app this workspace last ran and stops it, so the app must be running first.',
  '- Install or launch fails, or a tool reports ENOENT: xcode_doctor first.',
  'Load the `xcode-build-loop` skill for the full procedure.',
].join('\n')

/** The on-demand playbook behind the `xcode-build-loop` skill. */
const SKILL_BODY = `# Xcode build loop

Use the xcode_* tools for all Xcode work. Every run they start is shown live in the
user's Xcode panel (same log, same status), so the user can watch and stop it.

## 1. Find the project
- \`xcode_project path=<dir or .xcworkspace/.xcodeproj>\` returns schemes, configurations,
  targets and any SweetPad defaults. Prefer a .xcworkspace when both exist (CocoaPods).
- Pick the scheme the user named, else the SweetPad default, else the app scheme
  (not a test or framework scheme). Ask only if several app schemes remain.

## 2. Pick a destination
- \`xcode_destinations path=… scheme=…\` returns ready \`destination\` strings and a
  \`recommended\` one. Use it unless the user asked for a specific simulator or device.
- Pass the \`destination\` string verbatim to xcode_run; never compose one by hand.

## 3. Run
- \`xcode_run path=… scheme=… destination=… action=build|run|test|clean|archive\`.
- \`run\` = build, install and launch. It is \`succeeded\` only when the app is actually
  on the destination; otherwise \`note\` names why.
- If the result says \`running\`, keep reading with \`xcode_log runId=<id> from=<next>\`
  until the status is final. Do not start a second run of the same scheme meanwhile.

## 4. Debug the running app with LLDB
- \`xcode_lldb action=view-hierarchy\` returns the running app's view tree: class names, frames,
  text, hidden flags, and stack-view attributes. It attaches to the app this workspace last
  ran and stops it. Use it for "why does this screen look wrong", "which view is on top",
  "where is this label". Narrow a big tree with \`className=\` or \`text=\`.
- \`xcode_lldb action=command command="po self.view"\` runs any LLDB command in the same
  session: \`bt\`, \`bt all\`, \`breakpoint set -n viewDidLoad\`, \`expression\`, \`image list\`.
- A device attach takes 10-25 seconds and the session is kept, so attach once and ask
  several questions. Every command is shown in the user's LLDB drawer, where they can run
  their own.
- The app must be running and is PAUSED by the attach. Detach when done if the user wants
  it running again.

## 4. Fix errors
- The result carries the first compiler errors. For all of them:
  \`xcode_log runId=<id> grep="error:"\`. For warnings: \`grep="warning:"\`.
- Fix the source, then run the same xcode_run again. Repeat until it succeeds.
- Signing / provisioning errors are the user's decision (team, bundle id): report them.

## 5. After launch
- Crash or wrong behaviour: \`xcode_device_log udid=<id>\`.
  - Simulator: \`mode=snapshot duration=2m\`, or \`mode=follow durationSeconds=15\` while
    reproducing. Narrow with \`predicate='process == "AppName"'\` or \`grep\`.
  - iOS 16 and earlier device: pass \`bundleId\` to read the app's own log file, which
    survives the crash.
- Install/launch fails, "device not found", or \`spawn … ENOENT\`: \`xcode_doctor\` and
  report the missing install command instead of guessing.
`

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
    // Also which debugger `xcrun lldb` finds: the Command Line Tools' lldb cannot debug an iOS
    // device, and lldb names devices differently from the rest of the toolchain, so the plugin
    // asks lldb itself (device list) and picks its debugger from candidates.
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
    // This also decides which lldb `xcrun lldb` finds, and the Command Line Tools' lldb
    // cannot debug an iOS device at all — which is why the plugin picks its debugger from
    // candidates instead of trusting `xcrun`.
    purpose: 'report and select the active Xcode',
    install: 'ships with the Xcode command line tools: xcode-select --install',
  },
  {
    command: 'plutil',
    group: 'macOS',
    required: true,
    purpose: "read the built app's bundle identifier, and write the .lookin file Lookin.app opens",
    install: 'ships with macOS',
  },
  {
    command: 'open',
    group: 'macOS',
    required: true,
    // Both halves of opening a .lookin need it: `open -a Lookin` when Lookin.app is
    // installed, and the `open -R` fallback that reveals the file when it is not.
    purpose: 'open the exported Lookin file',
    install: 'ships with macOS',
  },
  {
    command: 'ps',
    group: 'macOS',
    required: true,
    purpose: 'spot the debugger processes this plugin left behind, before asking for a new one',
    install: 'ships with macOS',
  },
  {
    command: 'pgrep',
    group: 'macOS',
    required: true,
    purpose: 'check that a run\'s console session is really attached before blaming it',
    install: 'ships with macOS',
  },
  {
    command: 'mdfind',
    group: 'macOS',
    // Only the fallback for a Lookin.app installed somewhere unusual: /Applications and
    // ~/Applications are checked first, and with Spotlight off this simply finds nothing.
    required: false,
    purpose: 'find a Lookin.app that is not in an Applications folder',
    install: 'ships with macOS',
  },
  {
    command: 'sips',
    group: 'macOS',
    required: true,
    // Cropping the screen capture per view is `sips -c … --cropOffset …`: no image library, no
    // compiled helper, and it ships with macOS.
    purpose: 'crop the screen capture into per-view screenshots',
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
    command: 'idevicescreenshot',
    group: LEGACY_GROUP,
    required: false,
    purpose: 'capture a physical device screen for the Lookin file',
    install: 'brew install libimobiledevice',
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
    .map((entry) => ({ ...entry, source: 'xcodebuild' }))
  // `-showdestinations` is one source among several, and the one that goes blind
  // first: it lists only the devices Xcode's own layer currently manages, so a phone
  // that is plugged in, unlocked and buildable can be missing from it while
  // `xcdevice`, `devicectl` and the classic channel all still see it. Each channel is
  // mapped into the same record shape and merged by device id, so a device is offered
  // as long as ANY source knows it — and the sources cannot disagree about identity,
  // only about what they know.
  const extras = [
    ...await xcdeviceDevices(project.root),
    ...await coreDeviceDevices(project.root),
  ]
  // The classic channel goes last because it probes per device, and by then it only has
  // to ask about what nothing else could see. It is also the last one standing: when
  // Xcode's layer and CoreDevice are both wedged, lockdown still answers.
  const known = new Set(listed.concat(extras).map((entry) => entry.id))
  const classic = await classicDevices(known, project.root)
  // Sorted here, once, so the panel and the tool cannot disagree about the order — and
  // so a device plugged in a moment ago takes its place among the hardware instead of
  // being appended below every simulator, which is where xcodebuild leaves anything it
  // does not manage itself.
  // Which of these phones is on the end of a cable, because it decides what works: the classic
  // channel (the live log reader, `ios-deploy`) needs the cable, attaching does not. `idevice_id -l`
  // is the usbmuxd view of what is plugged in — measured empty with the phone on Wi-Fi, and listing
  // the udid the moment the cable went in — so it answers this and nothing else has to be asked.
  const usbListed = await capture([legacyTool('idevice_id'), '-l'], project.root, 20000)
  const usbIds = new Set(
    String(usbListed.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== ''),
  )
  return annotateTransports(sortDestinations(mergeDestinations(listed, extras.concat(classic))), usbIds)
}

/**
 * Physical devices missing from Xcode's destination list, over the classic channel.
 *
 * `idevice_id` is the usbmuxd view of what is plugged in, and it is the one that keeps
 * answering when Xcode's own device layer and CoreDevice have lost track of a device
 * between them. Every id it reports that no other source knew is probed for its name
 * and version, so the row is worth showing rather than a bare udid.
 *
 * The version is recorded, not used as a filter: `needsLegacyChannel` decides which
 * install channel a run takes, and each run makes that decision from the same version.
 * Filtering this list by version is what previously hid a modern phone from the panel
 * on a bench where this channel was the only one that could still see it.
 *
 * @param {Set<string>} known - ids every other source already reported.
 * @param {string} cwd - working directory for the probes.
 * @returns {Promise<Array<object>>} destination records.
 */
async function classicDevices(known, cwd) {
  const listed = await capture([legacyTool('idevice_id'), '-l'], cwd, 20000)
  if (listed.exitCode !== 0) return []
  const out = []
  const ids = String(listed.stdout).split('\n').map((line) => line.trim()).filter((line) => line !== '')
  for (const id of ids) {
    if (known.has(id)) continue
    const version = await capture([legacyTool('ideviceinfo'), '-u', id, '-k', 'ProductVersion'], cwd, 20000)
    if (version.exitCode !== 0) continue
    const productVersion = version.stdout.trim()
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
      // Answering on this channel is a fact about the device, not about a tunnel to
      // it: it is plugged in and paired, so it is reachable.
      available: true,
      legacy: needsLegacyChannel(productVersion),
      model: model.stdout.trim(),
      source: 'idevice',
    })
  }
  return out
}

/**
 * Devices from Xcode's own device layer, `xcrun xcdevice list`.
 *
 * This is the layer Xcode's GUI lists devices from, and on the bench that prompted this
 * it reported `available: true` for a phone `-showdestinations` had dropped entirely. Its
 * answer is JSON carrying the hardware udid, so it maps straight onto a destination.
 *
 * A device that fails to answer makes `xcdevice` exit non-zero while still printing every
 * device that did answer, so stdout decides and the exit code is not consulted.
 *
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<Array<object>>} destination records, or none when it said nothing.
 */
async function xcdeviceDevices(cwd) {
  const listed = await capture(['xcrun', 'xcdevice', 'list', '--timeout', '5'], cwd, 60000)
  return parseXcdeviceList(listed.stdout)
}

/**
 * Devices CoreDevice knows, `xcrun devicectl list devices`.
 *
 * The same channel installs and launches on a modern device, so a device it reports as
 * connected is one this plugin can act on immediately. `--json-output` is the interface
 * devicectl documents for a program; the human table is prose a future Xcode may reword.
 *
 * @param {string} cwd - working directory for the probe.
 * @returns {Promise<Array<object>>} destination records, or none when it failed.
 */
async function coreDeviceDevices(cwd) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-devices-'))
  const answer = join(root, 'devices.json')
  try {
    const listed = await capture(
      ['xcrun', 'devicectl', 'list', 'devices', '--json-output', answer],
      cwd,
      60000,
    )
    if (listed.exitCode !== 0) return []
    return parseDevicectlList(await readFile(answer, 'utf8'))
  } catch {
    /* a missing or unparsable answer is no devices, never a failed route */
    return []
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
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
      // What the launch session said about the app's life, once it said anything:
      // `{outcome, evidence, at}` from `lib/app-death.js`, or null while the app is
      // still up. Set the moment the console says so, which is before the session ends
      // — an app that dies is a fact about the run, not about its exit.
      death: null,
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
      death: run.death,
      projectPath: run.project.location,
      origin: run.origin ?? 'panel',
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
  async function startRun(request, signal, workspace, origin = 'panel') {
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
    const run = newRun({ ...spec, workspace, origin, argv })
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

  /** How much of the evidence a note repeats; the log keeps the whole line. */
  const EVIDENCE_IN_NOTE = 90

  /**
   * Settle a run when the session it is attached to ends.
   *
   * A settlement that throws would leave the run at `running` for good — the one status
   * the panel reads as "still working" — so its failure is reported rather than dropped.
   *
   * @param {object} run - the run.
   * @param {Promise<object>} exited - the session child's exit.
   */
  function settleWhenSessionEnds(run, exited) {
    void exited.then((result) => settleAttachedRun(run, result)).catch((error) => {
      pushLine(run, `settling the run failed: ${messageOf(error)}`, 'error')
      if (run.status === 'running') {
        run.status = 'failed'
        run.endedAt = Date.now()
      }
    })
  }

  /**
   * Notice the app dying the moment the session says so.
   *
   * The console is the only witness available while a session is attached: the phone's
   * life-cycle markers and the app's own last words arrive on the very stream the log is
   * tapped from. Recording the death here rather than at settlement is deliberate —
   * `autoexit_command` prints the stack trace UNDER the marker, so ending the run the
   * instant the marker arrives would cut off the thing the user needs to read. The run
   * keeps streaming; what changes now is that the panel says what happened.
   *
   * @param {object} run - the run whose launch is attached.
   * @param {string} line - one line of that session's console.
   */
  function noteAppDeath(run, line) {
    if (run.death !== null) return
    const outcome = appOutcomeOfLine(line)
    if (outcome === null) return
    // Stop ends the session and the app with it, so a death that follows our own signal
    // is our doing, not the app's. `run.stopped` is set before the kill is sent.
    if (run.stopped === true) return
    const evidence = String(line).trim()
    run.death = {
      outcome,
      evidence: evidence.length > EVIDENCE_IN_NOTE ? `${evidence.slice(0, EVIDENCE_IN_NOTE)}…` : evidence,
      at: Date.now(),
      fatal: isDeath(outcome),
    }
    const phrase = outcomePhrase(outcome)
    if (isDeath(outcome)) {
      // An error line, not a note: this is the line that has to be visible even when the
      // user is scrolled to the bottom watching the build, and it is what puts the crash
      // into the run's error list for `xcode_run` to report.
      pushLine(run, `the app ${phrase} on the device (${run.death.evidence}) — the session is still attached; Stop ends it`, 'error')
      run.note = `the app ${phrase} on the device (${run.death.evidence})`
      return
    }
    pushLine(run, `the app ${phrase} on the device`, 'note')
    run.note = `the app ${phrase} on the device — the run did what its action promised`
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
  async function settleAttachedRun(run, result) {
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
    const tap = run.consoleTap
    run.consoleTap = null
    // The console's last words are read AFTER the reader is stopped, because `stop()`
    // drains what the child wrote on its way out — and the app's death is usually in
    // exactly those lines.
    if (tap !== null && tap !== undefined) {
      await tap.stop().catch(() => undefined)
    }
    const said = run.death ?? appOutcomeOfSession(tap === null || tap === undefined ? '' : tap.text())
    if (said !== null && run.death === null && run.stopped !== true) run.death = { ...said, at: Date.now() }
    run.exitCode = typeof result?.code === 'number' ? result.code : -1
    run.signal = result?.signal ?? null
    run.endedAt = Date.now()
    // A Stop outranks every marker that follows it: the app died because the panel ended
    // the session, and calling that a crash would blame the app for our signal.
    if (run.stopped === true) {
      run.status = 'cancelled'
      run.note = 'the session was stopped from the panel, and the app went with it'
      return
    }
    // The bug this branch exists for: the app crashing and the user quitting it used to
    // be the same input here — `launched === true` — so every crashed launch settled
    // green, with a note still claiming the app was up. Dying is a failure of what `run`
    // promised, and it is the one outcome the panel must never report as success.
    if (said !== null && isDeath(said.outcome)) {
      run.status = 'failed'
      run.note = `the app ${outcomePhrase(said.outcome)} on the device (${said.evidence})`
      if (!run.errors.includes(run.note)) run.errors.push(run.note)
      return
    }
    if (run.launched === true) {
      run.status = 'succeeded'
      // The note written at launch says the app stays up for as long as the session does.
      // The session is over, so leaving it there would keep the panel describing a state
      // that has ended.
      run.note = said === null
        ? 'the run delivered what its action promised; the attached session ended'
        : `the app ${outcomePhrase(said.outcome)} on the device — the run delivered what its action promised`
      return
    }
    run.status = 'failed'
    // Whatever this run was saying, it was saying it about a session that has now ended —
    // "still attached, waiting" is not true any more, so the note is replaced rather than
    // kept.
    run.note = said === null
      ? `the attached session ended (exit ${run.exitCode}) before the app reported itself`
      : `the attached session ended (exit ${run.exitCode}) and the app ${outcomePhrase(said.outcome)} — it never reported itself`
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
          (line) => {
            // The app's death is read off this stream, not off the exit: ios-deploy quits
            // when the app does, but the panel has to say why before then.
            noteAppDeath(run, line)
            pushLine(run, line, consoleLineKind(line))
          },
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
            onLine: (line) => {
              // The app's own log is a second place its death can appear — the console
              // only carries what lldb flushed, and the fatal banner is written to the
              // file directly — so every reader of the app's output watches for it.
              noteAppDeath(run, line)
              pushLine(run, line, syslogLineKind(line))
            },
          })
        }
        run.syslogFeed = startSyslogFeed({
          udid,
          cwd: run.project.root,
          processName: syslogProcessName(appPath),
          onLine: (line, kind) => {
            noteAppDeath(run, line)
            pushLine(run, line, kind)
          },
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
          settleWhenSessionEnds(run, attached.exited)
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
        settleWhenSessionEnds(run, attached.exited)
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
        (line) => {
          // Same reader as the classic channel: this console is where devicectl reports
          // the launch, and where the app writes its own last words.
          noteAppDeath(run, line)
          pushLine(run, line, consoleLineKind(line))
        },
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
          onLine: (line) => {
            noteAppDeath(run, line)
            pushLine(run, line, syslogLineKind(line))
          },
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
        settleWhenSessionEnds(run, attached.exited)
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
      settleWhenSessionEnds(run, attached.exited)
      return
    }

    // A shutdown simulator is not the user's error: `simctl install` refuses one with
    // "Unable to lookup in current state: Shutdown" (measured on a device the user had
    // never opened), and Xcode boots it for you. `bootstatus -b` boots it if it is not
    // booted and waits until it is — about ten seconds cold, and nothing when it is
    // already up.
    pushLine(run, `$ xcrun simctl bootstatus ${udid} -b`)
    const bootedSimulator = await captureTee(['xcrun', 'simctl', 'bootstatus', udid, '-b'], run.project.root, 180000, (line) => pushLine(run, line))
    if (bootedSimulator.exitCode !== 0) throw new Error(tailOf(bootedSimulator.stdout + bootedSimulator.stderr, 20))

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
    description: 'List the destinations an Xcode scheme can build for: the `xcodebuild -showdestinations` '
      + 'list (simulators, My Mac, and the hardware Xcode itself manages) merged with every device that '
      + "Xcode's own device layer (`xcdevice`), CoreDevice (`devicectl`) or the classic USB channel reports — "
      + 'so a plugged-in phone is still offered when one of those channels has lost sight of it. Each entry '
      + 'carries a ready-to-use `destination` string for xcode_run, whether it is reachable, and the sources '
      + 'that saw it; `recommended` is never an unreachable device.',
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
      // Tagged with the calling session's workspace, so the panel open on that
      // project adopts this run and streams it exactly as if Build were pressed.
      const cwd = exec?.agent?.session?.header?.cwd
      const run = await startRun(args, exec?.signal, typeof cwd === 'string' ? cwd : '', 'agent')
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

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'xcode_lldb',
    description: 'Debug the app that is running on a device or simulator with LLDB. '
      + 'action=view-hierarchy attaches to the app this workspace last ran (or the destination you pass), '
      + 'stops it, and returns the key window\'s view tree — class names, frames, text and hidden flags — '
      + 'which is what answers "why does this screen look wrong" and "which view is on top". '
      + 'Every read also writes the same tree, with each view rendered into its own image, as a .lookin '
      + 'file that Lookin.app opens, and returns its '
      + 'path; action=lookin then opens that file for the user to browse. '
      + 'action=command runs any raw LLDB command against the same session (po, bt, breakpoint set, '
      + 'expression, image list) and returns its output. action=attach starts a session and stops the '
      + 'process; action=interrupt stops a running one; action=continue lets it run on, still '
      + 'attached; action=detach lets the app go; action=status reports the session. The session persists between calls, so attach once and then ask — a device '
      + 'attach takes 10-25 seconds, every question after it is immediate. The user watches every command '
      + 'in the panel\'s LLDB drawer, and can run their own there.',
    parameters: {
      action: { type: 'string', enum: ['view-hierarchy', 'lookin', 'attach', 'command', 'interrupt', 'continue', 'detach', 'status'], required: true, description: 'view-hierarchy: dump the view tree (which also writes a .lookin file Lookin.app can open). lookin: open that file in Lookin.app. command: run one LLDB command. attach: connect and stop. interrupt: stop a running process. continue: let it run on, still attached. detach: release the app. status: report the session.' },
      command: { type: 'string', description: 'action=command only: the LLDB command to run, e.g. `po self.view` or `bt all`.' },
      destination: { type: 'string', description: 'Optional destination string (from xcode_destinations) naming the device or simulator. Defaults to the destination of this workspace\'s most recent run.' },
      process: { type: 'string', description: 'Optional process name to attach to on a device, when it is not the app bundle\'s file name.' },
      bundleId: { type: 'string', description: 'Optional bundle id, needed only to launch an app that is not running yet (mode=launch).' },
      mode: { type: 'string', enum: ['attach', 'launch'], description: 'attach (default) joins the app that is running; launch starts it suspended on the destination first.' },
      className: { type: 'string', description: 'action=view-hierarchy: keep only views whose class name contains this, plus the ancestors that position them.' },
      text: { type: 'string', description: 'action=view-hierarchy: keep only views whose text contains this.' },
      maxLines: { type: 'integer', description: 'action=view-hierarchy: cap on tree lines returned (default 400).' },
    },
    output: looseOutput,
    // One debugger, one process: two concurrent sessions would attach to the same app and
    // fight over it.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd
      const workspace = typeof cwd === 'string' ? cwd : ''
      const action = typeof args.action === 'string' ? args.action : 'status'
      const op = action === 'view-hierarchy' ? 'view' : (action === 'status' ? 'state' : action)
      const result = await lldbOp(op, args, workspace)
      if (op !== 'view' || result.ok !== true) return result
      // The tree is the answer, so it is returned as text rather than as JSON of itself.
      const head = [
        `${result.views} views, ${result.depth} levels deep — ${result.target.process || result.target.bundleId} on ${result.target.destination}`,
        `top classes: ${result.classes.slice(0, 8).map((entry) => `${entry.className}x${entry.count}`).join(', ')}`,
        result.truncated ? `showing ${result.shown} of ${result.views} views` : '',
        typeof result.lookinPath === 'string' && result.lookinPath !== ''
          ? `Lookin file: ${result.lookinPath}`
          : (typeof result.lookinNote === 'string' && result.lookinNote !== '' ? `no Lookin file: ${result.lookinNote}` : ''),
      ].filter((line) => line !== '')
      return [{ type: 'text', text: `${head.join('\n')}\n\n${result.tree}` }]
    },
  })), 'dsh-xcodebuild:xcode_lldb'))

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

  // -- LLDB ----------------------------------------------------------------
  //
  // A debugger is a SESSION, not a command. The first question ("can you see this app?")
  // costs a device attach measured at 10–25 s; every question after it is cheap, because
  // the session stays attached and the app only has to be stopped. So one session is kept
  // per plugin instance and reused, and it is ended by the plugin, never left behind —
  // a second lldb attached to the same app would fight the first for it.
  //
  // What the session is attached to comes from the workspace's own last run, so that
  // "show me the view hierarchy" needs no arguments: it means the app the user just
  // watched launch.

  let lldb = null

  /**
   * Which lldb this plugin runs, chosen once.
   *
   * Not `xcrun lldb` by default: `xcrun` follows `xcode-select`, and when that points at the Command
   * Line Tools the lldb it finds cannot debug an iOS device at all — it starts, cannot do the one
   * thing it was asked for, and exits, leaving a session that reads `lldb exited (status dead)`.
   * Candidates are tried best-first (Xcode's own lldb leads) and the first that answers is kept.
   *
   * Resolved off to the side at load, so no operation has to wait for it: until it lands the
   * default is used, and a session created with it is replaced the moment the choice is known
   * (a dead session is replaced anyway, see `lldbFor`).
   */
  let lldbChoice
  void (async () => {
    try {
      const apps = await readdir('/Applications').catch(() => [])
      const xcodes = apps
        .filter((name) => /^Xcode[\w .-]*\.app$/.test(name))
        .map((name) => `/Applications/${name}`)
      const developerDir = (await capture(['xcode-select', '-p'], '/', 10000)).stdout.trim()
      lldbChoice = await chooseLldb({
        candidates: lldbCandidates({ developerDir, xcodes }),
        run: async (argv) => {
          const answer = await capture(argv, '/', 20000)
          return { ok: answer.exitCode === 0, stdout: answer.stdout, stderr: answer.stderr }
        },
      })
    } catch {
      // Never fatal: the default below is still a debugger worth trying.
      lldbChoice = null
    }
  })()

  /** The live session, replaced when the previous one died. */
  function lldbFor() {
    if (lldb === null || lldb.state === 'dead') {
      lldb = createLldbSession({ argv: lldbChoice?.argv ?? ['xcrun', 'lldb'], cwd: '/' })
    }
    return lldb
  }

  // The debugger outlives a call by design; it must not outlive the plugin.
  disposers.push(ctx.effect(() => () => {
    const session = lldb
    lldb = null
    void session?.dispose()
  }, 'dsh-xcodebuild: lldb session'))

  /**
   * Which app, on which destination, this workspace's debugger should talk to.
   *
   * The default is the most recent run that produced an installable artifact, because that
   * is the app the user is looking at. Everything can be overridden, which is what makes
   * the route usable before anything has been run.
   *
   * @param {string} workspace - the calling session's cwd.
   * @param {object} [body] - overrides: destination, process, mode, bundleId, pid.
   * @returns {object} an attach target.
   */
  function lldbTargetFor(workspace, body) {
    const mine = [...runs.values()].filter((run) => run.workspace === workspace)
    mine.sort((a, b) => b.startedAt - a.startedAt)
    const run = mine.find((entry) => entry.artifact !== null) ?? null
    const destination = typeof body?.destination === 'string' && body.destination !== ''
      ? body.destination
      : (run?.destination ?? '')
    const appPath = typeof body?.appPath === 'string' && body.appPath !== ''
      ? body.appPath
      : (run?.artifact?.appPath ?? '')
    // lldb's `device process attach -n` wants the PROCESS name, which is the executable's:
    // for an app bundle that is the bundle's file name without `.app`. The bundle id is a
    // different string and would never match a process.
    const name = typeof body?.process === 'string' && body.process !== ''
      ? body.process
      : (appPath === '' ? '' : basename(appPath).replace(/\.app$/, ''))
    const pid = Number.isFinite(body?.pid) ? body.pid : (Number.isFinite(run?.artifact?.pid) ? run.artifact.pid : null)
    return {
      kind: destinationKindOf(destination) === 'simulator' ? 'simulator' : 'device',
      id: /id=([^,]+)/.exec(destination)?.[1] ?? '',
      name,
      appPath,
      pid,
      bundleId: typeof body?.bundleId === 'string' && body.bundleId !== ''
        ? body.bundleId
        : (run?.artifact?.bundleId ?? ''),
      destination,
      mode: body?.mode === 'launch' ? 'launch' : 'attach',
      // A device run keeps its console session attached (ios-deploy), and a second
      // debugger cannot always inspect an app that is already being held. Worth knowing
      // BEFORE attaching, so a failure can say what to do about it.
      heldByRun: run?.artifact?.attached === true,
      // How long a launched app is given to build its UI before it is stopped again.
      settleMs: Number.isFinite(body?.settleMs) ? body.settleMs : 2500,
      runId: run?.id ?? null,
      scheme: run?.scheme ?? '',
    }
  }

  /**
   * Launch the app and report its pid, so a debugger can attach to a running process.
   *
   * NOT `--start-stopped`, although that is what Apple's `devicectl` flow suggests and what
   * this did at first. A process stopped before it has executed a line has no UI and no
   * Objective-C runtime to evaluate against: measured on a device, the dump came back
   * `error: use of undeclared identifier 'UIApplication'` — LLDB had nothing to read. The
   * app is therefore started for real, given time to build its UI by the caller, and then
   * stopped by the attach itself, which delivers SIGSTOP.
   *
   * @param {object} target - from `lldbTargetFor`.
   * @param {string} cwd - working directory for devicectl.
   * @returns {Promise<{ok: boolean, pid?: number, note: string}>} the pid, or why not.
   */
  async function launchForDebugger(target, cwd) {
    if (target.bundleId === '') {
      return { ok: false, note: 'no bundle id is known for this workspace — run the app once, or pass bundleId' }
    }
    if (target.id === '') return { ok: false, note: 'no device id in the destination string' }
    const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-lldb-'))
    const answer = join(root, 'launch.json')
    try {
      const launched = await capture([
        'xcrun', 'devicectl', 'device', 'process', 'launch',
        '--device', target.id,
        '--terminate-existing',
        '--json-output', answer,
        target.bundleId,
      ], cwd, 30000)
      if (launched.timedOut === true) {
        // Launching is the device's own control channel, one step BEFORE any debugger. Measured on
        // 蜜语-Dev: `devicectl device process launch` ran past 84 s with no answer while
        // `devicectl device info details` answered in 2 s in the same minute, so a launch that never
        // returns says the device's control channel is wedged and nothing about the app.
        return {
          ok: false,
          note: 'the device did not launch the app within 30 s: devicectl got no answer at all, which '
            + 'is the device\'s control channel rather than the app — quit Xcode, replug the device, '
            + 'and try again',
        }
      }
      if (launched.exitCode !== 0) {
        const said = `${launched.stderr}\n${launched.stdout}`.trim()
        return { ok: false, note: said.slice(0, 400) === '' ? `devicectl exited ${launched.exitCode}` : said.slice(0, 400) }
      }
      const parsed = JSON.parse(await readFile(answer, 'utf8'))
      const pid = parsed?.result?.process?.processIdentifier
      if (!Number.isFinite(pid)) return { ok: false, note: 'devicectl did not report a process id' }
      return { ok: true, pid, note: '' }
    } catch (error) {
      return { ok: false, note: messageOf(error) }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Make sure a session is attached to the target AND stopped.
   *
   * Reusing an attachment is the whole point of keeping a session: an already attached app
   * only needs interrupting, which is instant, where re-attaching is the 10–25 s path.
   *
   * @param {object} target - from `lldbTargetFor`.
   * @param {string} workspace - for launching commands' working directory.
   * @returns {Promise<{ok: boolean, note: string, session: object, reused?: boolean}>} readiness.
   */
  /**
   * The pid of the app `target` names, as it is running right now.
   *
   * `device process attach -n <name>` does not attach to a named process: it WAITS for one
   * with that name to appear, blocking LLDB's interpreter for as long as it takes. Measured
   * on an iPhone 13, a View Hierarchy press for an app that was not running left the
   * transcript at `device process attach -n 蜜语-Dev` with no answer at all — not even to
   * the `process status` probe sent eight seconds later, because the probe was queued behind
   * it. So the pid is found first and the attach is by pid, and an app that is not running
   * becomes one actionable sentence instead of a session that never answers.
   *
   * @param {object} target - from `lldbTargetFor`.
   * @param {string} workspace - working directory for the listing command.
   * @returns {Promise<{ok: boolean, pid: number, note: string}>} the pid, or why there is none.
   */
  async function resolveRunningApp(target, workspace) {
    const cwd = workspace === '' ? '/' : workspace
    // The first line of a tool's complaint, which is the line that names the problem; the
    // rest is usually advice about flags.
    const reason = (out) => (String(out.stderr !== '' ? out.stderr : out.stdout).trim().split('\n')[0] ?? '')
    if (target.kind === 'device') {
      const answer = join(tmpdir(), `dsh-xcodebuild-procs-${String(Date.now())}.json`)
      const out = await capture(
        ['xcrun', 'devicectl', 'device', 'info', 'processes', '--device', target.id, '--json-output', answer],
        cwd,
        60000,
      )
      let processes = []
      try {
        processes = parseProcessList(await readFile(answer, 'utf8'))
      } catch {
        processes = []
      }
      await rm(answer, { force: true })
      // What the list says decides, not the exit code: devicectl narrates its tunnel
      // handshake on stdout and has been seen to exit non-zero after writing a complete
      // list, so a parsed list is used and the exit code only explains an EMPTY one.
      if (processes.length === 0 && out.exitCode !== 0) {
        return { ok: false, pid: 0, note: `could not list the device's processes: ${reason(out)}` }
      }
      const found = findAppProcess(processes, target.name)
      if (found === null) {
        return {
          ok: false,
          pid: 0,
          note: `${target.name === '' ? target.bundleId : target.name} is not running on the device (${String(processes.length)} processes are, and none of them is it). Run it first — Build & Run — or pass mode=launch to start it under the debugger`,
        }
      }
      return { ok: true, pid: found.pid, note: '' }
    }
    // A simulator's apps are services, and the bundle id is what names them there.
    const out = await capture(['xcrun', 'simctl', 'spawn', target.id, 'launchctl', 'list'], cwd, 30000)
    const pid = parseLaunchctlList(out.stdout, target.bundleId)
    if (pid === null && out.exitCode !== 0) {
      return { ok: false, pid: 0, note: `could not list the simulator's processes: ${reason(out)}` }
    }
    if (pid === null) {
      return {
        ok: false,
        pid: 0,
        note: `${target.name === '' ? target.bundleId : target.name} is not running on the simulator. Run it first — Build & Run — or pass mode=launch to start it under the debugger`,
      }
    }
    return { ok: true, pid, note: '' }
  }

  /**
   * End the debuggers this plugin left behind, before asking for a new one.
   *
   * A failed attach does not always take its processes with it, and the one that is easy to miss is
   * the CoreDevice `.../bin/device` helper, which owns the channel to the phone. Both keep the device
   * busy, so the next attempt fails at the first step — `device select <udid>: no answer within
   * 30000 ms` — a message that names no cause, while the cause is a process this plugin started
   * minutes ago. Measured on 蜜语-Dev: an lldb (2m57s) and its helper (3m17s) still on the device.
   *
   * Only our own descendants are candidates (see lib/stuck-debuggers.js) — Xcode runs the same two
   * programs and its session is not ours to end. Best effort: it must never be the reason a read
   * fails.
   *
   * @returns {Promise<Array<{pid: number, kind: string, command: string}>>} what was ended.
   */
  async function clearStuckDebuggers() {
    let found = []
    try {
      const table = (await capture(['ps', '-ax', '-o', 'pid=,ppid=,command='], '/', 10000)).stdout
      found = stuckDebuggers(parseProcessTable(table), process.pid)
      if (found.length === 0) return []
      for (const entry of found) {
        try { process.kill(entry.pid, 'SIGTERM') } catch { /* already gone */ }
      }
      // A debugger that ignores SIGTERM is exactly the kind that is holding a device: it gets a
      // moment, then SIGKILL, because the device has to come free before anything else can work.
      await new Promise((resolve) => setTimeout(resolve, 250))
      for (const entry of found) {
        try { process.kill(entry.pid, 'SIGKILL') } catch { /* it obeyed SIGTERM */ }
      }
    } catch {
      return found
    }
    return found
  }

  /** lldb's own device list — the only naming of devices that `device select` accepts. */
  async function lldbDeviceList() {
    const argv = lldbChoice?.argv ?? ['xcrun', 'lldb']
    const answer = await capture([...argv, '-b', '-o', 'device list', '-o', 'quit'], '/', 30000)
    return parseDeviceList(`${answer.stdout}${answer.stderr}`)
  }

  /** Whether a run's console session (ios-deploy) is really attached, rather than just recorded. */
  async function consoleSessionAlive() {
    try {
      return (await capture(['pgrep', '-f', 'ios-deploy'], '/', 10000)).stdout.trim() !== ''
    } catch {
      return false
    }
  }

  /** The two names one phone goes by, as last resolved for an attach: hardware UDID ↔ CoreDevice id. */
  const deviceAliases = new Map()
  const sameDevice = (a, b) => sameDeviceId(a, b, deviceAliases)

  /**
   * Whether an lldb command reads or runs code in the app, and so needs it stopped.
   *
   * `po`, `p`, `expr`/`expression`, `call`, `frame variable`/`v`, `bt`/`thread backtrace`, `x`/`memory
   * read` and `register read` all need a stopped process; breakpoint, settings, target, process and
   * platform management do not, and an asynchronous interpreter answers them while the app runs.
   */
  function needsStop(command) {
    const word = command.trim().split(/\s+/)
    const head = word[0] ?? ''
    if (['po', 'p', 'e', 'expr', 'expression', 'call', 'print', 'v', 'var', 'bt', 'x', 'up', 'down', 'finish'].includes(head)) return true
    if (head === 'frame' || head === 'register') return true
    if (head === 'thread' && ['backtrace', 'info', 'select', 'list'].includes(word[1] ?? '')) return true
    if (head === 'memory' && ['read', 'find'].includes(word[1] ?? '')) return true
    return false
  }

  async function lldbEnsureAttached(target, workspace) {
    const existing = lldb
    const current = existing === null ? null : existing.summary().attached
    // A dead lldb is not a session to reuse. It is what a failed attach leaves behind, and
    // answering `reused: true` for it locked the whole LLDB route: every later operation answered
    // "the lldb session is dead" and nothing could be read again until the plugin was restarted
    // (measured on 蜜语-Dev, after two stuck debuggers were cleared off the device).
    const usable = existing !== null && existing.state !== 'dead' && existing.state !== 'exited'
    // A request that names no DEVICE is not asking for a different target: it is asking the session
    // that is already attached ("read this address", "attach to this pid"). That is what the
    // inspector's reads do — `attributes`, `constraints` and `edit` carry an address and nothing else
    // — and what a read carrying only a pid or a bundle id amounts to, since neither names a device.
    // Resolved against the workspace's runs, such a request produced an EMPTY device target, matched
    // no live session, disposed a working attach and failed with `the device  () is not one lldb can
    // attach to right now` — for the whole inspector, on every read, while the tree beside it had
    // just been read from that very session (measured live on 0.6.0).
    //
    // `id` is the test, and nothing else: it is the only field that comes from a destination string,
    // and `attachCommands` only ever emits `device select <id>` for it. Without one, LLDB attaches to
    // the device that is already selected — the one being read — so resolving a fresh session for
    // such a request cannot reach a different app and only risks dropping a working attach.
    const anonymous = target.mode !== 'launch' && target.id === ''
    // A phone has two names, and the session holds the one lldb accepts (the CoreDevice identifier,
    // resolved below) while every later request arrives with the destination's hardware UDID. Compared
    // as strings they never matched, so EVERY View Hierarchy disposed a working session and attached
    // again from scratch — 15–23 s on 蜜语-Dev each time. Either name of the same phone is a match.
    const samePhone = current !== null && target.id !== '' && current.kind === target.kind
      && (current.id === target.id || (current.kind === 'device' && sameDevice(current.id, target.id)))
    if (usable && (samePhone || anonymous)) {
      // Reused as it is. A running app is NOT stopped here: whoever needs a stop takes the shortest
      // one, through `pauseFor`, and gives it back. Stopping on reuse is what kept the app frozen
      // from one read to the next.
      if (existing.state === 'attaching') {
        const waited = await existing.waitForStopped({ timeoutMs: 90000, probeAfterMs: 0, probeEveryMs: 3000 })
        if (!waited.stopped) return { ok: false, note: `still attaching: ${waited.detail}`, session: existing, reused: true }
      }
      return { ok: true, note: '', session: existing, reused: true }
    }
    // Nothing attached and nothing named: attaching to "" is not a device lookup that can succeed, so
    // it is answered here rather than as a list of the phones lldb does know.
    if (anonymous) {
      return {
        ok: false,
        note: 'nothing is attached, and this request named no device: press View Hierarchy, or pick one with Apps',
        session: existing,
      }
    }
    if (existing !== null && existing.state !== 'idle') await existing.dispose()
    const cleared = await clearStuckDebuggers()
    let session = lldbFor()
    const attachTarget = { ...target }

    // A phone has two names, and the toolchain hands out the one lldb does not know: -showdestinations
    // and xcdevice name it by hardware UDID, while `device select` accepts only the CoreDevice
    // identifier. The wrong name is not an error to lldb — it selects nothing and says nothing, and
    // the attach that follows waits forever. Measured on 蜜语-Dev: `device select` on the name lldb
    // knows returns in 4 s; the hardware UDID produced no answer in 90 s, every time, with no tree at
    // the end of it. So the target is resolved against lldb's own list before anything attaches, and
    // a device lldb does not have is reported at once instead of waited on.
    if (attachTarget.kind === 'device' && attachTarget.placeholder !== true) {
      let devices = []
      try {
        devices = await lldbDeviceList()
      } catch {
        devices = []
      }
      // devicectl reports both names of each phone, so it is the bridge from the hardware udid the
      // destination carries to the identifier lldb accepts; the phone's own name is the fallback.
      const known = await coreDeviceDevices(workspace === '' ? '/' : workspace)
      const record = known.find((entry) => entry.id.toLowerCase() === attachTarget.id.toLowerCase())
      const resolved = resolveDeviceId(devices, {
        id: attachTarget.id,
        coreDeviceId: record?.coreDeviceId ?? '',
        deviceName: record?.name ?? '',
      })
      if (resolved === '') {
        const phone = record?.name ?? attachTarget.id
        return {
          ok: false,
          note: `the device ${phone} (${attachTarget.id}) is not one lldb can attach to right now. `
            + `${describeConnectedDevices(devices)}`,
          session,
        }
      }
      if (resolved.toLowerCase() !== attachTarget.id.toLowerCase()) {
        deviceAliases.set(attachTarget.id.toLowerCase(), resolved.toLowerCase())
        deviceAliases.set(resolved.toLowerCase(), attachTarget.id.toLowerCase())
      }
      attachTarget.id = resolved
    }

    const launching = target.mode === 'launch'
    if (launching && target.kind === 'device') {
      const launched = await launchForDebugger(target, workspace === '' ? '/' : workspace)
      if (!launched.ok) return { ok: false, note: `launch failed: ${launched.note}`, session }
      attachTarget.pid = launched.pid
      // The UI has to exist BEFORE the attach stops the app: this is the wait that makes
      // `mode=launch` a way to read a view tree rather than a way to read an empty window.
      await new Promise((resolveSettle) => { setTimeout(resolveSettle, target.settleMs) })
    }
    // The pid is looked up on the device before every attach, not trusted from wherever it came
    // from: a run's pid or one picked from the Apps list goes stale the moment the app restarts, and
    // lldb attaching to a pid that is gone answers only `Process must be launched.` (measured: 704
    // asked for while 754 was running). A lookup costs about a second; a wrong attach costs a dead
    // session. Without a name there is nothing to look up, and the given pid is all there is.
    // A device is searched by process name, a simulator by bundle id (see resolveRunningApp).
    const lookedUp = !launching && (target.kind === 'device' ? target.name !== '' : target.bundleId !== '')
    if (lookedUp) {
      const found = await resolveRunningApp(target, workspace)
      if (!found.ok) return { ok: false, note: found.note, session }
      attachTarget.pid = found.pid
      attachTarget.name = ''
    } else if (!launching && attachTarget.pid === null) {
      return { ok: false, note: 'nothing to attach to: no process name, bundle id or pid', session }
    }
    const attachOnce = (candidate) => session.attach(candidate, {
      // 30 s, down from 90. The slowest successful device attach measured here was 40.7 s cold, but
      // a *silent* 90 s is indistinguishable from a wedged channel and costs the user a minute and a
      // half per try; a cold device that needs longer is better served by a retry than by a wait
      // nobody can read. A refusal (an app that turns debuggers away) never answers at all, so
      // waiting longer cannot turn it into a success.
      timeoutMs: 30000,
      // A device attach stops the process by itself; a simulator launch leaves it running
      // on purpose, and is stopped below once it has come up.
      waitForStop: target.kind === 'device',
    })
    let attached = await attachOnce(attachTarget)
    if (!attached.ok && lookedUp) {
      // The app can restart between the lookup and the attach. Look again, and retry only when the
      // device names a DIFFERENT pid: attaching to the one that just failed would fail the same way.
      const found = await resolveRunningApp(target, workspace)
      if (found.ok && found.pid !== attachTarget.pid) {
        attachTarget.pid = found.pid
        attachTarget.name = ''
        // A fresh lldb: attaching to a pid that is gone leaves this one `exited`, and an exited
        // session refuses every command — the retry would fail without ever reaching the device.
        await session.dispose()
        session = lldbFor()
        attached = await attachOnce(attachTarget)
      }
    }
    if (!attached.ok) {
      // Nothing back at all is its own diagnosis, and it has its own remedy — or none. A slow
      // attach says something eventually (a known-good app: 8.5 s), while an app that refuses a
      // debugger stays silent for as long as you wait (46 s once, then 90 s on 蜜语-Dev), and
      // taking THAT app over cannot help either. The reasoning lives in `attach-failure.js`, where
      // it is tested rather than assembled from two strings that contradict each other.
      // A debugger that attached and then stopped saying anything is still holding the device, and
      // THAT is what makes the next attempt hang in exactly the same way — measured here: two stuck
      // lldb processes, one of them an orphan over an hour old, after which every attach was silent
      // for 90 s while a perfectly debuggable build (get-task-allow = true) waited behind them. The
      // child is ended before the caller is told anything, so the retry has a free device.
      // Any failed attach ends its own debugger, not only a silent one: whatever state it left —
      // half-attached, waiting on the device, or refused — the next attempt needs a free device and
      // the app must not be left stopped.
      const released = lldb !== null
      if (released) await lldb.dispose()
      const failure = attachFailure({
        note: attached.note,
        quiet: attached.quiet === true,
        kind: target.kind,
        // Verified, not remembered: the run record can outlive the console session it describes, and
        // blaming a session that is not there sends the user to stop a run that already ended.
        heldByRun: target.heldByRun === true && (await consoleSessionAlive()),
        // Asked BEFORE the note is written, because "another debugger has it" is only half an answer:
        // which one is a fact this Mac holds, and making the user open Activity Monitor to find it is
        // the guessing this removes.
        heldBy: await debuggerHolders(),
        pid: attachTarget.pid,
        name: target.name === '' ? target.bundleId : target.name,
        released,
        stuck: describeStuckDebuggers(cleared),
      })
      return { ok: false, note: failure.note, remedies: failure.remedies, refused: failure.refused, session }
    }
    if (launching && target.kind !== 'device') {
      // lldb launched this one itself, so it is running: give it time to build its UI, then
      // stop it the way a debugger does.
      await new Promise((resolveSettle) => { setTimeout(resolveSettle, target.settleMs) })
      const stopped = await session.interrupt()
      if (!stopped.ok) {
        return { ok: false, note: `the app was launched and attached but could not be stopped: ${stopped.note}`, session }
      }
    }
    return { ok: true, note: '', cleared, session }
  }

  /**
   * The debuggers running on this Mac that are not ours, named by their owner.
   *
   * @returns {Promise<string>} e.g. `Xcode is holding an app on this Mac right now (lldb pid 42159)`,
   *   or '' when there is nothing to name.
   */
  async function debuggerHolders() {
    const table = await capture(['ps', '-ax', '-o', 'pid=,ppid=,command='], '/', 10000)
    if (table.exitCode !== 0) return ''
    return describeForeignDebuggers(foreignDebuggers(parseProcessTable(table.stdout), process.pid))
  }

  /**
   * The apps that can be attached to right now, as the device itself lists them.
   *
   * This is the answer to "which app is it?" without a build: attaching needs a pid, and the device
   * already knows every process it runs. The list is narrowed to app processes, because a phone runs
   * a few hundred system ones and the app would have to be read past to be found — measured on
   * 蜜语-Dev: 265 processes, one of them the app. The user picks, and the pid travels with the read,
   * so nothing has to be built or relaunched first.
   *
   * @param {object} body - the panel's request, carrying the destination it has selected.
   * @param {string} workspace - the calling session's cwd.
   * @returns {Promise<{ok: boolean, processes: Array<{pid: number, name: string, path: string}>, note: string}>} the list, or why there is none.
   */
  /**
   * One app's log, read live off the device.
   *
   * A selected app is meant to come with its log, because the question that follows "which app is
   * it?" is "what is it saying?" — and asking for each separately is the step this removes. The
   * filter is the process name, which is exactly what the running-app list already gives us, so no
   * bundle id has to be looked up first. It is a bounded window (a few seconds), not a subscription:
   * the panel asks again while it is showing the log, and a device that goes away ends the read
   * instead of leaving a reader that looks alive.
   *
   * @param {object} body - the panel's request, carrying the process name and the destination.
   * @param {string} workspace - the calling session's cwd.
   * @returns {Promise<{ok: boolean, name: string, lines: string[], note: string}>} the window.
   */
  /**
   * The app's own log file, taken out of its data container over CoreDevice.
   *
   * Measured on 蜜语-Dev with the phone on Wi-Fi and no cable — `idevice_id -l` empty, `devicectl`
   * reporting it available: `device info files --domain-type appDataContainer --domain-identifier
   * com.suishoubo.ppmain3 --username mobile --subdirectory Documents/PPCrashLog` listed the app's
   * per-launch logs (`log_2026-10-08-10-19-16.683.log`, 103 KB, plus `watchdog_stall.log`), and
   * `device copy from --source <that> --user mobile --destination <a FILE>` copied one out. Both
   * details cost a failed attempt each: the user flag is `--user` (not `--username`), and the
   * destination is a file, because a directory is refused with `Cannot open destination file`.
   *
   * @param {{id: string, bundleId: string, name: string}} target - the device.
   * @param {object} body - the panel's request; `bundleId` saves looking one up.
   * @returns {Promise<{ok: boolean, name: string, lines: Array<{t: string, k: string}>, note: string}>}
   */
  async function pullContainerLog(target, body) {
    const bundleId = String(body?.bundleId ?? '').trim() === ''
      ? await installedBundleId(target)
      : String(body.bundleId).trim()
    if (bundleId === '') {
      return { ok: false, name: target.name, lines: [], note: `${target.name} is not among the installed apps, so its container cannot be opened` }
    }
    const dir = 'Documents/PPCrashLog'
    const listed = await capture([
      'xcrun', 'devicectl', 'device', 'info', 'files',
      '--device', target.id,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', bundleId,
      '--username', 'mobile',
      '--subdirectory', dir,
    ], '/', 60000)
    const names = [...String(listed.stdout).matchAll(/(log_[0-9][0-9._-]*\.log)/g)].map((match) => match[1])
    if (names.length === 0) {
      return {
        ok: false,
        name: target.name,
        lines: [],
        note: `no log file in ${bundleId}/${dir} over CoreDevice: ${listed.exitCode === 0 ? 'the directory is there but holds none' : `${(listed.stderr || listed.stdout).trim().split('\n').slice(-1)[0] ?? `devicectl exited ${listed.exitCode}`}`}. The live reader needs a cable; this route needs the app to have written a log`,
      }
    }
    // The names carry their timestamps, so the newest is the last one alphabetically — no date column
    // has to be parsed, and a file being written right now still sorts last.
    const newest = names.sort().at(-1) ?? ''
    const answer = join(tmpdir(), `dsh-xcodebuild-applog-${String(Date.now())}.log`)
    const copied = await capture([
      'xcrun', 'devicectl', 'device', 'copy', 'from',
      '--device', target.id,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', bundleId,
      '--user', 'mobile',
      '--source', `${dir}/${newest}`,
      '--destination', answer,
    ], '/', 90000)
    if (copied.exitCode !== 0) {
      const said = (copied.stderr !== '' ? copied.stderr : copied.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
      return { ok: false, name: target.name, lines: [], note: `could not copy ${dir}/${newest} out of the app: ${said}` }
    }
    const text = await readFile(answer, 'utf8').catch(() => '')
    await rm(answer, { force: true }).catch(() => {})
    const lines = String(text)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-300)
      .map((line) => ({ t: line.slice(0, 500), k: syslogLineKind(line) ?? 'plain' }))
    return {
      ok: true,
      name: target.name,
      lines,
      note: lines.length === 0
        ? `the app's own log (${newest}) is empty so far`
        : `the app's own log, ${newest}, read over CoreDevice — the last ${lines.length} lines`,
    }
  }

  /**
   * The bundle id of the installed app whose name matches, asked of the device.
   *
   * @param {{name: string}} target - whose name is the app's, as the device spells it.
   * @returns {Promise<string>} the bundle id, or '' when nothing matches.
   */
  async function installedBundleId(target) {
    const answer = join(tmpdir(), `dsh-xcodebuild-apps-list-${String(Date.now())}.json`)
    const out = await capture(['xcrun', 'devicectl', 'device', 'info', 'apps', '--device', target.id, '--json-output', answer], '/', 60000)
    if (out.exitCode !== 0) return ''
    const text = await readFile(answer, 'utf8').catch(() => '')
    await rm(answer, { force: true }).catch(() => {})
    try {
      const apps = JSON.parse(text)?.result?.apps ?? []
      const wanted = String(target.name ?? '').trim()
      for (const app of apps) {
        if (String(app?.name ?? '').trim() === wanted && String(app?.bundleIdentifier ?? '') !== '') {
          return String(app.bundleIdentifier)
        }
      }
    } catch {
      /* an unreadable list is the same as no match */
    }
    return ''
  }

  async function lldbAppLog(body, workspace) {
    /**
     * A device log line, cut down to what is worth reading.
     *
     * The device sends `Sep 30 19:28:57 蜜语-Dev(libxpc.dylib)[751] <Notice>: activating connection:
     * ...`: the process name is what the reader filtered BY, the library is a subsystem of the app,
     * and the level is already carried by the line's kind — so the panel's colour says it. What is
     * left is the time and the message, which is what a person reads. Without this the log panel
     * showed a wall of prefixes around short messages.
     */
    const syslogReadableLine = (line) => {
      const match = /^([A-Z][a-z]{2} +\d+ +\d\d:\d\d:\d\d) +\S+ +<[^>]*>: ?([\s\S]*)$/.exec(line)
      if (match === null) return decodeSyslogEscapes(line)
      const clock = /\d\d:\d\d:\d\d/.exec(match[1])
      return `${clock === null ? match[1] : clock[0]} ${decodeSyslogEscapes(match[2])}`
    }

    const name = String(body?.name ?? '').trim()
    if (name === '') return { ok: false, name, lines: [], note: 'no app is selected, so there is no log to read' }
    const target = lldbTargetFor(workspace, body)
    if (target.id === '') return { ok: false, name, lines: [], note: 'no destination is selected in the panel' }
    if (target.kind !== 'device') return { ok: false, name, lines: [], note: 'the app log stream is for a device' }
    const syslog = resolveTool('idevicesyslog')
    if (syslog === null) return { ok: false, name, lines: [], note: missingToolNotice('idevicesyslog') }
    const seconds = Math.max(1, Math.min(Number(body?.seconds) || 6, 20))
    let out = ''
    await captureBounded(
      [syslog, '-u', target.id, '-p', name, '--no-colors'],
      seconds * 1000,
      (chunk) => { out += chunk },
    )
    // `tailLog` hands back its lines JOINED — one string, capped — because the tool that reads it
    // wants to print it. The panel wants lines, and handing it the string read as "no lines at all":
    // measured, a window that had really captured 31 lines of 蜜语-Dev showed an empty log. Split it
    // back, which is also where the cap still applies.
    // `idevicesyslog` speaks the classic USB/lockdown channel, and its complaints are not the app's
    // output: printing them as log lines put `Device with udid <udid> not found!` in the log panel as
    // though the app had said it. Measured while the phone was reachable over CoreDevice only (paired
    // for Wi-Fi, no cable): `idevice_id -l` was empty, USB showed no iPhone, and this reader could not
    // start. Attaching and the view tree do not need this channel; the log does.
    if (/not found!|Could not start logger|Unable to connect|No device found/i.test(out)) {
      // The classic channel is gone, but the device itself is usually still reachable the modern way:
      // CoreDevice has no live log stream, and it does not need one — the app WRITES its own log, and
      // `devicectl device copy from` can take it out of the app's data container over the same tunnel
      // that attaching uses. So a phone on Wi-Fi with no cable is not a phone without logs.
      const pulled = await pullContainerLog(target, body)
      if (pulled.ok) return { ...pulled, name }
      const said = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== '[connected]')
        .slice(0, 2)
      return {
        ok: false,
        name,
        lines: [],
        note: `the app log needs the USB channel and this device is not on it: ${said.join(' / ')}. `
          + 'Connect the iPhone with a cable, or pair it for Wi-Fi with usbmuxd so the classic channel '
          + 'can reach it. Reading the view tree does not need this channel.',
      }
    }

    const tail = tailLog(out, '')
    // Classified here, with the same reader the launch path uses, so the log panel can filter these
    // lines with the four buttons it already has: a device log's levels ARE those four. The panel is
    // where an app's output belongs — the debugger drawer is not a second log viewer.
    const lines = String(tail.lines ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => ({ t: syslogReadableLine(line), k: syslogLineKind(line) ?? 'plain' }))
    return {
      ok: true,
      name,
      lines,
      note: lines.length === 0
        ? `the device said nothing from ${name} in ${seconds} s — a quiet app is the usual reason`
        : '',
    }
  }

  async function lldbProcessList(body, workspace) {
    const target = lldbTargetFor(workspace, body)
    if (target.id === '') {
      return { ok: false, processes: [], note: 'no destination is selected in the panel, so there is no device to list' }
    }
    if (target.kind !== 'device') {
      return { ok: false, processes: [], note: 'listing running apps is for a device: on a simulator the app is named by its bundle id' }
    }
    const cwd = workspace === '' ? '/' : workspace
    const answer = join(tmpdir(), `dsh-xcodebuild-apps-${String(Date.now())}.json`)
    const out = await capture(
      ['xcrun', 'devicectl', 'device', 'info', 'processes', '--device', target.id, '--json-output', answer],
      cwd,
      60000,
    )
    let processes = []
    try {
      processes = parseProcessList(await readFile(answer, 'utf8'))
    } catch {
      processes = []
    }
    if (processes.length === 0 && out.exitCode !== 0) {
      const reason = (out.stderr !== '' ? out.stderr : out.stdout).trim().split('\n')[0] ?? ''
      return { ok: false, processes: [], note: reason === '' ? `devicectl exited ${out.exitCode}` : reason }
    }
    const apps = []
    for (const entry of processes) {
      const path = String(entry?.executable ?? '')
      if (!path.includes('/Bundle/Application/') && !path.includes('/Containers/Bundle/')) continue
      let name = String(entry?.name ?? '')
      try {
        name = decodeURIComponent(name)
      } catch {
        /* a name that is not percent-encoded is not a problem */
      }
      apps.push({ pid: entry.pid, name, path })
    }
    apps.sort((left, right) => left.name.localeCompare(right.name))
    return {
      ok: true,
      processes: apps,
      note: apps.length === 0
        ? `no app process is running (${processes.length} system processes are)`
        : '',
    }
  }

  /**
   * The running app's view hierarchy — what Xcode's Debug View Hierarchy shows.
   *
   * Requires a stopped process: the expression allocates memory in the app, and LLDB
   * refuses it while the app runs. That refusal is treated as a failure here rather than
   * as an empty hierarchy, because "the app has no views" and "the app was not stopped"
   * would otherwise be the same answer.
   *
   * @param {object} body - overrides plus maxLines/className/text filters.
   * @param {string} workspace - the calling session's cwd.
   * @returns {Promise<object>} the tree, its records, and the session state.
   */
  /** Chains probed this session: a dump holds hundreds of views but a dozen classes. */
  const lookinChains = new Map()
  /** The last file exported, so the panel's button can open what the last dump wrote. */
  let lastLookinPath = null
  // `undefined` means "not looked yet", so a host with no Lookin does not run mdfind per read.
  let lookinApp
  /**
   * The nodes of the last dump, by address, with their rendered images where they fit.
   *
   * The panel shows one node at a time, so this is read per click rather than shipped with the
   * tree: the tree is text and stays small, while 31 renders of a real app are already a megabyte.
   * Kept in memory because the app's sandbox directory may be gone — or belong to a relaunched
   * copy — by the time a row is clicked.
   */
  let lastLookinNodes = new Map()
  /** How much of that to keep: a real app's renders, without holding a whole screen set twice. */
  const LOOKIN_RETAIN_BYTES = 12 * 1024 * 1024

  /** Where scratch files (pulled PNGs, crops) live while an export is being made. */
  function lookinDir() {
    return join(tmpdir(), 'dsh-xcodebuild')
  }

  /**
   * Where finished exports are KEPT, so the history survives a restart of the host.
   *
   * The temp directory is the system's to empty, and an export kept there was known only as "the
   * last one". `~/Library/Caches` is the place macOS expects a regenerable cache, and it is what a
   * user clears when they clear caches — which is the right fate for these.
   */
  function lookinCacheDir() {
    return join(homedir(), 'Library', 'Caches', 'dsh-xcodebuild', 'lookin')
  }

  /**
   * The superclass chain of every class in this dump, probed once each.
   *
   * A failure is cached as a miss, so a class the runtime will not answer for costs one
   * expression per session rather than one per dump.
   */
  /**
   * Everything a Lookin file needs from the app beyond the tree, asked in ONE expression.
   *
   * The app is stopped while it answers, and this used to be up to 33 round trips (one per class,
   * three for the screen). Now it is one, and only classes not already known are asked about: a
   * second read of the same screen asks for the screen size alone. Measured against a live app on a
   * simulator: one answer for ten classes and the screen.
   *
   * Falls back to the per-class probes when the batch is not understood, so an expression a future
   * SDK rejects degrades into the slow path rather than into a file without class chains.
   *
   * @returns {Promise<{chains: Object<string, string[]>, screen: {width: number, height: number, scale: number}}>}
   */
  async function lookinFacts(records, session) {
    const names = [...new Set(records.map((record) => record.className))].slice(0, 60)
    const unknown = names.filter((name) => !lookinChains.has(name))
    const asked = await session.evaluate(classChainsExpression(unknown), { timeoutMs: 15000 })
    const report = asked.ok ? parseChainsReport(asked.text, unknown) : null
    if (report === null) {
      return { chains: await lookinClassChains(records, session), screen: await screenSizeFor(session) }
    }
    for (const name of unknown) lookinChains.set(name, report.chains[name] ?? null)
    const chains = {}
    for (const name of names) {
      const chain = lookinChains.get(name)
      if (chain !== null && chain !== undefined) chains[name] = chain
    }
    return { chains, screen: report.screen ?? { width: 0, height: 0, scale: 0 } }
  }

  async function lookinClassChains(records, session) {
    const names = [...new Set(records.map((record) => record.className))].slice(0, 30)
    const chains = {}
    for (const name of names) {
      if (lookinChains.has(name)) {
        const cached = lookinChains.get(name)
        if (cached !== null) chains[name] = cached
        continue
      }
      const probed = await session.evaluate(classChainExpression(name), { timeoutMs: 8000 })
      const chain = probed.ok ? parseClassChain(probed.text) : null
      lookinChains.set(name, chain)
      if (chain !== null) chains[name] = chain
    }
    return chains
  }

  /**
   * The device's logical size, asked over the debugger that is already attached.
   *
   * Lookin scales its coordinates by this, so it is read from the running app rather than
   * guessed from the model name — and the same expression answers for a device and a
   * simulator, which is why neither `simctl list` nor a device query is involved. Zeros are
   * what an unanswerable question leaves: Lookin renders without scaling rather than
   * refusing the file.
   */
  async function screenSizeFor(session) {
    // Three scalar questions, asked one after another (one interpreter, so they cannot be
    // concurrent), rather than one `stringWithFormat:`: LLDB's expression parser has no
    // declaration for a VARIADIC Foundation method and answers `too many arguments to method
    // call, expected 1, have 4` — measured on a simulator against a live app. The `(double)`
    // cast is what makes `po` print a number instead of complaining about an unknown type.
    const ask = async (expression) => {
      const asked = await session.evaluate(expression, { timeoutMs: 8000 })
      if (!asked.ok) return 0
      const value = Number.parseFloat(String(asked.text).trim())
      return Number.isFinite(value) ? value : 0
    }
    return {
      width: await ask('po (double)[UIScreen mainScreen].bounds.size.width'),
      height: await ask('po (double)[UIScreen mainScreen].bounds.size.height'),
      scale: await ask('po (double)[UIScreen mainScreen].scale'),
    }
  }

  /** What Lookin shows in its header: the app it came from, and the screen it was drawn on. */
  async function appInfoForLookin(target, screen) {
    return {
      appName: target.bundleId === '' ? target.name : target.bundleId,
      appBundleIdentifier: target.bundleId,
      deviceDescription: target.kind === 'device' ? target.name : target.id,
      osDescription: '',
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenScale: screen.scale,
    }
  }

  /**
   * Let the app run again after a read that worked.
   *
   * A dump stops the app — it has to, the layers are only readable in that state — but a frozen app
   * is a side effect of debugging rather than something anyone asked for, so the default is to let
   * it go the moment the tree is read. `continue: false` keeps it stopped for a caller that wants to
   * poke at it (the drawer's Interrupt does the same thing by hand).
   *
   * Best effort on purpose: a debugger that has already gone cannot be told to continue, and that
   * must not turn a good tree into a failed read.
   *
   * @returns {Promise<boolean>} whether the app is running again.
   */
  async function continueAfterRead(session, body) {
    if (body?.continue === false) return false
    try {
      const resumed = await session.resume()
      return resumed?.ok !== false
    } catch {
      return false
    }
  }

  /**
   * Let the app go after a read that failed.
   *
   * A dump stops the app so its layers can be read, and a stopped app cannot be used at all — so a
   * read that fails must not be the end of it. The expression can be hung, because a dump of a real
   * app is slow and a device connection can stall, which is why this interrupts first and then lets
   * go: a clean detach if the debugger still answers, and a dispose otherwise, which ends the child
   * and takes the stop with it.
   *
   * Measured: a read that went silent left an lldb holding the device with the app frozen on screen,
   * unusable, until that process was killed by hand. Nothing the user could do about it from here.
   *
   * @returns {Promise<boolean>} whether the app was let go.
   */
  async function releaseApp(session) {
    if (session === null || session === undefined) return false
    try {
      await session.interrupt()
    } catch {
      // A debugger that cannot even be interrupted is one to end, not to argue with.
    }
    try {
      const detached = await session.detach()
      if (detached?.ok !== false) return true
    } catch {
      /* fall through to ending it */
    }
    try {
      await session.dispose()
    } catch {
      /* the child is already gone, which is what was wanted */
    }
    return false
  }

  /** One class's superclass chain, out of the same cache the export fills. */
  async function lldbClassChain(className, session) {
    const cached = lookinChains.get(className)
    if (cached !== undefined) return cached ?? []
    const probed = await session.evaluate(classChainExpression(className), { timeoutMs: 8000 })
    const chain = probed.ok ? parseClassChain(probed.text) : null
    lookinChains.set(className, chain)
    return chain ?? []
  }

  /**
   * Where Lookin.app is, or null.
   *
   * Checked once per process and remembered: `/Applications` covers almost every install, and the
   * `mdfind` fallback reaches a Lookin that lives somewhere unusual — but Spotlight can take a
   * second, and the panel asks on every read.
   */
  async function lookinAppPath(workspace) {
    if (lookinApp !== undefined) return lookinApp
    const cwd = workspace === '' ? '/' : workspace
    const direct = firstExisting(lookinAppCandidates(homedir()), (candidate) => existsSync(candidate))
    if (direct !== null) {
      lookinApp = direct
      return lookinApp
    }
    const found = await capture(['mdfind', '-name', 'Lookin.app'], cwd, 15000)
    lookinApp = found.exitCode === 0 ? parseMdfindLookin(found.stdout) : null
    return lookinApp
  }

  /** The pixel size of an image, read with `sips` rather than guessed from the screen. */
  async function imagePixelSize(path, cwd) {
    const asked = await capture(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], cwd, 30000)
    const width = /pixelWidth:\s*(\d+)/.exec(asked.stdout)
    const height = /pixelHeight:\s*(\d+)/.exec(asked.stdout)
    return width === null || height === null ? { width: 0, height: 0 } : { width: Number(width[1]), height: Number(height[1]) }
  }

  /**
   * One screen capture, cropped per view.
   *
   * A flat capture cannot separate a view from its subviews, so each node gets the honest crop
   * of what is actually on screen, and the file offers the same crop as both its solo and its
   * group image rather than one of them being a fiction.
   *
   * Bounded on purpose: a 130-node tree cropped at full size is tens of megabytes of PNG. Crops
   * below 8 points are skipped (a hairline separator teaches nobody anything) and every crop is
   * resampled to at most 480 pixels on its long side.
   */
  async function screenCrops(target, records, workspace, stamp, screen) {
    const cwd = workspace === '' ? '/' : workspace
    const scratch = join(lookinDir(), `shots-${stamp}`)
    await mkdir(scratch, { recursive: true })
    const full = join(scratch, 'screen.png')
    const grabbed = target.kind === 'simulator'
      // `simctl io screenshot` is the simulator's own capture: no debugger involvement, and it
      // works while the app is stopped.
      ? await capture(['xcrun', 'simctl', 'io', target.id, 'screenshot', '--type=png', full], cwd, 60000)
      // A physical device needs libimobiledevice's screenshot tool; `ios-deploy` has none.
      : await capture(['idevicescreenshot', '-u', target.id, full], cwd, 60000)
    if (grabbed.exitCode !== 0) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
      const said = String(grabbed.stderr !== '' ? grabbed.stderr : grabbed.stdout).trim().split('\n')[0] ?? ''
      return { images: {}, note: `the screen could not be captured: ${said}` }
    }
    // Frames are points; a capture is pixels. The ratio is taken from the capture itself rather
    // than trusted from the device's scale, because it is the capture that is being cropped.
    const pixels = await imagePixelSize(full, cwd)
    const scale = pixels.width > 0 && screen.width > 0
      ? pixels.width / screen.width
      : (screen.scale > 0 ? screen.scale : 1)
    const images = {}
    for (const node of absoluteFrames(records).slice(0, 200)) {
      const frame = node.frame
      const left = Math.max(0, Math.round(frame.x * scale))
      const top = Math.max(0, Math.round(frame.y * scale))
      const width = Math.min(pixels.width - left, Math.round(frame.width * scale))
      const height = Math.min(pixels.height - top, Math.round(frame.height * scale))
      if (width < 8 || height < 8) continue
      const out = join(scratch, `crop-${node.oid}.png`)
      const cropped = await capture(
        ['sips', '-c', String(height), String(width), '--cropOffset', String(top), String(left), full, '--out', out],
        cwd,
        30000,
      )
      if (cropped.exitCode !== 0) continue
      // Resampled after cropping: a 1290x2796 window crop is a 3 MB PNG for a thumbnail.
      await capture(['sips', '-Z', '480', out], cwd, 30000).catch(() => {})
      const bytes = await readFile(out).catch(() => null)
      if (bytes !== null) images[String(node.oid)] = bytes
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    return { images, note: '' }
  }

  /**
   * The images of the views themselves, rendered inside the app.
   *
   * This is what Lookin's own `soloScreenshot`/`groupScreenshot` are, and a crop of a screenshot
   * cannot stand in for either: a crop of the screen contains every child drawn over the view, so
   * it is neither the control alone nor — for anything scrolled off screen — a faithful view of the
   * control with its subtree.
   *
   * The app writes the PNGs into its own sandbox, so they have to be fetched:
   *
   *   - a simulator's data container is a directory on this machine and the app reports its own
   *     path, so the files are read straight out of it;
   *   - a physical device needs `devicectl device copy from`, which knows how to address an app's
   *     container. An iOS 16 or earlier device has no `devicectl` at all, so it keeps the crop
   *     fallback instead.
   *
   * Anything that goes wrong here returns no images rather than failing the export: the tree is the
   * thing worth having, and the caller falls back to cropping one screen capture.
   */
  async function renderedViewImages(target, workspace, session, stamp, job = null) {
    const cwd = workspace === '' ? '/' : workspace
    // The walk's size is learned from a first batch: a tree already read is the KEY window's, and
    // this walks the first window, so the two counts are not assumed to agree.
    // Without a job nobody is watching or able to cancel, so the walk is rendered in one go, as it
    // always was; with one it goes 40 views at a time.
    const size = job === null ? 0 : 40
    let report = null
    let total = 0
    for (let start = 0; ; start += size) {
      if (job?.cancelled === true) return { images: {}, note: 'cancelled', cancelled: true }
      // Each batch is one short stop. The app arrives here stopped (the tree, the class chains and
      // the screen size were all read in that stop); between batches it is let go, so the phone stays
      // usable, and it is stopped again for the next batch.
      if (job !== null && start > 0) {
        // `resume()` only writes `continue`; the session reports `running` a moment later. An
        // interrupt sent before that would be answered "already stopped" while the app runs, and the
        // render would then be refused — so the run is waited for first, briefly.
        for (let waited = 0; waited < 30 && session.summary().state === 'stopped'; waited += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (job.cancelled === true) return { images: {}, note: 'cancelled', cancelled: true }
        const stopped = await session.interrupt()
        if (!stopped.ok) return { images: {}, note: `the app could not be stopped for the next batch: ${stopped.note}` }
      }
      const rendered = await session.evaluate(viewShotsExpression(size === 0 ? {} : { start, limit: size }), { timeoutMs: 180000 })
      if (job !== null) session.resume()
      const batch = parseShotsReport(rendered.text)
      if (batch === null) {
        const why = rendered.error !== '' ? rendered.error : 'the app did not answer'
        return { images: {}, note: `the views could not be rendered: ${why}` }
      }
      total = batch.views.length
      report = report === null ? batch : { ...batch, rendered: report.rendered + batch.rendered }
      if (job !== null) {
        job.stage = 'rendering'
        job.total = total
        job.done = Math.min(start + size, total)
      }
      if (size === 0 || renderBatches(total, size).every((entry) => entry.start <= start)) break
    }
    if (job?.cancelled === true) return { images: {}, note: 'cancelled', cancelled: true }
    if (job !== null) job.stage = 'copying'
    let local = report.dir
    if (target.kind === 'device') {
      const pulled = join(lookinDir(), `shots-${stamp}`)
      await mkdir(pulled, { recursive: true })
      const copied = await capture(
        [
          'xcrun', 'devicectl', 'device', 'copy', 'from',
          '--device', target.id,
          '--domain-type', 'appDataContainer',
          '--domain-identifier', target.bundleId,
          '--source', `tmp/${SHOT_DIR_NAME}`,
          '--destination', pulled,
        ],
        cwd,
        120000,
      )
      if (copied.exitCode !== 0) {
        await rm(pulled, { recursive: true, force: true }).catch(() => {})
        const said = String(copied.stderr !== '' ? copied.stderr : copied.stdout).trim().split('\n')[0] ?? ''
        return { images: {}, note: `the rendered views could not be copied off the device: ${said}` }
      }
      // `devicectl` copies the directory itself, but which level it lands at has moved between
      // Xcode versions, so both are tried before an image is given up on.
      const nested = join(pulled, SHOT_DIR_NAME)
      local = (await stat(nested).catch(() => null)) === null ? pulled : nested
    }
    const images = {}
    for (const view of report.views) {
      const solo = await readFile(join(local, shotFileName('solo', view.index))).catch(() => null)
      const group = await readFile(join(local, shotFileName('group', view.index))).catch(() => null)
      if (solo === null && group === null) continue
      const oid = String(oidFromAddress(view.address))
      images[oid] = { ...(solo === null ? {} : { solo }), ...(group === null ? {} : { group }) }
    }
    if (target.kind === 'device') {
      await rm(join(lookinDir(), `shots-${stamp}`), { recursive: true, force: true }).catch(() => {})
    }
    return { images, note: '' }
  }

  /**
   * Write the tree LLDB just read as the file Lookin.app opens.
   *
   * Never throws and never fails the dump: a missing export is a note beside a tree that is
   * still in the drawer, because this panel's red line is that a debugger problem must not
   * paint itself across a healthy build.
   */
  async function exportLookin(records, target, workspace, session, options = {}) {
    const kind = options.kind === 'full' ? 'full' : 'quick'
    const job = options.job ?? null
    try {
      // Facts asked while the app was still stopped are passed in, so a quick export writes its file
      // with the app already running again and never touches the debugger.
      const facts = options.facts ?? await lookinFacts(records, session)
      const chains = facts.chains
      const screen = facts.screen
      const app = await appInfoForLookin(target, screen)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const dir = lookinCacheDir()
      await mkdir(dir, { recursive: true })
      // A quick export is the tree alone: rendering every view is most of a full export's time, and
      // a read that only wants the structure should not stop the app for it. A full one renders the
      // views' own images first, and crops one screen capture per view only when they cannot be had
      // (an iOS 16 or earlier device, a render the app refused).
      let shots = { images: {}, note: '' }
      let fromCrops = false
      if (kind === 'full') {
        shots = await renderedViewImages(target, workspace, session, stamp, job)
        if (shots.cancelled === true) return { path: null, note: 'cancelled', cancelled: true }
        if (Object.keys(shots.images).length === 0) {
          fromCrops = true
          shots = await screenCrops(target, records, workspace, stamp, screen)
        }
      }
      if (job?.cancelled === true) return { path: null, note: 'cancelled', cancelled: true }
      if (job !== null) job.stage = 'writing'
      // Retained for the panel's detail pane, in the order the tree has them so a row click finds
      // its images without re-reading anything.
      lastLookinNodes = new Map()
      // A new tree means new addresses, so every attribute list read against the old one is stale.
      forgetViewAttributes()
      let retained = 0
      for (const record of records) {
        const entry = { className: record.className, record, images: {} }
        const rendered = shots.images[String(oidFromAddress(record.address))]
        if (rendered !== undefined) {
          const bytes = (rendered.solo?.length ?? 0) + (rendered.group?.length ?? 0)
          if (retained + bytes <= LOOKIN_RETAIN_BYTES) {
            entry.images = rendered
            retained += bytes
          }
        }
        lastLookinNodes.set(record.address, entry)
      }
      const name = archiveNameFor(stamp, kind)
      const xmlPath = join(dir, `${name}.xml`)
      await writeFile(xmlPath, toArchiveXml(buildLookinFile(records, { appInfo: app, classChains: chains, images: shots.images })), 'utf8')
      const converted = await capture(
        ['plutil', '-convert', 'binary1', '-o', join(dir, name), xmlPath],
        workspace === '' ? '/' : workspace,
        30000,
      )
      await rm(xmlPath, { force: true })
      if (converted.exitCode !== 0) {
        // The XML is deliberately still on disk when the conversion fails: it is the only
        // copy of the tree that was read, and a stuck `plutil` is a thing to look at.
        const said = String(converted.stderr !== '' ? converted.stderr : converted.stdout).trim().split('\n')[0] ?? ''
        return { path: null, note: `could not convert the Lookin archive: ${said}` }
      }
      const shotCount = Object.keys(shots.images).length
      await writeFile(join(dir, metaNameFor(name)), JSON.stringify({
        kind,
        app: String(target.name ?? target.process ?? target.bundleId ?? ''),
        bundleId: String(target.bundleId ?? ''),
        views: records.length,
        images: shotCount,
        created: new Date().toISOString(),
      }), 'utf8').catch(() => {})
      await pruneLookinCache()
      lastLookinPath = join(dir, name)
      const note = shots.note !== ''
        ? shots.note
        : (shotCount === 0
          ? ''
          : `${shotCount} views rendered${fromCrops ? ' from a screen capture' : ''}`)
      return { path: lastLookinPath, note }
    } catch (error) {
      return { path: null, note: `could not write the Lookin file: ${messageOf(error)}` }
    }
  }

  /** Keep the newest LOOKIN_KEEP exports, and the metadata of only those. */
  async function pruneLookinCache() {
    const dir = lookinCacheDir()
    const names = await readdir(dir).catch(() => [])
    for (const stale of staleArchives(names, LOOKIN_KEEP)) {
      await rm(join(dir, stale), { force: true }).catch(() => {})
      await rm(join(dir, metaNameFor(stale)), { force: true }).catch(() => {})
    }
    // Metadata whose archive is gone describes nothing.
    for (const name of names) {
      if (!name.endsWith('.lookin.json')) continue
      if (!names.includes(name.slice(0, -'.json'.length))) await rm(join(dir, name), { force: true }).catch(() => {})
    }
  }

  /** The exports kept, newest first, each described by the metadata written beside it. */
  async function lldbLookinHistory() {
    await pruneLookinCache()
    const dir = lookinCacheDir()
    const names = (await readdir(dir).catch(() => [])).filter(isArchiveName)
    const entries = []
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (info === null) continue
      const meta = await readFile(join(dir, metaNameFor(name)), 'utf8').then((text) => JSON.parse(text)).catch(() => null)
      entries.push(historyEntry(name, info.size, meta))
    }
    return { ok: true, entries: sortHistory(entries), keep: LOOKIN_KEEP, dir }
  }

  /** Delete one kept export. The name is checked against what this cache writes, so it cannot leave the directory. */
  async function lldbLookinDelete(body) {
    const name = body?.name
    if (!isArchiveName(name)) return { ok: false, note: 'that is not one of the kept view trees' }
    const dir = lookinCacheDir()
    await rm(join(dir, name), { force: true }).catch(() => {})
    await rm(join(dir, metaNameFor(name)), { force: true }).catch(() => {})
    if (lastLookinPath === join(dir, name)) lastLookinPath = null
    return { ...(await lldbLookinHistory()), note: `deleted ${name}` }
  }

  /** Open a file in Lookin.app, or show it in Finder when Lookin is not installed. */
  async function openInLookin(path, workspace) {
    const cwd = workspace === '' ? '/' : workspace
    const app = await lookinAppPath(workspace)
    if (app !== null) {
      const opened = await capture(['open', '-a', app, path], cwd, 30000)
      if (opened.exitCode === 0) return { ok: true, path, note: `opened in ${app}`, lookinAvailable: true }
    }
    const revealed = await capture(['open', '-R', path], cwd, 30000)
    return {
      ok: revealed.exitCode === 0,
      path,
      lookinAvailable: app !== null,
      note: revealed.exitCode === 0
        ? 'Lookin.app is not installed, so the file is shown in Finder instead'
        : 'could not open the file; its path is in this answer',
    }
  }

  /** Open one kept export by name. */
  async function lldbLookinOpenFile(body, workspace) {
    const name = body?.name
    if (!isArchiveName(name)) return { ok: false, note: 'that is not one of the kept view trees' }
    const path = join(lookinCacheDir(), name)
    if ((await stat(path).catch(() => null)) === null) return { ok: false, note: `${name} is no longer kept` }
    return openInLookin(path, workspace)
  }

  /**
   * The full export running in the background, if any.
   *
   * One at a time: two would fight over the same stopped app and the same scratch directory. The
   * panel polls `lookinJob` for this record; the work itself never waits on the panel, so closing
   * the dialog does not stop it — only `lookinCancel` does.
   */
  let lookinJob = null

  function jobView(job) {
    if (job === null) return { ok: true, job: null }
    return {
      ok: true,
      job: {
        id: job.id,
        stage: job.stage,
        done: job.done,
        total: job.total,
        percent: jobPercent(job),
        note: job.note,
        path: job.path,
        name: job.path === null ? '' : basename(job.path),
        finished: job.finished,
        cancelled: job.cancelled,
        failed: job.failed,
      },
    }
  }

  /**
   * Start a full export: read the tree, render every view in batches, pull the images, write the
   * archive, and open it — all without the caller waiting.
   *
   * Every stage checks `cancelled` before it starts, and a cancel lets the app go: a cancelled
   * export must not leave a phone stopped under a debugger.
   */
  async function lldbLookinFull(body, workspace) {
    if (lookinJob !== null && lookinJob.finished !== true) return { ...jobView(lookinJob), note: 'a full export is already running' }
    const job = { id: Date.now(), stage: 'attaching', done: 0, total: 0, note: '', path: null, finished: false, cancelled: false, failed: false }
    lookinJob = job
    const run = async () => {
      let session = null
      try {
        const target = lldbTargetFor(workspace, body)
        if (target.runId === null && target.destination === '') throw new Error('nothing to read yet: pick an app (Apps) or build and run one first')
        const ready = await lldbEnsureAttached(target, workspace)
        if (!ready.ok) throw new Error(ready.note)
        session = ready.session
        if (job.cancelled) return
        job.stage = 'reading'
        // A full export renders every view inside the app, so the app is held for the whole render —
        // one stop, taken by `pauseFor` and given back when the images are in hand.
        const held = await session.pauseFor(async () => {
          const evaluated = await session.evaluate(VIEW_HIERARCHY_EXPRESSION, { timeoutMs: 60000 })
          if (!evaluated.ok) throw new Error(evaluated.note === '' ? 'the tree could not be read' : evaluated.note)
          const records = parseViewHierarchy(evaluated.text)
          if (records.length === 0) throw new Error('the key window has no views yet')
          if (job.cancelled) return null
          return exportLookin(records, target, workspace, session, { kind: 'full', job })
        })
        if (!held.ok) throw new Error(held.note)
        const exported = held.value
        if (exported === null || exported.cancelled === true || job.cancelled) return
        if (exported.path === null) throw new Error(exported.note)
        job.path = exported.path
        job.note = exported.note
        job.stage = 'opening'
        const opened = await openInLookin(exported.path, workspace)
        job.note = [exported.note, opened.note].filter((text) => text !== '').join(' · ')
        job.stage = 'done'
      } catch (error) {
        job.failed = true
        job.stage = 'failed'
        job.note = messageOf(error)
      } finally {
        if (job.cancelled) {
          job.stage = 'cancelled'
          job.note = 'cancelled: the app was released and nothing was written'
        }
        // Whatever happened, the app is not left stopped: a failure or a cancel lets go of it
        // completely, and a finished export leaves it running with the debugger still attached,
        // like a quick read does.
        if (session !== null && (job.cancelled || job.failed)) await releaseApp(session).catch(() => false)
        else if (session !== null && session.summary().state === 'stopped') session.resume()
        job.finished = true
      }
    }
    void run()
    return jobView(job)
  }

  function lldbLookinCancel() {
    if (lookinJob === null || lookinJob.finished) return jobView(lookinJob)
    lookinJob.cancelled = true
    lookinJob.note = 'cancelling: finishing the batch in hand, then releasing the app'
    return jobView(lookinJob)
  }

  /**
   * Open the last export in Lookin.app.
   *
   * Lookin.app is looked for rather than assumed: `open -a Lookin` fails with the shell's own
   * error when it is not installed, and "not installed" is a different answer from "could not
   * open". Without it the file is revealed in Finder instead, which is still the useful half —
   * the file exists either way, and the note says which of the two happened.
   */
  async function lldbOpenLookin(body, workspace) {
    const summary = lldb === null ? null : lldb.summary()
    const available = (await lookinAppPath(workspace)) !== null
    if (lastLookinPath === null) {
      return {
        ok: false,
        path: null,
        note: 'nothing exported yet: read the view hierarchy first (View Hierarchy) and the file is written as the tree is read',
        session: summary,
        lookinAvailable: available,
      }
    }
    if (body?.open === false) {
      return { ok: true, path: lastLookinPath, note: '', session: summary, lookinAvailable: available }
    }
    return { ...(await openInLookin(lastLookinPath, workspace)), session: summary }
  }

  async function lldbViewHierarchy(body, workspace) {
    const target = lldbTargetFor(workspace, body)
    if (target.runId === null && target.destination === '') {
      return { ok: false, note: 'nothing to debug yet: build and run this project (xcode_run action=run) first, or pass a destination and bundleId', session: lldb === null ? null : lldb.summary() }
    }
    const ready = await lldbEnsureAttached(target, workspace)
    if (!ready.ok) return { ok: false, note: ready.note, session: ready.session.summary() }
    // One stop for the whole read — the tree and the facts beside it — and the app is let go the
    // moment they are in hand. An app the read found running is running again afterwards; one that
    // was already stopped (a breakpoint, a manual Interrupt) stays stopped, as it was found.
    let records = []
    const paused = await ready.session.pauseFor(async () => {
      const tree = await ready.session.evaluate(VIEW_HIERARCHY_EXPRESSION, { timeoutMs: 60000 })
      if (!tree.ok) return { tree, facts: null }
      records = parseViewHierarchy(tree.text)
      if (records.length === 0) return { tree, facts: null }
      const facts = await lookinFacts(records, ready.session)
      // The panel asks for this and the model does not: a tree read for the transcript wants the
      // tree and nothing else, while the drawer's panes want every view's own account in hand
      // before the first click. See `readViewDetails` for why it is read inside this same stop.
      const details = body?.details === true ? await readViewDetails(records, ready.session) : null
      return { tree, facts, details }
    })
    const evaluated = paused.ok && paused.value !== undefined
      ? paused.value.tree
      : { ok: false, text: '', note: paused.note }
    if (!evaluated.ok) {
      // The app was stopped for this read and the read did not come back, so it is released before
      // anything is reported: a frozen phone is not an acceptable way to learn that a dump failed.
      const freed = await releaseApp(ready.session)
      const why = evaluated.note === '' ? 'the dump produced no output' : evaluated.note
      return {
        ok: false,
        note: `${why}. ${freed ? 'The app was released, so it is running again' : 'The debugger was ended, which releases the app as well'}`,
        session: ready.session.summary(),
      }
    }
    if (records.length === 0) {
      return {
        ok: false,
        note: 'the key window has no views yet — normal before the UI is built, and it means the app was reached, not that the dump failed',
        session: ready.session.summary(),
        raw: evaluated.text.slice(0, 1000),
      }
    }
    const facts = paused.value.facts
    const details = paused.value.details ?? null
    const stoppedMs = paused.pausedMs
    // `continue: false` asks for the app to be left stopped after a read it found running.
    if (body?.continue === false && paused.resumed) await ready.session.send('process interrupt', { timeoutMs: 5000 })
    const continued = paused.resumed && body?.continue !== false
    // Exported here rather than by the caller, so the panel, the model and any future route
    // all get the same file for the same dump — and none of them has to remember to ask.
    const lookin = await exportLookin(records, target, workspace, ready.session, { facts })
    // `exportLookin` forgets every attribute list, because a tree read normally means new addresses
    // and the old lists are stale. The lists read in THIS stop are the new tree's own, so they are
    // put back: without this every click on a view re-read it from the app, one stop at a time.
    if (details !== null) for (const [address, shaped] of details.cache) viewAttributes.set(address, shaped)
    const stats = viewHierarchyStats(records)
    const formatted = formatViewHierarchy(records, {
      maxLines: Number.isFinite(body?.maxLines) ? body.maxLines : 400,
      className: body?.className,
      text: body?.text,
    })
    return {
      ok: true,
      note: '',
      reused: ready.reused === true,
      target: {
        kind: target.kind,
        destination: target.destination,
        process: target.name,
        bundleId: target.bundleId,
        runId: target.runId,
      },
      views: stats.views,
      // Read, then running again: the app is not left frozen just because someone looked at it.
      continued,
      // How long the app was held for this read, from the stop to the continue.
      stoppedMs,
      depth: stats.depth,
      classes: stats.classes.slice(0, 12),
      shown: formatted.shown,
      truncated: formatted.truncated,
      tree: formatted.text,
      // Every view's attributes and layout, keyed by address, read in the stop this tree was read
      // in. Absent unless the caller asked (`details: true`), empty when the bounds stopped it.
      details: details === null ? null : details.details,
      detailsViews: details === null ? 0 : details.read,
      detailsAttributes: details === null ? 0 : details.attributes,
      detailsLayouts: details === null ? 0 : details.layouts,
      detailsCapped: details !== null && details.capped === true,
      detailsMs: details === null ? 0 : details.ms,
      // The panel draws the tree from these rather than re-parsing text; the model reads
      // `tree`. Capped, with `truncated` saying so, because a real app is thousands deep.
      records: records.slice(0, 2000).map((record) => ({
        depth: record.depth,
        className: record.className,
        address: record.address,
        frame: record.frame,
        text: record.text,
        hidden: record.hidden,
        attributes: record.attributes,
      })),
      session: ready.session.summary(),
      lookinPath: lookin.path,
      lookinNote: lookin.note,
      // Whether the Lookin action can do anything here. The panel offers it only when it can, and
      // offers "Reveal" — the file in Finder — when it cannot.
      lookinAvailable: (await lookinAppPath(workspace)) !== null,
    }
  }

  /**
   * Every LLDB operation the panel and the tool share, so the two cannot drift.
   *
   * @param {string} op - state | view | attach | interrupt | detach | command | dispose.
   * @param {object} body - operation arguments.
   * @param {string} workspace - the calling session's cwd.
   * @returns {Promise<object>} the operation's result.
   */
  /**
   * One node's own images and class chain: what the panel's detail pane needs and nothing else.
   *
   * Cheap on purpose. The tree arrives as text, the details the panel can read for itself
   * (frame, bounds, alpha, background colour) are already on the record it holds, and a click
   * costs one lookup here plus — the first time a class is seen — one expression for its chain.
   */
  async function lldbNode(body) {
    const address = typeof body?.address === 'string' ? body.address : ''
    const node = lastLookinNodes.get(address)
    if (node === undefined) {
      return {
        ok: false,
        address,
        className: '',
        image: {},
        chain: [],
        rows: [],
        color: { css: '', name: '', raw: '' },
        note: 'that view is not in the tree this session last read',
      }
    }
    const images = node.images ?? {}
    const chain = lldb === null ? [] : await lldbClassChain(node.className, lldb)
    const record = node.record ?? {}
    return {
      ok: true,
      address,
      className: node.className,
      // Parsed here rather than in the panel: the host has the record, and a colour that comes out
      // the wrong shade is a failing test here instead of a screenshot someone has to squint at.
      rows: detailRows(record, { className: node.className, chain }),
      color: parseColorValue(record.attributes?.backgroundColor ?? ''),
      // A data URL, so the panel can hand it straight to an <img> without a second route.
      image: {
        ...(images.solo === undefined ? {} : { solo: `data:image/png;base64,${images.solo.toString('base64')}` }),
        ...(images.group === undefined ? {} : { group: `data:image/png;base64,${images.group.toString('base64')}` }),
      },
      chain,
      note: Object.keys(images).length === 0 ? 'no image was rendered for this view' : '',
    }
  }

  /**
   * The attributes read for each address, kept until the tree is read again.
   *
   * An attribute list is 250–350 rows and costs a stop of its own, so it is asked for when the user
   * opens the pane and remembered afterwards: re-selecting the same view, or flipping between two,
   * is then free. `viewAttributesEpoch` is bumped whenever the tree is re-read, because a new tree
   * means new addresses and an attribute list that may no longer describe anything.
   */
  const viewAttributes = new Map()

  /**
   * The attributes the panel is allowed to change from here.
   *
   * A short list on purpose. Every one of these is KVC-compliant on every `UIView`, changes
   * something a person can see, and cannot break the app: `alpha`, `hidden`, `bounds`, `center`,
   * `frame`, `backgroundColor`, `tintColor`, `clipsToBounds`, `opaque`, `tag`, and — for the
   * classes that have them — `text`, `font`, `textColor`, `numberOfLines`, `adjustsFontSizeToFitWidth`,
   * `placeholder`, `title`, `contentMode`, `cornerRadius`. Anything else an ivar dump contains
   * (`_viewFlags`, `_layer`, retain counts, the runtime's own bookkeeping) is shown and not offered
   * for editing: a debugger that lets someone set `_viewFlags` is a debugger that lets them crash
   * the app by mistyping.
   */
  /**
   * The attributes this plugin is willing to write.
   *
   * A whitelist rather than "anything with a type we understand", because of how KVC falls back: for
   * a key with no setter and no property, `setValue:forKey:` writes the *ivar* directly, and an ivar
   * that holds a flag the framework maintains is a crash or a strange screen later. Every name here
   * is a real UIKit property with a real setter, so the app's own code performs the change.
   *
   * The list is deliberately longer than what a dump tends to show: an entry that never appears as a
   * depth-0 ivar costs nothing, while a missing one makes a row that looks editable by type silently
   * not be.
   */
  const EDITABLE_KEYS = [
    'alpha', 'hidden', 'opaque', 'clipsToBounds', 'tag', 'frame', 'bounds', 'center',
    'backgroundColor', 'tintColor', 'contentMode', 'userInteractionEnabled', 'multipleTouchEnabled',
    'text', 'attributedText', 'font', 'textColor', 'textAlignment', 'numberOfLines', 'lineBreakMode',
    'adjustsFontSizeToFitWidth', 'minimumFontSize', 'minimumScaleFactor', 'preferredMaxLayoutWidth',
    'placeholder', 'title', 'image', 'secureTextEntry', 'showsHorizontalScrollIndicator',
    'showsVerticalScrollIndicator', 'alwaysBounceVertical', 'isScrollEnabled',
    'cornerRadius', 'borderWidth', 'borderColor', 'shadowOpacity', 'shadowRadius', 'transform',
  ]

  /** How many views one tree read pulls attributes and layout for, and how long it may take. */
  const VIEW_DETAILS_MAX = 400
  const VIEW_DETAILS_BUDGET_MS = 6000

  /** Forget every attribute list: the tree they were read against is gone. */
  function forgetViewAttributes() {
    viewAttributes.clear()
  }

  /**
   * One view's attribute dump, in the shape the panel draws — or `null` when the text is not one.
   *
   * Shared by the single-view read and by the tree's own prefetch so the two can never disagree
   * about what an editor is: the rows carry the parsed descriptor beside the value the app printed.
   *
   * @param {string} address - the view the text was read from.
   * @param {string} text - `_ivarDescription`'s output.
   * @returns the panel's payload, or null when the dump did not parse.
   */
  function attributeResultOf(address, text) {
    const parsed = parseIvarDescription(text)
    if (parsed === null) return null
    return {
      address,
      className: parsed.className,
      groups: parsed.groups.map((group) => ({
        name: group.name,
        // The editor each row deserves, decided here so the panel has no opinion about types — and
        // kept in a field of its own, because the descriptor's `value` is the parsed one while the
        // row's `value` is what the app printed, and both are wanted on screen.
        rows: group.rows.map((row) => ({ ...row, edit: editableDescriptor(row, { keys: EDITABLE_KEYS }) })),
      })),
      attributes: parsed.groups.reduce((total, group) => total + group.rows.length, 0),
    }
  }

  /**
   * The apps' own account of a view's ivars, grouped by the class that declares them.
   *
   * One expression, one stop — see `lib/view-attributes.js` for why `_ivarDescription` is the route
   * and not a property enumeration. The rows are annotated with the editor each one deserves, so
   * the panel decides nothing about which attributes can be changed.
   */
  async function lldbViewAttributes(body, workspace) {
    const address = typeof body?.address === 'string' ? body.address : ''
    const session = lldbFor()
    if (!/^0x[0-9a-fA-F]+$/.test(address)) {
      return { ok: false, note: 'no view address was given', session: session.summary(), groups: [], className: '' }
    }
    const target = lldbTargetFor(workspace, body)
    const ready = await lldbEnsureAttached(target, workspace)
    if (!ready.ok) return { ok: false, note: ready.note, session: ready.session.summary(), groups: [], className: '' }
    const cached = body?.refresh === true ? undefined : viewAttributes.get(address)
    if (cached !== undefined) {
      return { ...cached, ok: true, note: '', cached: true, session: ready.session.summary() }
    }
    // The class chain and the attribute dump are two expressions in ONE stop: what the view is and
    // what it holds belong to the same moment, so asking twice would be two windows onto a view
    // that may have changed between them.
    const paused = await ready.session.pauseFor(() => ready.session.evaluate(attributesExpression(address), { timeoutMs: 20000 }))
    const read = paused.ok && paused.value !== undefined ? paused.value : { ok: false, text: '', note: paused.note }
    if (!read.ok || String(read.text ?? '').trim() === '') {
      const freed = await releaseApp(ready.session)
      const why = read.note === '' ? 'the attribute dump produced no output' : read.note
      return {
        ok: false,
        note: `${why}. ${freed ? 'The app was released, so it is running again' : 'The debugger was ended, which releases the app as well'}`,
        session: ready.session.summary(),
        groups: [],
        className: '',
      }
    }
    const shaped = attributeResultOf(address, read.text)
    if (shaped === null) {
      return {
        ok: false,
        note: 'the attribute dump did not look like an ivar description — the address may no longer be a live object',
        session: ready.session.summary(),
        groups: [],
        className: '',
        raw: String(read.text).slice(0, 400),
      }
    }
    const result = {
      ...shaped,
      pausedMs: paused.pausedMs,
      continued: paused.resumed,
      session: ready.session.summary(),
    }
    viewAttributes.set(address, result)
    return { ...result, ok: true, note: '' }
  }

  /**
   * Every view's attributes and layout, read while the app is already stopped.
   *
   * This is Lookin's model, and the measurement is what makes it affordable: an attach costs 4–20 s,
   * while one `_ivarDescription` in a process that is already stopped costs about 20 ms and one
   * layout report about 10 ms (measured here: 80 dumps added 1.6 s, 80 layout reports 0.9 s, against
   * a 5.4 s attach). Reading them per click therefore paid the expensive half again and again — and
   * when the request named no app it did not even reach the session the tree had just come from,
   * answering `the device  () is not one lldb can attach to right now` instead. Read once, here, and
   * every pane is drawn from what is already in hand.
   *
   * Bounded twice over, because a real app is thousands of views and a stopped app is a frozen one:
   * a cap on how many views are read, and a budget on how long the whole pass may take. Whatever is
   * left over is read on demand, one view at a time, as before.
   *
   * @param {object[]} records - the tree, in the order it was read.
   * @param {object} session - the stopped session to read through.
   * @returns the details by address, and what the bounds did.
   */
  async function readViewDetails(records, session) {
    const details = {}
    // Kept beside the payload because the export that follows this read clears the cache for the
    // addresses of the tree that came before — and these belong to the tree that just arrived.
    const cache = new Map()
    const started = Date.now()
    let attributes = 0
    let layouts = 0
    let read = 0
    for (const record of records) {
      if (read >= VIEW_DETAILS_MAX || Date.now() - started >= VIEW_DETAILS_BUDGET_MS) break
      const address = record.address
      read += 1
      const dumped = await session.evaluate(attributesExpression(address), { timeoutMs: 20000 })
      const shaped = dumped.ok ? attributeResultOf(address, dumped.text) : null
      if (shaped !== null) {
        attributes += 1
        details[address] = { className: shaped.className, groups: shaped.groups, attributes: shaped.attributes }
        // A per-view read after this is answered from here rather than asked again.
        cache.set(address, shaped)
        viewAttributes.set(address, shaped)
      }
      const reported = await session.evaluate(constraintsExpression(address), { timeoutMs: 20000 })
      const layout = reported.ok ? parseConstraintsReport(reported.text) : null
      if (layout !== null) {
        layouts += 1
        details[address] = { ...(details[address] ?? {}), className: record.className, layout }
      }
    }
    return { details, cache, attributes, layouts, read, capped: read < records.length, ms: Date.now() - started }
  }

  /**
   * How the view is laid out: Auto Layout, ambiguity, intrinsic size, and the constraints that
   * place it — including the ones that live on its ancestors, which are the ones that usually
   * explain the frame.
   */
  async function lldbViewConstraints(body, workspace) {
    const address = typeof body?.address === 'string' ? body.address : ''
    if (!/^0x[0-9a-fA-F]+$/.test(address)) {
      return { ok: false, note: 'no view address was given', layout: null, session: lldb === null ? null : lldb.summary() }
    }
    const ready = await lldbEnsureAttached(lldbTargetFor(workspace, body), workspace)
    if (!ready.ok) return { ok: false, note: ready.note, layout: null, session: ready.session.summary() }
    const paused = await ready.session.pauseFor(() => ready.session.evaluate(constraintsExpression(address), { timeoutMs: 20000 }))
    const read = paused.ok && paused.value !== undefined ? paused.value : { ok: false, text: '', note: paused.note }
    if (!read.ok) {
      const freed = await releaseApp(ready.session)
      const why = read.note === '' ? 'the layout report produced no output' : read.note
      return {
        ok: false,
        note: `${why}. ${freed ? 'The app was released, so it is running again' : 'The debugger was ended, which releases the app as well'}`,
        layout: null,
        session: ready.session.summary(),
      }
    }
    const layout = parseConstraintsReport(read.text)
    if (layout === null) {
      return { ok: false, note: 'the layout report did not come back in the shape this plugin expects', layout: null, session: ready.session.summary() }
    }
    return { ok: true, note: '', address, layout, pausedMs: paused.pausedMs, continued: paused.resumed, session: ready.session.summary() }
  }

  /**
   * Change one attribute on a live view and say what the app says the value is now.
   *
   * The write and the read-back are one stop, and the read-back is the point: a setter that runs
   * `layoutSubviews`, or a property the app recomputes, can leave the value where it started, and
   * reporting the value that was *asked for* would hide exactly that. So the expression is the
   * write, and then the ivar is read again and returned.
   */
  async function lldbEditAttribute(body, workspace) {
    const address = typeof body?.address === 'string' ? body.address : ''
    const key = typeof body?.key === 'string' ? body.key : ''
    const built = editExpression({ address, key, kind: body?.kind, value: body?.value })
    if (built.expression === '') {
      return { ok: false, note: built.note, session: lldb === null ? null : lldb.summary() }
    }
    const ready = await lldbEnsureAttached(lldbTargetFor(workspace, body), workspace)
    if (!ready.ok) return { ok: false, note: ready.note, session: ready.session.summary() }
    const paused = await ready.session.pauseFor(async () => {
      const written = await ready.session.send(built.expression, { timeoutMs: 20000 })
      if (!written.completed || !editSucceeded(written.text)) return { written, after: null }
      // The whole attribute dump again, rather than one `valueForKey:`: the value's *type* decides
      // how it prints, and re-reading the list keeps the pane consistent with what it shows.
      const again = await ready.session.evaluate(attributesExpression(address), { timeoutMs: 20000 })
      return { written, after: again.ok ? parseIvarDescription(again.text) : null }
    })
    const value = paused.ok && paused.value !== undefined ? paused.value : { written: { completed: false, text: paused.note }, after: null }
    if (!value.written.completed || !editSucceeded(value.written.text)) {
      const freed = await releaseApp(ready.session)
      return {
        ok: false,
        note: `${value.written.text === '' ? 'the edit did not complete' : value.written.text.trim().split('\n')[0]}. ${freed ? 'The app was released, so it is running again' : ''}`.trim(),
        session: ready.session.summary(),
      }
    }
    // The list this address was showing is now wrong, so it is dropped rather than left to be
    // served as a cache hit.
    viewAttributes.delete(address)
    const rows = value.after === null
      ? []
      : value.after.groups.flatMap((group) => group.rows.map((row) => ({ group: group.name, ...row })))
    const changed = rows.find((row) => row.name === key)
    return {
      ok: true,
      note: '',
      address,
      key,
      // What the app says the value is now, not what was asked for. The panel compares the two and
      // says so when they differ — the case Lookin calls "the modification seems to have no
      // effect", which happens whenever the app's own layout code writes the value back.
      value: changed?.value ?? '',
      groups: value.after === null
        ? []
        : value.after.groups.map((group) => ({
          name: group.name,
          rows: group.rows.map((row) => ({ ...row, edit: editableDescriptor(row, { keys: EDITABLE_KEYS }) })),
        })),
      pausedMs: paused.pausedMs,
      continued: paused.resumed,
      session: ready.session.summary(),
    }
  }

  async function lldbOp(op, body, workspace) {
    if (op === 'processes') return lldbProcessList(body, workspace)
    if (op === 'logs') return lldbAppLog(body, workspace)
    if (op === 'view') return lldbViewHierarchy(body, workspace)
    if (op === 'lookin') return lldbOpenLookin(body, workspace)
    if (op === 'lookinFull') return lldbLookinFull(body, workspace)
    if (op === 'lookinJob') return jobView(lookinJob)
    if (op === 'lookinCancel') return lldbLookinCancel()
    if (op === 'lookinHistory') return lldbLookinHistory()
    if (op === 'lookinOpenFile') return lldbLookinOpenFile(body, workspace)
    if (op === 'lookinDelete') return lldbLookinDelete(body)
    if (op === 'node') return lldbNode(body)
    if (op === 'attributes') return lldbViewAttributes(body, workspace)
    if (op === 'constraints') return lldbViewConstraints(body, workspace)
    if (op === 'edit') return lldbEditAttribute(body, workspace)
    if (op === 'attach') {
      const ready = await lldbEnsureAttached(lldbTargetFor(workspace, body), workspace)
      // Mounting from the panel's Apps list must not leave the phone frozen: the session stays
      // attached, and the app runs on until a read stops it.
      const continued = ready.ok && body?.continue === true ? await continueAfterRead(ready.session, body) : false
      return {
        ok: ready.ok,
        note: ready.note,
        reused: ready.reused === true,
        refused: ready.refused === true,
        continued,
        session: (ready.session ?? lldbFor()).summary(),
      }
    }
    if (op === 'state') {
      if (lldb === null) return { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }
      const summary = lldb.summary()
      const from = Number.isFinite(body?.from) ? body.from : 0
      return {
        active: true,
        session: summary,
        // The session's own cursor, one PAST the last line (see `summary().next`).
        next: summary.next,
        firstAvailable: summary.firstAvailable,
        // The same forward-only cursor the build log uses, for the same reason: the panel
        // renders a window and the host owns the whole transcript.
        lines: lldb.readLines(from),
      }
    }
    if (op === 'interrupt') {
      const session = lldbFor()
      const stopped = await session.interrupt()
      return { ok: stopped.ok, note: stopped.note, session: session.summary() }
    }
    if (op === 'continue') {
      if (lldb === null) return { ok: false, note: 'no session to continue', session: null }
      // `resume()` cannot answer: while the inferior runs the interpreter has nothing to
      // say, so the state is read back a moment later instead — LLDB prints `Process N
      // resuming` at once, and an answer written before it would report the state the app
      // is just leaving.
      if (!lldb.resume()) return { ok: false, note: 'the session could not be resumed', session: lldb.summary() }
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      return { ok: true, note: 'the app is running again, still attached', session: lldb.summary() }
    }
    if (op === 'detach') {
      if (lldb === null) return { ok: true, note: 'no session', session: null }
      const out = await lldb.detach()
      return { ok: out.ok, note: out.note, session: lldb.summary() }
    }
    if (op === 'dispose') {
      if (lldb !== null) await lldb.dispose()
      lldb = null
      return { ok: true, note: 'session ended', session: null }
    }
    if (op === 'command') {
      const command = String(body?.command ?? '').trim()
      if (command === '') return { ok: false, note: 'action=command needs a command', session: lldb === null ? null : lldb.summary() }
      const session = lldbFor()
      // Typing a command in the drawer is how a user starts debugging, exactly as typing in
      // Xcode's console assumes the app is being debugged. So the first command attaches to
      // the target this workspace last ran, and a command typed before any session exists
      // is not answered with "no target".
      if (session.summary().attached === null && body?.attach !== false) {
        const target = lldbTargetFor(workspace, body)
        if (target.runId !== null || target.destination !== '') {
          const ready = await lldbEnsureAttached(target, workspace)
          if (!ready.ok) return { ok: false, note: ready.note, session: ready.session.summary() }
        }
      }
      const timeoutMs = Number.isFinite(body?.timeoutMs) ? body.timeoutMs : 30000
      // An expression needs a stop, and gets the shortest one: interrupt, run, continue. Everything
      // else (`process status`, `breakpoint set`, `continue`, `process interrupt` itself) is answered
      // by an asynchronous interpreter while the app runs, and is sent as it is.
      if (session.state === 'running' && needsStop(command)) {
        const paused = await session.pauseFor(() => session.send(command, { timeoutMs }))
        const sent = paused.value
        return {
          ok: paused.ok && sent?.completed === true,
          note: paused.ok ? (sent?.note ?? '') : paused.note,
          output: sent?.text ?? '',
          command,
          pausedMs: paused.pausedMs,
          session: session.summary(),
        }
      }
      const sent = await session.send(command, { timeoutMs })
      return { ok: sent.completed, note: sent.note, output: sent.text, command, session: session.summary() }
    }
    return { ok: false, note: `unknown lldb op: ${op}`, session: lldb === null ? null : lldb.summary() }
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
      // started by `xcode_run` carries its session's cwd, so it is claimed by that project's panel.
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
      return {
        workspace,
        activeRunId: active?.id ?? null,
        active: active === undefined ? null : runSummary(active),
        runs: list,
        revision: LOADED_REVISION,
      }
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
        death: run.death,
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
    /**
     * The debugger, for the panel's drawer. `op` picks the operation, so one route
     * carries the whole session — the panel polls it for output and clicks it for a
     * view hierarchy, and neither needs a second transport.
     */
    lldb: async (body) => lldbOp(body?.op ?? 'state', body ?? {}, workspaceFor(body?.sessionId)),
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

  // -- model guidance ------------------------------------------------------
  //
  // Tool descriptions say what each tool does; they do not say WHEN to reach for
  // them, so a model asked to "fix the build" would still shell out to raw
  // `xcodebuild`. Two optional contributions close that gap: a short prompt
  // section that is always present (routing), and a skill loaded on demand (the
  // full loop). Both are optional services, so a profile without them still
  // mounts the tools.

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'dsh-xcodebuild',
      order: PROMPT_ORDER,
      text: PROMPT_SECTION,
    }), 'dsh-xcodebuild: prompt section')
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.register({
      name: 'xcode-build-loop',
      description: 'Build, run, test and debug Xcode / iOS / macOS projects with the xcode_* tools: '
        + 'pick project, scheme and destination, read compiler errors, install and launch on a simulator '
        + 'or a physical iPhone (including iOS 16 and earlier), and read the app\'s log after a crash.',
      whenToUse: 'The user asks to build, compile, run, launch, test, archive or clean an Xcode project, '
        + 'fix build errors, run an app on a simulator or device, or find out why an iOS app crashed.',
      source: 'runtime',
      content: SKILL_BODY,
    }), 'dsh-xcodebuild: skill')
  })

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
