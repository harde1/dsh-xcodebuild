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

section('no CG struct is ever a value in the expression: LLDB on Xcode 26 has deleted its copy')
// Measured on an iPhone 17 simulator, Xcode 26's lldb, iOS 26. Every way of holding a struct by
// value fails to COMPILE — `CGSize size = [layer frame].size`, `CGRect r = CGRectMake(...)`,
// `CGSize s = CGSizeMake(...)`, `[view frame].size.width` with no local at all — in `po`,
// `expression -l objc` and `expression -l objc++` alike:
//
//     error: attempt to use a deleted function
//
// while the walk, the message sends, the arrays and everything pointer- or scalar-shaped compile
// and run. So the render takes its geometry out of `NSValue` into a `double[4]`, makes its context
// with `CGBitmapContextCreate` at a pixel size computed from those doubles, and reads the image
// back with `CGBitmapContextCreateImage`. Without this the whole render failed and every full export
// silently fell back to cropping a screen capture.
eq(/\b(CGSize|CGRect|CGPoint)\b/.test(expression), false, 'no struct type is named, in any form')
check(!/UIGraphicsBeginImageContext/.test(expression), 'and no UIKit image context, whose size argument is a struct')
check(expression.includes('[layer renderInContext:soloContext]'), 'the layer is drawn into a bitmap context')
check(/CGBitmapContextCreate\(NULL, pixelWidth, pixelHeight/.test(expression), 'made at a pixel size, not a point size')
check(expression.includes('double box[4] = {0, 0, 0, 0}'), 'geometry starts as four doubles')
check(expression.includes('[frameBox getValue:(void *)box]'), 'filled by NSValue, which is the only way to ask for a frame without naming CGRect')
check(/initWithCGImage:soloImage scale:\(CGFloat\)viewScale orientation:\(UIImageOrientation\)0/.test(expression),
  'and the image is an enum-cast UIImage, not a bare 0 the parser refuses')
eq(/\[NSValue valueWith/.test(expression), false, 'no NSValue is constructed, only read from the view')

section("the modules are imported, because the target\u2019s language has no headers")
// `po` evaluates in the target's language with no headers: ObjC classes resolve through the runtime,
// but every typedef is an undeclared identifier, so the render did not compile at first use either.
check(expression.includes('@import UIKit; @import QuartzCore;'), 'UIKit and QuartzCore are imported ahead of the expression')
eq(expression.indexOf('@import UIKit'), expression.indexOf('po ') + 3, 'immediately after the `po`, before anything that needs them')

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
