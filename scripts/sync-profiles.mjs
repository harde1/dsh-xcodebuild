// Keep every installed copy of this plugin on the version this checkout is.
//
// The plugin is developed here and used from a DSH profile, and a profile that pins an
// old version is indistinguishable from a bug: a run then fails inside code that was
// fixed long ago, in a panel that looks current. That happened — the web profile sat on
// 0.2.1 while this checkout went to 0.6.22, and an iOS 16 install failed on an
// `ideviceinstaller` command line that had been corrected three releases earlier.
//
// Two kinds of profile exist, and only one can be written from a shell:
//
// - A plain profile keeps `node_modules/dsh-xcodebuild` as a real directory. It is
//   replaced here with a copy of THIS checkout, packed exactly as `npm publish` packs
//   it — the `files` list decides, so `test/` stays out and a profile is not testing
//   something nobody installs.
// - A profile built out of "generations" keeps that path as a symlink into
//   `profiles/.generations/live/<pkg>+<version>+<hash>`, and its installer refuses a
//   tree that is not self-contained (a `link:` dependency fails with "generation
//   package tree is not self-contained"). Such a profile is reported and left alone:
//   its update is `plugin_manager install_bundle dsh-xcodebuild@<version>`, a host tool
//   call rather than a shell command.
//
// Run: node scripts/sync-profiles.mjs          # report only
//      node scripts/sync-profiles.mjs --write  # copy this checkout into place
//      node scripts/sync-profiles.mjs --write --force  # …even if the version matches
//
// Nothing here restarts a host: an updated profile is read when DSH starts again, and
// a running panel keeps the copy it loaded.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-xcodebuild'
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const write = process.argv.includes('--write')
// `--force` rewrites a plain profile even when the version already matches: the same
// version can differ in content, and a working tree that is ahead of the release it
// still calls itself is exactly the case this tool exists for.
const force = process.argv.includes('--force')

/** The version this checkout is. */
const localVersion = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version

/**
 * Every directory that may hold profiles, in the order DSH itself uses.
 *
 * @returns {string[]} existing roots.
 */
function profileRoots() {
  const roots = []
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles'))
  roots.push(join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness', 'profiles'))
  roots.push(join(homedir(), '.dsh', 'profiles'))
  return [...new Set(roots)].filter((root) => existsSync(root))
}

/**
 * The version recorded inside an installed copy, or null.
 *
 * @param {string} path - the installed package directory.
 * @returns {string|null} version.
 */
function versionAt(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * What is at `<profile>/node_modules/dsh-xcodebuild`.
 *
 * @param {string} path - the installed path.
 * @returns {{kind: 'missing'|'generation'|'directory', version: string|null, target: string|null}}
 */
function stateOf(path) {
  if (!existsSync(path)) return { kind: 'missing', version: null, target: null }
  if (lstatSync(path).isSymbolicLink()) {
    const raw = readlinkSync(path)
    const target = isAbsolute(raw) ? raw : resolve(dirname(path), raw)
    return { kind: 'generation', version: versionAt(path), target }
  }
  return { kind: 'directory', version: versionAt(path), target: null }
}

/**
 * Profiles that declare this plugin as a dependency, with the state of each.
 *
 * @returns {Array<{dir: string, manifest: string, declared: string, link: string, state: object}>}
 */
function profiles() {
  const found = []
  for (const root of profileRoots()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(root, entry.name)
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue
      let declared = null
      try {
        declared = JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.[NAME] ?? null
      } catch {
        continue
      }
      if (declared === null) continue
      const link = join(dir, 'node_modules', NAME)
      found.push({ dir, manifest, declared, link, state: stateOf(link) })
    }
  }
  return found
}

/**
 * A packed copy of this checkout in a fresh temporary directory.
 *
 * @returns {string} path to the .tgz.
 */
function packCheckout() {
  const into = mkdtempSync(join(tmpdir(), `${NAME}-pack-`))
  const out = execFileSync('npm', ['pack', '--pack-destination', into], { cwd: checkout, encoding: 'utf8' })
  const file = out.trim().split('\n').map((line) => line.trim()).filter(Boolean).pop()
  const tgz = join(into, file)
  if (!existsSync(tgz)) throw new Error(`npm pack said ${file}, but ${tgz} is not there`)
  return tgz
}

/**
 * Replace a plain profile's copy with this checkout.
 *
 * The copy is unpacked beside the target and moved in afterwards, so an interrupted run
 * leaves either the old copy or the new one, never half of each.
 *
 * @param {object} profile - as returned by `profiles()`.
 * @param {string} tgz - a packed copy of this checkout.
 */
function installInto(profile, tgz) {
  const unpacked = mkdtempSync(join(tmpdir(), `${NAME}-unpack-`))
  execFileSync('tar', ['xzf', tgz, '-C', unpacked, '--strip-components=1'])
  rmSync(profile.link, { recursive: true, force: true })
  cpSync(unpacked, profile.link, { recursive: true })
  const manifest = JSON.parse(readFileSync(profile.manifest, 'utf8'))
  manifest.dependencies[NAME] = localVersion
  writeFileSync(profile.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

// --- report and, when asked, write ------------------------------------------

console.log(`this checkout: ${localVersion}  (${checkout})`)
const found = profiles()
if (found.length === 0) {
  console.log('no profile depends on this plugin; nothing to sync')
  process.exit(0)
}

let stale = 0
let written = 0
for (const profile of found) {
  const name = profile.dir.split('/').pop()
  const { kind, version } = profile.state
  const same = version === localVersion && !force
  if (!same) stale += 1
  console.log(`\n${name}  ${profile.dir}`)
  console.log(`  declares:  ${profile.declared}`)
  console.log(`  installed: ${version ?? '—'}  (${kind})`)
  if (same) {
    console.log('  status: in sync')
    continue
  }
  if (force && kind !== 'generation' && !write) {
    console.log(`  status: same version, different content — --write --force copies this checkout in`)
    continue
  }
  if (kind === 'generation') {
    console.log('  status: STALE — a generation profile; update it with')
    console.log(`          plugin_manager install_bundle ${NAME}@${localVersion}`)
    continue
  }
  if (!write) {
    console.log(`  status: STALE — run this again with --write to copy ${localVersion} in`)
    continue
  }
  installInto(profile, packCheckout())
  written += 1
  console.log(`  status: updated to ${versionAt(profile.link) ?? '?'}`)
}

console.log(`\n${found.length} profile(s), ${stale} stale${write ? `, ${written} written` : ''}`)
console.log('A running host keeps the copy it loaded: restart DSH to use the new one.')
