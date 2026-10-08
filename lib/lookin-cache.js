/**
 * The view trees this plugin has read, kept so they can be opened again.
 *
 * An export used to live in the system temp directory and was known only as "the last one": a
 * restart of the host lost it, and a tree read an hour ago — before the bug was fixed, say — could
 * not be put beside the one read now. Each export is now a `.lookin` file with a `.json` beside it
 * that says what it is (which app, how many views, whether the images were rendered), so a history
 * can be listed without opening a single archive.
 *
 * Only the newest few are kept. A full export of a real app is megabytes of PNG, and the point of
 * the history is "the last few reads", not an archive nobody prunes.
 *
 * Everything here is pure or takes the filesystem functions it needs, so the rules — what is kept,
 * what a name may be, what a listing says — are tested without a device.
 */

/** How many exports are kept. The user's choice: enough to compare, never a disk problem. */
export const LOOKIN_KEEP = 3

/** The name an export's metadata goes under: the archive's own name with `.json` after it. */
export function metaNameFor(archive) {
  return `${String(archive)}.json`
}

/**
 * Whether a name is one of this cache's archives — and therefore safe to open or delete.
 *
 * The panel sends a name back to delete, so this is the boundary: a name with a separator, a
 * parent reference, or any other shape than the one `lookinArchiveName` writes is refused, which
 * keeps a delete inside this directory whatever the request says.
 */
export function isArchiveName(name) {
  return typeof name === 'string' && /^lookin-[0-9T-]+(?:-full|-quick)?\.lookin$/.test(name)
}

/** The archive name for one export; the kind is in the name so a listing sorts and reads alike. */
export function archiveNameFor(stamp, kind) {
  return `lookin-${String(stamp)}-${kind === 'full' ? 'full' : 'quick'}.lookin`
}

/**
 * Which archives to delete so that at most `keep` remain, oldest first.
 *
 * Names carry their timestamp first, so sorting them is sorting by time; the kind suffix comes
 * after the stamp and cannot reorder two exports made at different moments.
 */
export function staleArchives(names, keep = LOOKIN_KEEP) {
  const archives = names.filter(isArchiveName).sort()
  return archives.slice(0, Math.max(0, archives.length - keep))
}

/**
 * One history row, from an archive's name, its size, and the metadata written beside it.
 *
 * A missing or unreadable `.json` still yields a row — the archive is the thing worth opening, and
 * a tree whose description was lost is still a tree — with what the name alone can say.
 *
 * @param {string} name - the archive's file name.
 * @param {number} bytes - its size.
 * @param {object|null} meta - the parsed metadata, or null.
 * @returns {{name: string, kind: string, app: string, views: number, images: number, created: string, bytes: number}}
 */
export function historyEntry(name, bytes, meta) {
  const kind = /-full\.lookin$/.test(name) ? 'full' : 'quick'
  const stamp = /^lookin-([0-9T-]+?)(?:-full|-quick)?\.lookin$/.exec(name)?.[1] ?? ''
  const fromStamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(stamp)
  const created = typeof meta?.created === 'string' && meta.created !== ''
    ? meta.created
    : (fromStamp === null ? '' : `${fromStamp[1]}T${fromStamp[2]}:${fromStamp[3]}:${fromStamp[4]}Z`)
  return {
    name,
    kind: meta?.kind === 'full' || meta?.kind === 'quick' ? meta.kind : kind,
    app: typeof meta?.app === 'string' ? meta.app : '',
    views: Number.isFinite(meta?.views) ? meta.views : 0,
    images: Number.isFinite(meta?.images) ? meta.images : 0,
    created,
    bytes: Number.isFinite(bytes) ? bytes : 0,
  }
}

/** Newest first: the read just made is the one most likely to be opened. */
export function sortHistory(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

/**
 * The batches a full export renders, as `[start, limit]` pairs over the walk.
 *
 * @param {number} total - views in the walk.
 * @param {number} size - views per batch.
 * @returns {Array<{start: number, limit: number}>}
 */
export function renderBatches(total, size) {
  const count = Number.isInteger(total) && total > 0 ? total : 0
  const step = Number.isInteger(size) && size > 0 ? size : 1
  const out = []
  for (let start = 0; start < count; start += step) out.push({ start, limit: Math.min(step, count - start) })
  return out
}

/**
 * A full export's progress, as one number the panel can draw and one sentence it can show.
 *
 * The stages weigh what they cost: rendering is most of the wait, copying the PNGs off a device is
 * most of the rest, and writing the archive is quick. A bar that sat at 10% through every render and
 * jumped to 90% would be honest about stages and useless about time.
 *
 * @param {{stage: string, done?: number, total?: number}} job
 * @returns {number} 0–100.
 */
export function jobPercent(job) {
  const stage = String(job?.stage ?? '')
  const total = Number.isFinite(job?.total) && job.total > 0 ? job.total : 0
  const done = Number.isFinite(job?.done) && job.done > 0 ? Math.min(job.done, total) : 0
  const share = total === 0 ? 0 : done / total
  if (stage === 'attaching') return 2
  if (stage === 'reading') return 5
  if (stage === 'rendering') return Math.round(8 + share * 70)
  if (stage === 'copying') return 80
  if (stage === 'writing') return 92
  if (stage === 'opening' || stage === 'done') return 100
  return 0
}
