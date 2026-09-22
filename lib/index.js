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
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { classify } from './classify.js'
import { legacyLaunchFailure, parseLaunchedPid } from './legacy-launch.js'
import { mergeListings } from './listing.js'
import { PROJECT_FILE, findProjects } from './projects.js'
import { destinationKindOf, destinationString, parseDestinations, pickDefaultDestination } from './parse-destinations.js'
import { createRing, ringFirst, ringPush, ringSlice } from './ring.js'

export { classify } from './classify.js'
export { legacyLaunchFailure, parseLaunchedPid } from './legacy-launch.js'
export { destinationKindOf, destinationString, parseDestinations, pickDefaultDestination, variantForDestination } from './parse-destinations.js'
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
 * Spawn a child and stream stdout/stderr line by line.
 * @param {string[]} argv - command and arguments.
 * @param {string} cwd - working directory.
 * @param {(line: string) => void} onLine - one complete line (no trailing newline).
 * @param {{onChild?: (child: import('node:child_process').ChildProcess) => void}} [options] - spawn hook.
 * @returns {Promise<{exitCode: number, signal: string | null}>} exit facts.
 */
function spawnStreaming(argv, cwd, onLine, options = {}) {
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

    let carryOut = ''
    let carryErr = ''
    let settled = false
    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      if (carryOut !== '') {
        onLine(carryOut)
        carryOut = ''
      }
      if (carryErr !== '') {
        onLine(carryErr)
        carryErr = ''
      }
      resolveSpawn({ exitCode, signal: signal ?? null })
    }

    const feed = (chunk, which) => {
      let carry = which === 'out' ? carryOut : carryErr
      carry += chunk.toString('utf8')
      let index
      while ((index = carry.indexOf('\n')) >= 0) {
        onLine(carry.slice(0, index))
        carry = carry.slice(index + 1)
      }
      // A pathological no-newline stream must not grow without bound.
      if (carry.length > 262144) {
        onLine(carry)
        carry = ''
      }
      if (which === 'out') carryOut = carry
      else carryErr = carry
    }

    child.stdout?.on('data', (chunk) => feed(chunk, 'out'))
    child.stderr?.on('data', (chunk) => feed(chunk, 'err'))
    child.on('error', (error) => {
      onLine(`process error: ${messageOf(error)}`)
      finish(-1, null)
    })
    child.on('close', (code, signal) => finish(code === null ? -1 : code, signal))
  })
}

/** Homebrew prefixes. The legacy device tools are brewed, not shipped by Xcode. */
/** The group name for everything the pre-CoreDevice channel needs. */
const LEGACY_GROUP = 'iOS 16 and earlier devices'

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
    purpose: 'launch the app on that hardware',
    install: 'brew install ios-deploy',
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
 * Is this device id hardware rather than a simulator?
 *
 * Asked of the device, not inferred from the shape of the id: `ideviceinfo`
 * answers over the classic channel for anything libimobiledevice can reach, and a
 * simulator udid never does.
 *
 * @param {string} udid - id to classify.
 * @returns {Promise<boolean>} true when the id names physical hardware.
 */
async function isPhysicalDevice(udid) {
  const info = await capture([legacyTool('ideviceinfo'), '-u', udid, '-k', 'ProductVersion'], '/', 20000)
  return info.exitCode === 0
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
  const missingOptional = tools.filter((tool) => !tool.required && !tool.ready).map((tool) => tool.command)
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
  return listed.concat(await legacyDevices(known, project.root))
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

  function pushLine(run, text) {
    const line = String(text)
    const kind = classify(line)
    ringPush(run.ring, { t: line.length > 4000 ? line.slice(0, 4000) : line, k: kind })
    if (kind === 'error' && run.errors.length < 100) run.errors.push(line.slice(0, 400))
    if (kind === 'warning') run.warningCount += 1
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
   * The workspace root the panel should start from.
   *
   * `process.cwd()` is the harness's own directory, which has nothing to do with
   * the project a session is working in. The session's own header carries the
   * directory the user opened, and that is what the path field should offer.
   * Falls back to the process directory only when no session can be resolved —
   * a panel that cannot name a session is still better off than one that throws.
   */
  function workspaceFor(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        const cwd = ctx.get('sessions')?.get(sessionId)?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        /* an unresolvable session is not an error worth failing the route over */
      }
    }
    return process.cwd()
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

    pushLine(run, `$ ${argv.join(' ')}`)
    run.done = runBuild(run, signal).catch((error) => {
      // Nothing else awaits `run.done`, so a rejection here would be unhandled.
      pushLine(run, `run failed: ${messageOf(error)}`)
      run.status = 'failed'
      if (run.exitCode === null) run.exitCode = -1
    })
    return run
  }

  /** The build itself, followed by the install and launch that `run` adds. */
  async function runBuild(run, signal) {
    const exit = await spawnStreaming(run.argv, run.project.root, (line) => pushLine(run, line), {
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
    run.status = 'succeeded'
    run.endedAt = Date.now()
    return run
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
        // `--noinstall` is the point of this pairing: ios-deploy's own install
        // path fails against this generation of AMDevice with 0xe8000067, while
        // its lldb-driven launch works. Install with ideviceinstaller, launch
        // with ios-deploy.
        const launch = [launcher, '--id', udid, '--bundle', appPath, '--noinstall', '--justlaunch', '--no-wifi']
        pushLine(run, `$ ${launch.join(' ')}`)
        const launchedLegacy = await captureTee(launch, run.project.root, 300000, (line) => pushLine(run, line))
        // Nothing ios-deploy prints here is a verdict, so this does not read one.
        //
        // The `success` line it emits comes from the generated lldb script printing
        // `str(startup_error)` as soon as `Launch()` returns — LLDB's SBError
        // stringifies to that literal whenever the call reported no error, which is
        // before the process is known to be alive. safequit decides afterwards and
        // its failure message never arrives (Python block-buffers stdout, os._exit
        // discards it), so a failed launch leaves that SAME `success` line above a
        // silent, non-zero exit. Judging on it — as
        // `exitCode !== 0 && !/^success$/m.test(stdout)` did — reported every iPhone
        // X run as launched. `lib/legacy-launch.js` carries the full trace.
        //
        // The verdict is therefore the exit code, with the process id as evidence:
        // a pid short-circuits to success, but its ABSENCE does not fail the run,
        // because `ios-deploy --get_pid` answers nothing even for a running
        // SpringBoard here. It is still worth asking — it is the `pid > 0` evidence
        // the ios-dev-test skill requires of 拉起, and it lands in `artifact.pid`.
        const probeArgv = [launcher, '--id', udid, '--get_pid', '--bundle_id', bundleId]
        pushLine(run, `$ ${probeArgv.join(' ')}`)
        const probe = await capture(probeArgv, run.project.root, 60000)
        const launchedPid = parseLaunchedPid(probe.stdout)
        pushLine(run, probe.timedOut
          ? 'the pid probe did not answer within 60s'
          : launchedPid === null
            ? `the device reported no pid for ${bundleId} (this toolchain also reports none for a running SpringBoard, so it is not proof either way)`
            : `the device reports ${bundleId} as pid ${launchedPid}`)
        const launchFailure = legacyLaunchFailure({
          timedOut: launchedLegacy.timedOut,
          exitCode: launchedLegacy.exitCode,
          output: launchedLegacy.stdout + launchedLegacy.stderr,
          pid: launchedPid,
        })
        if (launchFailure !== null) throw new Error(launchFailure)
        run.artifact = { appPath, bundleId, pid: launchedPid }
        pushLine(run, launchedPid === null
          ? `launched ${bundleId} on legacy device ${udid}`
          : `launched ${bundleId} on legacy device ${udid} (pid ${launchedPid})`)
        return
      }
      const install = ['xcrun', 'devicectl', 'device', 'install', 'app', '--device', udid, appPath]
      pushLine(run, `$ ${install.join(' ')}`)
      const installed = await captureTee(install, run.project.root, 600000, (line) => pushLine(run, line))
      if (installed.exitCode !== 0) throw new Error(tailOf(installed.stdout + installed.stderr, 20) + channelHint())
      const launch = ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', udid, '--terminate-existing', bundleId]
      pushLine(run, `$ ${launch.join(' ')}`)
      const launched = await captureTee(launch, run.project.root, 300000, (line) => pushLine(run, line))
      if (launched.exitCode !== 0) throw new Error(tailOf(launched.stdout + launched.stderr, 20) + channelHint())
      run.artifact = { appPath, bundleId, pid: null }
      pushLine(run, `launched ${bundleId} on device ${udid}`)
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
    description: 'Read the unified log (os_log / print) of a booted iOS Simulator or a connected physical '
      + 'device, always as a bounded capture that returns rather than hanging. On a simulator: snapshot (recent '
      + 'persisted lines via `log show --last <duration>`) or follow (a live `log stream` window). On hardware '
      + 'there is no `simctl` and no queryable history — `idevicesyslog` only relays the syslog live — so the '
      + 'result is a live window and says so. Output is capped to the tail of ~300 lines.',
    parameters: {
      udid: { type: 'string', description: 'Simulator udid, or a physical device udid. Defaults to the first booted simulator.' },
      mode: { type: 'string', enum: ['snapshot', 'follow'], description: 'snapshot (default) or follow.' },
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
      if (await isPhysicalDevice(udid)) {
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
          note: 'a physical device keeps no queryable log history: idevicesyslog relays the syslog live, so this is a live window, not a snapshot',
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
      run.child?.kill('SIGINT')
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
    for (const run of runs.values()) run.child?.kill('SIGKILL')
    runs.clear()
  }, 'dsh-xcodebuild: run cleanup')

  ctx.logger?.info?.(`dsh-xcodebuild mounted (${Object.keys(api).length} panel routes, ${runs.size} runs)`)

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
