// What a view's attributes are, and how they are read and written.
//
// The expression strings are asserted directly: they are the interface to the debugger, and a
// changed quote or a dropped cast is not a style question — it is an expression LLDB refuses.
// The parser is asserted against `_ivarDescription` output captured from a real app on the
// iPhone 17 simulator, kept in test/fixtures.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  attributesExpression, constraintsExpression, editableDescriptor, editExpression,
  editSucceeded, colorToHex, parseConstraintsReport, parseHexColor, parseIvarDescription,
} from '../lib/view-attributes.js'

let failures = 0
function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
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

const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

// --- reading the attributes -------------------------------------------------

section('the attribute expression is built around the object, and refuses junk')
{
  eq(attributesExpression('0x1053069d0'), 'expr -l objc++ -O -- (id)[(id)0x1053069d0 _ivarDescription]',
    'the address is cast to id and the description is asked for')
  eq(attributesExpression('1053069d0'), '', 'an address that is not 0x… builds nothing')
  eq(attributesExpression(''), '', 'and neither does an empty one')
}

section('a real ivar description parses into the groups Lookin shows')
{
  const parsed = parseIvarDescription(fixture('ivars-uibutton.txt'))
  eq(parsed.className, 'UIButton', 'the object names its own class')
  eq(parsed.address, '0x105112a80', 'and its address')
  eq(parsed.groups.map((group) => group.name), ['UIButton', 'UIControl', 'UIView', 'UIResponder', 'NSObject'],
    'the groups are the class chain, in the order the runtime printed them')

  const nsObject = parsed.groups.at(-1)
  eq(nsObject.rows.length, 1, 'NSObject declares its one ivar')
  eq(nsObject.rows[0].name, 'isa', 'named isa')
  eq(nsObject.rows[0].type, 'Class', 'typed Class')
  check(/^UIButton \(isa, 0x/.test(nsObject.rows[0].value), 'with the class printed beside the isa', nsObject.rows[0].value)

  const view = parsed.groups.find((group) => group.name === 'UIView')
  const layer = view.rows.find((row) => row.name === '_layer')
  eq(layer.type, 'CALayer*', 'an ivar keeps its declared type')
  check(/^<CALayer: 0x/.test(layer.value), 'and its value', layer.value)
  const nilRow = view.rows.find((row) => row.value === 'nil')
  check(nilRow !== undefined, 'a nil value is kept as nil rather than dropped')

  const frame = parsed.groups.flatMap((group) => group.rows).find((row) => row.name === 'frame')
  check(frame === undefined, 'the public frame is not an ivar, so it is not here: its own readers supply it')

  const every = parsed.groups.flatMap((group) => group.rows)
  check(every.length > 200, 'a real view has hundreds of ivars', String(every.length))
}

section('a nested struct is kept as indented rows, not flattened into its parent')
{
  const parsed = parseIvarDescription(fixture('ivars-uiview.txt'))
  const rows = parsed.groups.find((group) => group.name === 'UIView').rows
  const flags = rows.find((row) => row.name === '_viewFlags')
  check(flags !== undefined, 'the flags struct is a row')
  eq(flags.depth, 0, 'at the top level of its group')
  const index = rows.indexOf(flags)
  const first = rows[index + 1]
  eq(first.name, 'userInteractionDisabled', 'its first member follows it')
  eq(first.depth, 1, 'one level deeper')
  eq(first.type, 'b1', 'with the runtime bitfield type')
  eq(first.value, 'NO', 'and its value')
  const after = rows.find((row) => row.name === '_minimumSafeAreaInsets')
  eq(after.depth, 0, 'and the next real ivar is back at the top level, so the struct is closed')
}

section('a union and a value the runtime cannot print are both kept')
{
  const parsed = parseIvarDescription(fixture('ivars-uiview.txt'))
  const rows = parsed.groups.flatMap((group) => group.rows)
  const union = rows.find((row) => row.name === '_clippedSafeAreaCornerInsets')
  check(union !== undefined, 'the union row is kept')
  eq(union.type, 'union ?', 'typed as the runtime names it')
  const member = rows[rows.indexOf(union) + 1]
  eq(member.name, 'cornerInsets', 'with its members indented under it')
  eq(member.depth, 1, 'one level deeper')
  const unprintable = rows.find((row) => row.value.startsWith('Value not representable'))
  check(unprintable !== undefined, 'a value the runtime refuses to print is not thrown away')
}

section('text that is not an ivar description is refused rather than half-parsed')
{
  eq(parseIvarDescription(''), null, 'nothing at all')
  eq(parseIvarDescription('error: something went wrong'), null, 'an error line')
  eq(parseIvarDescription('<UIButton: 0x105112a80>:'), { className: 'UIButton', address: '0x105112a80', groups: [] },
    'a bare object header parses to no groups')
}

// --- editing ----------------------------------------------------------------

section('an edit is data, not code: the key and the value are both checked')
{
  const ok = editExpression({ address: '0x1053069d0', key: 'alpha', kind: 'number', value: 0.5 })
  eq(ok.expression, 'expr -l objc++ -- (void)[(id)0x1053069d0 setValue:@(0.5) forKey:@"alpha"]; (void)[CATransaction flush]',
    'a number becomes a boxed literal and the layer is flushed')
  check(/setValue:@\(0\.5\)/.test(ok.expression), 'with the number boxed, which is what LLDB accepts')

  eq(editExpression({ address: '0x1', key: 'hidden', kind: 'bool', value: true }).expression.includes('setValue:@YES'), true,
    'a boolean becomes @YES')
  eq(editExpression({ address: '0x1', key: 'hidden', kind: 'bool', value: false }).expression.includes('setValue:@NO'), true,
    'and @NO')

  const text = editExpression({ address: '0x1', key: 'text', kind: 'text', value: 'he said "hi"\nbye' })
  check(text.expression.includes('setValue:@"he said \\"hi\\"\\nbye"'), 'a string is escaped rather than pasted in', text.expression)
  eq(editExpression({ address: '0x1', key: 'text', kind: 'text', value: '"); system("rm -rf /"); ("' }).expression.includes('system('),
    true, 'even an injection attempt stays inside the literal')

  const rect = editExpression({ address: '0x1', key: 'frame', kind: 'rect', value: [1, 2, 30, 40] })
  eq(rect.expression.includes('[NSValue valueWithCGRect:CGRectMake(1, 2, 30, 40)]'), true, 'a rect becomes an NSValue')
  eq(editExpression({ address: '0x1', key: 'center', kind: 'point', value: [5, 6] }).expression.includes('valueWithCGPoint:CGPointMake(5, 6)'), true,
    'a point too')
  eq(editExpression({ address: '0x1', key: 'bounds', kind: 'size', value: [7, 8] }).expression.includes('valueWithCGSize:CGSizeMake(7, 8)'), true,
    'and a size')

  const color = editExpression({ address: '0x1', key: 'backgroundColor', kind: 'color', value: '#ff000080' })
  eq(color.expression.includes('colorWithRed:1 green:0 blue:0 alpha:0.502'), true, 'a colour becomes a UIColor', color.expression)
}

section('an edit the plugin will not make says why, and builds no expression')
{
  eq(editExpression({ address: '0x1', key: 'alpha', kind: 'number', value: 'x' }).note, 'a number value was expected', 'a number that is not one')
  eq(editExpression({ address: '0x1', key: 'frame', kind: 'rect', value: [1, 2] }).note, 'a rect value was expected', 'a rect with two numbers')
  eq(editExpression({ address: '0x1', key: 'backgroundColor', kind: 'color', value: 'rebeccapurple' }).note, 'a color value was expected', 'a colour name')
  eq(editExpression({ address: '', key: 'alpha', kind: 'number', value: 1 }).note, 'no view address to edit', 'no address')
  check(editExpression({ address: '0x1', key: 'a"] ; system("x"); ["', kind: 'number', value: 1 }).note.includes('cannot be edited'),
    'a key that is not an identifier is refused whole')
  eq(editExpression({ address: '0x1', key: 'alpha', kind: 'expression', value: 'foo' }).note, 'a expression value was expected',
    'and an unknown kind is refused rather than guessed at')
}

section('what came back says whether the edit worked')
{
  eq(editSucceeded(''), true, 'no output is a clean edit')
  eq(editSucceeded('(void)'), true, 'and so is a bare void')
  eq(editSucceeded('error: no known method'), false, 'an error line is a failure')
  eq(editSucceeded('  ERROR: something'), false, 'however it is cased or spaced')
}

// --- the editors an attribute deserves --------------------------------------

section('an editor is chosen from the declared type, not guessed from the value')
{
  const desc = (row, keys) => editableDescriptor(row, keys === undefined ? {} : { keys })
  // `key` is what the panel must send back, and it is the property name: the ivar is `_numberOfLines`
  // and KVC reaches it as `numberOfLines`. It is part of every descriptor, so it is part of every
  // expectation here rather than an afterthought in one of them.
  eq(desc({ name: 'alpha', type: 'double', value: '1' }), { kind: 'number', value: 1, key: 'alpha' }, 'a double gets a number editor')
  eq(desc({ name: '_viewFlags', type: 'struct ?', value: '{' }), { kind: 'none', value: null }, 'an anonymous struct gets none')
  eq(desc({ name: 'hidden', type: 'BOOL', value: 'YES' }), { kind: 'bool', value: true, key: 'hidden' }, 'a BOOL gets a switch')
  eq(desc({ name: 'hidden', type: 'BOOL', value: 'maybe' }), { kind: 'none', value: null }, 'a BOOL whose value is not one gets none')
  // The runtime prints a CGRect nested, and that is the shape a real dump is full of: refusing it
  // would leave every rectangle in the list uneditable.
  eq(desc({ name: 'frame', type: 'CGRect', value: '{{0, 0}, {10, 20}}' }), { kind: 'rect', value: [0, 0, 10, 20], key: 'frame' },
    'a CGRect in the runtime\'s own print is read through its nesting')
  eq(desc({ name: 'frame', type: 'CGRect', value: '{0, 0, 10, 20}' }), { kind: 'rect', value: [0, 0, 10, 20], key: 'frame' }, 'and a flat one too')
  eq(desc({ name: 'frame', type: 'CGRect', value: '{{0, 0}, {10, nan}}' }), { kind: 'none', value: null }, 'a rect with a value the dump could not read gets none')
  eq(desc({ name: 'center', type: 'CGPoint', value: '{5, 6}' }), { kind: 'point', value: [5, 6], key: 'center' }, 'a point gets two fields')
  eq(desc({ name: '_minimumSafeAreaInsets', type: 'struct UIEdgeInsets', value: '{0, 0, 0, 0}' }), { kind: 'insets', value: [0, 0, 0, 0], key: 'minimumSafeAreaInsets' },
    'an inset gets four')
  eq(desc({ name: '_text', type: 'NSString*', value: '"row 0"' }), { kind: 'text', value: 'row 0', key: 'text' }, 'an NSString gets a text field')
  eq(desc({ name: '_text', type: 'NSString*', value: 'nil' }), { kind: 'text', value: '', key: 'text' }, 'a nil string starts empty')
  eq(desc({ name: '_backgroundColor', type: 'UIColor*', value: '<UIDeviceRGBColor: 0x1; red = 1; green = 0.5; blue = 0; alpha = 1>' }),
    { kind: 'color', value: '#ff8000ff', key: 'backgroundColor' }, 'a UIColor gets a colour well, pre-filled from the app\'s own values')
  eq(desc({ name: '_backgroundColor', type: 'UIColor*', value: '<UIDynamicSystemColor: 0x1; name = systemBackgroundColor>' }),
    { kind: 'color', value: null, key: 'backgroundColor' }, 'a dynamic colour offers the well without pretending to know its value')
  eq(desc({ name: '_layer', type: 'CALayer*', value: '<CALayer: 0x1>' }), { kind: 'none', value: null }, 'an unknown object type gets none')
  // A member of a struct the object holds is not a property of the object. Writing it by name would
  // reach a different thing entirely, silently — measured: the only CGRect in a UILabel's dump is a
  // member of `_intrinsicSizeBaselineInfo`.
  eq(desc({ name: 'bounds', type: 'struct CGRect', value: '{{0, 0}, {200, 20}}', depth: 1 }), { kind: 'none', value: null },
    'a row nested inside a struct gets no editor, however well its type is understood')
}

section('the plugin edits only the keys it has decided are safe')
{
  const keys = ['alpha', 'hidden', 'text']
  eq(editableDescriptor({ name: 'alpha', type: 'double', value: '1' }, { keys }).kind, 'number', 'a listed key is editable')
  eq(editableDescriptor({ name: '_numberOfLines', type: 'long', value: '1' }, { keys: ['numberOfLines'] }).key, 'numberOfLines',
    'and the underscored ivar a real dump prints matches the property name the plugin edits by')
  eq(editableDescriptor({ name: '_viewFlags', type: 'int', value: '1' }, { keys }).kind, 'none', 'one that is not listed is not')
  eq(editableDescriptor({ name: 'not-an-identifier', type: 'double', value: '1' }, { keys: ['not-an-identifier'] }).kind, 'none',
    'and not even a listing makes a non-identifier editable')
}

section('a colour hex, both ways')
{
  eq(parseHexColor('#ff0000'), ['1', '0', '0', '1'], 'six digits')
  eq(parseHexColor('ff000080'), ['1', '0', '0', '0.502'], 'eight digits keep the alpha')
  eq(parseHexColor('#f00'), ['1', '0', '0', '1'], 'three digits are shorthand')
  eq(parseHexColor('#gggggg'), null, 'and nonsense is refused')
  eq(colorToHex('<UIDeviceRGBColor: 0x1; red = 0.2; green = 0.4; blue = 0.6; alpha = 1>'), '#336699ff', 'a colour description round-trips')
  eq(colorToHex('<UIDeviceWhiteColor: 0x1; white = 0.5; alpha = 1>'), '#808080ff', 'a grey too')
  eq(colorToHex('<UIDynamicSystemColor: 0x1; name = labelColor>'), null, 'a dynamic colour has no values to read')
}

// --- constraints ------------------------------------------------------------

section('the layout expression reports everything the panel draws, in one stop')
{
  const expression = constraintsExpression('0x1053069d0')
  check(expression.startsWith('expr -l objc++ -O -- (id)({'), 'it is one object-description expression')
  check(!/\n/.test(expression), 'on a single line, because lldb reads a line at a time')
  check(expression.includes('[v hasAmbiguousLayout]'), 'it asks whether the layout is ambiguous')
  check(expression.includes('intrinsicContentSize'), 'and for the intrinsic size')
  // A struct built from a message's result is what a headerless target refuses ("no matching
  // constructor for initialization of 'CGSize'", 蜜语-Dev), and that one line lost the whole pane.
  check(!/\bCG(Size|Rect|Point)\s+\w+\s*=|\(CG(Size|Rect|Point)\)\[/.test(expression),
    'no geometry struct is declared or cast from a message: the size comes through KVC into doubles')
  check(expression.includes('[(id)[v valueForKey:@"intrinsicContentSize"] getValue:(void *)ic]'), 'the intrinsic size is read through KVC')
  check(expression.includes('contentHuggingPriorityForAxis'), 'and the hugging priority')
  check(expression.includes('contentCompressionResistancePriorityForAxis'), 'and the compression resistance')
  check(expression.includes('while (node != nil)'), 'it walks every ancestor for the constraints that place the view')
  check(!/stringWithFormat|appendFormat|enumerateObjectsUsingBlock|@try/.test(expression),
    'with no variadic call, no block and no exception handler, which the expression parser refuses')
  eq(constraintsExpression('nope'), '', 'and an address that is not one builds nothing')
}

section('the layout report parses into the rows the panel shows')
{
  const text = [
    'MASK 1',
    'AMBIGUOUS 0',
    'INTRINSIC 0 0',
    'HUG 250 250',
    'RESIST 750 750',
    'OWN 1',
    'C <NSLayoutConstraint:0x1 UILabel:0x2.width == 40   (active)>',
    'REF 2',
    'C <NSLayoutConstraint:0x3 UILabel:0x2.leading == UIView:0x4.leading + 20   (active)>',
    'C <NSLayoutConstraint:0x5 UILabel:0x2.top == UIView:0x4.top + 40   (active)>',
    'TRACE yes',
  ].join('\n')
  const parsed = parseConstraintsReport(text)
  eq(parsed.masked, true, 'a view laid out by Auto Layout says so')
  eq(parsed.ambiguous, false, 'and whether the engine admits the layout is ambiguous')
  eq(parsed.intrinsic, { width: 0, height: 0 }, 'the intrinsic size is two numbers, not a string')
  eq(parsed.hugging, [250, 250], 'the hugging priority is per axis')
  eq(parsed.resistance, [750, 750], 'and so is the compression resistance')
  eq(parsed.own.length, 1, 'the constraints the view owns')
  eq(parsed.referencing.length, 2, 'and the ones on its ancestors that mention it')
  check(parsed.referencing[0].includes('leading == UIView'), 'kept as the runtime described them', parsed.referencing[0])
  eq(parsed.traceAvailable, true, 'and it says whether the runtime offers a layout trace')

  eq(parseConstraintsReport(''), null, 'nothing is not a report')
  eq(parseConstraintsReport('error: no such thing'), null, 'and neither is an error')
  const empty = parseConstraintsReport('MASK 0\nAMBIGUOUS 0\nOWN 0\nREF 0')
  eq(empty.own.length + empty.referencing.length, 0, 'a view with no constraints reports none rather than failing')
}

console.log(failures === 0 ? '\nall view-attribute checks passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
