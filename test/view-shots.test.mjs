// The render expression is the one piece of this plugin that runs INSIDE the app, so its shape is
// what the debugger has to accept: one line, no variadic ObjC methods, a cast on every call whose
// return type LLDB says it does not know. Each of those was a live failure before it was a rule.
import { MAX_RENDER_SCALE, SHOT_DIR_NAME, parseShotsReport, shotFileName, viewShotsExpression } from '../lib/view-shots.js'

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

const expression = viewShotsExpression()

section('the expression is one line, because LLDB reads input a line at a time')
eq(expression.split('\n').length, 1, 'no newlines survive')
eq(expression.startsWith('po '), true, 'and it is a `po`, which is how a statement expression is evaluated')

section('nothing variadic: an LLDB expression reads the wrong register for variadic arguments')
// Measured: `snprintf(name, sizeof(name), "solo-%lx.png", address)` named all 32 renders
// `solo-93ccf4258ac9d1ca.png` — one constant garbage value, each overwriting the last.
eq(/stringWithFormat:|snprintf|NSLog\(|appendFormat:/.test(expression), false, 'no format-string call, C or ObjC')

section('the calls LLDB rejects without a cast are all cast')
for (const call of ['UIGraphicsGetCurrentContext', 'UIGraphicsGetImageFromCurrentImageContext', 'UIImagePNGRepresentation', 'stringValue', 'stringWithUTF8String']) {
  const used = expression.includes(call)
  const cast = new RegExp(`\\([A-Za-z_][\\w ]*\\*?\\)\\s*\\[?[^;]{0,40}${call}`).test(expression) || new RegExp(`\\([A-Za-z_][\\w ]*\\*?\\)${call}`).test(expression)
  check(!used || cast, `${call} carries a cast`, expression.slice(Math.max(0, expression.indexOf(call) - 40), expression.indexOf(call) + 20))
}

section('it renders each view the way LookinServer does')
check(expression.includes('renderInContext:'), 'renderInContext draws the layer tree while the app is stopped')
eq(expression.includes('drawViewHierarchyInRect'), false, 'and not drawViewHierarchyInRect, which waits for a screen update that cannot arrive')
check(/setHidden:YES/.test(expression) && /setHidden:NO/.test(expression), 'the sublayers are hidden for the solo image and restored after it')
check(expression.includes(`solo-`) && expression.includes(`group-`), 'both images are written, named solo-<index> and group-<index>')
eq(expression.includes('address'), false, 'and never named by address, which is the value a variadic call got wrong')
check(expression.includes(String(MAX_RENDER_SCALE)), `the render is capped at ${MAX_RENDER_SCALE} px on its long edge`)
check(expression.includes('20000'), 'and views too large for a context are skipped rather than crashing CoreGraphics')
// `firstObject` was another "no known method" error until it was cast, and it is nested three
// message sends deep, so it is asserted as the whole expression rather than by a clever pattern.
check(expression.includes('(UIView *)[[[UIApplication sharedApplication] windows] firstObject]'), 'the root window is reached through a cast too')

section('the report is parsed into the node it belongs to')
const report = parseShotsReport(`RENDERED 2 SKIPPED 1 DIR /tmp/dsh-lookin-shots
0 <UIWindow: 0x105a0eef0; frame = (0 0; 402 874); gestureRecognizers = <NSArray: 0x600000c070c0>>
1 <HIDProbe.StatusLight: 0x105b17fe0; frame = (0 0; 120.667 44)>
2 <_UITextLayoutView: 0x105911cd0; frame = (0 0; 10 10)>`)
eq(report.rendered, 2, 'the rendered count')
eq(report.skipped, 1, 'the skipped count')
eq(report.dir, '/tmp/dsh-lookin-shots', 'and the directory the app wrote to')
eq(report.views.length, 3, 'every walked view is reported')
eq(report.views[1].address, '0x105b17fe0', 'with the address the tree matches it by')
eq(report.views[1].className, 'HIDProbe.StatusLight', 'and its class, dots and all')
eq(report.views[0].index, 0, 'and the walk index that names its files')
eq(parseShotsReport('nothing useful'), null, 'a report that never happened parses to null')
eq(parseShotsReport('RENDERED 0 SKIPPED 0 DIR /tmp/x\n').views.length, 0, 'a walk with nothing in it yields no views, which is how the caller is told to fall back')

section('file names')
eq(shotFileName('solo', 0), 'solo-0.png', 'index zero')
eq(shotFileName('group', 41), 'group-41.png', 'and a two-digit one')
eq(shotFileName('solo', -1), null, 'a negative index has no file')
eq(shotFileName('solo', 1.5), null, 'nor has a fractional one')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('view shots OK')
