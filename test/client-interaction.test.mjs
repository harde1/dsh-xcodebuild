// Interaction tests for the browser half, in a real DOM.
//
// Two kinds of bug live here, and both have history:
//
// 1. The store's `emit` used to drain its subscriber list. Subscribers register
//    from a `useEffect(..., [])`, so they are added once and never re-added;
//    draining made the FIRST emit the last one that reached anybody. The
//    panel's mount-time `refreshState()` emits as soon as the host answers, so
//    by the time a user clicked anything every component was permanently deaf —
//    "click Xcode does nothing, and the close button does nothing either".
//
// 2. The panel has to work in two seats: as a better-sidebar tab and as the
//    floating overlay used when that service is absent. Only one of those can be
//    exercised by looking at the code.
//
// Run: node test/client-interaction.test.mjs

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules'
const ROUTE_PREFIX = '/_dsh/dsh-xcodebuild/'
const TAB_ID = 'dsh-xcodebuild'

const { JSDOM } = require(join(APP, 'jsdom'))
const React = require(join(APP, 'react'))
const { createRoot } = require(join(APP, 'react-dom/client'))
const act = React.act ?? require(join(APP, 'react-dom/test-utils')).act

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual: ${JSON.stringify(actual)} expected: ${JSON.stringify(expected)}`,
  )
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

// --- a DOM for the client half to attach to -------------------------------

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:43129/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Answer the panel's routes from a handler map, and record what it asked for. */
function serve(handlers) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    const method = Object.keys(handlers).find((name) => path.endsWith(`${ROUTE_PREFIX}${name}`))
      ?? path.slice(path.lastIndexOf('/') + 1)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    const handler = handlers[method]
    if (handler === undefined) {
      return { ok: false, status: 404, async text() { return JSON.stringify({ message: `no route ${method}` }) } }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify(handler(body)) } }
  }
  return calls
}

// --- load the shipped bundle through the real module-loader shape ---------

let loaded = null
dom.window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
globalThis.window.__ModuleLoader__ = dom.window.__ModuleLoader__

await import(join(ROOT, 'lib/client.js'))

section('bundle')
check(loaded !== null, 'the bundle registers itself with __ModuleLoader__')
equal(loaded?.id, 'dsh-xcodebuild', 'the module id matches the package name')

const client = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`the client bundle required an unexpected module: ${id}`)
})
equal(client.inject, ['slots'], 'only slots is a hard dependency, so a missing dock cannot park the plugin')

/**
 * Mount one instance of the plugin against a fake context.
 *
 * `dock` supplies the better-sidebar service when given; omitting it is the
 * shell-without-better-sidebar case that the overlay exists for.
 */
function mount({ dock } = {}) {
  const components = new Map()
  const seats = []
  const effects = []
  const registered = []
  const opened = []
  let dockListener = null

  const service = dock
    ? {
        registerTab(descriptor) {
          registered.push(descriptor)
          return () => {}
        },
        openTab(seed, scope) { opened.push({ seed, scope }) },
        subscribeState(listener) { dockListener = listener; return () => { dockListener = null } },
        getSnapshot: () => dock.snapshot ?? { sessionId: 's1', state: undefined },
      }
    : undefined

  const ctx = {
    slots: {
      inject(slotName, register) {
        seats.push(slotName)
        register()
      },
      register(spec, component) {
        components.set(spec.id, { spec, component })
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
    inject(services, callback) {
      if (service === undefined) return
      callback({
        betterSidebar: service,
        effect: (cb) => { const dispose = cb(); return typeof dispose === 'function' ? dispose : () => {} },
      })
    },
  }

  client.apply(ctx)

  return {
    components,
    seats,
    registered,
    opened,
    notifyDock: () => { if (dockListener !== null) dockListener() },
  }
}

/** Render components into a fresh container and return it. */
async function render(children) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(React.Fragment, null, children))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { container, root }
}

/** React keeps its props on the node; reach a handler without DOM event plumbing. */
function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  if (key === undefined) throw new Error('React stored no props on this node')
  return node[key]
}

// =========================================================================
// The shell has better-sidebar: the dock owns the panel.
// =========================================================================

section('with better-sidebar')
{
  const instance = mount({ dock: {} })
  const panel = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')

  equal(instance.seats, ['shell.overlay', 'conversation.session.header.utilities'],
    'the overlay fallback and the header button are still registered')
  check(panel !== undefined && toggle !== undefined, 'both seats filled')

  equal(instance.registered.length, 1, 'exactly one tab type is contributed')
  const descriptor = instance.registered[0]
  equal(descriptor.id, TAB_ID, 'the tab id matches the type the button opens')
  equal(descriptor.single, true, 'the tab is single-instance, so opening focuses rather than duplicates')
  check(typeof descriptor.component === 'function', 'the descriptor renders the panel itself')
  check(typeof descriptor.title === 'string' || typeof descriptor.title === 'function', 'the descriptor is titled')
  check(typeof descriptor.description === 'string', 'the descriptor describes itself for the new-tab list')

  // Polling has to outlive the panel being closed, so it belongs to the overlay
  // entry, which is always mounted, and not to the panel.
  check(panel !== undefined, 'the overlay entry stays mounted even while the dock owns the UI')

  const { container } = await render([
    React.createElement(toggle.component, { key: 'toggle' }),
    React.createElement(descriptor.component, { key: 'tab' }),
  ])

  const dockedPanel = container.querySelector('.xcb-panel')
  check(dockedPanel !== null, 'the docked panel renders')
  check(dockedPanel?.className.includes('docked') === true, 'the docked panel uses the filling layout, not the floating one')
  check(container.querySelector('.xcb-head') === null, 'the docked panel draws no head row: the tab strip already closes it')
  // The dock owns the panel, so the fixed header entry is gone: better-sidebar
  // offers the tab through its own add affordance, and a second permanent button
  // beside the session title would only be clutter.
  check(container.querySelector('.xcb-trigger') === null,
    'no fixed header button while the dock can host the panel')

  section('the fixed header entry is gone, not merely hidden')
  check(instance.seats.includes('conversation.session.header.utilities'),
    'the seat stays registered, for a shell with no dock to add the tab from')

  const lit = mount({
    dock: {
      snapshot: {
        sessionId: 's1',
        state: { root: { kind: 'leaf', id: 'p1', tabs: [{ id: 't1', type: TAB_ID, title: 'XcBuild' }], active: 't1' } },
      },
    },
  })
  const litToggle = lit.components.get('dsh-xcodebuild-toggle')
  const litRender = await render([React.createElement(litToggle.component, { key: 't', sessionId: 'sess-42' })])
  check(litRender.container.querySelector('.xcb-trigger') === null,
    'not even with a session, and with this tab already showing, does a button appear')
}

// =========================================================================
// The shell has no better-sidebar: the overlay is the surface.
// =========================================================================

section('without better-sidebar')
{
  const calls = serve({
    state: () => ({ workspace: '/Users/mac/Project/Gemoy', activeRunId: null, runs: [] }),
    projects: () => ({
      root: '/Users/mac/Project/Gemoy',
      truncated: false,
      candidates: [
        { kind: 'workspace', name: 'Gemoy', location: '/Users/mac/Project/Gemoy/Gemoy.xcworkspace', relative: 'Gemoy.xcworkspace', depth: 0 },
        { kind: 'workspace', name: 'YNLive', location: '/Users/mac/Project/Gemoy/OtherProject/YNLive/YNLive.xcworkspace', relative: 'OtherProject/YNLive/YNLive.xcworkspace', depth: 2 },
      ],
    }),
    detect: (body) => ({
      kind: 'workspace',
      root: '/Users/mac/Project/Gemoy',
      location: body.path,
      name: 'Gemoy',
      schemes: ['Gemoy'],
      configurations: ['Debug', 'Release'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  equal(instance.registered.length, 0, 'no tab type is contributed without the service')
  equal(instance.seats, ['shell.overlay', 'conversation.session.header.utilities'], 'both fallback seats are filled')

  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle' }),
  ])

  check(calls.some((call) => call.method === 'state'), 'the header button read state, so the panel opens onto known facts')
  check(container.querySelector('.xcb-panel') === null, 'the panel starts closed')

  section('click "Xcode"')
  const button = container.querySelector('.xcb-trigger')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  check(container.querySelector('.xcb-panel') !== null, 'the panel opens on the first click')
  check(button.className.includes('on') === true, 'the toggle shows its open state')

  section('click close')
  const close = container.querySelector('.xcb-head .xcb-btn')
  check(close !== null, 'the floating panel draws its own close button')
  await act(async () => {
    close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  check(container.querySelector('.xcb-panel') === null, 'the panel closes')

  section('reopen — a second toggle must still be heard')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  check(container.querySelector('.xcb-panel') !== null, 'the panel reopens on a later click')

  section('one project is selected outright')
  const path = container.querySelector('.xcb-input.path')
  check(path !== null, 'the path field rendered')
  const single = serve({
    state: () => ({ workspace: '/Users/mac/Project/Gemoy', activeRunId: null, runs: [] }),
    projects: (body) => ({
      root: body.path,
      truncated: false,
      candidates: [{ kind: 'workspace', name: 'Solo', location: `${body.path}/Solo.xcworkspace`, relative: 'Solo.xcworkspace', depth: 0 }],
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'Solo', schemes: ['Solo'], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })
  // Typing and clicking away are two separate events, and each gets its own
  // commit. Batching them into one act would let onBlur run against the props of
  // the previous render, i.e. the string the user had not typed yet.
  await act(async () => {
    propsOf(path).onChange({ target: { value: '/tmp/only' } })
  })
  await act(async () => {
    propsOf(path).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(single.some((call) => call.method === 'projects'), 'blurring the path searches the directory')
  check(single.some((call) => call.method === 'detect'), 'a single hit is adopted without asking')
  equal(single.filter((call) => call.method === 'detect').map((call) => call.body.path),
    ['/tmp/only/Solo.xcworkspace'], 'the hit is the project that was adopted')
  check(container.querySelector('.xcb-picker') === null, 'no picker is shown for one hit')

  section('several projects are offered as a choice')
  // The single-hit scenario above swapped the transport for its own; put the
  // two-candidate directory back before asking for a choice.
  const multi = serve({
    state: () => ({ workspace: '/Users/mac/Project/Gemoy', activeRunId: null, runs: [] }),
    projects: () => ({
      root: '/Users/mac/Project/Gemoy',
      truncated: false,
      candidates: [
        { kind: 'workspace', name: 'Gemoy', location: '/Users/mac/Project/Gemoy/Gemoy.xcworkspace', relative: 'Gemoy.xcworkspace', depth: 0 },
        { kind: 'workspace', name: 'YNLive', location: '/Users/mac/Project/Gemoy/OtherProject/YNLive/YNLive.xcworkspace', relative: 'OtherProject/YNLive/YNLive.xcworkspace', depth: 2 },
      ],
    }),
    detect: (body) => ({
      kind: 'workspace',
      root: '/Users/mac/Project/Gemoy',
      location: body.path,
      name: 'Gemoy',
      schemes: ['Gemoy'],
      configurations: ['Debug', 'Release'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [] }),
  })
  await act(async () => {
    propsOf(path).onChange({ target: { value: '/Users/mac/Project/Gemoy' } })
  })
  await act(async () => {
    propsOf(path).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const picker = container.querySelector('.xcb-picker')
  check(picker !== null, 'a picker appears when the search finds more than one project')
  equal(container.querySelectorAll('.xcb-candidate').length, 2, 'every candidate is offered')
  equal(multi.filter((call) => call.method === 'detect').length, 0, 'nothing is adopted while the choice is open')

  const candidates = container.querySelectorAll('.xcb-candidate')
  if (candidates.length === 0) throw new Error('no candidates to pick from; the rest of this section cannot run')
  equal(Array.from(candidates).map((node) => node.querySelector('.xcb-candidate-name')?.textContent), ['Gemoy', 'YNLive'],
    'candidates lead with the project name')
  equal(Array.from(candidates).map((node) => node.querySelector('.xcb-candidate-path')?.textContent),
    ['Gemoy.xcworkspace', 'OtherProject/YNLive/YNLive.xcworkspace'], 'and show where each sits, so the choice is informed')

  section('picking one adopts it')
  const before = multi.filter((call) => call.method === 'detect').length
  await act(async () => {
    candidates[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const adopted = multi.filter((call) => call.method === 'detect').slice(before).map((call) => call.body.path)
  equal(adopted, ['/Users/mac/Project/Gemoy/OtherProject/YNLive/YNLive.xcworkspace'], 'the clicked project is the one adopted')
  check(container.querySelector('.xcb-picker') === null, 'the picker closes once a project is chosen')

  section('and it can be changed again')
  const change = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Change')
  check(change !== undefined, 'a chosen project offers a way to change it')
  await act(async () => {
    change.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  check(container.querySelector('.xcb-picker') !== null, 'changing brings the choice back')

  section('filter commits on blur, not on each keystroke')
  const filterInput = container.querySelector('.xcb-input.filter')
  check(filterInput !== null, 'the filter field rendered')
  const searchesBefore = multi.filter((call) => call.method === 'search').length
  await act(async () => {
    propsOf(filterInput).onChange({ target: { value: 'warning:' } })
  })
  check(filterInput.value === 'warning:', 'the field shows what was typed', filterInput.value)
  check(filterInput.className.includes('pending'), 'an uncommitted filter is shown as pending')
  equal(multi.filter((call) => call.method === 'search').length, searchesBefore, 'typing issues no search request of its own')
  await act(async () => {
    propsOf(filterInput).onBlur()
  })
  check(filterInput.className.includes('pending') === false, 'blurring commits the filter')
}

// =========================================================================
// The session names the workspace; the project names its configurations.
// =========================================================================

section('the session names the workspace')
{
  // Earlier sections stored a project to remember; this one is about what the
  // panel offers with nothing remembered.
  dom.window.localStorage.clear()

  const calls = serve({
    state: () => ({ workspace: '/Users/mac/Project/workSpace/Enshi', activeRunId: null, runs: [] }),
    projects: () => ({ root: '/Users/mac/Project/workSpace/Enshi', truncated: false, candidates: [] }),
    detect: (body) => ({
      kind: 'workspace',
      root: '/Users/mac/Project/workSpace/Enshi',
      location: body.path,
      name: 'Enshi',
      schemes: ['Enshi'],
      configurations: ['Debug', 'Release', 'Test-Release'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-abc' }),
  ])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

  // The panel only draws once it is open.
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  const stateCalls = calls.filter((call) => call.method === 'state')
  check(stateCalls.length > 0, 'the panel read state')
  check(stateCalls.every((call) => call.body.sessionId === 'session-abc'),
    'every state read names the session the panel is rendered for')

  // The workspace only arrives with the first answer, so the field has to fill
  // in afterwards rather than stay blank.
  const path = container.querySelector('.xcb-input.path')
  equal(path.value, '/Users/mac/Project/workSpace/Enshi',
    'the path field offers the session workspace, not the harness directory')
}

section("the project names its configurations")
{
  dom.window.localStorage.clear()

  serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    projects: (body) => ({
      root: body.path,
      truncated: false,
      candidates: [{ kind: 'workspace', name: 'Enshi', location: `${body.path}/Enshi.xcworkspace`, relative: 'Enshi.xcworkspace', depth: 0 }],
    }),
    detect: (body) => ({
      kind: 'workspace',
      root: '/tmp',
      location: body.path,
      name: 'Enshi',
      schemes: ['Enshi'],
      configurations: ['Debug', 'Release', 'Test-Release'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle' }),
  ])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

  // Open the panel, then adopt the project through the path field.
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const path = container.querySelector('.xcb-input.path')
  await act(async () => { propsOf(path).onChange({ target: { value: '/tmp/Enshi' } }) })
  await act(async () => {
    propsOf(path).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  const select = Array.from(container.querySelectorAll('select'))
    .find((node) => Array.from(node.options).some((option) => option.value === 'Test-Release'))
  check(select !== undefined, "a third configuration from the project reaches the picker")
  equal(Array.from(select?.options ?? []).map((option) => option.value), ['Debug', 'Release', 'Test-Release'],
    'every configuration the project declares is offered, in its own order')
}

// =========================================================================
// The log follows the tail, and stops when the reader leaves the bottom.
// =========================================================================

/**
 * Give an element geometry jsdom does not compute.
 *
 * Without layout every scroll metric is 0, so a scroll decision made against a
 * real element would be untestable in either direction.
 */
function fakeScrollMetrics(element, { height, view }) {
  const box = { top: 0 }
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => view })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => box.top,
    set: (value) => { box.top = value },
  })
  return box
}

section('the log follows the tail')
{
  serve({
    state: () => ({ workspace: '/tmp', activeRunId: 'run-1', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: [{ n: body.from, k: 'plain', t: `line ${body.from}` }],
      next: body.from + 1,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    // A session, as the real header always supplies: it is what makes the
    // panel read state immediately instead of waiting for the first poll.
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-log' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  // The overlay polls on a timer, so a line only lands after one interval.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const log = container.querySelector('.xcb-log')
  check(log !== null, 'the log renders once a run has produced a line')
  if (log === null) throw new Error('no log element; the rest of this section cannot run')

  const box = fakeScrollMetrics(log, { height: 1000, view: 200 })

  // A reader who scrolls up and lets go is reading; the view must stay put.
  box.top = 100
  await act(async () => { propsOf(log).onScroll({ currentTarget: log }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(box.top, 100, 'scrolling away from the bottom stops the log following the tail')

  // Parked above the tail, the panel offers the way back in one click. Dragging a
  // scrollbar to the end just to resume watching is what this saves.
  const parked = container.querySelector('.xcb-jump')
  check(parked !== null, 'a jump-to-latest button appears once the view is parked above the tail')
  check(parked !== null && /new/.test(parked.textContent) === true,
    'and it says how much has arrived since, so clicking is an informed choice',
    parked === null ? 'no button' : parked.textContent)

  // Returning to the bottom and letting go is a request to follow again.
  box.top = 800
  await act(async () => { propsOf(log).onScroll({ currentTarget: log }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(box.top, 1000, 'reaching the bottom resumes following')
  check(container.querySelector('.xcb-jump') === null,
    'and the button goes away once the tail is being followed again')

  // Just shy of the end is still reading, not a request to follow.
  box.top = 700
  await act(async () => { propsOf(log).onScroll({ currentTarget: log }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(box.top, 700, 'a line short of the bottom does not re-arm following')

  // One click is the whole point: the newest output on screen, and following again.
  const button = container.querySelector('.xcb-jump')
  check(button !== null, 'the button is still offered while parked a line short of the end')
  if (button === null) throw new Error('no jump button; its click cannot be exercised')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(box.top, 1000, 'clicking it scrolls to the newest output')
  check(container.querySelector('.xcb-jump') === null,
    'and re-arms following, so the button is gone again')
}

// =========================================================================
// Clear empties the output. The filter has its own clear, and it is not this.
// =========================================================================

section('clear empties the output log, not the filter')
{
  const calls = serve({
    state: () => ({ workspace: '/tmp', activeRunId: 'run-1', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: [{ n: body.from, k: 'plain', t: `line ${body.from}` }],
      next: body.from + 1,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
    // A real host stops returning anything before the baseline it was given.
    search: (body) => ({
      runId: 'run-1',
      status: 'running',
      totalLines: 3,
      returned: body.since > 0 ? 0 : 1,
      lines: body.since > 0 ? [] : [{ n: 1, k: 'plain', t: 'line 1' }],
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-clear' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  // Commit a filter, so the rows come from the host's search rather than the
  // local buffer — the case where emptying the buffer alone would do nothing.
  const filter = container.querySelector('.xcb-input.filter')
  await act(async () => { propsOf(filter).onChange({ target: { value: 'line' } }) })
  await act(async () => {
    propsOf(filter).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 700))
  })
  check(container.querySelectorAll('.xcb-line').length > 0,
    'the committed filter is showing matching lines to begin with')

  const clear = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Clear')
  check(clear !== undefined, 'there is a Clear button')
  await act(async () => { propsOf(clear).onClick() })

  equal(container.querySelectorAll('.xcb-line').length, 0, 'Clear empties the output')
  equal(filter.value, 'line', "Clear leaves the filter text alone — clearing that is Esc's job")

  // And it stays empty: the host is told to ignore everything before the clear,
  // or the next search would pull the discarded lines straight back.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(container.querySelectorAll('.xcb-line').length, 0, 'the filter does not refill with the discarded lines')
  check(calls.filter((call) => call.method === 'search').some((call) => call.body.since > 0),
    'the filter query carries the clear baseline to the host')
}

// =========================================================================
// A panel belongs to one workspace. It must not show another's build.
// =========================================================================

section('one workspace never shows another\'s build')
{
  serve({
    state: (body) => (body.sessionId === 'sess-a'
      ? { workspace: '/project/a', activeRunId: 'run-a', runs: [] }
      : { workspace: '/project/b', activeRunId: null, runs: [] }),
    poll: () => ({
      missing: false,
      lines: [{ n: 1, k: 'plain', t: 'built in project A' }],
      next: 2,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const seat = (session) => React.createElement(toggle.component, { key: 't', sessionId: session })
  const { container, root } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    seat('sess-a'),
  ])

  const open = async () => {
    const trigger = container.querySelector('.xcb-trigger')
    if (trigger !== null) {
      await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    }
  }
  // Assert on WHICH log is showing, never on how many lines the timer happened
  // to deliver: the poll interval makes an exact count a race.
  const shownText = () => Array.from(container.querySelectorAll('.xcb-line'))
    .map((node) => node.textContent).join('\n')

  await open()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  check(shownText().includes('built in project A'), 'project A shows its own running build')

  // The same panel, now rendered for a session in another workspace.
  await act(async () => {
    root.render([React.createElement(overlay.component, { key: 'overlay' }), seat('sess-b')])
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  check(!shownText().includes('built in project A'), "project B does not inherit project A's log")
  equal(container.querySelector('.xcb-panel'), null, "project B's panel starts closed, as its own store says")

  await open()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  equal(shownText(), '', 'opened for project B, the panel is still empty: B has no running build')

  // Coming back finds A exactly as it was left, which is what "remembered per
  // workspace" means — and proves the isolation is a split, not a wipe.
  await act(async () => {
    root.render([React.createElement(overlay.component, { key: 'overlay' }), seat('sess-a')])
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  check(shownText().includes('built in project A'), 'project A still has its own log on return')
}

// =========================================================================
// Reading the log is not the UI's job. Unmounting every surface must not stop it.
// =========================================================================

section('the log keeps being read with no surface mounted')
{
  const calls = serve({
    // A run already in flight: the panel adopts it on mount and starts reading.
    state: () => ({ workspace: '/tmp', activeRunId: 'run-live', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: [{ n: body.from, k: 'plain', t: `live ${body.from}` }],
      next: body.from + 1,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({ dock: {} })
  const descriptor = instance.registered[0]
  const { root } = await render([
    React.createElement(descriptor.component, { key: 'tab', scope: { sessionId: 'sess-live' } }),
  ])

  const pollCount = () => calls.filter((call) => call.method === 'poll').length

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)) })
  check(pollCount() >= 1, 'a surface that adopts the session reads the running build')

  // The whole point: polling belongs to the plugin, not to whichever component
  // happens to be on screen. A log that only moves while some slot is mounted is
  // a log that freezes the moment the user closes the panel they were watching.
  const before = pollCount()
  await act(async () => { root.unmount() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1300)) })

  check(pollCount() > before,
    `the log is still read once every surface unmounts (${String(before)} -> ${String(pollCount())})`)
}

section('the run button says it builds first')
{
  serve({ state: () => ({ workspace: '/tmp', activeRunId: null, runs: [], revision: '2026-09-22T12:34:11Z' }) })
  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-run-label' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  // The profile mounts the host half once at boot, so a stale process looks exactly
  // like a broken fix. The panel has to be able to say which revision it reached.
  const rev = container.querySelector('.xcb-rev')
  check(rev !== null, 'the panel shows the host revision it is talking to')
  check(rev !== null && rev.textContent === 'rev 2026-09-22T12:34:11Z',
    'and it is the revision the host reported', rev === null ? 'no .xcb-rev' : rev.textContent)

  const buttons = Array.from(container.querySelectorAll('.xcb-btn'))
  const run = buttons.find((node) => node.textContent.includes('Run'))
  check(run !== undefined, 'a run button is offered')
  // `run` is a build followed by an install and a launch. A button reading only
  // "Run" hides the build — the expensive half, and the one that fills the log.
  check(run.textContent === 'Build & Run',
    'the run button names the build it performs', run.textContent)
  check(String(propsOf(run).title).toLowerCase().includes('build'),
    'and its tooltip says so as well', String(propsOf(run).title))
  check(buttons.some((node) => node.textContent === 'Build'),
    'the standalone build button is still offered separately')
}

section('a slow poll is not overlapped by the next tick')
{
  const reply = (value) => ({ ok: true, status: 200, async text() { return JSON.stringify(value) } })
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (path.endsWith(`${ROUTE_PREFIX}state`)) {
      return reply({ workspace: '/tmp', activeRunId: 'run-slow', runs: [] })
    }
    if (path.endsWith(`${ROUTE_PREFIX}poll`)) {
      // Deliberately outlives the 500ms interval: this is the case that used to
      // let two requests ask for the same `from` and append the same lines twice.
      await new Promise((resolve) => setTimeout(resolve, 900))
      return reply({
        missing: false,
        lines: [{ n: body.from, k: 'plain', t: `line ${body.from}` }],
        next: body.from + 1,
        status: 'running', exitCode: null, warningCount: 0, errors: [], durationMs: 0,
      })
    }
    return { ok: false, status: 404, async text() { return JSON.stringify({ message: 'no route' }) } }
  }

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-slow-poll' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  // Long enough for several ticks to fire while the first poll is still open.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2600)) })

  const shown = Array.from(container.querySelectorAll('.xcb-line')).map((node) => node.textContent)
  // The defect this pins: with no in-flight guard, every 500ms tick asked from the
  // same `from` and appended the same line again, so this window filled with
  // repeats of "line 0". Counting per-instance is what makes the assertion immune
  // to the earlier sections' intervals, which this fixture never disposes — their
  // polls are real but land in their own state, not in this container.
  check(shown.length > 0, 'the slow polls did deliver lines')
  check(new Set(shown).size === shown.length, 'no line is rendered twice', shown.join(' | '))
  check(new Set(shown).size >= 2, 'and the guard did not stall the log', shown.join(' | '))
}

section('result')
// =========================================================================
// A workspace remembers what was chosen in it.
// =========================================================================

section('returning to a workspace restores its choices')
{
  const ROOT = '/tmp/xcb-remember'
  // A fresh memory, so this section cannot depend on an earlier one.
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [ROOT]: {
      location: `${ROOT}/Second.xcworkspace`,
      scheme: 'Second',
      configuration: 'Test-Release',
      destination: 'platform=iOS,id=LEGACY-PHONE',
    },
  }))

  const calls = serve({
    state: () => ({ workspace: ROOT, activeRunId: null, runs: [] }),
    projects: () => ({
      root: ROOT,
      truncated: false,
      candidates: [
        { kind: 'workspace', name: 'First', location: `${ROOT}/First.xcworkspace`, relative: 'First.xcworkspace', depth: 0 },
        { kind: 'workspace', name: 'Second', location: `${ROOT}/Second.xcworkspace`, relative: 'Second.xcworkspace', depth: 0 },
      ],
    }),
    // `sweetpadDefaults` disagrees with the memory on purpose: the memory has to
    // win, or "the previous choice" would mean the project's default instead.
    detect: (body) => ({
      kind: 'workspace',
      root: ROOT,
      location: body.path,
      name: 'Second',
      schemes: ['Second', 'Other'],
      configurations: ['Debug', 'Test-Release'],
      sweetpadDefaults: { scheme: 'Other' },
    }),
    destinations: () => ({
      destinations: [
        { kind: 'device', id: 'LEGACY-PHONE', name: 'congiPhone', os: '16.7.12', placeholder: false, destination: 'platform=iOS,id=LEGACY-PHONE' },
        { kind: 'simulator', id: 'SIM-1', name: 'iPhone 17', os: '26.0', placeholder: false, destination: 'platform=iOS Simulator,id=SIM-1' },
      ],
      recommended: 'platform=iOS,id=LEGACY-PHONE',
    }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

  const path = container.querySelector('.xcb-input.path')
  check(path !== null, 'the path field rendered')
  await act(async () => { propsOf(path).onChange({ target: { value: ROOT } }) })
  await act(async () => {
    propsOf(path).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  // Several projects here, but this workspace already has one on record — so it is
  // adopted rather than asking again. Assuming one of several unseen would be the
  // bug this guards against; an exact remembered match is not an assumption.
  check(container.querySelector('.xcb-picker') === null,
    'a remembered project among several is adopted instead of asking again')
  equal(calls.filter((call) => call.method === 'detect').map((call) => call.body.path),
    [`${ROOT}/Second.xcworkspace`], 'the remembered project is the one adopted')

  const scheme = container.querySelector('.xcb-select.scheme')
  const dest = container.querySelector('.xcb-select.dest')
  const [config] = Array.from(container.querySelectorAll('.xcb-select')).slice(2)
  equal(scheme?.value, 'Second', 'the remembered scheme wins over the project default')
  equal(config?.value, 'Test-Release', 'the remembered configuration comes back')
  equal(dest?.value, 'platform=iOS,id=LEGACY-PHONE', 'the remembered destination comes back')

  const asked = calls.find((call) => call.method === 'destinations')
  equal(asked?.body.preferred, 'platform=iOS,id=LEGACY-PHONE',
    'the panel tells the host what this workspace used, so the host can honour it')
  equal(asked?.body.scheme, 'Second', 'and it asks about the scheme it restored')
}


// =========================================================================
// What is missing is said before it costs a build.
// =========================================================================

section('a missing device tool is named, with the command that installs it')
{
  const report = (missingRequired, missingOptional, tools) => ({
    ready: missingRequired.length === 0,
    tools,
    xcodePath: '/Applications/Xcode.app/Contents/Developer',
    xcodeVersion: 'Xcode 26.0.1',
    missingRequired,
    missingOptional,
    legacyInstall: missingOptional.length > 0
      ? 'brew install libimobiledevice ideviceinstaller ios-deploy'
      : '',
  })
  const build = (ready) => ({
    command: ready.command, group: ready.group, required: ready.required,
    purpose: ready.purpose, install: ready.install,
    found: ready.ready ? `/usr/bin/${ready.command}` : null, ready: ready.ready,
  })
  const tooling = [
    build({ command: 'xcodebuild', group: 'Xcode', required: true, purpose: 'build', install: 'install Xcode', ready: true }),
    // Two separate formulae on purpose: neither is part of libimobiledevice.
    build({ command: 'ideviceinstaller', group: 'iOS 16 and earlier devices', required: false, purpose: 'install onto iOS 16 hardware', install: 'brew install ideviceinstaller', ready: false }),
    build({ command: 'ios-deploy', group: 'iOS 16 and earlier devices', required: false, purpose: 'launch on iOS 16 hardware', install: 'brew install ios-deploy', ready: false }),
  ]

  const calls = serve({
    state: () => ({ workspace: '/tmp/xcb-doctor', activeRunId: null, runs: [] }),
    doctor: () => report([], ['ideviceinstaller', 'ios-deploy'], tooling),
  })
  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })

  check(calls.some((call) => call.method === 'doctor'), 'the panel asks what the machine is missing')
  const row = container.querySelector('.xcb-doctor')
  check(row !== null, 'a row appears when optional device tooling is absent')
  check(row !== null && row.className.includes('required') === false,
    'an optional gap is not painted as a hard error', row === null ? 'no row' : row.className)
  check(row !== null && row.textContent.includes('ideviceinstaller'),
    'the missing tool is named', row === null ? 'no row' : row.textContent)
  check(row !== null && row.textContent.includes('brew install ideviceinstaller'),
    'and so is the command that installs it', row === null ? 'no row' : row.textContent)
  check(row !== null && row.textContent.includes('brew install ios-deploy'),
    'each missing tool carries its own command, because they are separate formulae',
    row === null ? 'no row' : row.textContent)

  section('a missing required tool is painted as an error')
  serve({
    state: () => ({ workspace: '/tmp/xcb-doctor', activeRunId: null, runs: [] }),
    doctor: () => report(['xcodebuild'], [], [
      build({ command: 'xcodebuild', group: 'Xcode', required: true, purpose: 'build', install: 'install Xcode', ready: false }),
    ]),
  })
  const second = mount({})
  const { container: other } = await render([
    React.createElement(second.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(second.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle' }),
  ])
  await act(async () => {
    other.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
  const errorRow = other.querySelector('.xcb-doctor')
  check(errorRow !== null && errorRow.className.includes('required'),
    'a missing required tool gets the error treatment', errorRow === null ? 'no row' : errorRow.className)
}


// =========================================================================
// Opening the panel searches the workspace by itself, and does not re-ask the
// host for a project it has already been told about.
// =========================================================================

section('opening the panel searches the workspace without being asked')
{
  dom.window.localStorage.clear()
  const ROOT = '/tmp/xcb-auto'
  const calls = serve({
    state: () => ({ workspace: ROOT, activeRunId: null, runs: [] }),
    projects: () => ({
      root: ROOT,
      truncated: false,
      candidates: [{ kind: 'workspace', name: 'Auto', location: `${ROOT}/Auto.xcworkspace`, relative: 'Auto.xcworkspace', depth: 0 }],
    }),
    detect: (body) => ({
      kind: 'workspace', root: ROOT, location: body.path, name: 'Auto',
      schemes: ['Auto'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [], recommended: '' }),
  })

  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-auto' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  // Opening the panel used to land on a path with nothing behind it: the project
  // only appeared after clicking into the field and back out, or pressing search.
  check(calls.some((call) => call.method === 'projects'),
    'the workspace is searched on opening, with no second action from the user')
  equal(calls.filter((call) => call.method === 'detect').map((call) => call.body.path),
    [`${ROOT}/Auto.xcworkspace`], 'and the only candidate is adopted')
  equal(container.querySelector('.xcb-input.path')?.value, `${ROOT}/Auto.xcworkspace`,
    'the path field shows what was adopted')

  section('and the directory is walked once, not on every repaint')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
  equal(calls.filter((call) => call.method === 'projects').length, 1,
    'a search runs once per workspace')

  section('a workspace seen before is painted from the store, without walking it')
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [ROOT]: {
      location: `${ROOT}/Auto.xcworkspace`,
      scheme: 'Auto',
      configuration: 'Debug',
      destination: '',
      info: {
        kind: 'workspace', root: ROOT, location: `${ROOT}/Auto.xcworkspace`, name: 'Auto',
        schemes: ['Auto'], configurations: ['Debug'], sweetpadDefaults: {},
      },
    },
  }))
  const cached = serve({
    state: () => ({ workspace: ROOT, activeRunId: null, runs: [] }),
    // Deliberately unanswerable: reaching for a directory walk at all is the bug.
    projects: () => { throw new Error('the directory must not be walked when the project is stored') },
    detect: (body) => ({
      kind: 'workspace', root: ROOT, location: body.path, name: 'Auto',
      schemes: ['Auto', 'Extra'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [], recommended: '' }),
  })
  const second = mount({})
  const { container: other } = await render([
    React.createElement(second.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(second.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-auto-cached' }),
  ])
  await act(async () => {
    other.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  equal(cached.filter((call) => call.method === 'projects').length, 0,
    'the stored project is used instead of walking the directory again')
  equal(cached.filter((call) => call.method === 'detect').map((call) => call.body.path),
    [`${ROOT}/Auto.xcworkspace`],
    'the host is still asked in the background, so a project edited on disk corrects itself')
  equal(other.querySelector('.xcb-select.scheme')?.value, 'Auto',
    'the scheme select is already filled from the store')
}


console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('client interaction OK')
process.exit(0)
