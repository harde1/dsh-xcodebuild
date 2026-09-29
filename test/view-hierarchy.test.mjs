// Tests for the view-hierarchy parser.
//
// The fixture is the shape of a real `recursiveDescription` dump, taken from an iPhone
// 13 running iOS 26.6.2 under Xcode 26.0.1 while building this feature. Only the app's own
// names are replaced: what the parser has to get right is the FORMAT — the `|` indentation,
// the nested `<>` inside a view's own line, and the attributes that follow the closing `>>`.
//
// Run: node test/view-hierarchy.test.mjs
import {
  VIEW_HIERARCHY_EXPRESSION,
  buildViewTree,
  filterViewHierarchy,
  formatViewHierarchy,
  parseFrame,
  parseViewHierarchy,
  parseViewAttributes,
  parseViewLine,
  parseViewProperties,
  viewHierarchyStats,
} from '../lib/view-hierarchy.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}
function eq(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}
function section(name) {
  console.log(`\n# ${name}`)
}

const RAW = [
  '<UIWindow: 0x100f5f280; frame = (0 0; 390 844); gestureRecognizers = <NSArray: 0x1015d5f50>; layer = <UIWindowLayer: 0x1015cd740>>',
  '   | <UITransitionView: 0x101718c00; frame = (0 0; 390 844); autoresize = W+H; layer = <CALayer: 0x10174d3b0>>',
  '   |    | <UIView: 0x1017301c0; frame = (0 0; 390 844); autoresize = W+H; backgroundColor = <UIDynamicSystemColor: 0x101467940; name = systemBackgroundColor>; layer = <CALayer: 0x1014272a0>>',
  '   |    |    | <UIStackView: 0x101730a80; frame = (12 55; 366 747); layer = <CALayer: 0x101426b80>> axis=vert distribution=fill alignment=fill',
  '   |    |    |    | <UIStackView: 0x101730380; frame = (0 0; 366 44); layer = <CALayer: 0x1014272d0>> axis=horiz distribution=fillEqually alignment=fill',
  '   |    |    |    |    | <Example.StatusLight: 0x100f57280; baseClass = UILabel; frame = (0 0; 116.667 44); text = \'● GC 键盘\'; clipsToBounds = YES; userInteractionEnabled = NO; layer = <_UILabelLayer: 0x101463980>>',
  '   |    |    |    |    | <Example.StatusLight: 0x100f57f00; baseClass = UILabel; frame = (124.667 0; 116.667 44); text = \'○ GC 鼠标\'; clipsToBounds = YES; layer = <_UILabelLayer: 0x101463680>>',
  '   |    |    |    |    | <UITextField: 0x1016c4000; frame = (0 54; 366 34); text = \'\'; opaque = NO; layer = <CALayer: 0x101426b40>>',
  '   |    |    |    |    |    | <_UITouchPassthroughView: 0x101730fc0; frame = (0 0; 352 30); hidden = YES; alpha = 0.5; layer = <CALayer: 0x10174e100>>',
  '   |    |    |    | <UILabel: 0x101731340; frame = (0 0; 3 424.667); backgroundColor = UIExtendedGrayColorSpace 0 0.35; layer = <CALayer: 0x10174e760>>',
  ')',
  '(lldb) po [[[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]',
].join('\n')

// --- one line --------------------------------------------------------------

section('a view line becomes a record')
{
  const root = parseViewLine('<UIWindow: 0x100f5f280; frame = (0 0; 390 844); layer = <UIWindowLayer: 0x1015cd740>>')
  eq(root.depth, 0, 'the root has no pipes, so depth 0')
  eq(root.className, 'UIWindow', 'class name before the colon')
  eq(root.address, '0x100f5f280', 'address after it')
  eq(root.frame, { x: 0, y: 0, width: 390, height: 844 }, 'frame is parsed into numbers')
  eq(root.tail, '', 'nothing follows the closing brackets')

  const child = parseViewLine('   | <UITransitionView: 0x101718c00; frame = (0 0; 390 844); autoresize = W+H>')
  eq(child.depth, 1, 'one pipe is one level, counted rather than measured')
  const deep = parseViewLine('   |    |    | <UIStackView: 0x101730a80; frame = (12 55; 366 747); layer = <CALayer: 0x101426b80>> axis=vert distribution=fill alignment=fill')
  eq(deep.depth, 3, 'three pipes are three levels')
  eq(deep.tail, 'axis=vert distribution=fill alignment=fill', 'the attributes after >> are kept, not swallowed into the layer')
  eq(deep.attributes, { axis: 'vert', distribution: 'fill', alignment: 'fill' }, 'and are parsed, because a stack view\'s axis is usually why a screen looks wrong')
  check(deep.raw.startsWith('   |    |    | <UIStackView'), 'the raw line is kept for a panel that wants to show it verbatim')
}

section('a view\'s own line survives its nested objects')
{
  const line = '   |    | <UIView: 0x1017301c0; frame = (0 0; 390 844); backgroundColor = <UIDynamicSystemColor: 0x101467940; name = systemBackgroundColor>; layer = <CALayer: 0x1014272a0>>'
  const record = parseViewLine(line)
  eq(record.className, 'UIView', 'the outer class is the view, not the nested color')
  eq(record.address, '0x1017301c0', 'and the outer address')
  const background = record.properties.find((p) => p.key === 'backgroundColor')
  eq(background.value, '<UIDynamicSystemColor: 0x101467940; name = systemBackgroundColor>', 'a property value keeps its nested object and its inner semicolon intact')
  const layer = record.properties.find((p) => p.key === 'layer')
  eq(layer.value, '<CALayer: 0x1014272a0>', 'and the layer is its own property, not part of the background')
}

section('text, hidden and alpha are lifted out for searching')
{
  const label = parseViewLine('   |    |    |    |    | <Example.StatusLight: 0x100f57280; baseClass = UILabel; frame = (0 0; 116.667 44); text = \'● GC 键盘\'; clipsToBounds = YES>')
  eq(label.text, '● GC 键盘', 'quotes and non-ASCII text are unwrapped')
  eq(label.baseClass, 'UILabel', 'baseClass is available, since a custom class often masquerades')
  const empty = parseViewLine('   |    | <UITextField: 0x1016c4000; frame = (0 54; 366 34); text = \'\'; opaque = NO>')
  eq(empty.text, '', 'an empty string is an empty string, not a missing value')
  const hidden = parseViewLine('   |    |    | <_UITouchPassthroughView: 0x101730fc0; frame = (0 0; 352 30); hidden = YES; alpha = 0.5>')
  eq(hidden.hidden, true, 'hidden = YES is a boolean')
  eq(hidden.alpha, 0.5, 'and alpha is a number')
}

section('lines that are not views are not invented into views')
{
  for (const line of [
    ')',
    '(lldb) po [[[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]',
    'error: unable to evaluate expression while the process is attaching',
    '',
    'Process 13005 stopped',
  ]) {
    eq(parseViewLine(line), null, `rejected: ${JSON.stringify(line)}`)
  }
}

section('property and frame helpers')
{
  eq(parseViewProperties('frame = (0 0; 390 844); opaque = NO').map((p) => p.key), ['frame', 'opaque'], 'properties split on the separators that are not inside a value')
  eq(parseViewAttributes('axis=vert distribution=fill alignment=fill'), { axis: 'vert', distribution: 'fill', alignment: 'fill' }, 'the space-separated attributes after >> are split into the facts a stack view is made of')
  eq(parseViewAttributes(''), {}, 'and no tail is no attributes')
  eq(parseFrame('(0 0; 390 844)'), { x: 0, y: 0, width: 390, height: 844 }, 'a frame parses')
  eq(parseFrame('(12.5 -3; 366 747.25)'), { x: 12.5, y: -3, width: 366, height: 747.25 }, 'including negatives and fractions')
  eq(parseFrame('not a frame'), null, 'and nonsense is null rather than NaN fields')
}

// --- the whole dump --------------------------------------------------------

section('the whole dump')
{
  const records = parseViewHierarchy(RAW)
  eq(records.length, 10, 'every view line is a record and nothing else is')
  eq(records[0].className, 'UIWindow', 'the window comes first')
  eq(records.filter((r) => r.className === 'Example.StatusLight').length, 2, 'both custom labels are there')
  const stats = viewHierarchyStats(records)
  eq(stats.views, 10, 'the stats count views')
  eq(stats.depth, 6, 'and the deepest level')
  eq(stats.classes[0], { className: 'Example.StatusLight', count: 2 }, 'classes are ranked by how many there are')
  eq(formatViewHierarchy(records).total, 10, 'formatting without a filter shows everything')
}

section('nesting is rebuilt from depth')
{
  const tree = buildViewTree(parseViewHierarchy(RAW))
  eq(tree.length, 1, 'one root')
  eq(tree[0].className, 'UIWindow', 'which is the window')
  eq(tree[0].children[0].className, 'UITransitionView', 'its child')
  eq(tree[0].children[0].children[0].children[0].className, 'UIStackView', 'three levels down through the single-child chain')
  const outer = tree[0].children[0].children[0].children[0]
  eq(outer.children.length, 2, 'the vertical stack holds the horizontal stack and the label')
  eq(outer.children[0].children[0].className, 'Example.StatusLight', 'and the labels hang off the horizontal one')
  const jump = buildViewTree([{ depth: 0, className: 'A' }, { depth: 3, className: 'B' }])
  eq(jump[0].children[0].className, 'B', 'a depth that jumps still nests under the nearest shallower view rather than being dropped')
}

section('filtering keeps the ancestors that give a match its meaning')
{
  const records = parseViewHierarchy(RAW)
  const labels = filterViewHierarchy(records, { className: 'StatusLight' })
  eq(labels.map((r) => r.className), ['UIWindow', 'UITransitionView', 'UIView', 'UIStackView', 'UIStackView', 'Example.StatusLight', 'Example.StatusLight'], 'a label match brings its whole chain with it')
  const byText = filterViewHierarchy(records, { text: '鼠标' })
  eq(byText[byText.length - 1].text, '○ GC 鼠标', 'filtering by text finds the label')
  eq(byText.length, 6, 'and still shows the path to it')
  eq(filterViewHierarchy(records, {}).length, 10, 'no filter is no pruning')
  eq(filterViewHierarchy(records, { className: 'NoSuchView' }).length, 0, 'a filter that matches nothing yields nothing')
}

section('the text form is what a model reads')
{
  const records = parseViewHierarchy(RAW)
  const formatted = formatViewHierarchy(records)
  const lines = formatted.text.split('\n')
  eq(lines[0], 'UIWindow 0x100f5f280 0 0 390 844', 'the root line carries class, address and frame')
  eq(lines[1].startsWith('  UITransitionView'), true, 'children are indented by two spaces per level')
  check(lines.some((line) => line.includes('"● GC 键盘"')), 'a label\'s text is quoted so spaces are unambiguous')
  const capped = formatViewHierarchy(records, { maxLines: 4 })
  eq(capped.shown, 4, 'maxLines caps what is shown')
  eq(capped.truncated, true, 'and says so')
  check(capped.text.includes('6 more views not shown'), 'the count of what was left out is stated, not hidden')
  const filtered = formatViewHierarchy(records, { className: 'StatusLight' })
  eq(filtered.total, 7, 'filtering before formatting is applied')
  eq(filtered.text.includes('UITextField'), false, 'a view that does not match is gone')
}

section('the expressions are the ones that were measured to work')
{
  check(VIEW_HIERARCHY_EXPRESSION.includes('windows] firstObject] recursiveDescription'), 'the dump goes through the key window, which still answers on iOS 26')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
