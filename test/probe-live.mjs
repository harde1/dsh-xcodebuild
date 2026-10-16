// The helper inside the app, against a real app on a real simulator.
//
//   node test/probe-live.mjs [simulator-udid]
//
// The unit suites cover this feature's parts — the compile line, the protocol, the socket, the
// forward, the parsers — and none of them can cover the thing the feature is FOR: an app that
// answers for itself and is never stopped. That needs a booted simulator, an app to inject into, and
// a debugger to attach once. This file is that check, and it is deliberately NOT in `npm test`: it
// boots nothing, changes nothing, and SKIPS when there is no booted simulator to work with.
//
// It builds its own fixture app (a window, a card, and a label that counts ten times a second — the
// counter is the proof the app keeps running, because a stopped app's label freezes), installs it,
// launches it, and then drives the plugin's own `lldb` route the way the panel does. Everything the
// route says is checked against what the running app is: the records, the styles, the attributes, the
// layout, the pictures, an edit, and — twice — that the label moved between two reads.
//
// On to a phone instead of a simulator, the same helper is built for arm64, signed with this Mac's
// development identity and copied into the app's data container, and reached through `iproxy`. None
// of that can be exercised here.

import { apply } from '../lib/index.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = `#import <UIKit/UIKit.h>

// Deliberately plain: a window, a card with a corner radius and a border, and a label whose text
// counts up ten times a second.
static UILabel *gLabel = nil;
static NSInteger gTicks = 0;

@interface XCBProbeTestDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation XCBProbeTestDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.backgroundColor = [UIColor colorWithRed:0.2 green:0.35 blue:0.9 alpha:1.0];
  UIView *card = [[UIView alloc] initWithFrame:CGRectMake(40, 120, 240, 160)];
  card.backgroundColor = [UIColor colorWithWhite:1.0 alpha:0.9];
  card.layer.cornerRadius = 12;
  card.layer.borderWidth = 2;
  card.layer.borderColor = [UIColor blackColor].CGColor;
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(0, 20, 240, 40)];
  label.text = @"tick 0";
  label.textAlignment = NSTextAlignmentCenter;
  label.font = [UIFont boldSystemFontOfSize:20];
  [card addSubview:label];
  gLabel = label;
  UIView *dot = [[UIView alloc] initWithFrame:CGRectMake(100, 90, 40, 40)];
  dot.backgroundColor = [UIColor systemGreenColor];
  [card addSubview:dot];
  // A window needs a root view controller: without one the app is killed during launch, and the
  // fixture would fail for a reason that has nothing to do with the helper.
  UIViewController *root = [[UIViewController alloc] init];
  root.view.backgroundColor = self.window.backgroundColor;
  [root.view addSubview:card];
  self.window.rootViewController = root;
  [self.window makeKeyAndVisible];
  [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
    gTicks += 1;
    gLabel.text = [NSString stringWithFormat:@"tick %ld", (long)gTicks];
  }];
  return YES;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([XCBProbeTestDelegate class]));
  }
}
`

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>XCBProbeTest</string>
  <key>CFBundleIdentifier</key><string>com.dsh.xcbprobetest</string>
  <key>CFBundleName</key><string>XCBProbeTest</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>MinimumOSVersion</key><string>15.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>
</dict>
</plist>
`

let failures = 0
let checks = 0
const check = (condition, label, detail) => {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// Every child is bounded. A simulator whose CoreSimulator services have been left wedged — by a
// debugger that outlived its host, for instance — hangs `simctl install` and never returns, and a
// check that cannot finish must say so rather than sit there.
const run = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8',
  timeout: 180000,
  killSignal: 'SIGKILL',
  ...options,
})

/** A booted simulator, or null. Booting one is the user's business, not a test's. */
function bootedSimulator() {
  const listed = run('xcrun', ['simctl', 'list', 'devices', '--json'])
  try {
    const devices = JSON.parse(listed.stdout ?? '{}').devices ?? {}
    for (const runtime of Object.keys(devices)) {
      for (const device of devices[runtime]) {
        if (device.state === 'Booted') return { udid: device.udid, name: device.name }
      }
    }
  } catch {
    /* an unreadable list is no booted simulator */
  }
  return null
}

const asked = process.argv[2] ?? ''
const simulator = asked === '' ? bootedSimulator() : { udid: asked, name: asked }
if (simulator === null) {
  console.log('no simulator is booted: skipping the live helper check')
  console.log('  boot one and run again, e.g.: xcrun simctl boot "iPhone 17 Pro"')
  process.exit(0)
}

const bundleId = 'com.dsh.xcbprobetest'

// A run that was killed rather than finished leaves the fixture running with a debugger still
// attached — nothing in this process can run when it is SIGKILLed — and CoreSimulator will not
// install over that: `simctl install` then never returns. Only THIS fixture is killed here, by its
// own bundle path, so an app the reader is debugging in Xcode is untouched.
const strays = run('pgrep', ['-f', 'XCBProbeTest.app/XCBProbeTest']).stdout?.trim() ?? ''
if (strays !== '') {
  console.log(`killing a fixture left over from an earlier run: ${strays.split(/\s+/).join(', ')}`)
  run('kill', ['-9', ...strays.split(/\s+/)])
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
const root = join(tmpdir(), `xcb-probe-live-${String(process.pid)}`)
const app = join(root, 'XCBProbeTest.app')
mkdirSync(app, { recursive: true })
writeFileSync(join(root, 'main.m'), FIXTURE)
writeFileSync(join(app, 'Info.plist'), INFO_PLIST)

console.log(`simulator: ${simulator.name} (${simulator.udid})`)
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).stdout?.trim() ?? ''
const built = run('xcrun', ['--sdk', 'iphonesimulator', 'clang', '-fobjc-arc', '-isysroot', sdk,
  '-mios-simulator-version-min=15.0', '-framework', 'UIKit', '-framework', 'Foundation',
  '-o', join(app, 'XCBProbeTest'), join(root, 'main.m')])
check(built.status === 0, 'the fixture app builds', String(built.stderr ?? '').slice(0, 400))
if (built.status !== 0) process.exit(1)

const installed = run('xcrun', ['simctl', 'install', simulator.udid, app])
check(installed.status === 0, 'and installs',
  `${String(installed.stderr ?? '').slice(0, 200)}${installed.signal === null ? '' : ` (killed by ${String(installed.signal)})`}`)
if (installed.status !== 0) process.exit(1)

run('xcrun', ['simctl', 'terminate', simulator.udid, bundleId])
const launched = run('xcrun', ['simctl', 'launch', simulator.udid, bundleId])
const pid = Number(/(\d+)\s*$/.exec(String(launched.stdout ?? '').trim())?.[1] ?? '')
check(Number.isInteger(pid) && pid > 0, 'and launches', `${String(launched.stdout ?? '').trim()} ${String(launched.stderr ?? '').trim()}`)
if (!Number.isInteger(pid) || pid <= 0) process.exit(1)

// --- the plugin's own routes, as the panel drives them --------------------
const workspace = join(root, 'Project')
mkdirSync(workspace, { recursive: true })

const routes = new Map()
const SESSIONS = { 'probe-live': { header: { cwd: workspace } } }
const effect = (callback) => {
  const dispose = callback()
  return typeof dispose === 'function' ? dispose : () => {}
}
apply({
  logger: { info: () => {}, warn: (line) => console.log(`  warn: ${String(line)}`) },
  get: (name) => (name === 'sessions' ? { get: (id) => SESSIONS[id] } : undefined),
  tools: { register: () => () => {} },
  effect,
  inject: (services, callback) => {
    if (services[0] === 'systemPrompt') return callback({ effect, systemPrompt: { section: () => () => {} } })
    if (services[0] === 'skills') return callback({ effect, skills: { register: () => () => {} } })
    callback({
      effect,
      webServer: { register: (route) => { routes.set(route.path.replace('/_dsh/dsh-xcodebuild/', ''), route.handler); return () => {} } },
      connection: { requestRejection: () => undefined },
    })
  },
})

async function route(path, body) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`no route ${path}`)
  let text = ''
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
    resume() {},
  }, {
    setHeader() {},
    end(chunk) { if (typeof chunk === 'string') text += chunk },
    write(chunk) { if (typeof chunk === 'string') text += chunk },
  })
  return text === '' ? null : JSON.parse(text)
}

const target = { sessionId: 'probe-live', destination: `platform=iOS Simulator,id=${simulator.udid}`, pid, bundleId }
const labelText = (tree) => (tree?.records ?? []).find((record) => record.className === 'UILabel')?.text ?? ''

const first = await route('lldb', { op: 'view', ...target })
check(first?.ok === true, 'the plugin reads the view hierarchy', first?.note)
check(first?.probe === true, 'through the helper inside the app, not the debugger',
  JSON.stringify({ probe: first?.probe, note: first?.probeNote }))
check(first?.continued === true && first?.stoppedMs === 0, 'and the app is not left stopped',
  JSON.stringify({ continued: first?.continued, stoppedMs: first?.stoppedMs }))
check((first?.records ?? []).some((record) => record.className === 'UILabel'), 'the tree holds the label')
check(/tick \d+/.test(labelText(first)), 'with the app\'s own live text in it', labelText(first))
check(typeof first?.lookinPath === 'string' && first.lookinPath.endsWith('.lookin'), 'and the Lookin file is written', first?.lookinPath)

const card = (first?.records ?? []).find((record) => record.className === 'UIView' && record.frame?.width === 240)
const label = (first?.records ?? []).find((record) => record.className === 'UILabel')
check(card !== undefined && label !== undefined, 'the card and the label are in the tree')
if (card === undefined || label === undefined) process.exit(1)
// The same view, spelled two ways: the tree prints what LLDB printed (`0x0000000101a20d70`), and the
// style lines carry the address converted from the decimal the helper reports (`0x101a20d70`). Both
// are the same number, so the lookup normalises instead of trusting one spelling.
const styleOf = (record) => {
  const key = String(record.address).toLowerCase()
  const bare = key.replace(/^0x0*/, '0x')
  return first?.styles?.[key] ?? first?.styles?.[bare] ?? null
}
const cardStyle = styleOf(card)
const labelStyle = styleOf(label)
check(cardStyle?.radius === 12, 'the styles carry the card\'s corner radius',
  `${JSON.stringify(cardStyle)} · keys ${JSON.stringify(Object.keys(first?.styles ?? {}).slice(0, 4))} · address ${card.address}`)
check(labelStyle?.fontSize === 20, 'and the label\'s font size', JSON.stringify(labelStyle))

// The whole point, proved from inside the app: the label the app rewrites ten times a second has
// moved between two reads. A stopped app's label does not.
await new Promise((resolve) => setTimeout(resolve, 700))
const second = await route('lldb', { op: 'view', ...target, fresh: true })
check(labelText(second) !== '' && labelText(second) !== labelText(first),
  'and the label moved between two reads: the app was never stopped',
  `${labelText(first)} then ${labelText(second)}`)

const attrs = await route('lldb', { op: 'attributes', ...target, address: label.address })
check(attrs?.ok === true && attrs?.probe === true, 'the attributes are read live', attrs?.note)
check((attrs?.groups ?? []).some((group) => group.rows.some((row) => row.name === '_numberOfLines')) === true,
  'from what the runtime reports about the class', JSON.stringify((attrs?.groups ?? []).length))

const layout = await route('lldb', { op: 'constraints', ...target, address: card.address })
check(layout?.ok === true && layout?.probe === true, 'the layout report is read live', layout?.note)
check(layout?.layout !== null && layout?.layout !== undefined, 'with a report in it', JSON.stringify(layout?.layout)?.slice(0, 120))

const images = await route('lldb', { op: 'images', ...target, addresses: [card.address] })
const picture = images?.images?.[card.address.toLowerCase()] ?? images?.images?.[card.address]
check(images?.ok === true && images?.probe === true, 'the view renders its own pixels, live', images?.note)
check(typeof picture === 'string' && picture.startsWith('data:image/png;base64,'), 'and they are a picture', String(picture)?.slice(0, 40))

const edit = await route('lldb', { op: 'edit', ...target, address: label.address, key: 'text', kind: 'text', value: 'written by the helper' })
check(edit?.ok === true && edit?.probe === true, 'an attribute is written while the app runs', edit?.note)
check(String(edit?.value).includes('written by the helper'), 'and the app reports it back', edit?.value)

const state = await route('state', { sessionId: 'probe-live', workspace })
check(state?.probe?.active === true && state?.probe?.port > 0, 'the panel is told the reads are live', JSON.stringify(state?.probe))

// A stop the user asked for is not ended, and the read still works — through the debugger.
await route('lldb', { op: 'interrupt', ...target })
const stopped = await route('lldb', { op: 'view', ...target, fresh: true })
check(stopped?.ok === true && stopped?.probe !== true, 'an app stopped by hand is read through the debugger', JSON.stringify({ ok: stopped?.ok, probe: stopped?.probe }))
const stoppedState = await route('state', { sessionId: 'probe-live', workspace })
check(stoppedState?.probe?.active === false, 'and the panel is not told reads are live while it is stopped', JSON.stringify(stoppedState?.probe))
await route('lldb', { op: 'continue', ...target })
const again = await route('lldb', { op: 'view', ...target, fresh: true })
check(again?.probe === true, 'letting it go makes the next read live again, with no second injection', JSON.stringify({ probe: again?.probe, note: again?.probeNote }))

const status = await route('lldb', { op: 'state' })
check(status?.session?.state === 'running', 'and the debugger is left with the app running', JSON.stringify(status?.session?.state))

// Released before the app is asked to go away. `simctl terminate` against an app that still has an
// lldb attached does not return — measured here, three times — which is one more reason the
// debugger is never left attached to an app nobody is reading any more.
await route('lldb', { op: 'detach', ...target })
const released = await route('lldb', { op: 'state' })
check(released?.session?.state === 'dead' || released?.session?.state === 'idle',
  'detaching leaves no debugger holding the app', JSON.stringify(released?.session?.state))
run('xcrun', ['simctl', 'terminate', simulator.udid, bundleId], { timeout: 30000 })
rmSync(root, { recursive: true, force: true })

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('probe live OK')
