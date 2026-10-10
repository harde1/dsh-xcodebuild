// The running app's view hierarchy, read out of LLDB.
//
// This is what Xcode's "Debug View Hierarchy" shows, obtained the way a program can
// obtain it: a paused process plus an expression that asks UIKit to describe itself.
//
//   po [[[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]
//
// Two facts about that, both measured on an iPhone 13 running iOS 26.6.2 under Xcode
// 26.0.1 rather than assumed:
//
//   * `[UIApplication sharedApplication].windows` still answers on iOS 26 even though
//     it is deprecated, and its first window is the key window. The scene-based
//     replacements (`connectedScenes`, `UIWindowScene.windows`) need the app to have a
//     scene delegate this plugin cannot know about; `windows` needs nothing.
//   * `recursiveDescription` is private and returns an indented string, one view per
//     line, with the indentation carrying the tree. A real dump looks like this:
//
//       <UIWindow: 0x100f5f280; frame = (0 0; 390 844); layer = <UIWindowLayer: 0x1015cd740>>
//          | <UITransitionView: 0x101718c00; frame = (0 0; 390 844); autoresize = W+H>
//          |    | <UIView: 0x1017301c0; frame = (0 0; 390 844); backgroundColor = <...>>
//          |    |    | <HIDProbe.StatusLight: 0x100f57280; baseClass = UILabel; frame = (0 0; 116.667 44); text = '● GC 键盘'>
//
//     Depth is the number of `|` before the `<`, which is why this parser counts those
//     rather than measuring spaces: the two agree, but the pipes survive any future
//     re-indentation.
//
// The expression is evaluated only while the process is STOPPED. LLDB refuses
// otherwise ("the process must be stopped because the expression might require
// allocating memory"), so the caller pauses the app first — see `lldb-session.js`.
//
// This module is plain JS with no imports, like `parse-destinations.js`, so its exact
// source can also be embedded in the dynamic Cordis host half.

/**
 * The dump Xcode's view debugger would show, as text.
 *
 * The result is cast to `NSString *` and that cast is not decoration. `recursiveDescription` is a
 * private method no header declares, so on a target whose UIKit module cannot be imported the
 * evaluator has no return type for the send and refuses the whole expression with
 * `no known method '-recursiveDescription'; cast the message send to the method's return type` —
 * measured on an iPhone 17 simulator in a session that had imported nothing, where the same cast
 * makes the identical send evaluate. A cast is inert where the method IS known, so this is the one
 * spelling that reads the tree on both kinds of target — and without a tree there are no boxes on
 * the canvas at all, which is what a device with no SDK module looked like.
 */
export const VIEW_HIERARCHY_EXPRESSION
  = 'po (NSString *)[[[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]'

/**
 * Walk the outer `<...>` of a dump line and return what is inside it and what follows.
 *
 * The scan is depth-counting rather than a regular expression because a view's own line
 * carries nested objects (`layer = <CALayer: 0x…>`, `gestureRecognizers = <NSArray: 0x…>`),
 * and a non-greedy match would stop at the first `>` instead of the last. Single quotes
 * are skipped so that `text = 'a < b'` cannot unbalance the count.
 *
 * @param {string} line - one line of `recursiveDescription` output.
 * @returns {{inside: string, tail: string}} element body and the trailing extras.
 */
function outerElement(line) {
  let depth = 0
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && line[i - 1] !== '\\') quoted = !quoted
    else if (quoted) continue
    else if (ch === '<') depth += 1
    else if (ch === '>') {
      depth -= 1
      if (depth === 0) return { inside: line.slice(1, i), tail: line.slice(i + 1).trim() }
    }
  }
  return { inside: line.replace(/^</, ''), tail: '' }
}

/**
 * Split an element body into `key = value` properties without breaking on the
 * separators that live inside a value — `frame = (0 0; 390 844)` contains a `;`, and
 * `backgroundColor = <UIDynamicSystemColor: 0x…; name = …>` contains one inside `<>`.
 *
 * @param {string} body - everything after `Class: 0xadddress; `.
 * @returns {Array<{key: string, value: string}>} properties in printed order.
 */
export function parseViewProperties(body) {
  const props = []
  let current = ''
  let depth = 0
  let quoted = false
  const flush = () => {
    const piece = current.trim()
    current = ''
    if (piece === '') return
    const at = piece.indexOf('=')
    if (at < 0) props.push({ key: piece, value: '' })
    else props.push({ key: piece.slice(0, at).trim(), value: piece.slice(at + 1).trim() })
  }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === "'" && body[i - 1] !== '\\') { quoted = !quoted; current += ch; continue }
    if (!quoted) {
      if (ch === '(' || ch === '<' || ch === '[') depth += 1
      else if (ch === ')' || ch === '>' || ch === ']') depth -= 1
      else if (ch === ';' && depth <= 0) { flush(); continue }
    }
    current += ch
  }
  flush()
  return props
}

/**
 * Parse the space-separated attributes a dump writes after the closing `>>`.
 *
 * `UIStackView` is the reason this exists: it prints `axis=vert distribution=fill
 * alignment=fill` outside its own element, and for a stack view those three ARE the
 * layout — they are what a wrong-looking screen is usually made of. The dump separates
 * them with spaces rather than semicolons, so the `;`-based property parser sees one
 * opaque value where there are three facts.
 *
 * @param {string} tail - the text after the outermost `>`.
 * @returns {Object<string, string>} attribute name to value.
 */
export function parseViewAttributes(tail) {
  const attributes = {}
  const text = String(tail ?? '')
  // Only a token like `name=value` starts an attribute, so a value that itself contains
  // spaces (a quoted string, a variant name) is not split in half.
  const pattern = /(?:^|\s)([A-Za-z_][\w.]*)=/g
  const starts = []
  let match
  while ((match = pattern.exec(text)) !== null) starts.push({ key: match[1], at: match.index + match[0].length - 1 })
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].at - (starts[index + 1].key.length + 1) : text.length
    attributes[entry.key] = text.slice(entry.at + 1, end).trim()
  })
  return attributes
}

/** `(0 0; 390 844)` -> numbers, so a panel can size things without re-parsing text. */
export function parseFrame(value) {
  const match = /^\(([-\d.]+)\s+([-\d.]+);\s+([-\d.]+)\s+([-\d.]+)\)$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const [x, y, width, height] = match.slice(1).map(Number)
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) return null
  return { x, y, width, height }
}

/**
 * Parse one line of a dump into a view record, or null when the line is not a view.
 *
 * Rejecting non-view lines matters as much as accepting view lines: the same stream
 * carries the echoed command, LLDB's own `error:` text, and prompt lines, and a parser
 * that guessed would invent nodes out of a failed expression.
 *
 * @param {string} line - one output line.
 * @returns {object|null} the record, or null.
 */
export function parseViewLine(line) {
  const text = String(line ?? '')
  const lead = /^[\s|]*/.exec(text)[0]
  const rest = text.slice(lead.length)
  if (!rest.startsWith('<')) return null
  const { inside, tail } = outerElement(rest)
  const head = /^([A-Za-z_][\w.]*):\s*(0x[0-9a-fA-F]+)\s*;?\s*/.exec(inside)
  if (head === null) return null
  const props = parseViewProperties(inside.slice(head[0].length))
  const get = (key) => props.find((p) => p.key === key)?.value ?? ''
  const hidden = get('hidden')
  const alpha = Number.parseFloat(get('alpha'))
  return {
    // `|` count, not spaces: see the header comment.
    depth: (lead.match(/\|/g) ?? []).length,
    className: head[1],
    address: head[2],
    frame: parseFrame(get('frame')),
    text: get('text').replace(/^'/, '').replace(/'$/, ''),
    hidden: hidden === 'YES',
    alpha: Number.isFinite(alpha) ? alpha : null,
    baseClass: get('baseClass'),
    properties: props,
    tail,
    attributes: parseViewAttributes(tail),
    raw: text,
  }
}

/**
 * Parse a whole dump.
 *
 * @param {string} output - the text LLDB printed for `recursiveDescription`.
 * @returns {Array<object>} view records in printed order (parents before children).
 */
export function parseViewHierarchy(output) {
  const out = []
  for (const line of String(output ?? '').split('\n')) {
    const record = parseViewLine(line)
    if (record !== null) out.push(record)
  }
  return out
}

/**
 * Nest flat records by depth.
 *
 * A dump is printed depth-first, so a stack of the current ancestors is enough — and it
 * tolerates a depth that jumps by more than one, which a dump of an unusual tree can do,
 * where a parent-index lookup would attach the node to the wrong branch.
 *
 * @param {Array<object>} records - from `parseViewHierarchy`.
 * @returns {Array<object>} roots, each with a `children` array.
 */
export function buildViewTree(records) {
  const roots = []
  const stack = []
  for (const record of Array.isArray(records) ? records : []) {
    const node = { ...record, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/**
 * What the tree is made of, for a one-line summary and for grouping in a panel.
 *
 * @param {Array<object>} records - from `parseViewHierarchy`.
 * @returns {{views: number, depth: number, classes: Array<{className: string, count: number}>}} stats.
 */
export function viewHierarchyStats(records) {
  const counts = new Map()
  let depth = 0
  for (const record of Array.isArray(records) ? records : []) {
    counts.set(record.className, (counts.get(record.className) ?? 0) + 1)
    if (record.depth > depth) depth = record.depth
  }
  const classes = [...counts.entries()]
    .map(([className, count]) => ({ className, count }))
    .sort((a, b) => b.count - a.count || (a.className < b.className ? -1 : 1))
  return { views: (records ?? []).length, depth, classes }
}

/**
 * Keep the records that match a class name and/or a text value.
 *
 * A filtered view must keep its ancestors, or the result is a flat list pretending to be
 * a tree: a `UILabel` match is only meaningful under the view that positions it. This
 * returns the matching records plus every ancestor they hang from, in printed order.
 *
 * @param {Array<object>} records - from `parseViewHierarchy`.
 * @param {{className?: string, text?: string}} [filter] - substrings, case-insensitive.
 * @returns {Array<object>} the pruned records.
 */
export function filterViewHierarchy(records, filter = {}) {
  const list = Array.isArray(records) ? records : []
  const className = String(filter.className ?? '').trim().toLowerCase()
  const text = String(filter.text ?? '').trim().toLowerCase()
  if (className === '' && text === '') return list
  const keep = new Set()
  const ancestorsOf = (index) => {
    let depth = list[index].depth
    for (let i = index - 1; i >= 0 && depth > 0; i -= 1) {
      if (list[i].depth < depth) {
        if (keep.has(i)) break
        keep.add(i)
        depth = list[i].depth
      }
    }
  }
  list.forEach((record, index) => {
    const hitClass = className === '' || record.className.toLowerCase().includes(className)
    const hitText = text === '' || String(record.text ?? '').toLowerCase().includes(text)
    if (hitClass && hitText) {
      keep.add(index)
      ancestorsOf(index)
    }
  })
  return list.filter((_, index) => keep.has(index))
}

/**
 * Render records as an indented outline, depth relative to what is shown.
 *
 * This is what a model reads: a dump of a real app is thousands of lines, and the tree
 * shape plus the class/frame/text of each view is the part that identifies a bug. The
 * panel renders its own DOM from the records; this is the text form.
 *
 * @param {Array<object>} records - from `parseViewHierarchy` (optionally filtered).
 * @param {{maxLines?: number, indent?: string, className?: string, text?: string}} [options] - rendering.
 * @returns {{text: string, shown: number, total: number, truncated: boolean, stats: object}} outline.
 */
export function formatViewHierarchy(records, options = {}) {
  const filtered = filterViewHierarchy(records, options)
  const maxLines = Number.isFinite(options.maxLines) ? Math.max(1, options.maxLines) : 400
  const indent = typeof options.indent === 'string' ? options.indent : '  '
  const base = filtered.length > 0 ? Math.min(...filtered.map((r) => r.depth)) : 0
  const shown = filtered.slice(0, maxLines)
  const lines = shown.map((record) => {
    const parts = [`${indent.repeat(Math.max(0, record.depth - base))}${record.className}`, record.address]
    if (record.frame !== null) {
      const { x, y, width, height } = record.frame
      parts.push(`${x} ${y} ${width} ${height}`)
    }
    if (record.text !== '') parts.push(JSON.stringify(record.text))
    if (record.hidden) parts.push('hidden')
    return parts.join(' ')
  })
  const truncated = filtered.length > shown.length
  return {
    text: lines.join('\n') + (truncated ? `\n… ${filtered.length - shown.length} more views not shown` : ''),
    shown: shown.length,
    total: filtered.length,
    truncated,
    stats: viewHierarchyStats(filtered),
  }
}
