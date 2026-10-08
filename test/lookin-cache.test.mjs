// Tests for the view-tree history: names, retention, rows, batches and progress.
//
// The delete route takes a name from the panel, so `isArchiveName` is a security boundary and is
// tested as one — every shape that could step outside the cache directory must be refused.
//
// Run: node test/lookin-cache.test.mjs
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
} from '../lib/lookin-cache.js'

let failures = 0
let checks = 0
function eq(actual, expected, label) {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1
    console.error(`FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

eq(LOOKIN_KEEP, 3, 'the newest three are kept, as the user chose')
eq(archiveNameFor('2026-10-08T10-30-00', 'full'), 'lookin-2026-10-08T10-30-00-full.lookin', 'a full export says so in its name')
eq(archiveNameFor('2026-10-08T10-30-00', 'anything'), 'lookin-2026-10-08T10-30-00-quick.lookin', 'anything else is a quick one')
eq(metaNameFor('lookin-2026-10-08T10-30-00-full.lookin'), 'lookin-2026-10-08T10-30-00-full.lookin.json', 'metadata sits beside its archive')

// The boundary: only names this cache writes may be opened or deleted.
eq(isArchiveName('lookin-2026-10-08T10-30-00-full.lookin'), true, 'a written name is accepted')
eq(isArchiveName('lookin-2026-10-08T10-30-00.lookin'), true, 'and so is an export from before kinds were named')
for (const bad of ['../lookin-2026-10-08T10-30-00-full.lookin', 'lookin-x/../../etc.lookin', '/tmp/lookin-1.lookin',
  'lookin-2026.lookin.json', 'Lookin-2026-10-08T10-30-00.lookin', '', null, 42, 'lookin-2026-10-08T10-30-00-full.lookin\n']) {
  eq(isArchiveName(bad), false, `refused: ${JSON.stringify(bad)}`)
}

// Retention.
const names = [
  'lookin-2026-10-08T10-00-00-quick.lookin',
  'lookin-2026-10-08T09-00-00-full.lookin',
  'lookin-2026-10-08T11-00-00-full.lookin',
  'lookin-2026-10-08T12-00-00-quick.lookin',
  'lookin-2026-10-08T12-00-00-quick.lookin.json',
  'shots-2026',
]
eq(staleArchives(names), ['lookin-2026-10-08T09-00-00-full.lookin'], 'the oldest goes when there are four, whatever its kind')
eq(staleArchives(names.slice(0, 2)), [], 'nothing goes while there are three or fewer')
eq(staleArchives(names, 1).length, 3, 'keep is a parameter, not a constant baked in')

// Rows.
const row = historyEntry('lookin-2026-10-08T10-30-05-full.lookin', 2048, { kind: 'full', app: '蜜语-Dev', views: 412, images: 398, created: '2026-10-08T10:30:05.000Z' })
eq(row, { name: 'lookin-2026-10-08T10-30-05-full.lookin', kind: 'full', app: '蜜语-Dev', views: 412, images: 398, created: '2026-10-08T10:30:05.000Z', bytes: 2048 }, 'a row carries what the metadata says')
const bare = historyEntry('lookin-2026-10-08T10-30-05-quick.lookin', 10, null)
eq([bare.kind, bare.app, bare.views, bare.created], ['quick', '', 0, '2026-10-08T10:30:05Z'], 'a lost metadata file still yields a row, from the name')
eq(sortHistory([{ name: 'lookin-a' }, { name: 'lookin-c' }, { name: 'lookin-b' }]).map((entry) => entry.name), ['lookin-c', 'lookin-b', 'lookin-a'], 'newest first')

// Batches.
eq(renderBatches(5, 2), [{ start: 0, limit: 2 }, { start: 2, limit: 2 }, { start: 4, limit: 1 }], 'the last batch is the remainder')
eq(renderBatches(0, 40), [], 'nothing to render is no batches')
eq(renderBatches(3, 0), [{ start: 0, limit: 1 }, { start: 1, limit: 1 }, { start: 2, limit: 1 }], 'a nonsense size still walks everything')

// Progress.
eq(jobPercent({ stage: 'attaching' }), 2, 'attaching shows as started')
eq(jobPercent({ stage: 'rendering', done: 0, total: 100 }), 8, 'rendering begins after the read')
eq(jobPercent({ stage: 'rendering', done: 50, total: 100 }), 43, 'and moves with the views rendered')
eq(jobPercent({ stage: 'rendering', done: 500, total: 100 }), 78, 'and never past its share')
eq(jobPercent({ stage: 'copying' }), 80, 'copying follows')
eq(jobPercent({ stage: 'done' }), 100, 'done is full')
eq(jobPercent({ stage: 'cancelled' }), 0, 'anything else is not progress')

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
console.log('lookin cache OK')
