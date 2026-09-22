// Project discovery: which Xcode project a directory holds, and which ones it
// offers to choose from.
//
// Kept apart from the host half so it can be tested without the runtime's
// package aliasing: nothing here needs `@deepseek-ai/dsh-tools`, only the
// filesystem.

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

export const PROJECT_FILE = /\.(xcworkspace|xcodeproj)$/i

/**
 * Directories a project search never descends into.
 *
 * These hold copies of projects that are not the user's own: a `Pods/` tree
 * carries every pod's own `.xcodeproj`, `PodCache/` carries the specs, and
 * `build`/`DerivedData` carry build products. A plain recursive scan of a real
 * iOS checkout returns dozens of these, which is exactly the noise a picker
 * must not offer.
 */
const SEARCH_SKIP_DIRS = new Set([
  'Pods',
  'PodCache',
  'Carthage',
  'DerivedData',
  'SourcePackages',
  'build',
  'build_derived',
  'node_modules',
  '.build',
  '.git',
  '.swiftpm',
])

/** How deep a search walks below the directory the user named. */
const MAX_SEARCH_DEPTH = 3
/** Candidates returned before the search stops looking. */
const MAX_SEARCH_RESULTS = 40
/** Directories read before the search gives up, so a huge tree cannot stall the panel. */
const MAX_SEARCH_DIRS = 600

/**
 * Find every Xcode project at or below one directory.
 *
 * The panel cannot ask the user to type a project path and hope: a real iOS
 * checkout holds several, most of them noise. `Pods/` carries a `.xcodeproj`
 * per dependency, a `.xcodeproj` bundle contains its own
 * `project.xcworkspace`, and a workspace sits beside the `.xcodeproj` it wraps.
 * A picker built on a plain recursive scan would offer all of that.
 *
 * Two rules remove almost all of it:
 *
 * - Never descend INTO a `.xcodeproj` or `.xcworkspace`; they are directories,
 *   but they are artifacts, not containers of other projects. This alone drops
 *   `Gemoy.xcodeproj/project.xcworkspace`.
 * - Drop a `.xcodeproj` that shares a basename with a `.xcworkspace` beside it.
 *   `Gemoy.xcworkspace` sits next to `Gemoy.xcodeproj`, which is the target
 *   list the workspace already includes; offering both would ask the user to
 *   choose between a project and the workspace containing it.
 *
 * What survives is a genuine choice — `Gemoy.xcworkspace` alongside
 * `OtherProject/YNLive/YNLive.xcworkspace` — which is what the picker is for.
 *
 * @param input - a directory, or a project path that is returned as the sole candidate.
 * @returns candidates ordered shallowest first, workspaces before projects.
 */
export async function findProjects(input) {
  if (typeof input !== 'string' || input === '') throw new Error('path is required')
  const abs = resolvePath(isAbsolute(input) ? input : resolvePath(process.cwd(), input))

  const named = await stat(abs).catch(() => null)
  if (named === null) throw new Error(`path does not exist: ${abs}`)
  if (named.isFile()) throw new Error(`expected a directory: ${abs}`)
  // Naming the bundle itself is an answer, not a place to search.
  if (PROJECT_FILE.test(basename(abs))) {
    return { root: dirname(abs), candidates: [candidateOf(dirname(abs), dirname(abs), basename(abs), 0)], truncated: false }
  }

  const candidates = []
  let visited = 0
  let truncated = false

  const walk = async (dir, depth) => {
    if (truncated) return
    if (visited >= MAX_SEARCH_DIRS || candidates.length >= MAX_SEARCH_RESULTS) {
      truncated = true
      return
    }
    visited += 1

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (entries === null) return

    const workspaces = []
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_FILE.test(entry.name)) continue
      if (/\.xcworkspace$/i.test(entry.name)) workspaces.push(entry.name)
      else projects.push(entry.name)
    }

    for (const name of workspaces) candidates.push(candidateOf(abs, dir, name, depth))
    const wrapped = new Set(workspaces.map((name) => name.replace(/\.xcworkspace$/i, '')))
    for (const name of projects) {
      if (wrapped.has(name.replace(/\.xcodeproj$/i, ''))) continue
      candidates.push(candidateOf(abs, dir, name, depth))
    }

    if (depth >= MAX_SEARCH_DEPTH) return
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // A bundle is never searched, and a dot-directory is tooling state.
      if (PROJECT_FILE.test(entry.name) || entry.name.startsWith('.')) continue
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }

  await walk(abs, 0)

  candidates.sort((left, right) => (
    left.depth - right.depth
    || Number(left.kind === 'project') - Number(right.kind === 'project')
    || left.relative.localeCompare(right.relative)
  ))

  return { root: abs, candidates, truncated }
}

/** One search hit, described relative to the directory the user searched. */
function candidateOf(root, dir, name, depth) {
  const location = join(dir, name)
  const workspace = /\.xcworkspace$/i.test(name)
  return {
    kind: workspace ? 'workspace' : 'project',
    name: name.replace(PROJECT_FILE, ''),
    location,
    relative: relative(root, location),
    depth,
  }
}

