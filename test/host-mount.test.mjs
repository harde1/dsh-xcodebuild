// Smoke test for the host half: mounts the plugin against a fake Cordis context
// and asserts what it actually contributed.
//
// This exists because the plugin only becomes visible after a profile restart,
// which is a slow and opaque way to discover a typo in a tool name, a malformed
// `defineTool` spec, or a route registered on the wrong path. Mounting here
// turns "restart and hope" into a check that runs in under a second.
//
// It requires `@deepseek-ai/dsh-tools` to be resolvable (the runtime aliases it
// for a mounted row; `npm run smoke` links the deployment's copy temporarily).
//
// Run: node test/host-mount.test.mjs

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This plugin's own directory — a tree that deliberately holds no Xcode project. */
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The host half imports `@deepseek-ai/dsh-tools`, which the running harness
// aliases for a mounted row rather than installing into the plugin. Outside that
// runtime it has to resolve some other way, so this suite links the deployment's
// own copy — never a second install, which would be a different module instance
// than the host's and would make the result meaningless.
let plugin
try {
  plugin = await import('../lib/index.js')
} catch (error) {
  if (String(error?.message ?? '').includes('@deepseek-ai/dsh-tools')) {
    console.error(
      'cannot resolve @deepseek-ai/dsh-tools.\n'
      + 'Link the deployment\'s copy (do not install one):\n\n'
      + '  mkdir -p node_modules/@deepseek-ai\n'
      + '  ln -sfn "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools" \\\n'
      + '    node_modules/@deepseek-ai/dsh-tools\n',
    )
    process.exit(1)
  }
  throw error
}

const { apply, inject, name } = plugin

let failures = 0
let checks = 0

function check(condition, label, detail) {
  checks += 1
  if (!condition) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}

// --- a fake context that records every contribution -----------------------

const registeredTools = []
const registeredRoutes = []
const effectLabels = []
const warnings = []
const infos = []

function makeCtx() {
  return {
    logger: { info: (line) => infos.push(line), warn: (line) => warnings.push(line) },
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
    effect(callback, label) {
      effectLabels.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      equal(services, ['webServer', 'connection'], 'routes are mounted behind webServer + connection')
      callback({
        effect: (cb, label) => {
          effectLabels.push(label)
          const dispose = cb()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        webServer: {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          },
        },
        // Reject nothing: this test exercises the wiring, not the fence. The
        // fence itself is the composition's, and is covered by its own owner.
        connection: { requestRejection: () => undefined },
      })
    },
  }
}

apply(makeCtx())

// --- plugin identity ------------------------------------------------------

equal(name, 'xcodebuild', 'plugin name matches the cordis.patch.yml row id')
equal(inject, ['tools'], 'plugin requires the tools service')

// The profile keeps the host half in memory from boot, so a stale process is
// indistinguishable from a broken fix unless the mounted revision is recorded.
check(
  infos.some((line) => /^dsh-xcodebuild: host half mounted \(source written .+\)$/.test(line)),
  'mount records which revision of the host half is loaded',
  infos.join(' | '),
)

// --- tools ----------------------------------------------------------------

const EXPECTED_TOOLS = ['xcode_project', 'xcode_doctor', 'xcode_destinations', 'xcode_run', 'xcode_log', 'xcode_device_log']
equal(registeredTools.map((tool) => tool.name), EXPECTED_TOOLS, 'every tool is registered')

// `xcode_doctor` asks the machine, not the caller: it has nothing to be told, so
// an empty property map is correct there and only there.
const NO_ARGUMENT_TOOLS = new Set(['xcode_doctor'])

for (const tool of registeredTools) {
  check(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} has a real description`)
  check(typeof tool.execute === 'function', `${tool.name} has an execute function`)
  // defineTool compiles the author-facing property map into a JSON-Schema object
  // root. If the spec form were wrong, this is where it would surface.
  check(tool.parameters?.type === 'object', `${tool.name} compiled to an object-rooted parameter schema`)
  if (NO_ARGUMENT_TOOLS.has(tool.name)) {
    equal(Object.keys(tool.parameters?.properties ?? {}), [],
      `${tool.name} takes no arguments on purpose, and declares none`)
  } else {
    check(
      tool.parameters?.properties !== undefined && Object.keys(tool.parameters.properties).length > 0,
      `${tool.name} declares parameters`,
    )
  }
  check(tool.output?.schema !== undefined, `${tool.name} declares an output schema`)
  check(typeof tool.output?.render === 'function', `${tool.name} has a renderer`)
}

// Parameter specs are author-facing: `required: true` sits on the property and
// is compiled into a `required` array. A regression here silently makes every
// argument optional to the model.
const projectTool = registeredTools.find((tool) => tool.name === 'xcode_project')
equal(projectTool.parameters.required, ['path'], 'xcode_project compiles `required: true` into a required array')

const runTool = registeredTools.find((tool) => tool.name === 'xcode_run')
check(runTool.parameters.properties.action.enum !== undefined, 'xcode_run keeps its action enum')
equal(runTool.parameters.required, ['path'], 'xcode_run requires only path')

// --- routes ---------------------------------------------------------------

const EXPECTED_ROUTES = ['state', 'detect', 'projects', 'destinations', 'doctor', 'start', 'poll', 'search', 'stop']
equal(
  registeredRoutes.map((route) => route.path.replace('/_dsh/dsh-xcodebuild/', '')),
  EXPECTED_ROUTES,
  'the panel transport mounts one route per method',
)
check(registeredRoutes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'), 'every route is an exact-path handler')

check(effectLabels.includes('dsh-xcodebuild: panel routes'), 'panel routes are registered inside a disposal scope')
check(effectLabels.includes('dsh-xcodebuild: run cleanup'), 'runs are killed on unload')

// --- route behaviour ------------------------------------------------------

/** A request stand-in: an async iterable of body chunks plus method/headers. */
function fakeRequest({ method = 'POST', body = '' } = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
    resume() {},
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk) },
  }
}

const stateRoute = registeredRoutes.find((route) => route.path.endsWith('/state'))
const startRoute = registeredRoutes.find((route) => route.path.endsWith('/start'))

// Method guard.
{
  const res = fakeResponse()
  await stateRoute.handler(fakeRequest({ method: 'GET' }), res)
  equal(res.statusCode, 405, 'a non-POST request is refused with 405')
  equal(res.headers.allow, 'POST', 'the refusal names the allowed method')
}

// Body validation.
{
  const res = fakeResponse()
  await stateRoute.handler(fakeRequest({ body: '{not json' }), res)
  equal(res.statusCode, 400, 'a malformed JSON body is refused with 400')
}

// Happy path: `state` answers with the run inventory the panel boots from.
{
  const res = fakeResponse()
  await stateRoute.handler(fakeRequest({ body: '' }), res)
  equal(res.statusCode, 200, 'state answers 200')
  const payload = JSON.parse(res.body)
  check(Array.isArray(payload.runs), 'state returns a runs array')
  check(/^\d{4}-\d{2}-\d{2}T/.test(String(payload.revision)),
    'state reports the mounted revision, so a stale process is visible',
    String(payload.revision))
  check(payload.activeRunId === null, 'no run is active before anything is started')
}

const projectsRoute = registeredRoutes.find((route) => route.path.endsWith('/projects'))

// The picker's data source. A directory holding no Xcode project is an empty
// answer, not a failure: the panel has to be able to say "nothing here" without
// dressing it up as an error.
{
  const res = fakeResponse()
  await projectsRoute.handler(fakeRequest({ body: JSON.stringify({ path: pluginRoot }) }), res)
  equal(res.statusCode, 200, 'projects answers 200 for a directory with no Xcode project')
  const payload = JSON.parse(res.body)
  equal(payload.candidates, [], 'and reports no candidates')
  equal(payload.root, pluginRoot, 'and names the directory it searched')
}

// A path that does not exist IS a failure.
{
  const res = fakeResponse()
  await projectsRoute.handler(fakeRequest({ body: JSON.stringify({ path: '/definitely/not/here' }) }), res)
  equal(res.statusCode, 500, 'projects refuses a directory that does not exist')
  check(typeof JSON.parse(res.body).message === 'string', 'and says why')
}

// A failing handler is reported as 500 with a message, never as an unhandled throw.
{
  const res = fakeResponse()
  await startRoute.handler(fakeRequest({ body: JSON.stringify({ path: '/definitely/not/here' }) }), res)
  equal(res.statusCode, 500, 'a failing action is answered with 500')
  check(typeof JSON.parse(res.body).message === 'string', 'the 500 carries a message for the panel')
}

// `/destinations` is where the default is now decided — the panel no longer
// decides it independently, so the field has to be there and has to be honoured.
//
// The project cannot be listed, but `legacyDevices` still reports attached iOS 16
// hardware, so what comes back is machine-dependent: assert the shape and the
// contract, never a fixture.
const destinationsRoute = registeredRoutes.find((route) => route.path.endsWith('/destinations'))
check(destinationsRoute !== undefined, 'the destinations route is registered')
if (destinationsRoute !== undefined) {
  const res = fakeResponse()
  await destinationsRoute.handler(fakeRequest({
    body: JSON.stringify({
      path: join(tmpdir(), 'dsh-xcodebuild-detach', 'Nope.xcodeproj'),
      scheme: 'Nope',
      preferred: 'platform=iOS Simulator,id=NOT-CONNECTED',
    }),
  }), res)
  const payload = JSON.parse(res.body)
  equal(res.statusCode, 200, 'destinations answers for a project that cannot be listed')
  check(Array.isArray(payload.destinations), 'destinations returns a list')
  check(typeof payload.recommended === 'string',
    'destinations returns a recommended default, so the panel and the tool cannot disagree')
  check(payload.recommended !== 'platform=iOS Simulator,id=NOT-CONNECTED',
    'a remembered destination that is not connected is never recommended')
  check(payload.recommended === ''
    || payload.destinations.some((entry) => entry.destination === payload.recommended),
  'the recommendation is always one of the destinations on offer', payload.recommended)
}

// The panel's `/start` must answer at once, and the run must already be active and
// already tagged with its workspace when it does.
//
// Awaiting the run inside that route held one HTTP request open for the whole build,
// and — because the workspace tag was applied only after that await — `/state` could
// not report an active run while the build was happening. The panel therefore never
// polled, and a successful Build & Run showed neither an install nor a launch: those
// lines were written into a log the client had already stopped reading.
//
// The project path deliberately does not exist. `detectProject` accepts a `.xcodeproj`
// suffix without touching the disk, so `/start` does everything it normally does bar
// finding a project, and the background xcodebuild fails quickly against a real
// directory — which is the window this asserts in.
if (!existsSync('/usr/bin/xcrun')) {
  console.log('skipping the /start detachment check: no xcodebuild on this machine')
} else {
  const res = fakeResponse()
  const before = Date.now()
  await startRoute.handler(fakeRequest({
    body: JSON.stringify({
      path: join(tmpdir(), 'dsh-xcodebuild-detach', 'Nope.xcodeproj'),
      action: 'run',
      scheme: 'Nope',
      configuration: 'Debug',
      destination: 'generic/platform=iOS',
    }),
  }), res)
  const elapsed = Date.now() - before
  equal(res.statusCode, 200, 'start accepts a run and answers 200')
  const started = JSON.parse(res.body)
  check(typeof started.runId === 'string' && started.runId !== '', 'start names the run it created')
  check(elapsed < 1000, 'start answers without waiting for the build to finish', `${elapsed}ms`)

  const afterRes = fakeResponse()
  await stateRoute.handler(fakeRequest({ body: '' }), afterRes)
  const inventory = JSON.parse(afterRes.body)
  equal(inventory.activeRunId, started.runId,
    'the run is active — and already tagged — the moment start answers, so the panel can poll it')
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('host mount OK')
