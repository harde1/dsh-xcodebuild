// Tests for folding `xcodebuild -list -json` answers into one listing.
// Run: node test/list-schemes.test.mjs
//
// Both fixtures are real output. The workspace one is the whole reason this
// module exists: `-list -json -workspace X.xcworkspace` answers with
// `{ workspace: { name, schemes } }` and reports NO configurations at all, so a
// workspace asked only once makes every project look like it has nothing but
// Debug and Release. That project also builds `Test-Release`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeListings } from '../lib/listing.js'

const here = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = JSON.parse(readFileSync(join(here, 'fixtures/list-workspace.json'), 'utf8'))
const PROJECT = JSON.parse(readFileSync(join(here, 'fixtures/list-project.json'), 'utf8'))

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (cond) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label,
    `actual: ${JSON.stringify(actual)} expected: ${JSON.stringify(expected)}`)
}

// --------------------------------------------------------------------------
// The shape that caused the bug.
// --------------------------------------------------------------------------

check(WORKSPACE.workspace !== undefined && WORKSPACE.project === undefined,
  'the workspace fixture really is a workspace-only answer')
eq(Object.keys(WORKSPACE), ['workspace'], 'a workspace answer carries nothing but `workspace`')
check(WORKSPACE.workspace.configurations === undefined,
  'a workspace answer carries no configurations — this is the whole problem')

const workspaceAlone = mergeListings(WORKSPACE)
eq(workspaceAlone.name, 'Enshi', 'the workspace name survives')
eq(workspaceAlone.schemes.length, 70, 'every scheme the workspace declares is kept')
eq(workspaceAlone.configurations, [], 'asked once, a workspace yields no configurations')

// --------------------------------------------------------------------------
// Asking the project inside it is what recovers them.
// --------------------------------------------------------------------------

eq(PROJECT.project.configurations, ['Debug', 'Release', 'Test-Release'],
  'the project fixture declares three configurations, not two')

const complete = mergeListings(WORKSPACE, PROJECT)
eq(complete.name, 'Enshi', 'the workspace name still wins over the nested project name')
eq(complete.schemes.length, 70, 'the workspace still supplies the schemes')
eq(complete.configurations, ['Debug', 'Release', 'Test-Release'],
  'the nested project supplies the real configurations')
eq(complete.targets, ['Enshi', 'Tests'], 'and the targets')

// --------------------------------------------------------------------------
// A plain project needs no second question.
// --------------------------------------------------------------------------

const plain = mergeListings(PROJECT)
eq(plain.configurations, ['Debug', 'Release', 'Test-Release'],
  'a project answers with its configurations in a single call')
eq(plain.schemes, PROJECT.project.schemes, 'and with its own schemes')
eq(plain.targets, ['Enshi', 'Tests'], 'and its own targets')

// A nested answer must never displace what the named project already said.
const overridden = mergeListings(PROJECT, { project: { name: 'Other', schemes: ['X'], configurations: ['Nope'], targets: ['Y'] } })
eq(overridden.configurations, ['Debug', 'Release', 'Test-Release'],
  'a direct answer outranks the nested one')
eq(overridden.name, 'Enshi', 'and the nested answer cannot rename it either')
eq(mergeListings({ workspace: { schemes: ['S'] } }).name, '',
  'an answer that never names anything falls back to empty, for the caller to fill in')

// --------------------------------------------------------------------------
// Degenerate answers must not throw.
// --------------------------------------------------------------------------

eq(mergeListings({}), { name: '', schemes: [], configurations: [], targets: [] },
  'an empty answer yields an empty listing rather than throwing')
eq(mergeListings(null), { name: '', schemes: [], configurations: [], targets: [] },
  'a missing answer yields an empty listing rather than throwing')
eq(mergeListings({ workspace: {} }, { project: { configurations: ['Release'] } }).configurations, ['Release'],
  'a nested answer is read when the outer one is silent')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('listing merge OK')
