// The helper that is loaded INTO the app, and the way this plugin talks to it.
//
// The point of the helper is that the debugger stops the app exactly once — to `dlopen` it — and the
// app answers for itself afterwards, while it keeps running. So these checks pin the three things
// that decision depends on:
//
//   * how the helper is built for a simulator and for a device (argv, signing, cache key), and that
//     the source really compiles and exports the entry point the expression calls;
//   * the one expression that loads and starts it, and the port it answers with;
//   * one request per connection, with a deadline — a helper answering on the app's main thread cannot
//     answer while the debugger holds the app stopped, and a request with no deadline is a hang.
//
// Run: node test/probe.test.mjs
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROBE_LIB, PROBE_MIN_IOS, buildProbe, developmentIdentity, parseContainerPath, probeArch,
  probeBuildCommand, probeCacheKey, probeContainerCommand, probeCopyCommand, probeInjectExpression, probePortFromText,
  probeSdk, probeSignCommand, probeSourcePath,
} from '../lib/probe.js'
import { probePing, probeRequest, probeText } from '../lib/probe-link.js'
import { iproxyArgv, startIproxy } from '../lib/probe-forward.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}
function equal(actual, expected, label) {
  check(actual === expected, label, `actual: ${JSON.stringify(actual)} expected: ${JSON.stringify(expected)}`)
}

// --- how it is built ------------------------------------------------------

{
  const simulator = probeBuildCommand({ platform: 'simulator', arch: 'arm64', source: '/s/xcb-probe.m', output: '/o/xcbprobe.dylib', sdkPath: '/sdk/sim' })
  equal(simulator.command, 'xcrun', 'the compiler is asked for through xcrun, so the SDK is the toolchain\'s')
  check(simulator.args.includes('iphonesimulator'), 'a simulator build names the simulator SDK', simulator.args.join(' '))
  check(simulator.args.includes(`-mios-simulator-version-min=${PROBE_MIN_IOS}`), 'and the simulator floor', simulator.args.join(' '))
  check(simulator.args.includes('-dynamiclib'), 'it is a library, so the app can dlopen it')
  check(simulator.args.includes('-fobjc-arc'), 'and it is built with ARC: the helper is long-lived code')
  for (const framework of ['UIKit', 'Foundation', 'QuartzCore', 'CoreGraphics']) {
    check(simulator.args.includes(framework), `it links ${framework}, which its own code uses`)
  }
  equal(simulator.args[simulator.args.length - 1], '/s/xcb-probe.m', 'the source is the last argument')

  const device = probeBuildCommand({ platform: 'device', arch: 'arm64', source: 'src', output: 'out', sdkPath: '/sdk/os' })
  check(device.args.includes('iphoneos'), 'a device build names the device SDK', device.args.join(' '))
  check(device.args.includes(`-mios-version-min=${PROBE_MIN_IOS}`), 'with the device floor', device.args.join(' '))
  check(!device.args.some((arg) => arg.includes('simulator-version')), 'and not the simulator one')

  equal(probeSdk({ platform: 'simulator' }), 'iphonesimulator', 'the SDK name for a simulator')
  equal(probeSdk({ platform: 'device' }), 'iphoneos', 'the SDK name for a device')
  equal(probeArch({ platform: 'simulator', hostArch: 'x64' }), 'x86_64', 'an Intel Mac builds an Intel simulator helper')
  equal(probeArch({ platform: 'simulator', hostArch: 'arm64' }), 'arm64', 'and an Apple silicon Mac builds arm64')
  equal(probeArch({ platform: 'device', hostArch: 'x64' }), 'arm64', 'a device is always arm64')
}

{
  const sign = probeSignCommand({ identity: 'Apple Development: someone (ABCDE12345)', path: '/o/x.dylib' })
  equal(sign.command, 'codesign', 'signing goes through codesign')
  check(sign.args.includes('Apple Development: someone (ABCDE12345)'), 'with the identity the app would accept', sign.args.join(' '))
  check(sign.args.includes('/o/x.dylib'), 'and the file just built', sign.args.join(' '))

  const identity = developmentIdentity(() => ({
    status: 0,
    stdout: '  1) 4A2N4NCM4Z "Apple Distribution: A Company (4A2N4NCM4Z)"\n  2) QTX777HD69 "Apple Development: someone@example.com (QTX777HD69)"\n',
  }))
  equal(identity, 'Apple Development: someone@example.com (QTX777HD69)', 'the first DEVELOPMENT identity is the one to sign with')
  equal(developmentIdentity(() => ({ status: 0, stdout: '     0 valid identities found\n' })), '', 'a Mac with none answers none, so the device path can say so')
}

{
  const key = (over) => probeCacheKey({ source: '/lib/probe/xcb-probe.m', sdkPath: '/sdk/sim', platform: 'simulator', arch: 'arm64', ...over })
  check(key({}) === key({}), 'the same target hashes to the same cache entry')
  check(key({ platform: 'device' }) !== key({}), 'a device helper is not served a simulator one')
  check(key({ arch: 'x86_64' }) !== key({}), 'and neither is another architecture')
  check(key({ sdkPath: '/sdk/other' }) !== key({}), 'an SDK upgrade rebuilds rather than reuses')
  check(key({ source: '/lib/probe/other.m' }) !== key({}), 'and so does a different source')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'xcb-probe-test-'))
  const source = join(dir, 'xcb-probe.m')
  writeFileSync(source, 'int xcb_probe_start(int port) { return port; }\n')
  const cacheDir = join(dir, 'cache')

  const refused = buildProbe({
    platform: 'simulator', arch: 'arm64', sdkPath: '/sdk', cacheDir, source,
    spawnFn: () => ({ status: 1, stdout: '', stderr: 'error: unknown type name CGFloat' }),
  })
  check(!refused.ok, 'a compile that fails is a failure, not a missing file later')
  check(refused.note.includes('unknown type name'), 'and it reports what clang said', refused.note)

  // A build that "succeeds" without writing the library is still a failure: the next step is a copy
  // and a dlopen of that exact path.
  const lied = buildProbe({ platform: 'simulator', arch: 'arm64', sdkPath: '/sdk', cacheDir, source, spawnFn: () => ({ status: 0, stdout: '', stderr: '' }) })
  check(!lied.ok, 'a compiler that wrote nothing is not a build')

  const output = join(cacheDir, probeCacheKey({ source, sdkPath: '/sdk', platform: 'simulator', arch: 'arm64' }), PROBE_LIB)
  const built = buildProbe({
    platform: 'simulator', arch: 'arm64', sdkPath: '/sdk', cacheDir, source,
    spawnFn: (command, args) => {
      writeFileSync(args[args.indexOf('-o') + 1], 'mach-o')
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  check(built.ok && built.path === output, 'a build that worked is answered with the path', built.path)
  equal(built.cached, false, 'and is reported as a fresh build')
  let compiled = 0
  const again = buildProbe({
    platform: 'simulator', arch: 'arm64', sdkPath: '/sdk', cacheDir, source,
    spawnFn: () => { compiled += 1; return { status: 0, stdout: '', stderr: '' } },
  })
  check(again.ok && again.cached === true, 'the second call reuses it', JSON.stringify(again))
  equal(compiled, 0, 'without running the compiler again')

  // A device library has to be signed, and a signing failure has to be visible here rather than as
  // an unexplained dlopen of nothing later.
  const unsigned = buildProbe({
    platform: 'device', arch: 'arm64', sdkPath: '/sdk', cacheDir, source, identity: 'Apple Development: someone (X)',
    spawnFn: (command, args) => {
      if (command === 'codesign') return { status: 1, stdout: '', stderr: 'errSecInternalComponent' }
      writeFileSync(args[args.indexOf('-o') + 1], 'mach-o')
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  check(!unsigned.ok && unsigned.note.includes('codesign'), 'a signing failure is reported as one', unsigned.note)
  rmSync(dir, { recursive: true, force: true })
}

// --- the one expression that loads it ------------------------------------

{
  const expression = probeInjectExpression({ path: '/tmp/x y/xcbprobe.dylib', port: 0 })
  check(expression.startsWith('expr -l objc++'), 'the injection is one expression verbatim', expression.slice(0, 40))
  check(expression.includes('dlopen'), 'it dlopens the library')
  check(expression.includes('dlsym') && expression.includes('xcb_probe_start'), 'and calls the helper\'s entry point')
  check(expression.includes('(int)0'), 'passing the port it was asked for')
  check(expression.trimEnd().endsWith('xcbProbePort; })'), 'and the port is the statement expression\'s value, not an `if`', expression.slice(-40))
  check(expression.includes('(void *(*)(const char *, int))dlopen'), 'the C calls are cast, so a target without headers still links them')
  check(expression.includes('UTF8String'), 'the path is handed over as an NSString, the only literal the parser takes')
  check(probeInjectExpression({ path: '/x.dylib', port: 47601 }).includes('(int)47601'), 'a fixed port is passed through')

  equal(probePortFromText('(int) 47601'), 47601, 'the port is read back from what the expression printed')
  equal(probePortFromText('(int) $0 = 47601'), 47601, 'in either of the shapes lldb prints a value')
  equal(probePortFromText('(int) 0'), 0, 'a helper that could not listen answers nothing')
  equal(probePortFromText('(int) -1'), 0, 'and so does a refused port')
  equal(probePortFromText('error: no such file'), 0, 'an error is not mistaken for a port')
  equal(probePortFromText('(int) 99999'), 0, 'and a number that is not a port is not one either')
}

// --- getting it onto a device --------------------------------------------

{
  const copy = probeCopyCommand({ device: 'B7485956', source: '/cache/xcbprobe.dylib', destination: '/container/Documents/xcbprobe.dylib', bundleId: 'com.example.app' })
  equal(copy.command, 'xcrun', 'the copy goes through devicectl')
  check(copy.args.join(' ').includes('devicectl device copy to'), 'the copy subcommand', copy.args.join(' '))
  check(copy.args.includes('appDataContainer'), 'into the app\'s own data container, which dlopen may read')
  check(copy.args.includes('com.example.app'), 'named by the bundle id the app was launched with')
  check(copy.args.includes('/container/Documents/xcbprobe.dylib'), 'at a path inside the container')

  const container = probeContainerCommand({ device: 'B7485956', bundleId: 'com.example.app', out: '/tmp/container.json' })
  check(container.args.includes('/tmp/container.json'), 'the container answer goes to a file, devicectl\'s documented interface', container.args.join(' '))

  const json = JSON.stringify({ result: { files: [{ path: '/private/var/mobile/Containers/Data/Application/1A2B/Documents' }] } })
  equal(parseContainerPath(json), '/private/var/mobile/Containers/Data/Application/1A2B/Documents', 'the container path is read out of devicectl\'s json')
  equal(parseContainerPath('devicectl: device is not paired'), null, 'an answer that is not json is no path')
  equal(parseContainerPath(JSON.stringify({ result: { files: [] } })), null, 'and neither is an empty list')
}

// --- the forward a device needs ------------------------------------------

{
  equal(iproxyArgv({ udid: 'B748', localPort: 47600, devicePort: 47601 }).join(' '), '-u B748 47600:47601', 'iproxy takes the ports as one local:device argument')
  equal(iproxyArgv({ udid: '', localPort: 47600, devicePort: 47601 }).join(' '), '47600:47601', 'and the udid only when there is one to name')

  const child = { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} }
  const started = await startIproxy({ tool: 'iproxy', udid: 'B748', localPort: 47600, devicePort: 47601, spawnFn: () => child, probePort: async () => true })
  check(started.ok, 'a forward that answers is ready')
  equal(started.localPort, 47600, 'on the local port the host chose')

  let killed = null
  const stubborn = {
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill: (signal) => { killed = signal },
  }
  const never = await startIproxy({ tool: 'iproxy', udid: 'B748', localPort: 47601, devicePort: 47602, timeoutMs: 400, spawnFn: () => stubborn, probePort: async () => false })
  check(!never.ok && /within/.test(never.note), 'a forward that never answers times out', never.note)
  check(killed !== null, 'and is killed rather than left holding a local port')

  const broken = await startIproxy({ tool: 'iproxy', udid: '', localPort: 0, devicePort: 1, spawnFn: () => child })
  check(!broken.ok && /two ports/.test(broken.note), 'a forward with no port is refused before anything is spawned', broken.note)

  const missing = await startIproxy({ tool: 'iproxy', udid: '', localPort: 47603, devicePort: 47604, spawnFn: () => { throw new Error('spawn iproxy ENOENT') } })
  check(!missing.ok && /ENOENT/.test(missing.note), 'a tool that cannot start is a refusal, not a throw', missing.note)
}

// --- one request, one reply, with a deadline ------------------------------

/** A probe stand-in: one answer per connection, chosen by the request's op. */
async function fakeProbe(handler) {
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (!buffer.includes('\n')) return
      const reply = handler(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      if (reply === null) return
      socket.end(`${typeof reply === 'string' ? reply : JSON.stringify(reply)}\n`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

{
  const probe = await fakeProbe((request) => {
    if (request.op === 'ping') return { ok: 1, version: 1, pid: 4711, bundle: 'com.example.app' }
    if (request.op === 'tree') return { ok: 1, text: '<UIWindow: 0x1; frame = (0 0; 10 10)>' }
    if (request.op === 'gone') return { ok: 0, note: 'that view is not in the window any more' }
    if (request.op === 'rude') return 'not json at all'
    return null // never answers
  })
  const ping = await probePing({ port: probe.port })
  check(ping.ok, 'a ping is answered', ping.note)
  equal(ping.version, 1, 'with the protocol version, so an old copy in a running app is visible')
  equal(ping.pid, 4711, 'and the pid the helper is running in')

  const tree = await probeText({ port: probe.port, op: 'tree' })
  check(tree.ok && tree.text.startsWith('<UIWindow:'), 'a tree read answers with the text the debugger would have printed', tree.text)
  equal(tree.ms >= 0, true, 'and is timed')

  const gone = await probeText({ port: probe.port, op: 'gone' })
  check(!gone.ok && /not in the window/.test(gone.note), 'a refusal carries the helper\'s own note', gone.note)

  const rude = await probeText({ port: probe.port, op: 'rude' })
  check(!rude.ok && /not JSON/.test(rude.note), 'an answer that is not JSON is a failure, not a crash', rude.note)

  const silence = await probeText({ port: probe.port, op: 'silence', timeoutMs: 300 })
  check(!silence.ok && /did not answer/.test(silence.note), 'an app that never answers is given up on', silence.note)

  await probe.close()
}

{
  const refused = await probeText({ port: 9, op: 'tree', timeoutMs: 1000 })
  check(!refused.ok, 'a port with nothing on it is a failure')
  const nowhere = await probeText({ port: 0, op: 'tree' })
  check(!nowhere.ok && /no probe port/.test(nowhere.note), 'and so is no port at all', nowhere.note)
}

// --- the helper itself compiles ------------------------------------------

{
  const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' })
  const sdkPath = String(sdk.stdout ?? '').trim()
  if (sdk.status !== 0 || sdkPath === '' || !existsSync(sdkPath)) {
    console.log('  (no simulator SDK on this Mac: the helper was not compiled)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'xcb-probe-compile-'))
    const built = buildProbe({ platform: 'simulator', arch: probeArch({ platform: 'simulator', hostArch: process.arch }), sdkPath, cacheDir: dir })
    check(built.ok, 'the helper compiles for a simulator with the argv this module builds', built.note)
    // A phone's build is the same source against the device SDK, and it is checked here because the
    // cross-compile is the part that cannot be checked without a phone: everything after it (signing,
    // the container copy, the forward) needs hardware, and none of it can make a build that does not
    // link work.
    const deviceSdk = spawnSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' })
    const deviceSdkPath = String(deviceSdk.stdout ?? '').trim()
    if (deviceSdk.status === 0 && deviceSdkPath !== '' && existsSync(deviceSdkPath)) {
      const phone = buildProbe({ platform: 'device', arch: 'arm64', sdkPath: deviceSdkPath, cacheDir: dir })
      check(phone.ok, 'and for a phone, which is the build a device read needs', phone.note)
      if (phone.ok) {
        const archs = spawnSync('lipo', ['-archs', phone.path], { encoding: 'utf8' })
        check(String(archs.stdout ?? '').includes('arm64'), 'the phone build is an arm64 library', String(archs.stdout ?? '').trim())
        // Left unsigned on purpose: signing needs an identity this Mac may not have, and
        // `buildProbe` is where an identity turns into a signature. The compile is what is checked here.
      }
    }
    if (built.ok) {
      check(existsSync(built.path), 'and the library is where the injection expression will look for it')
      const symbols = spawnSync('nm', ['-gU', built.path], { encoding: 'utf8' })
      check(String(symbols.stdout ?? '').includes('_xcb_probe_start'), 'and it exports the entry point the expression calls', String(symbols.stdout ?? '').slice(0, 200))
      check(existsSync(probeSourcePath()), 'the source ships with the plugin')
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exit(1)
console.log('probe OK')
