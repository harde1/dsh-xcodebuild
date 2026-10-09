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
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = ['app', 'app.asar.unpacked']
  .map((dir) => `/Applications/DSH Desktop.app/Contents/Resources/${dir}/node_modules`)
  .find((dir) => existsSync(join(dir, 'jsdom'))) ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules'
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
 * `dock` supplies the better-sidebar service when given, `sidebarRight` the
 * official right sidebar's tab registry. Omitting both is the shell with neither
 * sidebar — the case the header button and the overlay exist for.
 *
 * The two services are answered in the order the plugin asked for them, which is
 * the fallback first and the dock second, so every mount exercises the handover
 * `syncSeats` exists for. `seatOrder` reorders them for the other arrival order.
 */
function mount({ dock, sidebarRight, seatOrder } = {}) {
  const components = new Map()
  // Keyed seats reach this map by `id` or by `key` — and two seats of the plugin can
  // share a key (a tab type's body and its chip are the same id in two slots), so the
  // exact seat is looked up through `bySeat`, by slot name and cell.
  const bySeat = new Map()
  const seats = []
  const effects = []
  const registered = []
  const opened = []
  const rightTypes = []
  const rightLive = []
  const liveSeats = []
  const givenBack = []
  const pending = []
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

  // The official registry's contract that matters here: `register` records the
  // definition and returns an idempotent disposer, and an id registered twice is a
  // wiring mistake rather than something to paper over.
  const registry = sidebarRight
    ? {
        register(definition) {
          if (rightTypes.some((type) => type.id === definition.id)) {
            throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
          }
          rightTypes.push(definition)
          rightLive.push(definition.id)
          let live = true
          return () => {
            if (!live) return
            live = false
            rightLive.splice(rightLive.indexOf(definition.id), 1)
            givenBack.push(definition.id)
          }
        },
      }
    : undefined

  const scopeEffect = (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  }

  const ctx = {
    slots: {
      inject(slotName, register) {
        seats.push(slotName)
        liveSeats.push(slotName)
        const dispose = register()
        return () => {
          liveSeats.splice(liveSeats.indexOf(slotName), 1)
          givenBack.push(slotName)
          if (typeof dispose === 'function') dispose()
        }
      },
      register(spec, component) {
        // A keyed seat names its cell with `key`; the plugin's own seats use `id`.
        const seat = { spec, component }
        components.set(spec.id ?? spec.key, seat)
        bySeat.set(`${spec.name}#${spec.id ?? spec.key}`, seat)
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
    inject(services, callback) {
      pending.push({ services, callback })
    },
  }

  client.apply(ctx)

  const scopes = {
    betterSidebar: service === undefined ? null : { betterSidebar: service, effect: scopeEffect },
    sidebarRightTabs: registry === undefined ? null : { sidebarRightTabs: registry, effect: scopeEffect },
  }
  for (const key of seatOrder ?? ['sidebarRightTabs', 'betterSidebar']) {
    const call = pending.find((entry) => entry.services.includes(key) && scopes[key] !== null && entry.done !== true)
    if (call === undefined) continue
    call.done = true
    call.callback(scopes[key])
  }

  return {
    components,
    bySeat,
    seats,
    registered,
    opened,
    rightTypes,
    rightLive,
    liveSeats,
    givenBack,
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
/** Let the drawer's own state poll run once, so a change in the fixture's session state shows. */
async function refreshLldbIn() {
  await new Promise((resolve) => setTimeout(resolve, 1600))
}

function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  if (key === undefined) throw new Error('React stored no props on this node')
  return node[key]
}

const buttonNamed = (container, label) => Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === label)

/** Mount an app the way a person does: Apps, then the first running app in the list. */
async function mountApp(container) {
  await act(async () => {
    propsOf(buttonNamed(container, 'Apps')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  await act(async () => {
    propsOf(container.querySelector('.xcb-lldb-apps-row')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
}

const APPS = [{ pid: 13290, name: 'HIDProbe', path: '/private/var/containers/Bundle/Application/X/HIDProbe.app/HIDProbe' }]
const MOUNTED = { state: 'running', detail: '', pid: 13290, target: 'HIDProbe', attached: { kind: 'device', id: 'u', name: 'HIDProbe', mode: 'attach' }, lineCount: 1, firstAvailable: 1 }

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
  // The debugger's handle is in the STATUS row, not the head: the tab strip closes the
  // panel, so a handle that only existed in the head would leave a docked panel — the
  // usual seat — with no way to open the drawer at all.
  const dockedLldb = container.querySelector('.xcb-lldb-toggle')
  check(dockedLldb !== null, 'the docked panel still carries the LLDB handle')
  check(dockedLldb?.textContent === 'LLDB', 'and it reads LLDB')
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

  section('the header control is a glyph, not a word')
  const button = container.querySelector('.xcb-trigger')
  check(button !== null, 'the header seat draws a control at all')
  equal(button.textContent.trim(), '', 'it carries no text label')
  check(button.querySelector('.xcb-mark') !== null, 'it draws its mark instead')
  equal(button.getAttribute('aria-label'), 'XcBuild panel',
    'the mark keeps an accessible name, which is the only place the name is left')
  equal(button.getAttribute('aria-pressed'), 'false', 'and reports its state — closed')
  check(button.querySelector('.xcb-dot') !== null, 'the build status is still on the control')

  section('click "XcBuild"')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  check(container.querySelector('.xcb-panel') !== null, 'the panel opens on the first click')
  check(button.className.includes('on') === true, 'the toggle shows its open state')
  equal(button.getAttribute('aria-pressed'), 'true', 'and reports its state — open')

  section('the two marks on screen are one drawing')
  const pen = (svg) => Array.from(svg.querySelectorAll('path'))
    .map((node) => node.getAttribute('d')).join('|')
  const buttonMark = container.querySelector('.xcb-trigger svg.xcb-mark')
  const headMark = container.querySelector('.xcb-head svg.xcb-mark')
  check(buttonMark !== null && headMark !== null,
    'the header entry and the floating head both draw the mark')
  equal(pen(headMark), pen(buttonMark), 'and it is the same drawing, so the plugin looks like itself in both')

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
// The shell has the official right sidebar: it owns the panel the same way the
// dock does, and the header button goes away for the same reason.
// =========================================================================

section('with the official right sidebar and no better-sidebar')
{
  const calls = serve({
    state: () => ({ workspace: '/Users/mac/Project/Gemoy', activeRunId: null, runs: [] }),
    projects: () => ({ root: '/Users/mac/Project/Gemoy', truncated: false, candidates: [] }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({ sidebarRight: true })
  equal(instance.registered.length, 0, 'nothing is contributed to a dock the shell does not have')
  equal(instance.liveSeats, ['shell.overlay', 'conversation.session.header.utilities',
    'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    'the fallback seats stay, and the official sidebar gets the tab body and its chip')
  equal(instance.rightLive, ['dsh-xcodebuild'], 'exactly one tab type is held by the official sidebar')

  const type = instance.rightTypes[0]
  equal(type.id, 'dsh-xcodebuild', 'the type id is the plugin id, which is also the body seat key')
  equal(type.kind, 'xcodebuild', 'under a kind of its own, so no builtin type is taken over')
  equal(type.priority, 'extension', 'contributed in the band a plugin belongs to')
  equal(type.title(), 'XcBuild', 'titled like the dock tab')
  equal(type.guide.length, 1, 'with one Guide capsule: that is how a shell with no dock discovers it')
  equal(type.guide[0].title(), 'XcBuild', 'named the same there')
  equal(typeof type.guide[0].description(), 'string', 'and described for the Guide')

  const body = instance.bySeat.get('sidebar.right.pane.tab#dsh-xcodebuild')
  const chip = instance.bySeat.get('sidebar.right.pane.tab.title#dsh-xcodebuild')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  check(body !== undefined && chip !== undefined && toggle !== undefined, 'all three seats are filled')

  const { container } = await render([
    React.createElement(body.component, { key: 'body', sessionId: 'session-gemoy' }),
    React.createElement(chip.component, { key: 'chip' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-gemoy' }),
  ])
  check(container.textContent.includes('XcBuild'), 'the chip names the tab')

  const docked = container.querySelector('.xcb-panel')
  check(docked !== null, 'the tab body is the panel')
  check(docked?.className.includes('docked') === true, 'laid out to fill the tab, not to float')
  check(container.querySelector('.xcb-head') === null, 'with no head row: the shell draws the tab chip and its close button')
  check(container.querySelector('.xcb-trigger') === null,
    'and no header button, because the sidebar offers the tab itself')

  // The official sidebar's tab bodies are session-scoped, and this panel's whole
  // point is that it works on the session it was opened in.
  check(calls.some((call) => call.method === 'state' && call.body.sessionId === 'session-gemoy'),
    'the tab named its session, so the panel read that workspace')

  section('the header seat is still registered, so a shell without any sidebar keeps its button')
  const neither = mount({})
  const bothSeats = neither.components.get('dsh-xcodebuild-toggle')
  const fallback = await render([React.createElement(bothSeats.component, { key: 't', sessionId: 's2' })])
  check(fallback.container.querySelector('.xcb-trigger') !== null, 'with neither sidebar, the button is drawn')
}

section('both sidebars: better-sidebar keeps the panel, the official seat is given back')
{
  const instance = mount({ dock: {}, sidebarRight: true })
  equal(instance.registered.length, 1, 'the dock tab is registered')
  // The official service answered first here, so the fallback seat really was taken
  // — and the dock's arrival is what has to take it back.
  equal(instance.rightTypes.length, 1, 'the official seat was taken while it was the only sidebar')
  equal(instance.rightLive, [], 'and is not held once the dock turns out to be in charge')
  equal(instance.liveSeats, ['shell.overlay', 'conversation.session.header.utilities'],
    'so the header/overlay fallback is what is left, with no body seat behind it')
  check(instance.givenBack.includes('dsh-xcodebuild'), 'the type it had registered was given back')
  check(instance.givenBack.includes('sidebar.right.pane.tab'), 'and so was the body seat')

  section('and the other arrival order settles the same way')
  const reversed = mount({ dock: {}, sidebarRight: true, seatOrder: ['betterSidebar', 'sidebarRightTabs'] })
  equal(reversed.registered.length, 1, 'the dock tab is registered')
  equal(reversed.rightTypes.length, 0, 'the official sidebar is never registered with')
  equal(reversed.givenBack.length, 0, 'and nothing had to be given back, because nothing was taken')
}

// =========================================================================
// One mark, every seat: the plugin is recognised by the same drawing wherever
// it is docked, and each surface asks for it in its own shape.
// =========================================================================

section('one mark for the header button, the dock tab, the Guide and the chip')
{
  // Compared by the drawing, not by the wrapper: the seats ask for different sizes,
  // and the chip adds a layout class, but the path has to be the same one. That is
  // what "the plugin's mark" means.
  const drawing = (svg) => Array.from(svg.querySelectorAll('path'))
    .map((node) => node.getAttribute('d'))
    .join('|')

  const docked = mount({ dock: {} }).registered[0]
  check(typeof docked.icon === 'function', 'the dock tab is registered with an icon')

  const official = mount({ sidebarRight: true })
  const type = official.rightTypes[0]
  const chip = official.bySeat.get('sidebar.right.pane.tab.title#dsh-xcodebuild')
  // The header seat, from the mount where no sidebar owns the panel — that is the only
  // shell in which it draws anything at all.
  const plain = mount({})
  const toggle = plain.components.get('dsh-xcodebuild-toggle')

  const { container } = await render([
    // better-sidebar's contract: `icon(size)` — the function is called, not rendered.
    docked.icon(16),
    // The shell's Guide contract: `entry.icon` drawn as a component with `{size}`.
    React.createElement(type.guide[0].icon, { key: 'guide', size: 22 }),
    React.createElement(toggle.component, { key: 'header' }),
    React.createElement(chip.component, { key: 'chip' }),
  ])

  const marks = Array.from(container.querySelectorAll('svg.xcb-mark'))
  equal(marks.length, 4, 'all four seats drew the mark')
  equal(new Set(marks.map(drawing)).size, 1, 'and every one of them is the same drawing')
  equal(marks.map((node) => node.getAttribute('width')), ['16', '22', '20', '16'],
    'each at the size its own seat draws')

  const fills = marks.map((node) => node.querySelector('path').getAttribute('fill'))
  equal(new Set(fills).size, 4,
    'each drawing declares its own gradient, so one seat cannot resolve to another seat\'s')
  check(fills.every((fill) => /^url\(#xcb-emblem-[A-Za-z0-9_-]+\)$/.test(fill)),
    'and references it by a plain, url()-safe id')

  section('the chip carries the name as well')
  const chipRender = await render([React.createElement(chip.component, { key: 'chip' })])
  check(chipRender.container.textContent.includes('XcBuild'), 'the chip is mark plus the registered name')
  check(chipRender.container.querySelector('svg.xcb-mark.chip') !== null,
    'with the chip layout class, so a long title shrinks and the mark does not')
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

section('an app that died is not a run that is still working')
{
  // The pill the panel used to show for a crashed launch: `running`, with the dot the
  // session earns, while the phone held no such process. The host now puts the console's
  // verdict on the run (`lib/app-death.js`), and this is what the panel does with it.
  serve({
    state: () => ({ workspace: '/tmp', activeRunId: 'run-died', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0
        ? [
            { n: 0, k: 'plain', t: 'Launched application with com.example.demo bundle identifier.' },
            { n: 1, k: 'error', t: '*** Terminating app due to uncaught exception \'NSInvalidArgumentException\'' },
          ]
        : [],
      next: 2,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 4100,
      note: 'the app crashed on the device (*** Terminating app due to uncaught exception …)',
      death: { outcome: 'crashed', evidence: 'PROCESS_CRASHED', at: 1, fatal: true },
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'session-died' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  const dot = container.querySelector('.xcb-status .xcb-dot')
  check(dot !== null, 'the status row has its dot')
  check(dot !== null && dot.className.includes('failed'),
    'a dead app shows the failure dot even though the session is still attached',
    dot === null ? '(no dot)' : dot.className)
  check(dot !== null && dot.className.includes('running') === false,
    'and never the dot that means "still working"')
  check(/app died/.test(container.querySelector('.xcb-status').textContent) === true,
    'the status row says the app died rather than that the run is running',
    container.querySelector('.xcb-status').textContent)
  const note = container.querySelector('.xcb-status .xcb-note')
  check(note !== null && note.className.includes('died') === true,
    'the reason is set apart, not left as one faint fact among the quiet ones',
    note === null ? '(no note)' : note.className)
  check(note !== null && /crashed on the device/.test(note.textContent) === true,
    'and it carries the verdict the console gave', note === null ? '(no note)' : note.textContent)
  // The closed panel is the other place the status is read from.
  check(container.querySelector('.xcb-trigger .xcb-dot').className.includes('failed') === true,
    'the header entry shows the same dot with the panel closed')

  // The other half of the rule: an app the user quit is not a failure, and painting it
  // red would make the panel cry wolf about the most ordinary ending there is.
  serve({
    state: () => ({ workspace: '/tmp', activeRunId: 'run-quit', runs: [] }),
    poll: (body) => ({
      missing: false,
      lines: body.from === 0 ? [{ n: 0, k: 'note', t: 'PROCESS_EXITED' }] : [],
      next: 1,
      status: 'running',
      exitCode: null,
      warningCount: 0,
      errors: [],
      durationMs: 8000,
      note: 'the app exited on the device — the run delivered what its action promised',
      death: { outcome: 'exited', evidence: 'PROCESS_EXITED', at: 2, fatal: false },
    }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
  })
  const quit = mount({})
  const quitOverlay = quit.components.get('dsh-xcodebuild-panel')
  const quitToggle = quit.components.get('dsh-xcodebuild-toggle')
  const quitRender = await render([
    React.createElement(quitOverlay.component, { key: 'overlay' }),
    React.createElement(quitToggle.component, { key: 'toggle', sessionId: 'session-quit' }),
  ])
  await act(async () => {
    quitRender.container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  const quitStatus = quitRender.container.querySelector('.xcb-status')
  const quitDot = quitStatus.querySelector('.xcb-dot')
  check(quitDot.className.includes('failed') === false, 'an app the user quit is not painted as a failure', quitDot.className)
  check(/app died/.test(quitStatus.textContent) === false, 'and the row does not claim it died')
  const quitNote = quitStatus.querySelector('.xcb-note')
  check(quitNote !== null && quitNote.className.includes('died') === false,
    'its note stays the ordinary kind', quitNote === null ? '(no note)' : quitNote.className)
}

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

section('the run log has the same right-click menu as the debugger transcript')
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
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'sess-runmenu' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  const log = container.querySelector('.xcb-log')
  check(log !== null && container.querySelectorAll('.xcb-line').length > 0, 'the run log has lines to begin with')
  await act(async () => { propsOf(log).onContextMenu({ preventDefault() {}, clientX: 50, clientY: 60, currentTarget: log }) })
  const menu = container.querySelector('.xcb-log-ctxmenu')
  check(menu !== null && menu.className.includes('xcb-ctxmenu'), 'a right-click opens the shared menu, fixed above the panel')
  equal(Array.from(menu?.querySelectorAll('.xcb-ctxmenu-item') ?? []).map((item) => item.firstChild.textContent),
    ['Select All', 'Copy', 'Clear'], 'with the same three entries')
  equal([menu?.style.left, menu?.style.top], ['50px', '60px'], 'at the pointer')
  const lastBefore = Math.max(...Array.from(container.querySelectorAll('.xcb-line .xcb-num')).map((node) => Number(node.textContent)))
  await act(async () => { propsOf(Array.from(menu.querySelectorAll('.xcb-ctxmenu-item')).find((item) => item.textContent === 'Clear')).onClick() })
  equal(container.querySelectorAll('.xcb-line').length, 0, 'Clear empties the run log, as the toolbar Clear does')
  check(container.querySelector('.xcb-log-ctxmenu') === null, 'and the menu closes')
  // The baseline moved with it: what arrives next is new, the cleared lines do not return.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  const numbers = Array.from(container.querySelectorAll('.xcb-line .xcb-num')).map((node) => Number(node.textContent))
  check(numbers.length > 0 && numbers.every((n) => n > lastBefore),
    'new lines still arrive after it, and the cleared ones stay gone', `${numbers.join(',')} after ${String(lastBefore)}`)
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

section('a cached list does not outrank the remembered choice')
{
  // The panel stores the last destination LIST too, so a return visit can paint something before
  // `-showdestinations` answers. That cache carries the recommendation of the day — and painting
  // from it used to overwrite the workspace's own choice, so the host was told to prefer a guess
  // over explicit intent. Which is exactly what "it stopped remembering my device" looked like.
  const ROOT = '/tmp/xcb-remember-cached'
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('dsh-xcodebuild:selections', JSON.stringify({
    [ROOT]: {
      location: `${ROOT}/App.xcworkspace`,
      scheme: 'App',
      destination: 'platform=iOS Simulator,id=CHOSEN',
      destinations: {
        scheme: 'App',
        at: 1,
        recommended: 'platform=iOS,id=SOME-PHONE',
        list: [
          { kind: 'device', id: 'SOME-PHONE', name: 'someone iPhone', placeholder: false, destination: 'platform=iOS,id=SOME-PHONE' },
          { kind: 'simulator', id: 'CHOSEN', name: 'iPhone 17', placeholder: false, destination: 'platform=iOS Simulator,id=CHOSEN' },
        ],
      },
    },
  }))

  const calls = serve({
    state: () => ({ workspace: ROOT, activeRunId: null, runs: [] }),
    projects: () => ({ root: ROOT, truncated: false, candidates: [{ kind: 'workspace', name: 'App', location: `${ROOT}/App.xcworkspace`, relative: 'App.xcworkspace', depth: 0 }] }),
    detect: (body) => ({ kind: 'workspace', root: ROOT, location: body.path, name: 'App', schemes: ['App'], configurations: ['Debug'], sweetpadDefaults: {} }),
    destinations: (body) => ({
      destinations: [
        { kind: 'device', id: 'SOME-PHONE', name: 'someone iPhone', placeholder: false, destination: 'platform=iOS,id=SOME-PHONE' },
        { kind: 'simulator', id: 'CHOSEN', name: 'iPhone 17', placeholder: false, destination: 'platform=iOS Simulator,id=CHOSEN' },
      ],
      // The host honours what the panel asks for, which is the point: the panel has to ask.
      recommended: body.preferred || 'platform=iOS,id=SOME-PHONE',
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
  await act(async () => { propsOf(path).onChange({ target: { value: ROOT } }) })
  await act(async () => {
    propsOf(path).onBlur()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  equal(calls.find((call) => call.method === 'destinations')?.body.preferred,
    'platform=iOS Simulator,id=CHOSEN',
    'the panel asks the host for the workspace choice, not for the cached recommendation')
  equal(container.querySelector('.xcb-select.dest')?.value, 'platform=iOS Simulator,id=CHOSEN',
    'and the control shows the choice that was remembered')
}

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

// =========================================================================
// The LLDB drawer: hidden by default, opened by hand or by the model.
// =========================================================================

section('the LLDB drawer')
{
  /** A view tree as the host sends it: records with depth, class, frame and text. */
  const RECORDS = [
    { depth: 0, className: 'UIWindow', address: '0x1', frame: { x: 0, y: 0, width: 390, height: 844 }, text: '', hidden: false, attributes: {} },
    { depth: 1, className: 'UIStackView', address: '0x2', frame: { x: 0, y: 55, width: 366, height: 747 }, text: '', hidden: false, attributes: { axis: 'vert', distribution: 'fill' } },
    { depth: 2, className: 'Example.StatusLight', address: '0x3', frame: { x: 0, y: 0, width: 116.667, height: 44 }, text: '● GC 键盘', hidden: false, attributes: {} },
    // A second branch, so a filter has something to drop.
    { depth: 1, className: 'UILabel', address: '0x4', frame: { x: 0, y: 200, width: 40, height: 20 }, text: 'other', hidden: true, attributes: {} },
  ]
  const TREE = {
    ok: true,
    reused: true,
    target: { kind: 'device', destination: 'platform=iOS,id=u', process: 'HIDProbe', bundleId: 'com.example.HIDProbe', runId: 'xr1' },
    views: 4,
    depth: 2,
    classes: [{ className: 'UIWindow', count: 1 }],
    shown: 4,
    truncated: false,
    records: RECORDS,
    lookinPath: '/tmp/dsh-xcodebuild/lookin-2026-09-29T14-50-01.lookin',
    // Lookin.app is installed on this host, so the slot offers to open the file in it.
    lookinAvailable: true,
    session: { state: 'stopped', detail: '', pid: 13290, target: 'HIDProbe', attached: { kind: 'device', id: 'u', name: 'HIDProbe', mode: 'attach' }, lineCount: 3, firstAvailable: 1 },
  }
  let sessionActive = false
  let fullJob = null
  // What the inspector asked for, and the edits it sent: the ops are the whole contract between the
  // panel and the app, so the tests read them the way the host would.
  const attributeReads = []
  const edits = []
  let editSticks = true
  let history = [
    { name: 'lookin-2026-10-08T10-30-05-full.lookin', kind: 'full', app: '蜜语-Dev', views: 412, images: 398, created: '2026-10-08T10:30:05.000Z', bytes: 3 * 1024 * 1024 },
    { name: 'lookin-2026-10-08T09-00-00-quick.lookin', kind: 'quick', app: '蜜语-Dev', views: 410, images: 0, created: '2026-10-08T09:00:00.000Z', bytes: 90 * 1024 },
  ]
  // Which host the fixture is pretending to be: one with Lookin.app, or one without. Flipped
  // inside the flow below, because that is exactly what a re-read after installing it looks like.
  let lookinAvailable = true
  // Two states the fixture can be moved between, so Continue and Interrupt can each be
  // seen to appear when the app is in the state that button is for.
  let sessionState = 'stopped'
  const transcript = [{ n: 1, t: 'Process 13290 stopped' }, { n: 2, t: 'Target 0: (HIDProbe) stopped.' }]
  // The host's line count rides on every summary: it is how the panel tells a fresh answer from a
  // snapshot taken before lines it has already shown.
  const sessionAt = (state) => ({ ...TREE.session, state, lineCount: transcript.length })
  let staleSnapshot = null
  const calls = serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    lldb: (body) => {
      // Like the host: taking a dump leaves a session behind, so the state poll that
      // follows it agrees with the dump's own answer instead of contradicting it.
      if (body.op === 'processes') return { ok: true, processes: APPS, note: '' }
      if (body.op === 'attach') { sessionActive = true; sessionState = 'running'; return { ok: true, note: '', continued: true, session: sessionAt('running') } }
      if (body.op === 'detach') { sessionState = 'idle'; return { ok: true, note: '', session: sessionAt('idle') } }
      if (body.op === 'view') { sessionActive = true; sessionState = 'stopped'; return { ...TREE, lookinAvailable } }
      if (body.op === 'lookin') return { ok: true, path: TREE.lookinPath, note: 'opened in Lookin', session: sessionAt(sessionState) }
      if (body.op === 'lookinFull') { fullJob = { id: 1, stage: 'rendering', done: 40, total: 120, percent: 31, note: '', path: null, name: '', finished: false, cancelled: false, failed: false }; return { ok: true, job: fullJob } }
      if (body.op === 'lookinJob') return { ok: true, job: fullJob }
      if (body.op === 'lookinCancel') { fullJob = { ...fullJob, cancelled: true, note: 'cancelling' }; return { ok: true, job: fullJob } }
      if (body.op === 'lookinHistory') return { ok: true, entries: history, keep: 3 }
      if (body.op === 'lookinOpenFile') return { ok: true, note: 'opened in /Applications/Lookin.app', path: body.name }
      if (body.op === 'lookinDelete') { history = history.filter((entry) => entry.name !== body.name); return { ok: true, entries: history, note: 'deleted' } }
      if (body.op === 'command') return { ok: true, note: '', output: '2', session: staleSnapshot ?? sessionAt(sessionState) }
      if (body.op === 'node') {
        return {
          ok: true,
          address: body.address,
          className: 'Example.StatusLight',
          // A one-pixel PNG, so the panel is provably rendering the bytes it was handed.
          image: { solo: 'data:image/png;base64,iVBORw0KGgo=', group: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
          color: { css: 'rgba(255, 0, 0, 0.5)', name: '', raw: '<UIDeviceRGBColor: 0x1; red = 1; green = 0; blue = 0; alpha = 0.5>' },
          rows: [{ label: 'Class', value: 'Example.StatusLight' }, { label: 'Frame', value: '0, 0  116.667×44' }],
          note: '',
        }
      }
      if (body.op === 'attributes') {
        attributeReads.push({ address: body.address, refresh: body.refresh === true })
        return {
          ok: true,
          address: body.address,
          className: 'UILabel',
          attributes: 5,
          note: '',
          session: sessionAt(sessionState),
          groups: [
            {
              name: 'UILabel',
              rows: [
                { name: '_text', type: 'NSString*', value: '"row 0"', depth: 0, edit: { kind: 'text', value: 'row 0', key: 'text' } },
                { name: '_numberOfLines', type: 'long', value: '1', depth: 0, edit: { kind: 'number', value: 1, key: 'numberOfLines' } },
              ],
            },
            {
              name: 'UIView',
              rows: [
                { name: '_backgroundColor', type: 'UIColor*', value: '<UIDeviceRGBColor: 0x1; red = 1; green = 0.5; blue = 0; alpha = 1>', depth: 0, edit: { kind: 'color', value: '#ff8000ff', key: 'backgroundColor' } },
                { name: '_viewFlags', type: 'struct ?', value: '{', depth: 0, edit: { kind: 'none', value: null } },
                { name: 'bounds', type: 'struct CGRect', value: '{{0, 0}, {200, 20}}', depth: 1, edit: { kind: 'none', value: null } },
              ],
            },
          ],
        }
      }
      if (body.op === 'constraints') {
        return {
          ok: true,
          address: body.address,
          note: '',
          session: sessionAt(sessionState),
          layout: {
            masked: false,
            ambiguous: true,
            intrinsic: { width: 42.66666666666666, height: 20.33333333333333 },
            hugging: [250, 250],
            resistance: [750, 750],
            own: ['<NSLayoutConstraint:0x6000001 UILabel:0x2.width == 200   (active)>'],
            referencing: ['<NSLayoutConstraint:0x6000002 H:|-(12)-[UILabel:0x2]   (active)>'],
          },
        }
      }
      if (body.op === 'edit') {
        edits.push(body)
        // A setter that does not stick — the case a debugger has to own up to, because the app
        // writes the value back in its own layout pass.
        const kept = editSticks ? body.value : 1
        return {
          ok: true,
          address: body.address,
          key: body.key,
          value: typeof kept === 'number' ? String(kept) : JSON.stringify(kept),
          note: '',
          session: sessionAt(sessionState),
          groups: [
            {
              name: 'UILabel',
              rows: [
                { name: '_text', type: 'NSString*', value: '"row 0"', depth: 0, edit: { kind: 'text', value: 'row 0', key: 'text' } },
                { name: '_numberOfLines', type: 'long', value: String(typeof kept === 'number' ? kept : 1), depth: 0, edit: { kind: 'number', value: Number(kept), key: 'numberOfLines' } },
              ],
            },
          ],
        }
      }
      if (body.op === 'continue') { sessionState = 'running'; return { ok: true, note: 'the app is running again, still attached', session: sessionAt('running') } }
      if (body.op === 'interrupt') { sessionState = 'stopped'; return { ok: true, note: '', session: sessionAt('stopped') } }
      if (!sessionActive) return { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }
      // A forward-only cursor, like the host's: only lines at or after `from` come back.
      const from = Number.isFinite(body.from) ? body.from : 0
      return { active: true, session: sessionAt(sessionState), next: transcript.length + 1, firstAvailable: 1, lines: transcript.filter((line) => line.n >= from) }
    },
  })

  const instance = mount({})
  const overlay = instance.components.get('dsh-xcodebuild-panel')
  const toggle = instance.components.get('dsh-xcodebuild-toggle')
  const { container } = await render([
    React.createElement(overlay.component, { key: 'overlay' }),
    React.createElement(toggle.component, { key: 'toggle', sessionId: 'lldb-drawer' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })

  // Hidden by default, with a handle that says so.
  check(container.querySelector('.xcb-lldb') === null, 'the drawer is not on screen until it is asked for')
  const handle = container.querySelector('.xcb-lldb-toggle')
  check(handle !== null && handle.textContent === 'LLDB', 'a status-row LLDB button is the handle', handle === null ? '(none)' : handle.textContent)

  // The keyboard chord opens it, and it is its own panel, not the log's.
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }))
  })
  check(container.querySelector('.xcb-lldb') !== null, 'Command-L opens the drawer')
  equal(container.querySelectorAll('.xcb-line').length, 0, 'and it is not a log row: it uses its own classes')
  // Nothing is mounted yet, so the way to mount something is offered — and View Hierarchy with it,
  // because that press is what attaches: the empty tree names it, and a named button that is not on
  // screen is how the drawer came to say "press View Hierarchy" with no such button in it.
  check(buttonNamed(container, 'Apps') !== undefined, 'with no app mounted, Apps is offered')
  check(buttonNamed(container, 'View Hierarchy') !== undefined,
    'and View Hierarchy is offered too: pressing it is what attaches')
  check(buttonNamed(container, 'Lookin') === undefined, 'while Lookin is not, because there is nothing to open yet')
  check(container.textContent.includes('Apps picks one that is running now'),
    'and the empty tree names the buttons that are on screen')

  await mountApp(container)
  const attachCall = calls.filter((call) => call.method === 'lldb' && call.body.op === 'attach').at(-1)
  check(attachCall !== undefined && attachCall.body.pid === 13290 && attachCall.body.process === 'HIDProbe',
    'picking an app attaches to that process', JSON.stringify(attachCall?.body))
  equal(attachCall?.body.continue, true, 'and asks for it to keep running once mounted')
  check(buttonNamed(container, 'Apps') === undefined, 'once mounted, Apps goes away')
  check(buttonNamed(container, 'Lookin') !== undefined, 'and Lookin is offered')

  // The priority feature: one click reads the running app's view tree.
  const viewButton = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'View Hierarchy')
  check(viewButton !== undefined, 'there is a View Hierarchy button')
  await act(async () => {
    propsOf(viewButton).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  check(calls.some((call) => call.method === 'lldb' && call.body.op === 'view'), 'it asks the host for the view hierarchy')
  equal(container.querySelectorAll('.xcb-lldb-row').length, 4, 'and every view is drawn')
  check(container.textContent.includes('4 views · 2 levels'), 'with the count of what was found', container.querySelector('.xcb-lldb-stats')?.textContent)
  check(container.querySelector('.xcb-lldb-state').textContent.includes('stopped'),
    'and the head says what the session is doing')
  check(container.querySelector('.xcb-lldb-state').textContent.includes('HIDProbe'),
    'and which process it has stopped')
  check(container.textContent.includes('● GC 键盘'), 'a label speaks for itself in the tree')
  check(container.textContent.includes('axis=vert'),
    'and a stack view says how it is laid out, which is usually why a screen looks wrong')
  const hiddenRow = Array.from(container.querySelectorAll('.xcb-lldb-row')).find((node) => node.className.includes('invisible'))
  check(hiddenRow !== undefined, 'a hidden view is drawn the way Lookin draws one: italic, and dimmed')
  // The row is the Lookin shape — a 15-pixel class icon, the class name, and a subtitle — and the
  // frame is the extra this panel can afford, since the dump already carried it.
  check(hiddenRow.querySelector('.xcb-lldb-icon') !== null, 'every row has a class icon')
  check(hiddenRow.querySelector('.xcb-lldb-frame') !== null, 'and the frame it was laid out in')
  const indent = (node) => Number(/padding-left:\s*(\d+)/.exec(node.getAttribute('style') ?? '')?.[1] ?? 0)
  const drawn = Array.from(container.querySelectorAll('.xcb-lldb-row'))
  check(indent(drawn[1]) > indent(drawn[0]), 'a child is indented under its parent', `${String(indent(drawn[1]))} > ${String(indent(drawn[0]))}`)
  equal(indent(drawn[1]) - indent(drawn[0]), 14, 'by Lookin\'s own 14 pixels per level')

  // The export is written as the tree is read, so the button opens a file that exists — and
  // the head knows which file, because the dump's own answer carried the path.
  // An operation's answer is a snapshot from when IT finished. The poll that ran meanwhile may
  // already know better — the app resumed, or was killed — and the late snapshot must not paint over
  // it: the light then said green while the transcript said `resuming`.
  {
    const saved = sessionState
    sessionState = 'running'
    staleSnapshot = { state: 'stopped', lineCount: 1 }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
    check(container.querySelector('.xcb-lldb-light.yellow') !== null, 'the poll shows the app running', container.querySelector('.xcb-lldb-light')?.className)
    // A command whose answer carries the session as it was BEFORE lines the drawer already showed.
    transcript.push({ n: transcript.length + 1, t: 'Process 13290 resuming' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
    staleSnapshot = { ...TREE.session, state: 'stopped', lineCount: 1 }
    const input = container.querySelector('.xcb-lldb-cmd')
    await act(async () => { propsOf(input).onChange({ target: { value: 'po 1' } }) })
    await act(async () => { propsOf(input).onKeyDown({ key: 'Enter', preventDefault() {} }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    check(container.querySelector('.xcb-lldb-light.green') === null, 'and an older snapshot arriving later does not turn it back to green',
      container.querySelector('.xcb-lldb-light')?.className)
    transcript.splice(2)
    staleSnapshot = null
    sessionState = saved
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })

  }
  // While attaching (the blinking yellow light) Lookin waits: both exports read the tree, which needs
  // the stop the attach has not delivered yet.
  {
    const saved = sessionState
    sessionState = 'attaching'
    await act(async () => { await refreshLldbIn(container) })
    const waiting = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Lookin')
    check(waiting !== undefined && waiting.disabled === true, 'during an attach the Lookin button cannot be pressed')
    check(waiting !== undefined && /attach/i.test(waiting.getAttribute('title') ?? ''),
      'and its title says it is waiting for the attach', waiting?.getAttribute('title'))
    check(container.querySelector('.xcb-lldb-light.blink') !== null, 'while the light blinks yellow')
    sessionState = saved
    await act(async () => { await refreshLldbIn(container) })
  }
  const lookinButton = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Lookin')
  check(lookinButton !== undefined, 'a read tree offers a Lookin button')
  check(lookinButton.disabled === false, 'and once the app is stopped it can be pressed again')
  check(lookinButton.className.includes('xcb-lldb-lookin'),
    'and it is the drawer\'s own control, not a log or run button', lookinButton.className)
  // Lookin opens a choice rather than a file: the tree alone, or the tree with every view rendered.
  await act(async () => { propsOf(lookinButton).onClick() })
  const choice = container.querySelector('.xcb-lookin-popup')
  check(choice !== null, 'clicking Lookin opens a popup to choose the export')
  check(choice !== null && choice.querySelector('.xcb-lookin-quick') !== null && choice.querySelector('.xcb-lookin-full') !== null,
    'which offers the quick and the full export')
  await act(async () => {
    propsOf(choice.querySelector('.xcb-lookin-quick')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const openCall = calls.filter((call) => call.method === 'lldb' && call.body.op === 'lookin').at(-1)
  check(openCall !== undefined, 'the quick choice asks the host to open the export the read wrote')
  equal(openCall?.body.open, true, 'and to open it, not merely report where it is')
  check(container.querySelector('.xcb-lookin-popup') === null, 'and the popup goes away')

  // The full export runs in the background: progress is shown, and it can be cancelled.
  await act(async () => { propsOf(Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Lookin')).onClick() })
  await act(async () => {
    propsOf(container.querySelector('.xcb-lookin-full')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const fullCall = calls.filter((call) => call.method === 'lldb' && call.body.op === 'lookinFull').at(-1)
  check(fullCall !== undefined, 'the full choice starts a background export on the host')
  const progress = container.querySelector('.xcb-lookin-progress')
  check(progress !== null && progress.textContent.includes('40/120') && progress.textContent.includes('31%'),
    'and its progress is shown, with the views rendered so far', progress === null ? '(none)' : progress.textContent)
  check(container.querySelector('.xcb-lookin-full').disabled === true, 'a second full export cannot be started over the first')
  check(container.querySelector('.xcb-lookin-job') !== null, 'the drawer itself says an export is running, popup or not')
  await act(async () => {
    propsOf(container.querySelector('.xcb-lookin-cancel')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  check(calls.some((call) => call.method === 'lldb' && call.body.op === 'lookinCancel'), 'Cancel asks the host to stop the export')
  equal(container.querySelector('.xcb-lookin-cancel')?.textContent, 'Cancelling...', 'and says it is cancelling until the host has let go')
  // The host finishes cancelling; the poll picks that up and the drawer stops saying it is busy.
  fullJob = { ...fullJob, stage: 'cancelled', finished: true, percent: 0, note: 'cancelled: the app was released and nothing was written' }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)) })
  check(container.querySelector('.xcb-lookin-job') === null, 'a finished export no longer shows as running')
  check(container.querySelector('.xcb-lookin-progress')?.textContent.includes('the app was released') === true,
    'and the popup says what the cancel did')
  await act(async () => { propsOf(Array.from(container.querySelectorAll('.xcb-lookin-popup .xcb-btn')).find((node) => node.textContent === 'Close')).onClick() })
  check(container.querySelector('.xcb-lookin-popup') === null, 'Close dismisses the popup')

  // History: the kept trees, newest first, each openable and deletable.
  await act(async () => {
    propsOf(Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'History')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  equal(container.querySelectorAll('.xcb-lookin-row').length, 2, 'History lists the kept trees')
  const firstRow = container.querySelector('.xcb-lookin-row')
  check(firstRow.textContent.includes('Full') && firstRow.textContent.includes('412 views') && firstRow.textContent.includes('398 images') && firstRow.textContent.includes('3.0 MB'),
    'each row says what it is', firstRow.textContent)
  await act(async () => {
    propsOf(firstRow.querySelector('.xcb-lookin-open')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  equal(calls.filter((call) => call.method === 'lldb' && call.body.op === 'lookinOpenFile').at(-1)?.body.name,
    'lookin-2026-10-08T10-30-05-full.lookin', 'Open asks for that row\'s file by name')
  await act(async () => {
    propsOf(container.querySelector('.xcb-lookin-row .xcb-lookin-delete')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  equal(calls.filter((call) => call.method === 'lldb' && call.body.op === 'lookinDelete').at(-1)?.body.name,
    'lookin-2026-10-08T10-30-05-full.lookin', 'Delete asks for that row by name')
  equal(container.querySelectorAll('.xcb-lookin-row').length, 1, 'and the row is gone from the list')
  await act(async () => { propsOf(container.querySelector('.xcb-lookin-popup')).onClick({ target: container.querySelector('.xcb-lookin-popup'), currentTarget: container.querySelector('.xcb-lookin-popup') }) })
  check(container.querySelector('.xcb-lookin-popup') === null, 'a click on the backdrop dismisses the history')

  // A dump stops the app, so the panel asks the host to let it go again as soon as the tree is in
  // hand: a frozen phone is a side effect of debugging, not something the user asked for.
  const readCall = calls.filter((call) => call.method === 'lldb' && call.body.op === 'view').at(-1)
  equal(readCall?.body.continue, true, 'a read asks the host to let the app run again afterwards')

  // Clicking a row asks about that one view and answers beside the tree: the control's own image
  // first, then the numbers behind it. This is the Lookin-shaped half of the drawer.
  await act(async () => {
    propsOf(container.querySelectorAll('.xcb-lldb-row')[1]).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const nodeCall = calls.filter((call) => call.method === 'lldb' && call.body.op === 'node').at(-1)
  check(nodeCall !== undefined, 'clicking a row asks the host about that view')
  equal(nodeCall.body.address, '0x2', 'naming the row that was clicked')
  // The inspector is beside the tree, headed by the class the row named and the chain of
  // ancestors that places it — window down to this view, each link a jump.
  const insp = container.querySelector('.xcb-lldb-insp')
  check(insp !== null, 'and an inspector appears beside the tree')
  check(insp.querySelector('.xcb-lldb-insp-head').textContent.includes('UIStackView'), 'naming the view the row named')
  equal(insp.querySelector('.xcb-lldb-pane') === null, true, 'beside the tree column, not over it')
  const chain = Array.from(insp.querySelectorAll('.xcb-lldb-chain-link')).map((node) => node.textContent)
  equal(chain.join(' > '), 'UIWindow > UIStackView', 'with the chain from the window down to it')
  // A link in the chain is a jump: clicking the window selects the window.
  await act(async () => { propsOf(insp.querySelectorAll('.xcb-lldb-chain-link')[0]).onClick() })
  equal(calls.filter((call) => call.method === 'lldb' && call.body.op === 'node').at(-1)?.body.address, '0x1',
    'clicking an ancestor in the chain asks about that ancestor')
  await act(async () => { propsOf(container.querySelectorAll('.xcb-lldb-row')[1]).onClick() })
  const previewTab = Array.from(insp.querySelectorAll('.xcb-lldb-tab')).find((node) => node.textContent === '预览')
  await act(async () => { propsOf(previewTab).onClick() })
  const detail = container.querySelector('.xcb-lldb-preview')
  check(detail !== null, 'and the preview pane opens')
  const shot = detail.querySelector('.xcb-lldb-preview-canvas img')
  check(shot !== null && shot.getAttribute('src') === 'data:image/png;base64,iVBORw0KGgo=',
    'showing its own image, not a crop of the screen', shot === null ? '(no image)' : shot.getAttribute('src'))
  check(detail.textContent.includes('Example.StatusLight'), 'naming the view the host answered about')
  check(detail.textContent.includes('0, 0  116.667×44'), 'with the frame from the host')
  check(detail.querySelector('.xcb-lldb-swatch') !== null, 'and a swatch for its background colour')
  check(container.querySelector('.xcb-lldb-row.picked') !== null, 'and the row it belongs to is marked as picked')
  const groupTab = detail.querySelector('.xcb-lldb-shot-group')
  await act(async () => { propsOf(groupTab).onClick() })
  equal(detail.querySelector('.xcb-lldb-preview-canvas img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    'the group toggle shows the control with its subtree instead')
  // Zoom is arithmetic on the transform, so it costs no round trip and no stop.
  const zoomIn = Array.from(detail.querySelectorAll('.xcb-btn')).find((node) => node.textContent === '+')
  await act(async () => { propsOf(zoomIn).onClick() })
  check(/scale\(1\.25\)/.test(detail.querySelector('.xcb-lldb-preview-canvas img').getAttribute('style') ?? ''),
    'and zooming scales the image in place', detail.querySelector('.xcb-lldb-preview-canvas img').getAttribute('style'))

  // -- the attribute list --------------------------------------------------
  //
  // Opening a view reads its attributes at once — the pane is the point of picking a row — and the
  // list is everything the app says, grouped by the class that declares it, the way Lookin groups
  // it. The readings and the edits are what the panel sends the app, so they are what is asserted.
  check(attributeReads.some((read) => read.address === '0x2'), 'picking a view reads its attributes', JSON.stringify(attributeReads))
  // The read is queued behind the selection's own round trip — `runLldb` runs one operation at a
  // time — so it lands a tick after the click, exactly as it does against the real host.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  // The preview was the pane on screen from the check above; attributes are the default and the one
  // this half is about.
  const attrTab = Array.from(insp.querySelectorAll('.xcb-lldb-tab')).find((node) => node.textContent === '属性')
  await act(async () => { propsOf(attrTab).onClick() })
  equal(container.querySelectorAll('.xcb-lldb-attrgroup').length, 2, 'the attributes are grouped by the class that declares them')
  const attrNames = () => Array.from(container.querySelectorAll('.xcb-lldb-attr .xcb-lldb-attr-name')).map((node) => node.textContent)
  check(attrNames().join(',') === '_text,_numberOfLines,_backgroundColor,_viewFlags,bounds',
    'every attribute the app printed is on screen, in the order it printed them', attrNames().join(','))
  const attrRow = (name) => Array.from(container.querySelectorAll('.xcb-lldb-attr'))
    .find((node) => node.querySelector('.xcb-lldb-attr-name')?.textContent === name)
  const attrField = (name) => attrRow(name)?.querySelector('input') ?? null
  // The printed value, not the parsed one: the app said `"row 0"` and `{`, and a pane that showed
  // `row 0` or `null` would be showing something the app never said.
  check(attrRow('_viewFlags').querySelector('.xcb-lldb-val').textContent === '{',
    'a row shows the value exactly as the app printed it', attrRow('_viewFlags').querySelector('.xcb-lldb-val')?.textContent)
  check(propsOf(attrField('_text')).defaultValue === 'row 0', 'and pre-fills its editor with what is there',
    JSON.stringify(propsOf(attrField('_text'))))
  check(propsOf(attrField('_numberOfLines')).defaultValue === '1', 'a number field gets the number, not the text', JSON.stringify(propsOf(attrField('_numberOfLines'))))
  check(attrRow('_text').className.includes('editable'), 'an attribute that can be written is marked as such')
  check(attrRow('_viewFlags').className.includes('editable') === false, 'and one whose type the plugin does not understand is not')
  check(attrField('_viewFlags') === null, 'so it has no field at all', 'it has one')
  // A row nested inside a struct is indented under it: 14 pixels a level, Lookin's unit.
  equal(/padding-left:\s*(\d+)/.exec(attrRow('bounds').getAttribute('style'))?.[1], '22', 'a nested member is indented a level in')
  check(attrField('bounds') === null, 'and is never editable: writing it by name would reach the object\'s own property instead')

  // A class folds away and stays folded: `UIView` declares dozens of rows and most of them are not
  // the question being asked.
  const uiViewHead = Array.from(container.querySelectorAll('.xcb-lldb-attrgroup-head')).find((node) => node.textContent.includes('UIView'))
  equal(container.querySelectorAll('.xcb-lldb-attr').length, 5, 'every row is on screen to begin with')
  await act(async () => { propsOf(uiViewHead).onClick() })
  equal(container.querySelectorAll('.xcb-lldb-attr').length, 2, 'clicking a class folds its rows away')
  await act(async () => { propsOf(uiViewHead).onClick() })
  equal(container.querySelectorAll('.xcb-lldb-attr').length, 5, 'and clicking it again brings them back')

  // Editing: the panel sends the property name KVC can reach, the kind of editor, and the value.
  await act(async () => {
    propsOf(attrField('_numberOfLines')).onBlur({ target: { value: '2' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const edit = edits.at(-1)
  equal(edit?.key, 'numberOfLines', 'a field commits the property name, not the underscored ivar it is shown as')
  equal(edit?.kind, 'number', 'with the kind of editor it came from')
  equal(edit?.value, 2, 'and the number that was typed')
  equal(edit?.address, '0x2', 'against the view that is picked')
  equal(container.querySelector('.xcb-lldb-editnote'), null, 'and a value the app kept says nothing extra')

  // The case Lookin calls "the modification seems to have no effect": the setter ran, and the app
  // put its own value back. Saying the edit worked there would be a lie about the running app.
  editSticks = false
  await act(async () => {
    propsOf(attrField('_numberOfLines')).onBlur({ target: { value: '5' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const editNote = container.querySelector('.xcb-lldb-editnote')
  check(editNote !== null && editNote.textContent.includes('1'),
    'an edit the app did not keep says so, and repeats the value the app reports', editNote?.textContent)
  editSticks = true

  // -- the layout pane -----------------------------------------------------
  const layoutTab = Array.from(insp.querySelectorAll('.xcb-lldb-tab')).find((node) => node.textContent === '布局')
  await act(async () => {
    propsOf(layoutTab).onClick()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  check(calls.some((call) => call.method === 'lldb' && call.body.op === 'constraints' && call.body.address === '0x2'),
    'the layout pane asks the app for the report when it is first opened')
  const badges = Array.from(container.querySelectorAll('.xcb-lldb-badge-box')).map((node) => node.textContent)
  check(badges.some((text) => text.includes('Ambiguous') && text.includes('YES')),
    'an ambiguous layout is said to be ambiguous', badges.join(' | '))
  check(badges.some((text) => text.includes('Intrinsic') && text.includes('42.67')),
    'with the intrinsic size to two places', badges.join(' | '))
  check(badges.some((text) => text.includes('Hugging') && text.includes('250')),
    'and the hugging priority', badges.join(' | '))
  const constraintText = container.querySelector('.xcb-lldb-constraint')?.textContent ?? ''
  check(constraintText.includes('width == 200'), 'the constraints are listed as the runtime printed them', constraintText)
  // A constraint names the views it relates by printing them, so an address that is in the tree
  // becomes a way to reach the other end of it.
  const jump = container.querySelector('.xcb-lldb-jump')
  check(jump !== null, 'a constraint naming a view in the tree offers to select it')
  await act(async () => {
    propsOf(jump).onClick()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  equal(calls.filter((call) => call.method === 'lldb' && call.body.op === 'node').at(-1)?.body.address, '0x2',
    'and clicking it selects that view')

  // -- the drawer fills the panel ------------------------------------------
  //
  // The drawer is a strip at the bottom of the panel; a hierarchy beside an attribute list beside a
  // console does not fit in a strip, so it can be given the whole panel — the same drawer, not a
  // second window, so nothing about it stops working when it is big.
  const maxButton = container.querySelector('.xcb-lldb-max')
  check(maxButton !== null, 'the debugger offers to fill the panel')
  await act(async () => { propsOf(maxButton).onClick() })
  check(container.querySelector('.xcb-lldb.max') !== null, 'and clicking it gives the debugger the whole panel')
  check(container.querySelector('.xcb-lldb-tree') !== null && container.querySelector('.xcb-lldb-log') !== null,
    'with the tree and the console still there')
  await act(async () => { propsOf(container.querySelector('.xcb-lldb-max')).onClick() })
  check(container.querySelector('.xcb-lldb.max') === null, 'clicking it again gives the panel back')

  // -- focus ---------------------------------------------------------------
  const stackRow = Array.from(container.querySelectorAll('.xcb-lldb-row')).find((node) => node.textContent.includes('UIStackView'))
  await act(async () => { propsOf(stackRow).onDoubleClick() })
  const focused = Array.from(container.querySelectorAll('.xcb-lldb-row .xcb-lldb-class')).map((node) => node.textContent)
  equal(focused.join(' > '), 'UIStackView > Example.StatusLight', 'a double-click focuses that view and its subtree')
  await act(async () => {
    propsOf(buttonNamed(container, '退出聚焦')).onClick()
  })
  equal(container.querySelectorAll('.xcb-lldb-row').length, 4, 'and leaving focus shows the whole hierarchy again')

  // A picked view becomes the command bar's object: a chip names it, one-click commands act on it,
  // and `$v` in a typed command stands for it.
  {
    const chip = container.querySelector('.xcb-lldb-chip')
    check(chip !== null && chip.textContent.includes('UIStackView') && chip.textContent.includes('0x2'),
      'the picked view is named above the prompt', chip?.textContent)
    const quick = Array.from(container.querySelectorAll('.xcb-lldb-quick')).map((node) => node.textContent)
    check(['po', 'frame', 'superview', 'subviews', 'controller', 'tree', 'hide', 'flash'].every((name) => quick.includes(name)),
      'with one-click commands for it', quick.join(','))
    const sentBefore = calls.filter((call) => call.method === 'lldb' && call.body.op === 'command').length
    await act(async () => {
      propsOf(Array.from(container.querySelectorAll('.xcb-lldb-quick')).find((node) => node.textContent === 'frame')).onClick()
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const quickSent = calls.filter((call) => call.method === 'lldb' && call.body.op === 'command').slice(sentBefore)
    equal(quickSent[0]?.body.command, 'p (CGRect)[((UIStackView *)0x2) frame]', 'a quick command is an ordinary lldb command aimed at that view')
    const box = container.querySelector('.xcb-lldb-cmd')
    check(/\$v/.test(box.getAttribute('placeholder') ?? ''), 'the prompt says $v is the view', box.getAttribute('placeholder'))
    await act(async () => { propsOf(box).onChange({ target: { value: 'po [$v alpha]' } }) })
    await act(async () => {
      propsOf(box).onKeyDown({ key: 'Enter' })
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const typed = calls.filter((call) => call.method === 'lldb' && call.body.op === 'command').at(-1)
    equal(typed?.body.command, 'po [((UIStackView *)0x2) alpha]', 'and $v in a typed command becomes that view')
    // The tree and the log share a page: the command's answer lands below and the rows stay in view.
    check(container.querySelector('.xcb-lldb-treesec .xcb-lldb-row') !== null && container.querySelector('.xcb-lldb-logsec .xcb-lldb-log') !== null,
      'after a command the tree is still on screen, with the log beneath it')

    // ↑/↓ in the prompt walks every command the drawer sent — typed, and sent by a view's buttons —
    // newest first, and ↓ past the newest puts back what was being typed.
    {
      const prompt = container.querySelector('.xcb-lldb-cmd')
      await act(async () => { propsOf(prompt).onChange({ target: { value: 'half typed' } }) })
      const press = async (key) => act(async () => { propsOf(container.querySelector('.xcb-lldb-cmd')).onKeyDown({ key, preventDefault() {} }) })
      const value = () => container.querySelector('.xcb-lldb-cmd').value
      await press('ArrowUp')
      equal(value(), 'po [((UIStackView *)0x2) alpha]', '↑ brings back the last typed command, with $v as it was sent')
      await press('ArrowUp')
      equal(value(), 'p (CGRect)[((UIStackView *)0x2) frame]', 'and ↑ again the one a quick button sent')
      await press('ArrowDown')
      equal(value(), 'po [((UIStackView *)0x2) alpha]', '↓ walks forward')
      await press('ArrowDown')
      equal(value(), 'half typed', 'and past the newest restores the draft')
      await act(async () => { propsOf(container.querySelector('.xcb-lldb-cmd')).onChange({ target: { value: '' } }) })
    }

    // Clicking the picked row again lets go of it.
    const nodeCalls = calls.filter((call) => call.method === 'lldb' && call.body.op === 'node').length
    await act(async () => {
      propsOf(container.querySelector('.xcb-lldb-row.picked')).onClick()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    equal(container.querySelector('.xcb-lldb-row.picked'), null, 'a second click on the picked row deselects it')
    equal(container.querySelector('.xcb-lldb-insp-head').textContent.includes('No view picked'), true, 'and lets go of the inspector')
    equal(container.querySelector('.xcb-lldb-chip'), null, 'and the command bar no longer aims at it')
    equal(calls.filter((call) => call.method === 'lldb' && call.body.op === 'node').length, nodeCalls, 'without asking the host again')

    // Picked again, the chip's × lets go of it too.
    await act(async () => {
      propsOf(container.querySelectorAll('.xcb-lldb-row')[1]).onClick()
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    check(container.querySelector('.xcb-lldb-chip') !== null, 'picking it again brings the chip back')
    await act(async () => { propsOf(container.querySelector('.xcb-lldb-chip-x')).onClick() })
    equal(container.querySelector('.xcb-lldb-row.picked'), null, 'and its × deselects it')
    await act(async () => {
      propsOf(container.querySelectorAll('.xcb-lldb-row')[1]).onClick()
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
  }

  // The host that has no Lookin.app must not offer a button claiming to be Lookin: the same slot
  // offers the file itself, and says why in its title. Re-read with the fixture flipped, which is
  // what a host on a machine without Lookin answers from the start.
  {
    lookinAvailable = false
    await act(async () => {
      propsOf(Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'View Hierarchy')).onClick()
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    const bare = Array.from(container.querySelectorAll('.xcb-btn'))
    check(bare.every((node) => node.textContent !== 'Lookin'),
      'a host without Lookin.app offers no Lookin button')
    const reveal = bare.find((node) => node.textContent === 'Reveal')
    check(reveal !== undefined, 'and offers Reveal in the same slot instead')
    check(reveal !== undefined && reveal.className.includes('xcb-lldb-lookin'),
      'in the drawer\'s own control class', reveal === undefined ? '(none)' : reveal.className)
    check(reveal !== undefined && reveal.getAttribute('title').includes('not installed'),
      'with a title that says why it is not called Lookin', reveal === undefined ? '(none)' : reveal.getAttribute('title'))
    lookinAvailable = true
  }


  // Filtering is local: the tree is already in hand, so a keystroke is not a round trip.
  const before = calls.length
  const filter = container.querySelector('.xcb-lldb-filterinput')
  await act(async () => { propsOf(filter).onChange({ target: { value: 'StatusLight' } }) })
  equal(container.querySelectorAll('.xcb-lldb-row').length, 3, 'the filter keeps the match and the ancestors that place it')
  check(container.textContent.includes('other') === false, 'and drops the branch that does not match')
  // A kept row that is not itself a match is drawn dimmer, so the hits are what the eye lands on
  // without the shape of the tree being lost.
  const kept = Array.from(container.querySelectorAll('.xcb-lldb-row'))
  equal(kept.filter((node) => node.className.includes('hit')).length, 1, 'the row that matched is marked as the hit')
  equal(kept.filter((node) => node.className.includes('context')).length, 2, 'and the ancestors kept to place it are drawn as context')
  equal(container.querySelector('.xcb-lldb-hitcount')?.textContent, '1 处', 'and the bar says how many views matched')
  // Nothing found is said, not left as an empty list that looks like an app with no views.
  await act(async () => { propsOf(filter).onChange({ target: { value: 'no-such-view-anywhere' } }) })
  equal(container.querySelectorAll('.xcb-lldb-row').length, 0, 'a search that matches nothing draws no rows')
  check(container.querySelector('.xcb-lldb-empty') !== null, 'and says so in as many words')
  check(container.querySelector('.xcb-lldb-hitcount').className.includes('none'), 'with the count marked as nothing found')
  await act(async () => { propsOf(filter).onKeyDown({ key: 'Escape' }) })
  equal(container.querySelectorAll('.xcb-lldb-row').length, 4, 'Escape clears the search and the whole tree is back')
  // A dump leaves the app stopped, so Continue has to be there to let it go again —
  // otherwise the only way out of a stopped app would be to detach.
  const continueButton = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Continue')
  check(continueButton !== undefined, 'a stopped app offers Continue')
  check(Array.from(container.querySelectorAll('.xcb-btn')).every((node) => node.textContent !== 'Interrupt'),
    'and not Interrupt, which is for the running case')
  await act(async () => {
    propsOf(continueButton).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  check(calls.some((call) => call.method === 'lldb' && call.body.op === 'continue'),
    'which resumes the app through the session it is already attached to')
  check(container.textContent.includes('running'), 'and the head says the app is running again',
    container.querySelector('.xcb-lldb-state')?.textContent)
  const interruptButton = Array.from(container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Interrupt')
  check(interruptButton !== undefined, 'so Interrupt appears where Continue was')
  await act(async () => {
    propsOf(interruptButton).onClick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  check(calls.some((call) => call.method === 'lldb' && call.body.op === 'interrupt'),
    'and it stops the app again')

  // The drawer polls the session's state while it is open, so what must NOT happen is a
  // second dump: the filter has the tree in hand and only narrows it.
  check(calls.slice(before).every((call) => !(call.method === 'lldb' && call.body?.op === 'view')),
    'with no second dump: the filter narrows what the panel already holds',
    calls.slice(before).map((call) => `${call.method}${call.body?.op === undefined ? '' : `:${call.body.op}`}`).join(','))

  // A raw command, typed by the user, in the same session the model uses.
  const commandsBefore = calls.filter((call) => call.method === 'lldb' && call.body.op === 'command').length
  const box = container.querySelector('.xcb-lldb-cmd')
  check(box !== null, 'there is a prompt to type an lldb command into')
  await act(async () => { propsOf(box).onChange({ target: { value: 'po 1 + 1' } }) })
  await act(async () => {
    propsOf(box).onKeyDown({ key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const sent = calls.filter((call) => call.method === 'lldb' && call.body.op === 'command').slice(commandsBefore)
  equal(sent.length, 1, 'Enter sends the command')
  equal(sent[0].body.command, 'po 1 + 1', 'and sends exactly what was typed')
  check(container.querySelector('.xcb-lldb-log') !== null, 'the transcript is what the drawer shows after a command')
  {
    const light = container.querySelector('.xcb-lldb-light')
    check(light !== null, 'the drawer head carries a state light')
    check(light !== null && /\b(green|yellow|red|off)\b/.test(light.className) && light.getAttribute('title') !== '',
      'coloured by the session state, with the state in words on hover', light === null ? '(none)' : `${light.className} / ${light.getAttribute('title')}`)
  }

  // The transcript reads like the build log: numbered, coloured by kind, following its tail.
  {
    const rows = Array.from(container.querySelectorAll('.xcb-lldb-line'))
    check(rows.length > 0 && rows.every((row) => row.querySelector('.xcb-num') !== null && row.querySelector('.xcb-txt') !== null),
      'each transcript line has a number gutter and its text, like the build log')
    check(rows.some((row) => row.className.includes('xcb-lldb-k-state')),
      'a "Process N stopped" line is marked as a state change', rows.map((row) => row.className).join(' | '))
    const log = container.querySelector('.xcb-lldb-log')
    // jsdom does no layout, so the geometry a scroll reads is given to it: a tall transcript in a
    // short box, scrolled up away from the end.
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 })
    check(container.querySelector('.xcb-lldb-jump') === null, 'at the tail there is no jump button: it is already following')
    log.scrollTop = 300
    await act(async () => { propsOf(log).onScroll({ currentTarget: log }) })
    const jump = container.querySelector('.xcb-lldb-jump')
    check(jump !== null, 'scrolled up, the transcript stops following and offers the way back')
    check(jump !== null && jump.className.includes('xcb-jump'),
      'as the build log\'s floating button, not a button of its own', jump === null ? '(none)' : jump.className)
    // Floating means a sibling of the scroller, inside a positioned wrapper: inside the scroller it
    // would scroll away with the lines it is meant to sit over.
    check(jump !== null && jump.parentElement === log.parentElement && jump.parentElement.className.includes('xcb-lldb-logwrap'),
      'and it floats over the transcript rather than scrolling inside it')
    check(log.parentElement?.parentElement?.className.includes('xcb-lldb-logsec') === true,
      'the transcript sits in its own section under the tree, and is what scrolls there')
    // The Tree button folds the tree section away and brings it back; the log stays either way.
    const treeToggle = Array.from(container.querySelectorAll('.xcb-lldb-tab')).find((node) => node.textContent === 'Tree')
    check(treeToggle !== undefined && treeToggle.className.includes(' on'), 'the Tree button shows the tree section is open')
    await act(async () => { propsOf(treeToggle).onClick() })
    equal(container.querySelector('.xcb-lldb-treesec'), null, 'clicking Tree hides the tree section')
    check(container.querySelector('.xcb-lldb-logsec .xcb-lldb-log') !== null, 'and the log stays, taking the room')
    await act(async () => { propsOf(Array.from(container.querySelectorAll('.xcb-lldb-tab')).find((node) => node.textContent === 'Tree')).onClick() })
    check(container.querySelector('.xcb-lldb-treesec') !== null, 'clicking it again brings the tree back above the log')
    equal(jump?.textContent, '↓ Latest', 'which says it goes to the latest output')
    await act(async () => { propsOf(jump).onClick() })
    equal(log.scrollTop, 1000, 'clicking it scrolls to the newest line')
    check(container.querySelector('.xcb-lldb-jump') === null, 'and following resumes, so the button goes away')

    // Right-click: Select All, Copy, and Clear.
    await act(async () => { propsOf(log).onContextMenu({ preventDefault() {}, clientX: 40, clientY: 30, currentTarget: log }) })
    const menu = container.querySelector('.xcb-lldb-ctxmenu')
    check(menu !== null, 'a right-click on the transcript opens its menu')
    // Fixed at the pointer, in viewport coordinates: positioned inside the drawer it was clipped by
    // the transcript's and the panel's overflow whenever the log was short.
    equal([menu?.style.left, menu?.style.top], ['40px', '30px'], 'it opens at the pointer, in viewport coordinates')
    const sheet = Array.from(document.querySelectorAll('style')).map((node) => node.textContent).join('')
    check(/\.xcb-ctxmenu\{position:fixed;z-index:2147483000/.test(sheet), 'as a fixed layer above everything, so a short log cannot clip it')
    await act(async () => { propsOf(log).onContextMenu({ preventDefault() {}, clientX: window.innerWidth - 5, clientY: window.innerHeight - 5, currentTarget: log }) })
    const flipped = container.querySelector('.xcb-lldb-ctxmenu')
    check(Number.parseFloat(flipped.style.left) < window.innerWidth - 5 && Number.parseFloat(flipped.style.top) < window.innerHeight - 5,
      'and near the window\'s edge it opens toward the room there is', `${flipped.style.left} ${flipped.style.top}`)
    equal(Array.from(menu?.querySelectorAll('.xcb-ctxmenu-item') ?? []).map((item) => item.firstChild.textContent),
      ['Select All', 'Copy', 'Clear'], 'with Select All and Copy, and Clear after them')
    const before = container.querySelectorAll('.xcb-lldb-line').length
    check(before > 0, 'there is something to clear', String(before))
    await act(async () => { propsOf(Array.from(flipped.querySelectorAll('.xcb-ctxmenu-item')).find((item) => item.textContent === 'Clear')).onClick() })
    equal(container.querySelectorAll('.xcb-lldb-line').length, 0, 'Clear empties the transcript')
    check(container.querySelector('.xcb-lldb-ctxmenu') === null, 'and the menu closes on a choice')
    // The cursor is not rewound: the next poll brings what comes AFTER the clear, not the old lines.
    transcript.push({ n: transcript.length + 1, t: '(lldb) po 2' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
    const after = Array.from(container.querySelectorAll('.xcb-lldb-line .xcb-txt')).map((node) => node.textContent)
    equal(after, ['(lldb) po 2'], 'and only lines said after the clear come back', after.join(' | '))
  }

  // Detaching unmounts: the reading buttons go, and Apps comes back to pick the next one.
  await act(async () => {
    propsOf(buttonNamed(container, 'Detach')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  check(buttonNamed(container, 'Apps') !== undefined, 'after a detach, Apps is offered again')
  check(buttonNamed(container, 'Lookin') === undefined, 'and Lookin is gone with the app')
  check(buttonNamed(container, 'View Hierarchy') !== undefined,
    'but View Hierarchy stays: a detached app is still one a press can attach to')

  // A refused dump is the drawer's business, not the build panel's.
  const refusing = serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    lldb: (body) => (body.op === 'command'
      ? { ok: false, note: "error: use of undeclared identifier 'UIApplication'", session: null }
      : { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }),
  })
  const second = mount({})
  const secondOverlay = second.components.get('dsh-xcodebuild-panel')
  const secondToggle = second.components.get('dsh-xcodebuild-toggle')
  const secondRender = await render([
    React.createElement(secondOverlay.component, { key: 'overlay' }),
    React.createElement(secondToggle.component, { key: 'toggle', sessionId: 'lldb-refuse' }),
  ])
  await act(async () => {
    secondRender.container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  await act(async () => {
    secondRender.container.querySelector('.xcb-lldb-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const secondBox = secondRender.container.querySelector('.xcb-lldb-cmd')
  await act(async () => { propsOf(secondBox).onChange({ target: { value: 'po nope' } }) })
  await act(async () => {
    propsOf(secondBox).onKeyDown({ key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  check(secondRender.container.querySelector('.xcb-lldb-error') !== null, 'a failed command is reported in the drawer')
  check(Array.from(secondRender.container.querySelectorAll('.xcb-btn')).every((node) => node.textContent !== 'Take over'),
    'and a failed COMMAND does not offer to take the app over: only a failed dump does')
  const errRow = secondRender.container.querySelector('.xcb-err')
  check(errRow === null || errRow.textContent.includes('undeclared identifier') === false,
    'and never as a red row across the build panel: a debugger that cannot attach is not a failed build',
    errRow === null ? '(no error row)' : errRow.textContent)
  check(refusing.some((call) => call.method === 'lldb'), 'the failed attempt did reach the route')

  // A dump that failed because the run still holds the app offers to take it over.
  let heldMounted = false
  const held = serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    lldb: (body) => {
      if (body.op === 'processes') return { ok: true, processes: APPS, note: '' }
      if (body.op === 'attach') { heldMounted = true; return { ok: true, note: '', session: MOUNTED } }
      if (body.op === 'view' && body.mode === 'launch') { heldMounted = true; return TREE }
      if (body.op === 'view') { heldMounted = false; return { ok: false, note: 'attached but the process never stopped', session: null } }
      return heldMounted
        ? { active: true, session: MOUNTED, next: 1, firstAvailable: 1, lines: [] }
        : { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }
    },
  })
  const fourth = mount({})
  const fourthOverlay = fourth.components.get('dsh-xcodebuild-panel')
  const fourthToggle = fourth.components.get('dsh-xcodebuild-toggle')
  const fourthRender = await render([
    React.createElement(fourthOverlay.component, { key: 'overlay' }),
    React.createElement(fourthToggle.component, { key: 'toggle', sessionId: 'lldb-takeover' }),
  ])
  await act(async () => {
    fourthRender.container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  await act(async () => {
    fourthRender.container.querySelector('.xcb-lldb-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await mountApp(fourthRender.container)
  const fourthView = Array.from(fourthRender.container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'View Hierarchy')
  await act(async () => {
    propsOf(fourthView).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  const takeOver = Array.from(fourthRender.container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'Take over')
  check(takeOver !== undefined, 'a failed dump offers to take the app over', fourthRender.container.querySelector('.xcb-lldb-error')?.textContent)
  check(takeOver === undefined || /relaunch/i.test(String(propsOf(takeOver).title)),
    'and says that taking over relaunches the app')
  await act(async () => {
    propsOf(takeOver).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  check(held.some((call) => call.method === 'lldb' && call.body.op === 'view' && call.body.mode === 'launch'),
    'which asks for the tree by launching the app under the debugger')
  equal(fourthRender.container.querySelectorAll('.xcb-lldb-row').length, 4, 'and the tree arrives')

  // What the host really sends for 蜜语-Dev now that it listens to asynchronous errors: LLDB's own
  // words (`no such process`, debugserver E96) within seconds, and a relaunch as the remedy. It
  // used to send `refused: true` and an anti-debugging-guard story that the app did not deserve.
  let guardedMounted = false
  serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    projects: () => ({ root: '/tmp', truncated: false, candidates: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    lldb: (body) => (body.op === 'processes'
      ? { ok: true, processes: APPS, note: '' }
      : body.op === 'attach'
      ? (guardedMounted = true, { ok: true, note: '', session: MOUNTED })
      : body.op === 'view'
      ? (guardedMounted = false, {
          ok: false,
          refused: false,
          note: "error: attach failed: no such process. The phone's debugserver would not take 蜜语-Dev's process even though it is running — the refusal comes from the device, and this plugin only relays it. Relaunching the app under the debugger (mode=launch) gives it a fresh process to attach to.",
          remedies: ['pass mode=launch to relaunch the app under the debugger'],
          session: null,
        })
      : guardedMounted
      ? { active: true, session: MOUNTED, next: 1, firstAvailable: 1, lines: [] }
      : { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }),
  })
  const guarded = mount({})
  const guardedRender = await render([
    React.createElement(guarded.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(guarded.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'lldb-guarded' }),
  ])
  await act(async () => {
    guardedRender.container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  // Two clicks: the trigger opens the panel, the drawer's own handle opens the drawer.
  await act(async () => {
    guardedRender.container.querySelector('.xcb-lldb-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await mountApp(guardedRender.container)
  await act(async () => {
    propsOf(Array.from(guardedRender.container.querySelectorAll('.xcb-btn')).find((node) => node.textContent === 'View Hierarchy')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  const guardedButtons = Array.from(guardedRender.container.querySelectorAll('.xcb-btn'))
  check(guardedButtons.some((node) => node.textContent === 'Take over'),
    'a refused attach offers the relaunch that is its remedy')
  const guardedNotes = Array.from(guardedRender.container.querySelectorAll('.xcb-lldb-note, .xcb-lldb-error'))
    .map((node) => node.textContent)
  check(guardedNotes.some((text) => text.includes('no such process')),
    'the drawer shows LLDB\'s own words', guardedNotes.join(' | ').slice(0, 120))
  check(guardedNotes.every((text) => !text.includes('anti-debugging')),
    'and invents no guard', guardedNotes.join(' | ').slice(0, 160))
  // The same red line the command failure is held to: a debugger that cannot attach is not a
  // failed build, so the guard's words must not surface as a red row across the build panel.
  const guardedErr = guardedRender.container.querySelector('.xcb-err')
  check(guardedErr === null || guardedErr.textContent.includes('no such process') === false,
    'and never as a red row across the build panel: the app is not a failed build',
    guardedErr === null ? '(no error row)' : guardedErr.textContent.slice(0, 80))

  // A session the model starts opens the drawer by itself — and only on the transition, so
  // a drawer the user closed while a session is running stays closed.
  let agentSession = false
  serve({
    state: () => ({ workspace: '/tmp', activeRunId: null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    lldb: () => (agentSession
      ? { active: true, session: TREE.session, next: 2, firstAvailable: 1, lines: [{ n: 1, t: 'Process 13290 stopped' }, { n: 2, t: 'Target 0: (HIDProbe) stopped.' }] }
      : { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }),
  })
  const third = mount({})
  const thirdOverlay = third.components.get('dsh-xcodebuild-panel')
  const thirdToggle = third.components.get('dsh-xcodebuild-toggle')
  const thirdRender = await render([
    React.createElement(thirdOverlay.component, { key: 'overlay' }),
    React.createElement(thirdToggle.component, { key: 'toggle', sessionId: 'lldb-agent' }),
  ])
  await act(async () => {
    thirdRender.container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  check(thirdRender.container.querySelector('.xcb-lldb') === null, 'no drawer while no session exists')

  // The closed drawer asks every 4 s whether a session has appeared, so this outlasts one
  // interval: the model starting a debugger opens it within 4 s.
  agentSession = true
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4600)) })
  check(thirdRender.container.querySelector('.xcb-lldb') !== null,
    'a session the model started opens the drawer by itself')
  check(thirdRender.container.querySelector('.xcb-lldb-toggle').className.includes('live'),
    'and the handle says a debugger is holding the app',
    thirdRender.container.querySelector('.xcb-lldb-toggle').className)

  const closeDrawer = Array.from(thirdRender.container.querySelectorAll('.xcb-lldb-head .xcb-btn'))
    .find((node) => node.textContent === '✕')
  check(closeDrawer !== undefined, 'the drawer can be closed from its own head')
  await act(async () => { propsOf(closeDrawer).onClick() })
  check(thirdRender.container.querySelector('.xcb-lldb') === null, 'closing it hides the drawer, not the session')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4600)) })
  check(thirdRender.container.querySelector('.xcb-lldb') === null,
    'and it stays closed while that same session runs — only a NEW session opens it')

}

section('a Build & Run mounts the app it launched')
{
  let runStatus = 'running'
  let runMounted = false
  const calls = serve({
    state: () => ({ workspace: '/tmp', activeRunId: runStatus === 'running' ? 'run-1' : null, runs: [] }),
    doctor: () => ({ tools: [], missingRequired: [] }),
    detect: (body) => ({ kind: 'workspace', root: '/tmp', location: body.path, name: 'P', schemes: [], configurations: [], sweetpadDefaults: {} }),
    destinations: () => ({ destinations: [] }),
    poll: () => ({
      missing: false, lines: [], next: 1, status: runStatus, exitCode: null, warningCount: 0, errors: [], durationMs: 0,
      artifact: { appPath: '/tmp/Build/HIDProbe.app', bundleId: 'com.example.HIDProbe', pid: 13290, attached: true },
    }),
    stop: () => { runStatus = 'cancelled'; return { ok: true } },
    lldb: (body) => {
      if (body.op === 'attach') { runMounted = true; return { ok: true, note: '', continued: true, session: MOUNTED } }
      if (body.op === 'dispose') { runMounted = false; return { ok: true, note: 'session ended', session: null } }
      return runMounted
        ? { active: true, session: MOUNTED, next: 1, firstAvailable: 1, lines: [] }
        : { active: false, session: null, next: 0, firstAvailable: 1, lines: [] }
    },
  })
  const instance = mount({})
  const { container } = await render([
    React.createElement(instance.components.get('dsh-xcodebuild-panel').component, { key: 'overlay' }),
    React.createElement(instance.components.get('dsh-xcodebuild-toggle').component, { key: 'toggle', sessionId: 'lldb-run' }),
  ])
  await act(async () => {
    container.querySelector('.xcb-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)) })
  await act(async () => {
    container.querySelector('.xcb-lldb-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  // Panels mounted by earlier sections are still alive and share this fake host, so each of them
  // may attach once too; what matters is that it happens now, and never again once mounted.
  // Counted by this section's own app, so a panel left from an earlier section attaching late
  // cannot make the "only once" check flaky.
  // Counted by this panel's own session id: panels from earlier sections are still alive and talk to
  // this same fake host about the same app, so the app path alone could not tell them apart.
  const mine = (call) => call.method === 'lldb' && call.body.op === 'attach' && call.body.sessionId === 'lldb-run'
  const autoAttach = calls.filter(mine)
  check(autoAttach.length >= 1, 'opening the drawer attaches to the launched app at once, not on the first read')
  equal(autoAttach[0]?.body.process, 'HIDProbe', 'by the process the run launched')
  equal(autoAttach[0]?.body.continue, true, 'and leaves it running')
  const settled = calls.filter(mine).length
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3000)) })
  equal(calls.filter(mine).length, settled,
    'and only once: the polls that follow do not attach again')
  check(buttonNamed(container, 'Apps') === undefined, 'with the app the run launched, there is nothing to pick: no Apps')
  check(buttonNamed(container, 'View Hierarchy') !== undefined, 'and View Hierarchy reads that app')

  await act(async () => {
    propsOf(buttonNamed(container, 'Stop')).onClick()
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  check(calls.some((call) => call.method === 'stop'), 'Stop ends the run')
  check(buttonNamed(container, 'Apps') !== undefined, 'and Apps comes back once the app is let go')
  check(buttonNamed(container, 'View Hierarchy') !== undefined, 'with View Hierarchy still offered to read it again')
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('client interaction OK')
process.exit(0)
