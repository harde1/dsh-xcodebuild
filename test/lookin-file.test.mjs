// Tests for the Lookin archive builder.
//
// The fixture is the shape `lib/view-hierarchy.js` produces from a real dump, and the
// EXPECTED keys are the ones LookinServer itself archives, read off
// `LookinDisplayItem.m -encodeWithCoder:` — a missing key here is a node Lookin.app draws
// wrong, which is the failure this suite exists to catch. The string encoding of `frame`
// is not a choice made here: archiving a CGRect with the real UIKit on a simulator was
// measured to write exactly `{{12, 55}, {366, 747}}`.
//
// Run: node test/lookin-file.test.mjs
import {
  LOOKIN_SERVER_VERSION,
  buildLookinFile,
  classChainExpression,
  lookinArchiveName,
  parseClassChain,
  staleLookinFiles,
  toArchiveXml,
} from '../lib/lookin-file.js'

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

/** Every key LookinDisplayItem archives, in -encodeWithCoder: order. */
const ITEM_KEYS = [
  'customInfo', 'subitems', 'hidden', 'alpha', 'viewObject', 'layerObject',
  'hostViewControllerObject', 'attributesGroupList', 'customAttrGroupList',
  'representedAsKeyWindow', 'eventHandlers', 'shouldCaptureImage', 'screenshotEncodeType',
  'soloScreenshot', 'groupScreenshot', 'customDisplayTitle', 'danceuiSource',
  'frame', 'bounds', 'backgroundColor',
]

/** The fixture: the same tree the panel's own suite uses, with an address on every line. */
const RECORDS = [
  { depth: 0, className: 'UIWindow', address: '0x101607b40', frame: { x: 0, y: 0, width: 390, height: 844 }, text: '', hidden: false, alpha: null, baseClass: '' },
  { depth: 1, className: 'UIStackView', address: '0x101420fb0', frame: { x: 12, y: 55, width: 366, height: 747 }, text: '', hidden: false, alpha: 0.5, baseClass: '' },
  { depth: 2, className: 'Example.StatusLight', address: '0x10141a3d0', frame: { x: 0, y: 4, width: 116.667, height: 44 }, text: '● GC 键盘', hidden: true, alpha: null, baseClass: 'UIView' },
]

section('a view record becomes a Lookin display item')
{
  const file = buildLookinFile(RECORDS, {
    appInfo: { appName: '蜜语-Dev', appBundleIdentifier: 'com.suishoubo.ppmain3', screenWidth: 390, screenHeight: 844, screenScale: 3 },
    classChains: { UIStackView: ['UIStackView', 'UIView', 'UIResponder', 'NSObject'] },
  })

  eq(file.$class, 'LookinHierarchyFile', 'the root is a LookinHierarchyFile')
  eq(file.serverVersion, LOOKIN_SERVER_VERSION, 'with the protocol version Lookin.app accepts')
  eq(file.hierarchyInfo.$class, 'LookinHierarchyInfo', 'holding a LookinHierarchyInfo')
  eq(file.hierarchyInfo['3'], {}, 'with the alias table Lookin expects')
  eq(file.hierarchyInfo['4'], [], 'and the collapsed list')
  eq(file.hierarchyInfo['2'].$class, 'LookinAppInfo', 'and an app header')
  eq(file.hierarchyInfo['2']['5'], '蜜语-Dev', 'naming the app it came from')
  eq(file.hierarchyInfo['2']['6'].$real, 390, 'with the screen Lookin scales against (marked a real: an integer here loses every field of the header)')
  eq(file.soloScreenshots, null, 'V1 carries no screenshots')
  eq(file.groupScreenshots, null, 'in either dictionary')

  const root = file.hierarchyInfo['1'][0]
  // `$class` is this module's own marker and never reaches the archive (toArchiveXml strips it).
  eq(Object.keys(root).filter((key) => key !== '$class').sort(), ITEM_KEYS.slice().sort(), 'the item archives exactly the keys LookinServer archives')
  eq(root.frame, '{{0, 0}, {390, 844}}', 'frame is a STRING, the way UIKit archives a CGRect')
  eq(root.bounds, '{{0, 0}, {390, 844}}', 'and so is bounds')
  eq(root.subitems.length, 1, 'the child hangs off the parent')

  const stack = root.subitems[0]
  // LLDB prints a frame relative to its superview; Lookin draws in window coordinates.
  eq(stack.frame, '{{12, 55}, {366, 747}}', 'a child frame is accumulated with its ancestors')
  eq(stack.alpha.$real, 0.5, 'alpha comes through when the dump printed one, marked a real')
  eq(stack.viewObject.$class, 'LookinObject', 'the view object is a LookinObject')
  eq(stack.viewObject.classChainList, ['UIStackView', 'UIView', 'UIResponder', 'NSObject'], 'with the real chain when one was probed')
  eq(stack.viewObject.oid, Number.parseInt('101420fb0', 16), 'and an oid taken from the address LLDB printed')
  eq(stack.viewObject.memoryAddress, '0x101420fb0', 'keeping the address as printed')

  const light = stack.subitems[0]
  eq(light.frame, '{{12, 59}, {116.667, 44}}', 'frames accumulate through every level')
  eq(light.hidden, true, 'hidden comes through')
  eq(light.alpha.$real, 1, 'and a missing alpha means 1, still a real')
  eq(light.customDisplayTitle, '● GC 键盘', 'text becomes the title Lookin shows')
  eq(light.viewObject.classChainList, ['Example.StatusLight', 'UIView'], 'without a probed chain it falls back to the class and its printed base class')
  eq(light.layerObject, null, 'the layer object is left nil rather than invented')
  eq(root.representedAsKeyWindow, false, 'and nothing claims to be the key window')
}

section('what a dump cannot answer is left empty, not invented')
{
  const records = [
    { depth: 0, className: 'UIWindow', address: '0x1', frame: { x: 0, y: 0, width: 10, height: 20 }, text: '', hidden: false, alpha: null },
    // A line with no frame at all, and one whose address the parser could not read.
    { depth: 1, className: 'UIView', address: '', frame: null, text: '', hidden: false, alpha: null },
    { depth: 1, className: 'UIView', address: 'not-an-address', frame: { x: 1, y: 1, width: 2, height: 2 }, text: '', hidden: false, alpha: null },
  ]
  const file = buildLookinFile(records)
  const window = file.hierarchyInfo['1'][0]
  eq(window.subitems[0].frame, '{{0, 0}, {0, 0}}', 'a missing frame becomes a zero rect rather than NaN text')
  eq(window.subitems[0].viewObject.oid, 0, 'and an unreadable address becomes oid 0')
  eq(window.subitems[0].viewObject.classChainList, ['UIView'], 'with the chain still naming the class')
  eq(window.subitems[1].viewObject.oid, 0, 'a malformed address is not parsed into a number')
  eq(file.hierarchyInfo['2']['5'], '', 'an empty app header is still a header')
  eq(file.hierarchyInfo['2'].screenScale.$real, 0, 'and unknown screen numbers are 0, which Lookin renders unscaled')
}

section('the keys Lookin decodes with, not the ones its properties are named')
{
  // Measured, and the reason this section exists: a file whose LookinHierarchyInfo used
  // `displayItems`/`appInfo` decoded to the right class and serverVersion with a null payload
  // — an empty tree in Lookin.app — while every unit test here passed.
  const file = buildLookinFile(RECORDS)
  eq(
    Object.keys(file.hierarchyInfo).filter((key) => key !== '$class').sort(),
    ['1', '2', '3', '4', 'serverVersion'],
    'LookinHierarchyInfo archives under numeric keys',
  )
  eq(
    Object.keys(file.hierarchyInfo['2']).filter((key) => key !== '$class').sort(),
    ['1', '2', '3', '4', '5', '6', '7', '8', 'appBundleIdentifier', 'appInfoIdentifier', 'osMainVersion',
      'screenScale', 'serverVersion', 'serverReadableVersion', 'shouldUseCache', 'swiftEnabledInLookinServer'].sort(),
    'and so does LookinAppInfo',
  )
  // The classes that DO use their property names, so a later change cannot quietly "fix" them.
  eq(Object.keys(file).filter((key) => key !== '$class').sort(), ['hierarchyInfo', 'groupScreenshots', 'serverVersion', 'soloScreenshots'].sort(), 'LookinHierarchyFile uses its property names')
  eq(Object.keys(file.hierarchyInfo['1'][0].viewObject).filter((key) => key !== '$class').sort(), ['classChainList', 'ivarTraces', 'memoryAddress', 'oid', 'specialTrace'].sort(), 'and so does LookinObject')
}

section('the archive is written the way NSKeyedArchiver writes one')
{
  const xml = toArchiveXml(buildLookinFile(RECORDS))

  check(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'it is an XML plist')
  check(xml.includes('<key>$archiver</key><string>NSKeyedArchiver</string>'), 'declaring the archiver')
  check(xml.includes('<key>$version</key><integer>100000</integer>'), 'and the archive version')
  check(xml.includes('<key>CF$UID</key>'), 'with object references as CF$UID, which is how an XML plist carries them')
  check(xml.includes('<key>$classname</key><string>LookinDisplayItem</string>'), 'and a class descriptor per class')
  // One descriptor per class the graph uses — and no more, because a real dump would
  // otherwise write its class descriptors once per node.
  eq(
    [...new Set([...xml.matchAll(/<key>\$classname<\/key><string>([^<]+)<\/string>/g)].map((match) => match[1]))].sort(),
    ['LookinAppInfo', 'LookinDisplayItem', 'LookinHierarchyFile', 'LookinHierarchyInfo', 'LookinObject', 'NSArray', 'NSDictionary'],
    'the archive names exactly the classes the graph uses',
  )
  eq((xml.match(/<key>\$classes<\/key>/g) ?? []).length, 7, 'each descriptor standing for a class and NSObject')
  // The text of the dump reaches the file; escaping is what keeps a `&` in a label from
  // making the plist unparseable.
  check(xml.includes('<string>● GC 键盘</string>'), 'the label text is in the file')
  // Measured: NSKeyedUnarchiver refuses an integer where the reader asks for a 64-bit float,
  // and abandons the whole object — an empty tree in Lookin.app with every test passing.
  check(/<key>alpha<\/key><real>/.test(xml), 'alpha is written as a real, which decodeDoubleForKey: demands')
  check(/<key>6<\/key><real>/.test(xml), 'and so is the screen width')
  check(/<key>screenScale<\/key><real>/.test(xml), 'and the screen scale')
  check(/<key>hidden<\/key><(true|false)\/>/.test(xml), 'while a boolean stays a boolean')
  check(/<key>serverVersion<\/key><integer>/.test(xml), 'and an integer stays an integer')
  check(toArchiveXml(buildLookinFile([{ depth: 0, className: 'UIView', address: '0x1', frame: { x: 0, y: 0, width: 1, height: 1 }, text: 'a & b <c>', hidden: false, alpha: null }])).includes('a &amp; b &lt;c&gt;'), 'and text is escaped for XML')
}

section('the class chain is probed once per class')
{
  const expression = classChainExpression('UIStackView')
  check(expression.startsWith('po '), 'the probe is a po command, which is what the session runs')
  check(expression.includes('NSClassFromString(@"UIStackView")'), 'naming the class it is asked about')
  check(expression.includes('(Class)[c superclass]'), 'walking superclasses with a cast, which LLDB requires or it refuses the call')
  check(expression.includes('(NSString *)NSStringFromClass(c)'), 'and casting the class name for the same reason')
  check(classChainExpression('Evil"Class').includes('NSClassFromString(@"EvilClass")'), 'a quote in the name is stripped rather than injected')

  eq(parseClassChain('UILabel,UIView,UIResponder,NSObject'), ['UILabel', 'UIView', 'UIResponder', 'NSObject'], 'a printed chain parses')
  eq(parseClassChain('  UILabel , UIView '), ['UILabel', 'UIView'], 'with whitespace tolerated')
  eq(parseClassChain(''), null, 'an empty answer is no answer')
  eq(parseClassChain('lol;;error: something'), null, 'and so is junk, so a failed probe cannot become a chain')
  eq(parseClassChain('UIView,UIView'), null, 'a chain that repeats itself is rejected')
}

section('exports are named and pruned')
{
  eq(lookinArchiveName('2026-09-29T14-50-01'), 'lookin-2026-09-29T14-50-01.lookin', 'the file is named for when it was taken')
  eq(staleLookinFiles(['a.lookin', 'b.lookin', 'c.lookin'], 2), ['a.lookin'], 'the oldest beyond the cap are the ones to delete')
  eq(staleLookinFiles(['a.lookin'], 2), [], 'nothing to delete while under the cap')
  eq(staleLookinFiles([], 2), [], 'and nothing for an empty directory')
  eq(staleLookinFiles(['a.lookin', 'notes.txt'], 0), ['a.lookin'], 'only archives are counted, and a cap of 0 keeps none')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
console.log('lookin-file OK')
