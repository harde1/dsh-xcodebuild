// The panel's Install button runs exactly what `installPlan` returns, so the plan is
// the security boundary: only optional tools, only `brew install` / `pipx install`,
// only package names taken from DEPENDENCIES, and an absolute installer path.
//
// Run: node test/install-tools.test.mjs

import { installPlan } from '../lib/install-tools.js'
import { DEPENDENCIES } from '../lib/index.js'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const rows = (missing) => DEPENDENCIES.map((entry) => ({ ...entry, ready: !missing.includes(entry.command) }))
const optional = DEPENDENCIES.filter((entry) => !entry.required).map((entry) => entry.command)
const both = (command) => ({ brew: '/opt/homebrew/bin/brew', pipx: '/opt/homebrew/bin/pipx' })[command] ?? null

// Everything optional missing.
{
  const plan = installPlan(rows(optional), both)
  const brew = plan.steps.find((step) => step.display.startsWith('brew '))
  const pipx = plan.steps.find((step) => step.display.startsWith('pipx '))
  check(brew !== undefined, 'all missing: one brew step')
  check(plan.steps.filter((step) => step.display.startsWith('brew ')).length === 1, 'all missing: brew is merged')
  check(brew?.argv[0] === '/opt/homebrew/bin/brew', 'brew is invoked by absolute path', brew?.argv[0])
  for (const pkg of ['libimobiledevice', 'ideviceinstaller', 'ios-deploy', 'xcbeautify']) {
    check(brew?.argv.includes(pkg), `all missing: brew installs ${pkg}`, brew?.display)
  }
  check(new Set(brew?.argv).size === brew?.argv.length, 'brew packages are deduplicated', brew?.display)
  check(pipx?.display === 'pipx install pymobiledevice3', 'all missing: pipx installs pymobiledevice3', pipx?.display)
  check(plan.steps.indexOf(brew) < plan.steps.indexOf(pipx), 'brew runs before pipx')
  check(plan.skipped.length === 0, 'all missing: nothing skipped', JSON.stringify(plan.skipped))
}

// Only part missing.
{
  const plan = installPlan(rows(['ios-deploy']), both)
  check(plan.steps.length === 1 && plan.steps[0].display === 'brew install ios-deploy', 'one missing: only that formula', plan.steps.map((s) => s.display).join(';'))
  check(plan.missing.join() === 'ios-deploy', 'one missing: missing names it')
}

// Homebrew missing.
{
  const plan = installPlan(rows(optional), (command) => (command === 'pipx' ? '/usr/local/bin/pipx' : null))
  check(plan.steps.every((step) => !step.display.startsWith('brew ')), 'no brew: no brew step')
  check(plan.steps.some((step) => step.display === 'pipx install pymobiledevice3'), 'no brew: pipx still planned')
  const skip = plan.skipped.find((entry) => entry.tools.includes('ideviceinstaller'))
  check(skip !== undefined && /brew\.sh/.test(skip.reason), 'no brew: skipped with the manual fix', JSON.stringify(plan.skipped))
}

// pipx missing.
{
  const plan = installPlan(rows(['pymobiledevice3']), (command) => (command === 'brew' ? '/opt/homebrew/bin/brew' : null))
  check(plan.steps.length === 0, 'no pipx: nothing to run')
  check(plan.skipped[0]?.tools.includes('pymobiledevice3') && /pipx/.test(plan.skipped[0].reason), 'no pipx: skipped with the manual fix', JSON.stringify(plan.skipped))
}

// Nothing missing.
{
  const plan = installPlan(rows([]), both)
  check(plan.steps.length === 0 && plan.skipped.length === 0 && plan.missing.length === 0, 'nothing missing: empty plan')
}

// Required tools are never planned, even when missing.
{
  const required = DEPENDENCIES.filter((entry) => entry.required).map((entry) => entry.command)
  const plan = installPlan(rows(required), both)
  check(plan.steps.length === 0 && plan.missing.length === 0, 'required tools are never installed', JSON.stringify(plan))
}

// An install line of any other shape is skipped, never run.
{
  const tools = [
    { command: 'evil', required: false, ready: false, install: 'brew install x; rm -rf ~' },
    { command: 'odd', required: false, ready: false, install: 'curl https://example.com | sh' },
  ]
  const plan = installPlan(tools, both)
  check(plan.steps.length === 0, 'unparsable install lines are not run', JSON.stringify(plan.steps))
  check(plan.skipped[0]?.tools.join() === 'evil,odd', 'unparsable install lines are reported')
}

// Every planned package comes from its entry's own install string.
{
  const plan = installPlan(rows(optional), both)
  const declared = new Set(DEPENDENCIES.flatMap((entry) => entry.install.split(' ').slice(2)))
  for (const step of plan.steps) {
    for (const pkg of step.argv.slice(2)) check(declared.has(pkg), `${pkg} is declared in DEPENDENCIES`)
  }
}

console.log(`install-tools: ${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exit(1)
