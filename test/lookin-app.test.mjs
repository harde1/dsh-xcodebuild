// Whether Lookin.app is installed decides which button the panel offers, so the lookup has to be
// right about the ordinary case and honest about the rest.
import { firstExisting, lookinAppCandidates, parseMdfindLookin } from '../lib/lookin-app.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`)
  }
}
const eq = (actual, expected, label) => check(actual === expected, label, JSON.stringify(actual))

section('the places an install lives')
eq(lookinAppCandidates('/Users/mac')[0], '/Applications/Lookin.app', 'the system Applications folder comes first')
eq(lookinAppCandidates('/Users/mac')[1], '/Users/mac/Applications/Lookin.app', 'then the user one')
eq(lookinAppCandidates('').length, 1, 'and with no home directory only the system one')
eq(lookinAppCandidates('/Users/mac/')[1], '/Users/mac/Applications/Lookin.app', 'a trailing slash does not double up')

section('the first candidate that exists wins')
eq(firstExisting(['/a/Lookin.app', '/b/Lookin.app'], (path) => path === '/b/Lookin.app'), '/b/Lookin.app', 'a later candidate is still found')
eq(firstExisting(['/a/Lookin.app'], () => false), null, 'nothing installed is null, not a guess')
eq(firstExisting(['/a/Lookin.app'], () => { throw new Error('permission denied') }), null, 'an unreadable path is not an install')
eq(firstExisting(['/a/Lookin.app', '/b/Lookin.app'], (path) => path === '/a/Lookin.app'), '/a/Lookin.app', 'and the earliest one wins')

section('Spotlight is the fallback for a Lookin somewhere unusual')
eq(parseMdfindLookin('/Applications/Lookin.app\n'), '/Applications/Lookin.app', 'the plain answer')
eq(
  parseMdfindLookin('/Users/mac/Build/DerivedData/Lookin.app\n/Applications/Lookin.app\n'),
  '/Applications/Lookin.app',
  'the installed copy is preferred over one in a build directory',
)
eq(parseMdfindLookin(''), null, 'no results is null')
eq(parseMdfindLookin('/Users/mac/Documents/notes.txt\n'), null, 'and a file that merely mentions Lookin is not an app')
eq(parseMdfindLookin('/Users/mac/Apps/Lookin.app'), '/Users/mac/Apps/Lookin.app', 'a single unusual location is still accepted')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('lookin app OK')
