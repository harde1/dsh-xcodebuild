// The window to mirror, and the point a click in the image lands on: both are numbers that a
// wrong answer turns into a click in the wrong application, so both are checked here rather
// than by looking at the panel.
import {
  MIN_MIRROR_EDGE,
  MIN_MIRROR_WIDTH,
  clampFraction,
  clampWheelDelta,
  helperBinaryPath,
  lookinPermissionNote,
  mirrorPoint,
  needsHelperBuild,
  parseFirstPid,
  parseHelperStatus,
  parseWindowList,
  pickMirrorWindow,
} from '../lib/lookin-window.js'

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
const eq = (actual, expected, label) => check(Object.is(actual, expected), label, JSON.stringify(actual))

// Real lines from `wininfo list` on the development machine, tab-separated as printed:
// pid, window id, x, y, width, height, layer, owner, title.
const REAL_LIST = [
  '1186\t7\t0\t0\t1992\t1069\t0\tDSH Desktop\t',
  '1371\t8\t600\t260\t1000\t740\t0\t问题报告程序\tLookin的问题报告',
  '1425\t9\t740\t460\t1000\t700\t0\tXcode\tWelcome to Xcode',
  '4312\t1633\t200\t908\t420\t332\t0\tLookin\tLookin',
  '4313\t1634\t300\t300\t140\t90\t0\tLookin\tLookin Inspector',
  '841\t56\t2084\t0\t38\t30\t25\t控制中心\tItem-0',
].join('\n')

section('reading the helper’s window list')
const windows = parseWindowList(REAL_LIST)
eq(windows.length, 6, 'one entry per line')
eq(windows[0].pid, 1186, 'the pid is the first field')
eq(windows[0].id, 7, 'then the window id')
eq(windows[0].x, 0, 'then the x of the frame')
eq(windows[0].width, 1992, 'and its width, after the y')
eq(windows[0].layer, 0, 'then the layer')
eq(windows[3].owner, 'Lookin', 'the owner is read')
eq(windows[3].title, 'Lookin', 'and the title')
eq(windows[1].title, 'Lookin的问题报告', 'a title with non-ASCII characters survives')
eq(parseWindowList('').length, 0, 'no output is no windows')
eq(parseWindowList('\n\n').length, 0, 'blank lines are not windows')
eq(parseWindowList('1\t2\t3').length, 0, 'a truncated line is skipped rather than guessed at')
eq(parseWindowList('x\ty\t1\t2\t3\t4\t0\tOwner\tTitle').length, 0, 'and a non-numeric field is skipped too')

section('which window to mirror')
// The report window is FIRST in the list and smaller; the main window is the one to show.
eq(pickMirrorWindow(windows, 4312).id, 1633, 'the largest window of the process, not the first')
eq(pickMirrorWindow(windows, 4312).width, 420, 'and it is the wide one')
eq(pickMirrorWindow(windows, 1425).title, 'Welcome to Xcode', 'another process is mirrored just as well')
eq(pickMirrorWindow(windows, 9999), null, 'a process with no window has nothing to mirror')
eq(pickMirrorWindow(windows).owner, 'DSH Desktop', 'with no pid the largest window on screen wins')
check(pickMirrorWindow(parseWindowList('1\t2\t0\t0\t80\t60\t0\tLookin\tTiny'), 1) === null, 'a utility panel is below the floor')
check(
  pickMirrorWindow(parseWindowList(`1\t2\t0\t0\t${MIN_MIRROR_WIDTH}\t${MIN_MIRROR_EDGE}\t0\tLookin\tEdge`), 1) !== null,
  'and the floor itself is large enough',
)
check(pickMirrorWindow(parseWindowList('1\t2\t0\t0\t900\t600\t25\tLookin\tMenu'), 1) === null, 'a non-zero layer is not a window to mirror')

section('the pid of a running app')
eq(parseFirstPid('4312\n'), 4312, 'the plain answer')
eq(parseFirstPid('\n\n4312\n9999\n'), 4312, 'blank lines first are skipped')
eq(parseFirstPid(''), null, 'not running is null')
eq(parseFirstPid('not a pid\n'), null, 'and junk is not a pid')

section('where a click in the image lands')
// Measured: a 420x300 content rect reports a 420x332 frame, and its centre is (410, 1074) —
// the point a click was posted to on this machine while testing delivery.
const frame = { x: 200, y: 908, width: 420, height: 332 }
const centre = mirrorPoint(frame, 0.5, 0.5)
eq(centre.x, 410, 'the centre x of the frame')
eq(centre.y, 1074, 'the centre y of the frame — the point this was measured against')
eq(mirrorPoint(frame, 0, 0).x, 200, 'the top-left corner is the frame’s origin')
eq(mirrorPoint(frame, 0, 0).y, 908, 'on both axes')
eq(mirrorPoint(frame, 1, 1).x, 620, 'the bottom-right corner is origin plus size')
eq(mirrorPoint(frame, 1, 1).y, 1240, 'on both axes')
eq(mirrorPoint(frame, -0.5, -3).x, 200, 'a pointer dragged out of the left edge clamps to it')
eq(mirrorPoint(frame, 2, 7).y, 1240, 'and out of the bottom edge clamps to the bottom')
eq(mirrorPoint(frame, 0.25, 0.25).x, 305, 'a quarter across is a quarter of the width')
eq(mirrorPoint({ x: 0, y: 0, width: 10, height: 10 }, 0.55, 0).x, 6, 'a point is rounded, not truncated')

section('the fractions themselves')
eq(clampFraction(0.5), 0.5, 'a fraction inside the window is left alone')
eq(clampFraction(-0.1), 0, 'below zero is the left edge')
eq(clampFraction(1.4), 1, 'above one is the right edge')
eq(clampFraction(Number.NaN), 0, 'a missing fraction is not a click in the middle of the window')
eq(clampFraction(Number.POSITIVE_INFINITY), 1, 'and an infinite one is the far edge')

section('what the helper is allowed to do')
const blocked = parseHelperStatus('accessibility=0 screenCapture=1 frontmostPid=814\n')
eq(blocked.accessibility, false, 'the measured state of this machine: posting is blocked')
eq(blocked.screenCapture, true, 'while screen capture is allowed — which is why the mirror works and clicks do not')
eq(blocked.frontmostPid, 814, 'and the frontmost pid is read')
const allowed = parseHelperStatus('accessibility=1 screenCapture=1 frontmostPid=99')
eq(allowed.accessibility, true, 'a granted state reads as granted')
eq(parseHelperStatus('').accessibility, false, 'and silence is not permission')

section('where the compiled helper lives')
eq(helperBinaryPath('/Users/mac'), '/Users/mac/Library/Caches/dsh-xcodebuild/wininfo', 'under the user’s caches')
eq(helperBinaryPath('/Users/mac/'), '/Users/mac/Library/Caches/dsh-xcodebuild/wininfo', 'a trailing slash does not double up')
check(helperBinaryPath('').startsWith('/Library/Caches/'), 'no home directory still yields a path', helperBinaryPath(''))

section('when the helper has to be rebuilt')
eq(needsHelperBuild(null, 1000), true, 'a missing binary is built')
eq(needsHelperBuild(1000, null), true, 'an unreadable source is not trusted')
eq(needsHelperBuild(1000, 2000), true, 'a newer source rebuilds')
eq(needsHelperBuild(2000, 1000), false, 'an up-to-date binary is reused')
eq(needsHelperBuild(1000, Number.NaN), true, 'a timestamp that is not a number rebuilds')

section('a wheel delta the mirrored app can survive')
eq(clampWheelDelta(12), 12, 'an ordinary delta is forwarded as it is')
eq(clampWheelDelta(-12), -12, 'in both directions')
eq(clampWheelDelta(5000), 400, 'a trackpad flick is capped, not landed as a jump to the end')
eq(clampWheelDelta(-5000), -400, 'and capped the same way upwards')
eq(clampWheelDelta(5.7), 5, 'a fractional delta becomes an integer')
eq(clampWheelDelta(Number.NaN), 0, 'a delta that is not a number is no scroll at all')
eq(clampWheelDelta(100, 50), 50, 'the cap is a parameter, not a constant')

section('what to tell the user about the grants')
eq(
  lookinPermissionNote({ accessibility: true, screenCapture: true }),
  '',
  'nothing missing is nothing to say',
)
check(
  lookinPermissionNote({ accessibility: false, screenCapture: true }).includes('DSH Desktop Helper'),
  'the blocked half names the process the user has to switch on',
  lookinPermissionNote({ accessibility: false, screenCapture: true }),
)
check(
  lookinPermissionNote({ accessibility: false, screenCapture: true }).includes('Accessibility'),
  'and the pane it lives in',
)
check(
  !lookinPermissionNote({ accessibility: false, screenCapture: true }).includes('Screen Recording'),
  'without sending them to the pane that is already granted',
)
check(
  lookinPermissionNote({ accessibility: true, screenCapture: false }).includes('Screen Recording'),
  'a missing capture grant is reported on its own',
)
check(
  lookinPermissionNote({ accessibility: false, screenCapture: false }).includes('Accessibility')
    && lookinPermissionNote({ accessibility: false, screenCapture: false }).includes('Screen Recording'),
  'both missing is both said',
)
eq(lookinPermissionNote({}), '', 'a helper that said nothing is not reported as a missing grant')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('lookin window OK')
