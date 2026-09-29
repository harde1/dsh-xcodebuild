// What the panel's detail pane shows is decided in the host, so it is tested here rather than by
// looking at a screenshot: `recursiveDescription` prints colours and layers as object
// descriptions, and a swatch that comes out the wrong shade is a bug nobody notices.
import { detailRows, parseColorValue, parseLayerClass } from '../lib/view-details.js'

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

section('a colour with components becomes a CSS colour')
const rgb = parseColorValue('<UIDeviceRGBColor: 0x6000001; red = 1; green = 0.5; blue = 0; alpha = 0.5>')
eq(rgb.css, 'rgba(255, 128, 0, 0.5)', 'components are scaled to 0-255')
eq(rgb.name, '', 'and a component colour has no name to show')
eq(parseColorValue('<UIDeviceRGBColor:0x1 red=1 green=0 blue=0 alpha=1>').css, 'rgba(255, 0, 0, 1)',
  'the space-separated spelling iOS also prints is read too')
eq(parseColorValue('<UIDeviceRGBColor: 0x1; red = 1; green = 0; blue = 0>').css, 'rgba(255, 0, 0, 1)',
  'a missing alpha is opaque, not zero')
eq(parseColorValue('<UIDeviceRGBColor: 0x1; red = 2; green = 0; blue = -1; alpha = 3>').css, 'rgba(255, 0, 0, 1)',
  'and out-of-range values are clamped rather than trusted')

section('a dynamic colour keeps its name, because its value needs the app running')
const dynamic = parseColorValue('<UIDynamicSystemColor: 0x1; name = systemBackgroundColor>')
eq(dynamic.css, '', 'there is nothing to paint without the app')
eq(dynamic.name, 'systemBackgroundColor', 'so the name is what is shown')
eq(dynamic.raw.startsWith('<UIDynamicSystemColor'), true, 'with the printed value kept for the detail row')
eq(parseColorValue('').css, '', 'no colour at all is no colour')

section('the layer class is read out of its description')
eq(parseLayerClass('<CALayer: 0x6000034a0000>'), 'CALayer', 'a plain layer')
eq(parseLayerClass('<CAGradientLayer: 0x1>'), 'CAGradientLayer', 'and a subclass')
eq(parseLayerClass(''), '', 'and nothing is nothing')
eq(parseLayerClass('nil'), '', 'a layer description that is not an object is not guessed at')

section('the rows are what a person reads, in the order they read it')
const record = {
  className: 'HIDProbe.StatusLight',
  address: '0x105b17fe0',
  frame: { x: 12.5, y: 55, width: 116.6666666, height: 44 },
  text: 'GC 键盘',
  hidden: true,
  attributes: { bounds: '(0 0; 116.667 44)', backgroundColor: '<UIDynamicSystemColor: 0x1; name = systemRedColor>', layer: '<CALayer: 0x2>', tag: '7', alpha: '0.5' },
}
const rows = detailRows(record, { className: 'HIDProbe.StatusLight', chain: ['HIDProbe.StatusLight', 'UIView', 'UIResponder', 'NSObject'] })
const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]))
eq(rows[0].label, 'Class', 'it starts with what the view is')
eq(rows[1].label, 'Address', 'then which one it is')
eq(rows[2].label, 'Frame', 'then where it is')
eq(byLabel.Frame, '12.5, 55  116.667×44', 'with a frame rounded past floating-point noise')
eq(byLabel.Bounds, '(0 0; 116.667 44)', 'and its bounds, which is not the same number')
eq(byLabel.Hidden, 'yes', 'a hidden view says so')
eq(byLabel.Alpha, '0.5', 'and a half-transparent one gives its alpha')
eq(byLabel.Text, 'GC 键盘', 'the label text')
eq(byLabel.Layer, 'CALayer', 'the layer class')
eq(byLabel.Inherits, 'UIView → UIResponder → NSObject', 'and the chain without the class already named above')
eq(rows.some((row) => row.value === ''), false, 'nothing empty is listed as if it were a fact')
eq(rows.some((row) => row.label === 'Tag'), true, 'a non-zero tag is worth a row')

const bare = detailRows({ className: 'UIView', address: '0x1', attributes: { tag: '0' } }, { chain: [] })
eq(bare.some((row) => row.label === 'Tag'), false, 'a zero tag is the default and is left out')
eq(bare.some((row) => row.label === 'Inherits'), false, 'and an unknown chain is not invented')
eq(bare.some((row) => row.label === 'Frame'), false, 'nor is a frame that was never read')
eq(detailRows(null, null).length, 0, 'no record is no rows')
eq(detailRows(record, {}).some((row) => row.label === 'Inherits'), false, 'a host answer without a chain still lists the rest')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('view details OK')
