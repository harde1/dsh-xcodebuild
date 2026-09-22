// Tests for project discovery.
//
// The fixture reproduces the noise a real iOS checkout actually contains, taken
// from the layout that prompted this: a workspace beside the .xcodeproj it
// wraps, a .xcodeproj bundle holding its own project.xcworkspace, a Pods tree,
// a PodCache, and one genuinely different project nested elsewhere. A picker
// built on a plain recursive scan offers all of it, so each rule is pinned here.
//
// Run: node test/find-projects.test.mjs

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findProjects } from '../lib/projects.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '.fixture-projects')

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
}

function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}

/** Create every named path as a directory, so bundles and their contents exist. */
async function buildTree(root, paths) {
  for (const path of paths) await mkdir(join(root, path), { recursive: true })
}

try {
  await rm(FIXTURE, { recursive: true, force: true })
  await buildTree(FIXTURE, [
    // The project and the workspace that wraps it, side by side.
    'App.xcworkspace',
    'App.xcodeproj',
    // ...and the workspace INSIDE that bundle, which is not a choice.
    'App.xcodeproj/project.xcworkspace',
    // Dependency and cache copies, none of them the user's project.
    'Pods/SomeDep/SomeDep.xcodeproj',
    'Pods/SomeDep/SomeDep.xcworkspace',
    'PodCache/ASpec/ASpec.xcworkspace',
    'Carthage/Checkouts/Lib/Lib.xcodeproj',
    'build/Intermediates/Built.xcodeproj',
    // Tooling state, never a project.
    '.hidden/Hidden.xcodeproj',
    // A project with no sibling workspace — a real, standalone choice.
    'Only/Only.xcodeproj',
    // Within the depth limit...
    'nested/deep/deeper/Very.xcworkspace',
    // ...and one level past it.
    'nested/deep/deeper/more/Too.xcodeproj',
    // Not a project at all.
    'nested/notes.txt',
  ])
  await writeFile(join(FIXTURE, 'Only', 'notes.txt'), 'x')

  console.log('== findProjects ==')
  const result = await findProjects(FIXTURE)
  const relative = result.candidates.map((candidate) => candidate.relative)

  check(relative.includes('App.xcworkspace'), 'the workspace is offered')
  check(!relative.includes('App.xcodeproj'), 'the .xcodeproj wrapped by that workspace is not offered separately')
  check(!relative.includes(join('App.xcodeproj', 'project.xcworkspace')), 'a workspace inside a bundle is never offered')
  check(!relative.some((path) => path.startsWith('Pods/')), 'Pods is not searched')
  check(!relative.some((path) => path.startsWith('PodCache/')), 'PodCache is not searched')
  check(!relative.some((path) => path.startsWith('Carthage/')), 'Carthage is not searched')
  check(!relative.some((path) => path.startsWith('build/')), 'build output is not searched')
  check(!relative.some((path) => path.startsWith('.hidden/')), 'dot-directories are not searched')
  check(relative.includes(join('Only', 'Only.xcodeproj')), 'a standalone .xcodeproj is offered')
  check(relative.includes(join('nested', 'deep', 'deeper', 'Very.xcworkspace')), 'a project within the depth limit is found')
  check(!relative.includes(join('nested', 'deep', 'deeper', 'more', 'Too.xcodeproj')), 'a project past the depth limit is not found')
  check(result.truncated === false, 'a small tree is not reported as truncated')

  // Shallowest first, so the obvious answer leads the picker.
  equal(relative, [
    'App.xcworkspace',
    join('Only', 'Only.xcodeproj'),
    join('nested', 'deep', 'deeper', 'Very.xcworkspace'),
  ], 'candidates are ordered shallowest first')

  const kinds = Object.fromEntries(result.candidates.map((c) => [c.relative, c.kind]))
  equal(kinds['App.xcworkspace'], 'workspace', 'a .xcworkspace is reported as a workspace')
  equal(kinds[join('Only', 'Only.xcodeproj')], 'project', 'a .xcodeproj is reported as a project')
  equal(result.root, FIXTURE, 'the report names the directory that was searched')

  console.log('== naming one project directly ==')
  const named = await findProjects(join(FIXTURE, 'Only', 'Only.xcodeproj'))
  equal(named.candidates.length, 1, 'naming a bundle yields exactly that bundle')
  equal(named.candidates[0].location, join(FIXTURE, 'Only', 'Only.xcodeproj'), 'and it is the one named')
  equal(named.root, join(FIXTURE, 'Only'), 'the root becomes the bundle\'s parent')

  console.log('== refusals ==')
  for (const [input, label] of [
    [join(FIXTURE, 'does-not-exist'), 'a missing directory'],
    [join(FIXTURE, 'Only', 'notes.txt'), 'a file'],
    ['', 'an empty path'],
  ]) {
    let threw = false
    try {
      await findProjects(input)
    } catch {
      threw = true
    }
    check(threw, `${label} is refused`)
  }
} finally {
  await rm(FIXTURE, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('project discovery OK')
