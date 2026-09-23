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

import { KINDS } from '../lib/classify.js'
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

// React keeps an IE-era fallback for watching a text field's value, and that path calls
// `attachEvent`, which jsdom does not implement. Nothing reached it before because this
// suite never focused a field; the find bar focuses its box, which is exactly what is
// under test. Stubbed here rather than avoided in the client — a browser has the `input`
// event, so React never takes this path there.
dom.window.HTMLInputElement.prototype.attachEvent = () => {}
dom.window.HTMLInputElement.prototype.detachEvent = () => {}

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
    // A handler may return a promise: the destinations test answers late on purpose, so
    // that it can look at the panel while `xcodebuild -showdestinations` is still running.
    return { ok: true, status: 200, async text() { return JSON.stringify(await handler(body)) } }
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
// The level buttons must reach every kind the classifier can produce.
// =========================================================================
//
// A kind with no button is a line the user can never show again once it is off, and the
// classifier keeps gaining kinds — xcbeautify's `[x]` / `[!]` / `Build Succeeded`
// vocabulary was one such addition. So this walks the buttons instead of restating which
// level owns which kind: it watches what each button hides and then checks that between
// them they cover every kind exactly once.

section('every kind the classifier produces is reachable from a level button')
{
  // The vocabulary comes from the classifier itself, so adding a kind there — the way
  // xcbeautify's markers were added — fails this section until a level shows it.
  const allLines = KINDS.map((kind, index) => ({ n: index + 1, k: kind, t: `${kind} line` }))
  serve({
    state: () => ({ workspace: '/project/levels', activeRunId: 'run-levels', runs: [] }),
    // The panel's cursor starts at 0, so the whole set arrives in one poll and nothing
    // is answered twice.
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? allLines : [],
      next: body.from === 0 ? allLines.length + 1 : body.from,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-levels' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const shown = () => Array.from(container.querySelectorAll('.xcb-line'))
    .map((node) => /xcb-k-(\w+)/.exec(node.className)?.[1] ?? '?')
    .sort()
  const sorted = (list) => [...list].sort()
  const button = (label) => Array.from(container.querySelectorAll('.xcb-btn'))
    .find((node) => node.textContent === label)
  const click = async (node) => {
    await act(async () => {
      propsOf(node).onClick()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  equal(shown(), sorted(KINDS), 'every kind is on screen to begin with')

  const levelButtons = Array.from(container.querySelectorAll('.xcb-btn[data-level]'))
  equal(levelButtons.map((node) => node.textContent), ['verbose', 'info', 'warning', 'error'],
    'the row is the four levels a system log has, lowest first')
  equal(levelButtons.map((node) => node.dataset.level), ['verbose', 'info', 'warning', 'error'],
    'and each button is the level it names')

  const owner = new Map()
  for (const node of levelButtons) {
    const label = node.textContent
    const before = shown()
    await click(node)
    const hidden = before.filter((kind) => !shown().includes(kind))
    check(hidden.length > 0, `clicking ${label} hides at least one kind of line`)
    for (const kind of hidden) {
      check(!owner.has(kind), `${kind} belongs to exactly one level (${label} and ${owner.get(kind)})`)
      owner.set(kind, label)
    }
    await click(node)
    equal(shown(), before, `${label} puts back exactly what it hid`)
  }
  equal(sorted(owner.keys()), sorted(KINDS),
    'and between them the level buttons reach every kind the classifier produces')

  await click(button('Problems'))
  // The compiler's notes belong to the warning level, so narrowing to the diagnostics
  // keeps them: a note without the warning it explains is not a solvable problem.
  equal(shown(), sorted(['error', 'warning', 'note']), 'Problems keeps the two diagnostics and drops the rest')
}

// =========================================================================
// Searching the log is not filtering it.
// =========================================================================
//
// A filter changes which lines exist as far as the panel is concerned, and can reach
// lines the browser no longer holds by asking the host. The search does the opposite: it
// hides nothing, marks the hits inside the lines already on screen, and says which hit
// you are on so that "go to the next one" is a place you can trust.

section('searching the log marks hits without hiding anything')
{
  const lines = [
    { n: 1, k: 'plain', t: 'first line' },
    { n: 2, k: 'task', t: 'Compiling GemoyHit.swift' },
    { n: 3, k: 'warning', t: 'warning: unused variable in hitPath' },
    { n: 4, k: 'plain', t: 'nothing to see' },
    { n: 5, k: 'error', t: 'error: cannot find Hit in scope' },
    { n: 6, k: 'plain', t: 'done' },
  ]
  const calls = serve({
    state: () => ({ workspace: '/project/find', activeRunId: 'run-find', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? lines : [],
      next: body.from === 0 ? lines.length + 1 : body.from,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-find' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  /** The find bar is hidden until ⌘F, so every search test starts by asking for it. */
  const openFind = async () => {
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }

  check(container.querySelector('.xcb-input.find') === null,
    'the find bar is not on screen to begin with: it takes no space until it is asked for')
  check(container.querySelector('.xcb-find') === null, 'and neither is its row')
  await openFind()
  // Looked up every time: closing the bar unmounts the box, so a captured element goes
  // stale the moment it is reopened.
  const field = () => container.querySelector('.xcb-input.find')
  check(field() !== null, 'the panel has a search box, separate from the filter box')
  check(document.activeElement === field(), 'and ⌘F puts the caret in it, ready to type')

  const rows = () => Array.from(container.querySelectorAll('.xcb-line'))
  const rowFor = (number) => rows().find((node) => node.querySelector('.xcb-num')?.textContent === String(number))
  const nowRow = () => rows().find((node) => node.querySelector('.xcb-hit.now') !== null)
  const counter = () => container.querySelector('.xcb-findcount')?.textContent ?? ''
  const nav = (label) => Array.from(container.querySelectorAll('.xcb-btn.find-nav'))
    .find((node) => node.textContent === label)
  const type = async (text) => {
    await act(async () => {
      propsOf(field()).onChange({ target: { value: text } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const step = async (label) => {
    await act(async () => {
      propsOf(nav(label)).onClick()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const key = async (event) => {
    await act(async () => {
      propsOf(field()).onKeyDown({ preventDefault: () => {}, ...event })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  await type('hit')
  equal(counter(), '1 / 3', 'the count appears as you type, and the first hit is current')
  equal(rows().length, lines.length, 'nothing is hidden: the search is not a filter')
  equal(container.querySelectorAll('.xcb-hit').length, 3, 'every occurrence is marked')
  equal(nowRow()?.querySelector('.xcb-num')?.textContent, '2',
    'and the current hit is marked as the current one, in the first matching line')
  equal(propsOf(nav('↑')).disabled, false, 'the arrows are live while there are hits')
  equal(propsOf(nav('↓')).disabled, false, 'both of them')
  check(calls.filter((call) => call.method === 'search').length === 0,
    'typing asks the host for nothing: the search runs over the lines already on screen')

  await step('↓')
  equal(counter(), '2 / 3', 'the next arrow moves to the next hit')
  equal(nowRow()?.querySelector('.xcb-num')?.textContent, '3', 'and the marks follow it')
  await step('↓')
  equal(counter(), '3 / 3', 'and again')
  await step('↓')
  equal(counter(), '1 / 3', 'past the last hit it wraps, so repeated presses walk them all')
  await step('↑')
  equal(counter(), '3 / 3', 'and back up')

  await key({ key: 'Enter' })
  equal(counter(), '1 / 3', 'Enter goes forward too')
  await key({ key: 'Enter', shiftKey: true })
  equal(counter(), '3 / 3', 'and Shift+Enter goes back')

  equal(rows().filter((node) => node.querySelector('.xcb-hit.now') !== null).length, 1,
    'exactly one line is drawn as the current hit')
  equal(rowFor(5)?.querySelectorAll('.xcb-hit.now').length, 1,
    'and it is the line the count names')

  await type('HIT')
  equal(counter(), '1 / 3', 'the search ignores case, as finding a log line by name must')

  await type('Hit.swift')
  equal(counter(), '1 / 1', 'the needle is literal text, not a pattern')

  await type('(')
  equal(counter(), 'no hits', 'a lone bracket is looked for rather than compiled')
  equal(propsOf(nav('↑')).disabled, true, 'with no hits the arrows are greyed out')
  equal(propsOf(nav('↓')).disabled, true, 'both of them')
  equal(container.querySelectorAll('.xcb-hit').length, 0, 'and nothing is marked')

  await type('')
  check(field() !== null, 'emptying the box takes the count and the marks, not the bar')
  equal(container.querySelectorAll('.xcb-hit').length, 0, 'the marks are gone')

  // Esc is the same way out, from a box that still has something in it.
  await openFind()
  await type('hit')
  check(container.querySelectorAll('.xcb-hit').length > 0, 'there are marks to clear')
  await key({ key: 'Escape' })
  check(field() === null, 'Esc puts the bar away in one press')
  equal(container.querySelectorAll('.xcb-hit').length, 0, 'and drops the search with it')

  // Emptying the box by hand does NOT close it: the judgement is made on blur, because a
  // keystroke is not the user saying they are done — it is often them deleting a character
  // to retype it. The bar stays, empty and ready.
  await openFind()
  equal(field()?.value, '', 'reopening starts empty, not with the last query')
  await type('hit')
  await type('hi')
  check(field() !== null, 'a shorter query keeps the bar open')
  await type('')
  check(field() !== null, 'emptying the box leaves the bar open while it still has the caret')
  equal(container.querySelectorAll('.xcb-hit').length, 0, 'with the marks gone')
  check(container.querySelector('.xcb-findcount') === null, 'and the count with them')
  await type('again')
  equal(counter(), 'no hits', 'and it is still there to be typed into')

  // Losing focus is the moment it is judged: empty goes, filled stays.
  await type('hit')
  await act(async () => {
    propsOf(field()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(field() !== null, 'clicking away with a query in the box leaves the bar up')
  equal(field()?.value, 'hit', 'and leaves the query in it')
  await type('')
  check(field() !== null, 'emptying it while the caret is still there keeps it')
  await act(async () => {
    propsOf(field()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(field() === null, 'and clicking away from the empty box puts it away')
  await openFind()
  await act(async () => {
    propsOf(field()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(field() === null, 'clicking away from a box that was never typed into puts it away too')

  // The panel can be on screen in more than one seat at once — docked and floating are two
  // mountings of the same component over one store — so ⌘F opens this box in all of them
  // and each one focuses its own input. The seats that lose focus see a blur, and that
  // hand-off is not the user leaving the box: reading it as one would put the bar away the
  // instant it was asked for.
  const otherSeat = () => {
    const node = dom.window.document.createElement('input')
    node.className = 'xcb-input find'
    return node
  }
  await openFind()
  await act(async () => {
    propsOf(field()).onBlur({ relatedTarget: otherSeat() })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(field() !== null, 'focus handing over to the same box in another seat leaves the bar alone')
  await act(async () => {
    propsOf(field()).onBlur({ relatedTarget: container.querySelector('.xcb-input.filter') })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check(field() === null, 'but an empty box left for the filter box is still put away')

  // A second ⌘F while it is open is "find something else": focus and select.
  await openFind()
  await type('hit')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const again = container.querySelector('.xcb-input.find')
  check(document.activeElement === again, '⌘F again returns the caret to the box')
  equal([again.selectionStart, again.selectionEnd], [0, again.value.length],
    'with the existing query selected, so typing replaces it')
  equal(again.value, 'hit', 'and nothing about the query was lost on the way')

  // ⌥⌘F is somebody else's binding, so it must not be swallowed.
  await key({ key: 'Escape' })
  check(field() === null, 'the bar is away again')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, altKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  check(field() === null, '⌥⌘F is left to whatever else wants it')
}

section('moving to a hit takes the view there')
{
  const lines = [
    { n: 1, k: 'plain', t: 'heading' },
    { n: 2, k: 'plain', t: 'alpha' },
    { n: 3, k: 'plain', t: 'the needle' },
    { n: 4, k: 'plain', t: 'beta' },
  ]
  serve({
    state: () => ({ workspace: '/project/scroll', activeRunId: 'run-scroll', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? lines : [],
      next: body.from === 0 ? lines.length + 1 : body.from,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-scroll' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const log = container.querySelector('.xcb-log')
  const box = fakeScrollMetrics(log, { height: 4000, view: 200 })
  // Rows far enough apart that "centre it" is a number this can check.
  Array.from(container.querySelectorAll('.xcb-line')).forEach((node, index) => {
    Object.defineProperty(node, 'offsetTop', { configurable: true, get: () => index * 200 })
  })

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const find = container.querySelector('.xcb-input.find')
  const nav = (label) => Array.from(container.querySelectorAll('.xcb-btn.find-nav'))
    .find((node) => node.textContent === label)
  await act(async () => {
    propsOf(find).onChange({ target: { value: 'needle' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const parked = box.top
  check(parked > 0, 'the log starts at the tail, which the fake metrics can see')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  equal(box.top, parked, 'typing alone does not move the log around under the caret')

  await act(async () => {
    propsOf(nav('↓')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  // Row 3 of 4 is 400px down; half the 200px viewport above it puts it in the middle.
  equal(box.top, 300, 'the arrow scrolls the hit into view')
  // The "back to the tail" button appears exactly when the view is no longer following
  // it, which is the other half of "the arrow took the view somewhere".
  const jump = container.querySelector('.xcb-jump')
  equal(jump?.textContent, '↓ Latest', 'and parking on a hit stops the view following the tail')
}

section('a hit further back than the render cap is still reachable')
{
  // The log view renders the tail. Without the window following the current hit, "next"
  // would walk into lines that are not in the DOM and quietly do nothing.
  const many = []
  for (let n = 1; n <= 2600; n += 1) {
    many.push({ n, k: 'plain', t: n === 10 ? 'the needle is back here' : `line ${String(n)}` })
  }
  serve({
    state: () => ({ workspace: '/project/deep', activeRunId: 'run-deep', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? many : [],
      next: body.from === 0 ? many.length + 1 : body.from,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-deep' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const numbers = () => Array.from(container.querySelectorAll('.xcb-num')).map((node) => Number(node.textContent))
  check(!numbers().includes(10), 'line 10 starts outside the window, which shows the tail')

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const find = container.querySelector('.xcb-input.find')
  await act(async () => {
    propsOf(find).onChange({ target: { value: 'needle' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  equal(container.querySelector('.xcb-findcount')?.textContent, '1 / 1', 'the hit is counted')
  const current = container.querySelector('.xcb-line-current .xcb-num')
  check(current !== null && current.textContent === '10',
    'and the window moves so that the hit is rendered, not off the end of the DOM')
}

// =========================================================================
// The two boxes remember what they were given before.
// =========================================================================
//
// ↑/↓ walks each box's own history, newest first, the way a shell does it: ↑ is back in
// time, ↓ is forward, and ↓ past the newest entry puts back the text that was being typed
// when the walk started. One history per box — a filter and a search are different
// questions, and neither should offer the other's answers.

section('↑ and ↓ walk what each box was given before')
{
  const lines = [
    { n: 1, k: 'plain', t: 'alpha one' },
    { n: 2, k: 'plain', t: 'alpha two' },
    { n: 3, k: 'plain', t: 'beta three' },
  ]
  const calls = serve({
    state: () => ({ workspace: '/project/history', activeRunId: 'run-history', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? lines : [],
      next: body.from === 0 ? lines.length + 1 : body.from,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 0,
    }),
    search: (body) => ({ lines: body.pattern === '' ? [] : lines, total: lines.length, truncated: false, regex: false }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-history' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const filterField = () => container.querySelector('.xcb-input.filter')
  const findField = () => container.querySelector('.xcb-input.find')
  const counter = () => container.querySelector('.xcb-findcount')?.textContent ?? ''
  const typeInto = async (node, value) => {
    await act(async () => {
      propsOf(node).onChange({ target: { value: value } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const press = async (node, event) => {
    await act(async () => {
      // Shift is spelled out because a browser always sends it: the box uses it to tell
      // ↑ alone (history) from Shift+↑ (the previous hit).
      propsOf(node).onKeyDown({ preventDefault: () => {}, currentTarget: node, shiftKey: false, ...event })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const openFind = async () => {
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }

  // Nothing has been given to either box yet, so ↑ has nothing to offer and must not
  // quietly blank a half-written value.
  await typeInto(filterField(), 'half-written')
  await press(filterField(), { key: 'ArrowUp' })
  equal(filterField().value, 'half-written', '↑ with no history leaves what is in the box alone')

  await press(filterField(), { key: 'Enter' })
  await typeInto(filterField(), 'bar')
  await act(async () => {
    propsOf(filterField()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await typeInto(filterField(), 'bar')
  await act(async () => {
    propsOf(filterField()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  // A draft that was never committed is not history, which is what makes it the thing ↓
  // can put back.
  await typeInto(filterField(), 'draft')
  // Committing is what asks the host to search, and it does so on the panel's own clock.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  const searchesBefore = calls.filter((call) => call.method === 'search').length

  await press(filterField(), { key: 'ArrowUp' })
  equal(filterField().value, 'bar', '↑ brings back the filter committed last')
  await press(filterField(), { key: 'ArrowUp' })
  equal(filterField().value, 'half-written', 'and again for the one before it')
  await press(filterField(), { key: 'ArrowUp' })
  equal(filterField().value, 'half-written', 'at the oldest entry it stays, rather than wrapping')
  await press(filterField(), { key: 'ArrowDown' })
  equal(filterField().value, 'bar', '↓ walks forward again')
  await press(filterField(), { key: 'ArrowDown' })
  equal(filterField().value, 'draft', 'and past the newest one it puts back the draft')
  await press(filterField(), { key: 'ArrowDown' })
  equal(filterField().value, 'draft', 'with nothing newer to walk to')
  // The second `bar` was committed twice: one entry, or ↑ would need two presses to pass it.
  await press(filterField(), { key: 'ArrowUp' })
  await press(filterField(), { key: 'ArrowUp' })
  equal(filterField().value, 'half-written', 'a value committed twice is remembered once')
  equal(calls.filter((call) => call.method === 'search').length, searchesBefore,
    'walking the history issues no search of its own')

  // The search box keeps its own history, and recalling a query re-counts it without
  // moving the view.
  const log = container.querySelector('.xcb-log')
  const box = fakeScrollMetrics(log, { height: 4000, view: 200 })
  await openFind()
  await typeInto(findField(), 'alpha')
  equal(counter(), '1 / 2', 'the first query finds its two lines')
  await press(findField(), { key: 'Enter' })
  await press(findField(), { key: 'Escape' })
  check(findField() === null, 'and Esc closes the bar with the query remembered')

  await openFind()
  await typeInto(findField(), 'beta')
  equal(counter(), '1 / 1', 'a second query finds its one line')
  const parked = box.top
  // 'beta' is still being typed, so it is not history yet: ↑ offers the last query that
  // was finished with, and ↓ is the way back to the half-written one.
  await press(findField(), { key: 'ArrowUp' })
  equal(findField().value, 'alpha', '↑ in the search box brings back the last finished search, not the filter')
  equal(counter(), '1 / 2', 'and the count follows the recalled query')
  equal(box.top, parked, 'recalling a query does not move the log')
  await press(findField(), { key: 'ArrowDown' })
  equal(findField().value, 'beta', 'and ↓ puts back the query that was still being typed')

  // Finishing with it is what adds it: now the history is two deep.
  await press(findField(), { key: 'Enter' })
  await typeInto(findField(), 'bet')
  await press(findField(), { key: 'ArrowUp' })
  equal(findField().value, 'beta', '↑ now offers the query finished with last')
  await press(findField(), { key: 'ArrowUp' })
  equal(findField().value, 'alpha', 'and then the one before it')
  await press(findField(), { key: 'ArrowUp' })
  equal(findField().value, 'alpha', 'at the oldest entry it stays, rather than wrapping')
  await press(findField(), { key: 'ArrowDown' })
  equal(findField().value, 'beta', '↓ walks forward')
  await press(findField(), { key: 'ArrowDown' })
  equal(findField().value, 'bet', 'and past the newest it puts back the draft')
  await press(findField(), { key: 'ArrowDown' })
  equal(findField().value, 'bet', 'with nothing newer to walk to')
  check(findField() !== null, 'the bar stays up through the whole walk')

  // Typing after a recall is the user's own text again, so ↓ has nowhere to walk.
  await press(findField(), { key: 'ArrowUp' })
  equal(findField().value, 'beta', '↑ recalls again')
  await typeInto(findField(), 'bet')
  await press(findField(), { key: 'ArrowDown' })
  equal(findField().value, 'bet', 'after typing, ↓ no longer walks the history')
  await typeInto(findField(), 'gamma')
  equal(counter(), 'no hits', 'and the box counts what was typed, not what was recalled')
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

// =========================================================================
// A workspace holding several projects must not ask twice.
//
// The bug this pins: the choice was remembered under the PROJECT's own directory,
// because that is the `root` the host's `detect` reports, while the panel opens on
// the WORKSPACE and looks the choice up by that. With the project one level down —
// `/ws/App/App.xcworkspace` — the two keys differ, so the record existed and was
// never found, and "N projects found — pick one" came back on every open.
// =========================================================================

section('a project in a subdirectory is remembered for the workspace it was found in')
{
  const workspace = '/Users/mac/Project/Multi'
  const app = `${workspace}/App/App.xcworkspace`
  const other = `${workspace}/Other/Other.xcodeproj`
  const multi = (calls) => ({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => ({
      root: workspace,
      truncated: false,
      candidates: [
        { kind: 'workspace', name: 'App', location: app, relative: 'App/App.xcworkspace', depth: 1 },
        { kind: 'project', name: 'Other', location: other, relative: 'Other/Other.xcodeproj', depth: 1 },
      ],
    }),
    // Exactly what the host answers: `root` is the project's OWN directory, one
    // level below the workspace that was searched.
    detect: (body) => ({
      kind: /\.xcworkspace$/.test(body.path) ? 'workspace' : 'project',
      root: body.path.slice(0, body.path.lastIndexOf('/')),
      location: body.path,
      name: body.path.includes('/App/') ? 'App' : 'Other',
      schemes: [body.path.includes('/App/') ? 'App' : 'Other'],
      configurations: ['Debug'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [], recommended: '' }),
  })

  dom.window.localStorage.clear()
  const picked = serve(multi())
  const first = mount({})
  const { container: one } = await render([
    React.createElement(first.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(first.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-subdir-pick' }),
  ])
  await act(async () => {
    one.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  const candidates = one.querySelectorAll('.xcb-candidate')
  check(candidates.length === 2, 'two projects under the workspace are offered', `${candidates.length} shown`)
  await act(async () => {
    candidates[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  check(picked.filter((call) => call.method === 'detect').length > 0, 'picking a candidate detects it')

  const store = JSON.parse(dom.window.localStorage.getItem('dsh-xcodebuild:selections') ?? '{}')
  equal(store[workspace]?.location, app,
    'the choice is on record under the workspace, which is the key the panel reads back')
  equal(store[`${workspace}/App`]?.location, app,
    'and under the project directory, where the per-project facts live')

  section('reopening that workspace adopts it instead of asking again')
  const reopened = serve({
    ...multi(),
    // A directory walk is the bug: the answer is already on record.
    projects: () => { throw new Error('the directory must not be walked once the choice is on record') },
  })
  const second = mount({})
  const { container: two } = await render([
    React.createElement(second.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(second.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-subdir-pick' }),
  ])
  await act(async () => {
    two.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  equal(reopened.filter((call) => call.method === 'projects').length, 0,
    'reopening the workspace does not walk the directory again')
  check(two.querySelector('.xcb-picker') === null, 'and does not ask which project, because it already knows')
  equal(two.querySelector('.xcb-select.scheme')?.value, 'App', 'the remembered project is the one that is set up')
}

section('a choice on record without its cached description is still adopted')
{
  // Older records, and records written by an older panel, hold only `location`.
  // `adoptCached` needs the description to paint, so it declines — and the search
  // that follows has to pick the recorded candidate rather than show the picker.
  const workspace = '/Users/mac/Project/Legacy'
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [workspace]: { location: `${workspace}/App/App.xcworkspace` },
  }))
  const calls = serve({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => ({
      root: workspace,
      truncated: false,
      candidates: [
        { kind: 'workspace', name: 'App', location: `${workspace}/App/App.xcworkspace`, relative: 'App/App.xcworkspace', depth: 1 },
        { kind: 'workspace', name: 'Other', location: `${workspace}/Other/Other.xcworkspace`, relative: 'Other/Other.xcworkspace', depth: 1 },
      ],
    }),
    detect: (body) => ({
      kind: 'workspace',
      root: body.path.slice(0, body.path.lastIndexOf('/')),
      location: body.path,
      name: 'App',
      schemes: ['App'],
      configurations: ['Debug'],
      sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [], recommended: '' }),
  })
  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-legacy-record' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  equal(calls.filter((call) => call.method === 'detect').map((call) => call.body.path),
    [`${workspace}/App/App.xcworkspace`],
    'the recorded candidate is the one adopted, without asking')
  check(container.querySelector('.xcb-picker') === null, 'no picker for a workspace whose choice is on record')
}


// =========================================================================
// A test bench swaps phones and simulators all day, so the device list has to
// be refreshed on every look — and `-showdestinations` takes seconds to answer,
// so waiting for it before drawing anything makes the control feel dead.
//
// Both, in that order: the cached list is painted at once and marked with its
// age, and the command still runs every time.
// =========================================================================

section('the device list is painted from the cache and refreshed anyway')
{
  const workspace = '/Users/mac/Project/Bench'
  const project = `${workspace}/Bench.xcworkspace`
  const cachedDevice = {
    destination: 'id=00008110-000A1B2C3D4E5F60', kind: 'device', name: 'iPhone 12', os: '26.6.2', placeholder: false,
  }
  const cachedSimulator = {
    destination: 'platform=iOS Simulator,id=AAA', kind: 'simulator', name: 'iPhone 16', os: '18.0', placeholder: false,
  }
  const freshDevice = {
    destination: 'id=0000a1b2c3d4e5f60718293a4b5c6d7e8f901234', kind: 'device', name: 'iPhone X', os: '16.7.12', placeholder: false,
  }
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [workspace]: {
      scheme: 'Bench',
      configuration: 'Debug',
      // The phone that was plugged in last time; the cached list still says it is there.
      destination: cachedDevice.destination,
      info: {
        kind: 'workspace', root: workspace, location: project, name: 'Bench',
        schemes: ['Bench'], configurations: ['Debug'], sweetpadDefaults: {},
      },
      destinations: {
        scheme: 'Bench',
        list: [cachedDevice, cachedSimulator],
        recommended: cachedDevice.destination,
        at: Date.now() - 125000,
      },
    },
  }))

  let answer = null
  const pending = new Promise((resolve) => { answer = resolve })
  const calls = serve({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => { throw new Error('the stored project must not be searched for again') },
    detect: (body) => ({
      kind: 'workspace', root: workspace, location: body.path, name: 'Bench',
      schemes: ['Bench'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    // Deliberately late: the panel must fill the list before this ever answers.
    destinations: () => pending,
  })
  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-bench' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  const dest = () => container.querySelector('.xcb-select.dest')
  const noteText = () => container.querySelector('.xcb-destnote')?.textContent ?? ''
  const options = () => Array.from(dest()?.querySelectorAll('option') ?? []).map((node) => node.textContent)

  section('the cached list is on screen while the command runs')
  equal(options(), ['▣ iPhone 12 · 26.6.2', '◻ iPhone 16 · 18.0'],
    'the cached devices are painted before the host has answered')
  equal(dest()?.value, cachedDevice.destination,
    'and the device used last time is still selected, so nothing has to be re-picked')
  check(noteText().includes('cached'), `a cached list says so (${JSON.stringify(noteText())})`)
  check(noteText().includes('2m'), `with its age, so a phone unplugged minutes ago is not trusted blindly (${JSON.stringify(noteText())})`)
  check(noteText().includes('refreshing'), `and that a refresh is under way (${JSON.stringify(noteText())})`)
  check(noteText().includes('cached') && container.querySelector('.xcb-destnote.stale') !== null,
    'the note is drawn in its stale form, not as a live list')
  equal(calls.filter((call) => call.method === 'destinations').length, 1,
    'the command runs on every look, cached list or not')

  section('the refreshed list replaces it')
  // The bench swapped hardware: the cached phone is gone and another is in.
  await act(async () => {
    answer({ destinations: [freshDevice, cachedSimulator], recommended: freshDevice.destination })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  equal(options(), ['▣ iPhone X · 16.7.12', '◻ iPhone 16 · 18.0'],
    'the live list is what is shown once the command answers')
  equal(dest()?.value, freshDevice.destination,
    'a selection that no longer exists moves to the host\'s recommendation')
  equal(noteText(), '', 'and the cached marker is gone: the list is live now')
  check(container.querySelector('.xcb-destnote.stale') === null, 'including its stale styling')

  section('the fresh list is what the next look paints')
  const stored = JSON.parse(dom.window.localStorage.getItem('dsh-xcodebuild:selections'))[workspace]
  equal(stored.destinations.list.map((entry) => entry.name), ['iPhone X', 'iPhone 16'],
    'the list itself is stored, which is what makes the next look instant')
  equal(stored.destinations.scheme, 'Bench', 'stored against the scheme it belongs to')
  check(stored.destinations.at > Date.now() - 10000, 'with the instant it was read')
  equal(stored.destination, freshDevice.destination, 'and the moved selection is remembered too')
}

section('looking at the list refreshes it, without moving the options under the pointer')
{
  const workspace = '/Users/mac/Project/Look'
  const project = `${workspace}/Look.xcworkspace`
  const phone = { destination: 'id=PHONE', kind: 'device', name: 'iPhone X', os: '16.7.12', placeholder: false }
  const other = { destination: 'id=OTHER', kind: 'device', name: 'iPhone 12', os: '26.6.2', placeholder: false }
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [workspace]: {
      scheme: 'Look',
      destination: phone.destination,
      info: { kind: 'workspace', root: workspace, location: project, name: 'Look', schemes: ['Look'], configurations: ['Debug'], sweetpadDefaults: {} },
      destinations: { scheme: 'Look', list: [phone], recommended: phone.destination, at: Date.now() - 60000 },
    },
  }))
  let answer = null
  let reads = 0
  const calls = serve({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => { throw new Error('the stored project must not be searched for again') },
    detect: (body) => ({
      kind: 'workspace', root: workspace, location: body.path, name: 'Look',
      schemes: ['Look'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    // The mount-time read answers at once; the one the look triggers is deliberately late.
    destinations: () => {
      reads += 1
      if (reads === 1) return { destinations: [phone], recommended: phone.destination }
      return new Promise((resolve) => { answer = resolve })
    },
  })
  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-look' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  const dest = () => container.querySelector('.xcb-select.dest')
  const optionNames = () => Array.from(dest()?.querySelectorAll('option') ?? []).map((node) => node.textContent)
  const seen = calls.filter((call) => call.method === 'destinations').length
  equal(seen, 1, 'opening the panel read the list once')
  equal(optionNames(), ['▣ iPhone X · 16.7.12'], 'and the same hardware is what is on screen')

  section('opening the dropdown asks the host again')
  await act(async () => {
    dest().dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
  })
  equal(calls.filter((call) => call.method === 'destinations').length, seen + 1,
    'a look at the list is a refresh, even though the cache was painted')
  check(container.querySelector('.xcb-destnote')?.textContent.includes('refreshing') === true,
    'and the panel says it is refreshing')

  section('the answer waits for the dropdown to close')
  // The phone that was plugged in since. Applying it now would rebuild the options of an
  // open <select>, which is how a dropdown snaps shut on the item being chosen.
  await act(async () => {
    answer({ destinations: [other], recommended: other.destination })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  equal(optionNames(), ['▣ iPhone X · 16.7.12'], 'the options do not move while the list is open')
  await act(async () => {
    // React hears `blur` through the bubbling `focusout` it delegates, which is the event
    // a real dropdown closing produces; the panel's handler is called directly here so the
    // assertion is about the hand-off and not about jsdom's focus emulation.
    propsOf(dest()).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  equal(optionNames(), ['▣ iPhone 12 · 26.6.2'], 'and the fresh list is applied as soon as it shuts')
  equal(dest()?.value, other.destination, 'with the selection following the new hardware')
  equal(container.querySelector('.xcb-destnote'), null, 'and the refreshing marker gone')

  section('the refresh button re-reads on demand')
  const again = serve({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => { throw new Error('no search') },
    detect: (body) => ({
      kind: 'workspace', root: workspace, location: body.path, name: 'Look',
      schemes: ['Look'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [other], recommended: other.destination }),
  })
  const button = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === '⟳')
  check(button !== undefined, 'the panel offers an explicit way to re-read the device list')
  // A live list read a moment ago is not re-read on its own; asking outright must still work.
  equal(again.filter((call) => call.method === 'destinations').length, 0, 'nothing is asked for on its own')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  equal(again.filter((call) => call.method === 'destinations').length, 1,
    'the button asks the host regardless of how recently the list was read')
}

section('a cached list for another scheme is not painted')
{
  // Destinations follow the scheme: a scheme that only builds for simulators must not
  // be shown the previous scheme's hardware just because it is cached.
  const workspace = '/Users/mac/Project/Other'
  const project = `${workspace}/Other.xcworkspace`
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [workspace]: {
      scheme: 'Two',
      info: { kind: 'workspace', root: workspace, location: project, name: 'Other', schemes: ['One', 'Two'], configurations: ['Debug'], sweetpadDefaults: {} },
      destinations: {
        scheme: 'One',
        list: [{ destination: 'id=STALE', kind: 'device', name: 'iPhone 12', os: '26.6.2', placeholder: false }],
        recommended: 'id=STALE',
        at: Date.now() - 1000,
      },
    },
  }))
  const calls = serve({
    state: () => ({ workspace, activeRunId: null, runs: [] }),
    projects: () => { throw new Error('the stored project must not be searched for again') },
    detect: (body) => ({
      kind: 'workspace', root: workspace, location: body.path, name: 'Other',
      schemes: ['One', 'Two'], configurations: ['Debug'], sweetpadDefaults: {},
    }),
    destinations: () => ({ destinations: [], recommended: '' }),
  })
  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'session-other-scheme' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  equal(Array.from(container.querySelectorAll('.xcb-select.dest option')).map((node) => node.textContent),
    ['no destinations'], 'scheme Two is not shown scheme One\'s cached device list')
  check(calls.some((call) => call.method === 'destinations'), 'and the command still ran')
}

// =========================================================================
// Naming the session. With better-sidebar installed the panel is rendered by
// the dock tab, and that tab's `scope` is the only place the dockside session
// came from — until it arrives without one, at which point every read went out
// unnamed and the host answered with its own launch directory. The header seat
// is mounted in every shell and always knows its session; it now covers that gap
// without ever overriding the seat the user is actually looking at.
// =========================================================================

section('the header seat names the session the dock cannot')
{
  const workspace = '/Users/example/HeaderProject'
  const calls = serve({
    state: (body) => ({ workspace: body.sessionId === 'sess-header' ? workspace : '/launch-root', activeRunId: null, runs: [] }),
    projects: () => ({ candidates: [], root: workspace }),
    detect: (body) => ({ kind: 'workspace', root: workspace, location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
  })

  const instance = mount({ dock: {} })
  const descriptor = instance.registered[0]
  const toggle = instance.components.get('dsh-xcodebuild-toggle')

  // A tab the dock opened without a scope: exactly the shape that produced the
  // launch-root workspace.
  const { root } = await render([
    React.createElement(descriptor.component, { key: 'tab' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-header' }),
  ])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })

  const stateCalls = () => calls.filter((call) => call.method === 'state')
  // This suite mounts many instances against one shared module closure, and the
  // earlier sections' timers keep running (their fakes never dispose). Only the
  // calls naming one of THIS section's sessions are ours to judge.
  const mine = () => stateCalls().filter((call) => String(call.body.sessionId ?? '').startsWith('sess-'))

  check(stateCalls().length >= 1, 'the panel reads state on mount')
  check(mine().some((call) => call.body.sessionId === 'sess-header'),
    'an unscoped dock tab still reads under the header seat\'s session',
    JSON.stringify(mine().map((call) => call.body)))
  check(!mine().some((call) => call.body.sessionId === undefined),
    'and never asks the host to guess, which is what produced launch-root')

  // The dock is authoritative when it does speak.
  await act(async () => {
    root.render([
      React.createElement(descriptor.component, { key: 'tab', scope: { sessionId: 'sess-dock' } }),
      React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-header' }),
    ])
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  equal(mine().slice(-1)[0]?.body.sessionId, 'sess-dock',
    'the dock tab\'s scope wins once it names a session')

  // A scope that arrives empty is not a reason to forget the session the dock
  // itself just named — the panel would fall back to an unnamed read again.
  await act(async () => {
    root.render([
      React.createElement(descriptor.component, { key: 'tab', scope: {} }),
      React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-header' }),
    ])
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  equal(mine().slice(-1)[0]?.body.sessionId, 'sess-dock',
    'an empty scope does not wipe the session already established')

  await act(async () => { root.unmount() })
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('client interaction OK')
process.exit(0)
