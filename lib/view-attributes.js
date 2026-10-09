/**
 * A view's own attributes, read from the app instead of from LookinServer.
 *
 * Lookin's inspector shows every property and ivar of the selected object, grouped by the class in
 * the chain that declares it, with the values as the app itself reports them. LookinServer does that
 * work inside the app and ships the result over its own socket. There is no socket here, so the work
 * is done by one expression the debugger runs against the app:
 *
 *     expr -l objc++ -O -- (id)[(id)0x10530… _ivarDescription]
 *
 * `_ivarDescription` is one of the private NSObject description methods and prints the whole chain:
 *
 *     <UITransitionView: 0x105313e10>:
 *     in UITransitionView:
 *     	_fromView (UIView*): nil
 *     	_transitionViewFlags (struct ?): {
 *     		animationInProgress (b1): NO
 *     	}
 *     in UIView:
 *     	_window (UIWindow*): <UIWindow: 0x10510e330>
 *
 * Measured on the iPhone 17 simulator while building this: 250–350 lines for a real view, in the same
 * ~220 ms stop any other read takes — so the whole attribute list costs one short pause, not one per
 * attribute. It is deliberately preferred over enumerating with `class_copyPropertyList` +
 * `valueForKey:`, which drags the debugger's own expression parser into a fight it loses: variadic
 * ObjC calls (`stringWithFormat:`, `appendFormat:`) are rejected outright, `@try` needs
 * `-fobjc-exceptions` which the `expression` command has no way to pass, and every runtime function
 * needs a cast because LLDB does not know its return type. `_ivarDescription` needs none of that.
 *
 * This module is pure: it builds expression strings and parses what came back. Everything the panel
 * draws from an attribute list is decided here, so it is tested without a device.
 */

/** A key or ivar name this plugin is willing to build an expression around. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The classes a value may be set on: `UIView`, `CALayer`, `UILabel`, `UIScrollView`… */
const SAFE_CLASS = /^[A-Za-z_][A-Za-z0-9_.]*$/

/**
 * The expression that dumps an object's ivars, grouped as the runtime reports them.
 *
 * `-O` (object description) is what prints the value rather than a pointer, and `objc++` is the
 * language the value-carrying description is written in. The cast to `id` is needed because the
 * address is handed over as a bare number.
 *
 * @param {string} address - a pointer as `0x…`, as the tree read it.
 * @returns {string} an expression for the session's `evaluate`.
 */
export function attributesExpression(address) {
  const at = String(address ?? '')
  if (!/^0x[0-9a-fA-F]+$/.test(at)) return ''
  return `expr -l objc++ -O -- (id)[(id)${at} _ivarDescription]`
}

/**
 * Read `_ivarDescription` output.
 *
 * The format is entirely regular — measured over UIWindow, UIView, UILabel, UIButton and
 * UICollectionView fixtures, every line is one of four shapes:
 *
 *   - `<Class: 0xADDR>:` — the object itself;
 *   - `in <Class>:` — a class in the chain (the groups the panel draws headers for);
 *   - `\t…name (type): value` — one ivar, with deeper indentation inside a struct or union;
 *   - `{`, `}`, `(values are interpreted) (`, `)` — the open and close of a nested value.
 *
 * A nested value's members are kept as rows of their own with `depth` > 0 rather than being folded
 * into the parent's value: the panel shows them indented under it, which is the only way a
 * `_viewFlags` with forty `b1` bits stays readable.
 *
 * @param {string} text - what the debugger printed.
 * @returns {{className: string, address: string, groups: Array<{name: string, rows: Array<{name: string, type: string, value: string, depth: number}>}>}|null}
 *   the parsed list, or null when the text is not an ivar description.
 */
export function parseIvarDescription(text) {
  const lines = String(text ?? '').split('\n')
  let className = ''
  let address = ''
  const groups = []
  let group = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (className === '') {
      const head = /^<([^:>]+):\s*(0x[0-9a-fA-F]+)>:?$/.exec(line.trim())
      if (head !== null) {
        className = head[1].trim()
        address = head[2]
        continue
      }
    }
    const groupHead = /^in (.+):$/.exec(line.trim())
    if (groupHead !== null) {
      group = { name: groupHead[1].trim(), rows: [] }
      groups.push(group)
      continue
    }
    if (/^[})\])]/.test(line.trim()) || /^\(values are interpreted/.test(line.trim())) continue
    const row = /^(\t+)(.+?) \(([^)]*)\): (.*)$/.exec(line)
    if (row === null) continue
    if (group === null) {
      group = { name: className === '' ? 'Object' : className, rows: [] }
      groups.push(group)
    }
    group.rows.push({
      name: row[2].trim(),
      type: row[3].trim(),
      value: row[4].trim(),
      depth: row[1].length - 1,
    })
  }
  if (className === '' && groups.length === 0) return null
  return { className, address, groups }
}

/**
 * The expression that reports how a view is laid out.
 *
 * One report rather than several round trips, and everything in it is a value the panel draws as a
 * row: whether the view is laid out by Auto Layout at all, whether the engine admits the layout is
 * ambiguous, the intrinsic size and the two priorities, then the constraints the view owns and the
 * constraints on its ancestors that mention it — which is the set a person needs to see when asking
 * "why is this view here". Constraints are printed by their own `description`, the same text Xcode's
 * console shows.
 *
 * Written the way every expression in this plugin is: one line, no variadic ObjC calls, a cast on
 * every call whose return type LLDB does not know, and no blocks.
 *
 * @param {string} address - the view's pointer.
 * @returns {string} an expression for the session's `evaluate`.
 */
export function constraintsExpression(address) {
  const at = String(address ?? '')
  if (!/^0x[0-9a-fA-F]+$/.test(at)) return ''
  /**
   * Everything goes through `id` and indexed access, and nothing is fast-enumerated.
   *
   * That is not style: measured against a live app, `for (NSLayoutConstraint *c in own)` is rejected —
   * "may not respond to countByEnumeratingWithState:objects:count:" — because LLDB cannot prove the
   * collection conforms, and one such warning aborts the whole expression. `objectAtIndex:` on an
   * `id` needs no proof, `[c description]` on an `id` needs none either, and the two loops are the
   * only reason this expression is written as a statement block at all.
   */
  const parts = [
    `id v = (id)${at}`,
    'NSMutableString *out = (NSMutableString *)[NSMutableString string]',
    '[out appendString:@"MASK "]',
    '[out appendString:(NSString *)[[NSNumber numberWithBool:(BOOL)[v translatesAutoresizingMaskIntoConstraints]] stringValue]]',
    '[out appendString:@"\\nAMBIGUOUS "]',
    '[out appendString:(NSString *)[[NSNumber numberWithBool:(BOOL)[v hasAmbiguousLayout]] stringValue]]',
    'CGSize ic = (CGSize)[v intrinsicContentSize]',
    '[out appendString:@"\\nINTRINSIC "]',
    '[out appendString:(NSString *)[[NSNumber numberWithDouble:(double)ic.width] stringValue]]',
    '[out appendString:@" "]',
    '[out appendString:(NSString *)[[NSNumber numberWithDouble:(double)ic.height] stringValue]]',
    '[out appendString:@"\\nHUG "]',
    '[out appendString:(NSString *)[[NSNumber numberWithFloat:(float)[v contentHuggingPriorityForAxis:(UILayoutConstraintAxis)0]] stringValue]]',
    '[out appendString:@" "]',
    '[out appendString:(NSString *)[[NSNumber numberWithFloat:(float)[v contentHuggingPriorityForAxis:(UILayoutConstraintAxis)1]] stringValue]]',
    '[out appendString:@"\\nRESIST "]',
    '[out appendString:(NSString *)[[NSNumber numberWithFloat:(float)[v contentCompressionResistancePriorityForAxis:(UILayoutConstraintAxis)0]] stringValue]]',
    '[out appendString:@" "]',
    '[out appendString:(NSString *)[[NSNumber numberWithFloat:(float)[v contentCompressionResistancePriorityForAxis:(UILayoutConstraintAxis)1]] stringValue]]',
    // The view's own constraints: the ones it owns, which are the ones it can be blamed for.
    'id own = (id)[v constraints]',
    'unsigned long ownCount = (unsigned long)[own count]',
    '[out appendString:@"\\nOWN "]',
    '[out appendString:(NSString *)[[NSNumber numberWithUnsignedLong:ownCount] stringValue]]',
    'for (unsigned long i = 0; i < ownCount; i++) { id c = (id)[own objectAtIndex:i]; [out appendString:@"\\nC "]; [out appendString:(NSString *)[c description]]; }',
    // The constraints that position this view live on an ANCESTOR, because a constraint between two
    // views must sit in their nearest common ancestor. Stopping at the superview would miss the ones
    // that matter most, so the whole chain up to the window is walked.
    'id ref = (id)[NSMutableArray array]',
    'id node = (id)[v superview]',
    'while (node != nil) { id arr = (id)[node constraints]; unsigned long n = (unsigned long)[arr count]; for (unsigned long i = 0; i < n; i++) { id c = (id)[arr objectAtIndex:i]; if (((id)[c firstItem] == v) || ((id)[c secondItem] == v)) { [ref addObject:c]; } } node = (id)[node superview]; }',
    '[out appendString:@"\\nREF "]',
    '[out appendString:(NSString *)[[NSNumber numberWithUnsignedLong:(unsigned long)[ref count]] stringValue]]',
    'unsigned long refCount = (unsigned long)[ref count]',
    'for (unsigned long i = 0; i < refCount; i++) { id c = (id)[ref objectAtIndex:i]; [out appendString:@"\\nC "]; [out appendString:(NSString *)[c description]]; }',
    'out',
  ]
  return `expr -l objc++ -O -- (id)({ ${parts.join('; ')}; })`
}

/**
 * Read the layout report.
 *
 * @param {string} text - what the debugger printed.
 * @returns {{masked: boolean, ambiguous: boolean, intrinsic: {width: number, height: number}, hugging: Array<number>, resistance: Array<number>, own: Array<string>, referencing: Array<string>, traceAvailable: boolean}|null}
 */
export function parseConstraintsReport(text) {
  const lines = String(text ?? '').split('\n')
  const found = { own: [], referencing: [] }
  let section = ''
  let seen = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const own = /^OWN (\d+)$/.exec(line)
    if (own !== null) {
      section = 'own'
      seen = true
      continue
    }
    const ref = /^REF (\d+)$/.exec(line)
    if (ref !== null) {
      section = 'referencing'
      seen = true
      continue
    }
    const mask = /^MASK (\S+)$/.exec(line)
    if (mask !== null) {
      found.masked = mask[1] === '1'
      seen = true
      continue
    }
    const ambiguous = /^AMBIGUOUS (\S+)$/.exec(line)
    if (ambiguous !== null) {
      found.ambiguous = ambiguous[1] === '1'
      seen = true
      continue
    }
    const intrinsic = /^INTRINSIC (\S+) (\S+)$/.exec(line)
    if (intrinsic !== null) {
      found.intrinsic = { width: Number(intrinsic[1]), height: Number(intrinsic[2]) }
      seen = true
      continue
    }
    const hug = /^HUG (\S+) (\S+)$/.exec(line)
    if (hug !== null) {
      found.hugging = [Number(hug[1]), Number(hug[2])]
      seen = true
      continue
    }
    const resist = /^RESIST (\S+) (\S+)$/.exec(line)
    if (resist !== null) {
      found.resistance = [Number(resist[1]), Number(resist[2])]
      seen = true
      continue
    }
    const trace = /^TRACE (\S+)$/.exec(line)
    if (trace !== null) {
      found.traceAvailable = trace[1] === 'yes'
      seen = true
      continue
    }
    if (line.startsWith('C ')) found[section].push(line.slice(2).trim())
  }
  if (!seen) return null
  return {
    masked: found.masked === true,
    ambiguous: found.ambiguous === true,
    intrinsic: found.intrinsic ?? { width: 0, height: 0 },
    hugging: found.hugging ?? [],
    resistance: found.resistance ?? [],
    own: found.own,
    referencing: found.referencing,
    traceAvailable: found.traceAvailable === true,
  }
}

/**
 * The expression that sets one attribute and repaints.
 *
 * The value arrives from the panel as data, not as code: `kind` picks the literal, and a string is
 * escaped here. That is the boundary — a panel that could send its own expression would make the
 * drawer a way to run arbitrary code on someone's phone under the guise of editing a colour.
 *
 * `setValue:forKey:` rather than a setter call, so one route covers `alpha`, `hidden`, `text`,
 * `backgroundColor`, `frame`, `bounds` and any other KVC-compliant key. `CATransaction flush` is
 * what makes a change to a layer-backed view appear while the app is stopped for the edit; without
 * it the next runloop turn draws it, which is after the app has been let go.
 *
 * @param {{address: string, key: string, kind: string, value: any}} edit - what to set.
 * @returns {{expression: string, note: string}} the expression, or a note saying why not.
 */
export function editExpression(edit) {
  const address = String(edit?.address ?? '')
  const key = String(edit?.key ?? '')
  const kind = String(edit?.kind ?? '')
  if (!/^0x[0-9a-fA-F]+$/.test(address)) return { expression: '', note: 'no view address to edit' }
  if (!SAFE_NAME.test(key)) return { expression: '', note: `the attribute name ${JSON.stringify(key)} cannot be edited` }
  const literal = valueLiteral(kind, edit?.value)
  if (literal === null) return { expression: '', note: `a ${kind} value was expected` }
  const target = `(id)${address}`
  return {
    expression: `expr -l objc++ -- (void)[${target} setValue:${literal} forKey:@"${key}"]; (void)[CATransaction flush]`,
    note: '',
  }
}

/**
 * How one kind of value is written in Objective-C.
 *
 * Numbers are boxed with `@(…)` — which LLDB's parser accepts, unlike `numberWithDouble:` — and a
 * rectangle or point becomes the `NSValue` that KVC hands to a `frame` or `center` setter.
 *
 * @param {string} kind - `bool`, `number`, `text`, `color`, `rect`, `point`, `size` or `insets`.
 * @param {any} value - the panel's value for it.
 * @returns {string|null} the literal, or null when the value does not fit the kind.
 */
function valueLiteral(kind, value) {
  const finite = (n) => typeof n === 'number' && Number.isFinite(n)
  if (kind === 'bool') return value === true || value === false ? `@${value === true ? 'YES' : 'NO'}` : null
  if (kind === 'number') {
    const number = typeof value === 'number' ? value : Number(value)
    return finite(number) ? `@(${String(number)})` : null
  }
  if (kind === 'text') return typeof value === 'string' ? `@"${escapeForObjC(value)}"` : null
  if (kind === 'color') {
    const rgba = parseHexColor(value)
    if (rgba === null) return null
    return `[UIColor colorWithRed:${rgba[0]} green:${rgba[1]} blue:${rgba[2]} alpha:${rgba[3]}]`
  }
  if (kind === 'rect' || kind === 'point' || kind === 'size' || kind === 'insets') {
    if (!Array.isArray(value) || !value.every(finite)) return null
    const wanted = kind === 'rect' || kind === 'insets' ? 4 : 2
    if (value.length !== wanted) return null
    const numbers = value.map((n) => String(n)).join(', ')
    if (kind === 'rect') return `[NSValue valueWithCGRect:CGRectMake(${numbers})]`
    if (kind === 'point') return `[NSValue valueWithCGPoint:CGPointMake(${numbers})]`
    if (kind === 'size') return `[NSValue valueWithCGSize:CGSizeMake(${numbers})]`
    return `[NSValue valueWithUIEdgeInsets:UIEdgeInsetsMake(${numbers})]`
  }
  return null
}

/** Quote a string for an Objective-C literal: backslashes, quotes and newlines. */
function escapeForObjC(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

/**
 * `#rrggbb`, `#rrggbbaa` or `#rgb` into four 0–1 components, or null.
 *
 * @param {any} value - the panel's colour.
 * @returns {Array<string>|null} `[r, g, b, a]` as literal text, or null.
 */
export function parseHexColor(value) {
  const text = String(value ?? '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3,8}$/.test(text)) return null
  const wide = text.length === 3 || text.length === 4
  if (!wide && text.length !== 6 && text.length !== 8) return null
  const step = wide ? 1 : 2
  const parts = []
  for (let i = 0; i < text.length; i += step) {
    const pair = wide ? text[i] + text[i] : text.slice(i, i + step)
    parts.push(parseInt(pair, 16))
  }
  const [r, g, b, a = 255] = parts
  return [r, g, b, a].map((n) => String(Math.round((n / 255) * 1000) / 1000))
}

/**
 * The kind of editor an attribute's declared type deserves, and the value it holds now.
 *
 * The type text is the ivar's own — `double`, `BOOL`, `CGRect`, `UIColor*`, `NSString*` — so the
 * panel can put a stepper on a number and a colour well on a colour without guessing from the value.
 * An unknown type is `none`: shown, not editable.
 *
 * @param {{name: string, type: string, value: string}} row - one attribute row.
 * @param {object} [options]
 * @param {string[]} [options.keys] - keys the plugin is willing to edit at all.
 * @returns {{kind: string, value: any}} the editor and its current value.
 */
export function editableDescriptor(row, options = {}) {
  const name = String(row?.name ?? '')
  const type = String(row?.type ?? '')
  const value = String(row?.value ?? '')
  const allowed = Array.isArray(options.keys) ? options.keys : null
  const none = { kind: 'none', value: null }
  if (!SAFE_NAME.test(name)) return none
  // Only a member of the object itself can be written by name. A deeper row is a member of a struct
  // the object holds — the dump prints `_intrinsicSizeBaselineInfo`'s own `bounds` at depth 1 — and
  // KVC would write the *object's* property of that name instead: a different thing entirely, with
  // no error to say so. Measured on a live UILabel, that is where the only `CGRect` in the dump is.
  if (Number(row?.depth ?? 0) > 0) return none
  // UIKit declares almost every property behind an underscored ivar (`_numberOfLines`,
  // `_backgroundColor`), and KVC reaches the property through the name without the underscore.
  // Matching the underscored name against a list of property names matched nothing at all on a real
  // dump, so the key is the name with its leading underscores removed — and that key is what the
  // panel sends back, not the ivar name it was shown as.
  const key = name.replace(/^_+/, '')
  if (allowed !== null && !allowed.includes(key)) return none
  if (type === 'BOOL' || type === 'b1' || type === '_Bool') {
    if (value !== 'YES' && value !== 'NO') return none
    return { kind: 'bool', value: value === 'YES', key }
  }
  if (['double', 'float', 'CGFloat', 'int', 'long', 'unsigned long', 'short', 'unsigned short', 'NSInteger', 'NSUInteger', 'unsigned int', 'char', 'unsigned char'].includes(type)) {
    const number = Number(value)
    if (!Number.isFinite(number)) return none
    return { kind: 'number', value: number, key }
  }
  // A geometry value is read through its nesting, not around it: the runtime prints a CGRect as
  // `{{0, 0}, {200, 20.33}}`, so a parser that only took flat braces would leave every rectangle in
  // a real dump uneditable — which is what it did before this flattening existed.
  const geometry = (kind, count) => {
    const numbers = flattenNumbers(value)
    return numbers === null || numbers.length !== count ? none : { kind, value: numbers, key }
  }
  if (/^(struct )?(CGRect|CGRect)$/.test(type)) return geometry('rect', 4)
  if (/^(struct )?CGPoint$/.test(type)) return geometry('point', 2)
  if (/^(struct )?CGSize$/.test(type)) return geometry('size', 2)
  if (/^(struct )?UIEdgeInsets$/.test(type)) return geometry('insets', 4)
  if (/UIColor\s*\*$/.test(type)) return { kind: 'color', value: colorToHex(value), key }
  if (/NSString\s*\*$/.test(type)) return { kind: 'text', value: value === 'nil' ? '' : value.replace(/^"(.*)"$/, '$1'), key }
  return none
}

/**
 * Every number in a value, however deeply the runtime nested it.
 *
 * `{0, 0, 4, 4}`, `{0, 0}` and `{{0, 0}, {200, 20.33}}` all describe a shape, and the only thing
 * that differs is how many braces the printer put around them. Flattening here means one reader for
 * all four geometry types, and a shape that is not numbers at all — `{nan, 0}` inside a struct the
 * debugger could not decode — is refused rather than half-read.
 *
 * @param {string} text - the printed value.
 * @returns {Array<number>|null} the numbers in order, or null.
 */
function flattenNumbers(text) {
  const inside = /^[{(](.*)[})]$/.exec(String(text).trim())
  if (inside === null) return null
  const out = []
  for (const part of splitTopLevel(inside[1])) {
    const piece = part.trim()
    if (piece === '') continue
    if (/^[{(]/.test(piece)) {
      const inner = flattenNumbers(piece)
      if (inner === null) return null
      out.push(...inner)
      continue
    }
    const number = Number(piece)
    if (!Number.isFinite(number)) return null
    out.push(number)
  }
  return out.length === 0 ? null : out
}

/** Split on the commas that are not inside braces or parentheses. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let at = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '{' || character === '(') depth += 1
    else if (character === '}' || character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(at, index))
      at = index + 1
    }
  }
  parts.push(text.slice(at))
  return parts
}

/** `{1, 2, 3, 4}` or `(1, 2)` into an array of numbers, or null when it is not that many. */
function parseNumbers(text, count) {
  const inside = /^[{(](.*)[})]$/.exec(String(text).trim())
  if (inside === null) return null
  const parts = inside[1].split(',').map((part) => Number(part.trim()))
  if (parts.length !== count || !parts.every(Number.isFinite)) return null
  return parts
}

/**
 * A `UIColor` description into `#rrggbbaa`, or null.
 *
 * UIKit prints a colour three ways — `UIDeviceRGBColor`, `UIDeviceWhiteColor` and the dynamic
 * system colours — and the panel offers a colour well for all three. A dynamic colour's own values
 * are meaningless outside the trait collection it was resolved in, so it is offered and not
 * pre-filled, which is honest: the well starts white and the user picks what they meant.
 *
 * @param {string} text - the ivar's value text.
 * @returns {string|null} a hex colour, or null.
 */
export function colorToHex(text) {
  const rgb = /red\s*=\s*([0-9.]+)[;\s]*green\s*=\s*([0-9.]+)[;\s]*blue\s*=\s*([0-9.]+)[;\s]*alpha\s*=\s*([0-9.]+)/.exec(String(text))
  const parts = rgb === null
    ? (() => {
      const white = /white\s*=\s*([0-9.]+)[;\s]*alpha\s*=\s*([0-9.]+)/.exec(String(text))
      return white === null ? null : [white[1], white[1], white[1], white[2]]
    })()
    : [rgb[1], rgb[2], rgb[3], rgb[4]]
  if (parts === null) return null
  const bytes = parts.map((part) => {
    const number = Number(part)
    return Number.isFinite(number) ? Math.max(0, Math.min(255, Math.round(number * 255))) : null
  })
  if (bytes.some((byte) => byte === null)) return null
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Whether a value read back from the app says the edit worked. */
export function editSucceeded(text) {
  return !/error:/i.test(String(text ?? ''))
}

/** Exported for the tests: the class name a value may be cast to. */
export const safeClassName = (name) => SAFE_CLASS.test(String(name ?? ''))
