/**
 * Where Lookin.app is, if it is installed.
 *
 * The plugin can write a `.lookin` file whether or not Lookin is installed — the file is a useful
 * artifact on its own — but the action that opens it in Lookin only means something when Lookin is
 * there, and a button that reveals a file in Finder while calling itself "Lookin" would be a lie.
 * So the panel asks this first.
 *
 * Pure lookups over strings and paths, no `fs`, so the decisions can be tested; the host does the
 * stat-ing.
 */

/** The places an app is installed to on macOS, in the order worth checking. */
export function lookinAppCandidates(home) {
  const root = typeof home === 'string' && home !== '' ? home.replace(/\/$/, '') : ''
  const paths = ['/Applications/Lookin.app']
  if (root !== '') paths.push(`${root}/Applications/Lookin.app`)
  return paths
}

/**
 * The first existing path in a candidate list.
 *
 * @param {string[]} candidates
 * @param {(path: string) => boolean} exists
 * @returns {string|null}
 */
export function firstExisting(candidates, exists) {
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      // An unreadable directory is not an installed app; keep looking.
    }
  }
  return null
}

/**
 * The path of a Lookin.app out of `mdfind -name Lookin.app`.
 *
 * Spotlight is the fallback for a Lookin that lives somewhere unusual, and its output is one path
 * per line. `/Applications/Lookin.app` is preferred over a copy in a build directory, because that
 * is the one LaunchServices will start.
 *
 * @param {string} text - stdout of `mdfind -name Lookin.app`.
 * @returns {string|null}
 */
export function parseMdfindLookin(text) {
  const paths = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/Lookin.app') || line === 'Lookin.app')
  if (paths.length === 0) return null
  return paths.find((path) => path === '/Applications/Lookin.app') ?? paths[0]
}
