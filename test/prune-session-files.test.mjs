// The prune, against a real directory tree.
//
// The pure policy is pinned in `session-files.test.mjs`; what this checks is that the
// filesystem half actually deletes the right things and, more importantly, leaves the
// live ones alone: the current session's console file, a session from an hour ago
// that is still being written, and macOS's own temporary directories.
//
// Run: node test/prune-session-files.test.mjs

import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneSessionFiles } from '../lib/index.js'
import { APP_LOG_PREFIX } from '../lib/session-files.js'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
}

const UDID = '0000a1b2c3d4e5f60718293a4b5c6d7e8f901234'
const NOW = Date.now()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const root = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-prune-test-'))
const consoleDir = join(root, 'dsh-xcodebuild')
await mkdir(consoleDir, { recursive: true })

/** A file with a chosen mtime, so "old" and "new" are exact rather than elapsed. */
async function file(path, { ageMs, text = 'x' } = {}) {
  await writeFile(path, text)
  if (ageMs !== undefined) {
    const when = new Date(NOW - ageMs)
    await utimes(path, when, when)
  }
}

const consoleFile = (runId, ageMs) => file(join(consoleDir, `${runId}-${String(NOW - ageMs)}-ios-deploy.log`), { ageMs })
const uuid = () => `${Math.random().toString(16).slice(2, 10)}-1111-2222-3333-444444444444`

/** An ios-deploy temporary directory, named the way ios-deploy names its contents. */
async function fruitstrapDir({ ageMs, udid = UDID, marker = true }) {
  const path = join(root, uuid())
  await mkdir(path, { recursive: true })
  if (marker) {
    await file(join(path, `fruitstrap_${udid}.py`), { ageMs, text: 'module' })
    await file(join(path, `fruitstrap-lldb-prep-cmds-${udid}`), { ageMs, text: 'prep' })
  }
  await mkdir(join(path, 'fruitstrap_'), { recursive: true })
  const when = new Date(NOW - ageMs)
  await utimes(path, when, when)
  return path
}

console.log('== the current session is not touched ==')
const mine = await consoleFile('xr1', 2 * MINUTE)
const other2 = await consoleFile('xr2', 3 * MINUTE)
const other3 = await consoleFile('xr3', 4 * MINUTE)
const other4 = await consoleFile('xr4', 5 * MINUTE)
const other5 = await consoleFile('xr5', 6 * MINUTE)
const other6 = await consoleFile('xr6', 7 * MINUTE)
const abandoned = await consoleFile('xr7', 40 * DAY)
await file(join(consoleDir, 'notes.txt'), { ageMs: 40 * DAY, text: 'not ours' })

console.log('== and neither are the plugin\'s own, or macOS\'s, other directories ==')
const staleSession = await fruitstrapDir({ ageMs: 3 * HOUR })
const liveSession = await fruitstrapDir({ ageMs: 2 * MINUTE })
const otherDevice = await fruitstrapDir({ ageMs: 3 * HOUR, udid: 'someone-elses-device' })
const noMarker = await fruitstrapDir({ ageMs: 3 * HOUR, marker: false })
const staleDownload = join(root, `${APP_LOG_PREFIX}stale`)
await mkdir(staleDownload, { recursive: true })
await utimes(staleDownload, new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR))
const liveDownload = join(root, `${APP_LOG_PREFIX}live`)
await mkdir(liveDownload, { recursive: true })
const macosDir = join(root, 'BlobRegistryFiles-CiZDic3A')
await mkdir(macosDir, { recursive: true })
await utimes(macosDir, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY))

await pruneSessionFiles(UDID, [root])

const names = await readdir(root)
const inConsole = await readdir(consoleDir)

check(inConsole.includes('xr1-' + String(NOW - 2 * MINUTE) + '-ios-deploy.log'), 'the current session\'s console file stays')
check(inConsole.includes('xr2-' + String(NOW - 3 * MINUTE) + '-ios-deploy.log'), 'so do the newest few before it')
check(inConsole.includes('xr3-' + String(NOW - 4 * MINUTE) + '-ios-deploy.log'), 'the fourth newest too')
check(inConsole.includes('xr4-' + String(NOW - 5 * MINUTE) + '-ios-deploy.log'), 'and the fifth')
check(inConsole.includes('xr5-' + String(NOW - 6 * MINUTE) + '-ios-deploy.log'), 'and the sixth, up to the keep limit')
check(!inConsole.includes('xr6-' + String(NOW - 7 * MINUTE) + '-ios-deploy.log'), 'the oldest beyond the limit goes')
check(!inConsole.includes('xr7-' + String(NOW - 40 * DAY) + '-ios-deploy.log'), 'so does a forty-day-old one')
check(inConsole.includes('notes.txt'), 'a file this plugin did not write is left alone')

check(!names.includes(staleSession.replace(`${root}/`, '')), 'a three-hour-old ios-deploy directory for this device is deleted')
check(names.includes(liveSession.replace(`${root}/`, '')), 'a session from two minutes ago is NOT deleted')
check(names.includes(otherDevice.replace(`${root}/`, '')), 'another device\'s session is not this plugin\'s to delete')
check(names.includes(noMarker.replace(`${root}/`, '')), 'a directory that names no device is left alone')
check(!names.includes(staleDownload.replace(`${root}/`, '')), 'a download abandoned by a dead host is deleted')
check(names.includes(liveDownload.replace(`${root}/`, '')), 'an in-flight download is not')
check(names.includes(macosDir.replace(`${root}/`, '')), 'macOS\'s own temporary directories are never considered')

console.log('== a prune with nothing to do is not an error ==')
const empty = await mkdtemp(join(tmpdir(), 'dsh-xcodebuild-prune-empty-'))
await pruneSessionFiles(UDID, [empty])
check(true, 'an empty temporary root survives a prune')

await rm(root, { recursive: true, force: true })
await rm(empty, { recursive: true, force: true })
void mine
void other2
void other3
void other4
void other5
void other6
void abandoned

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('prune session files OK')
