/**
 * What the drawer's detail pane shows for one node, as plain data.
 *
 * The panel is a React template inside a large string, and the parts of this that are worth
 * testing are the parsing ones: `recursiveDescription` prints a colour as an object description
 * (`<UIDeviceRGBColor: 0x…; red = 1; green = 0; blue = 0; alpha = 1>` or
 * `<UIDynamicSystemColor: 0x…; name = systemBackgroundColor>`), and the layer as another object.
 * Parsing here rather than in the template means a swatch that is the wrong colour is a failing
 * test instead of a screenshot someone has to squint at.
 */

/**
 * A colour attribute, as a CSS colour when it has components and as a name when it does not.
 *
 * Both spellings are accepted for the components, because the printed description has used `;`
 * separators and bare spaces in different iOS versions, and a dynamic colour carries only a name —
 * resolving that name needs the app running, which is the one thing this pane cannot do.
 *
 * @param {string} text - the `backgroundColor = …` value, or ''.
 * @returns {{css: string, name: string, raw: string}}
 */
export function parseColorValue(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { css: '', name: '', raw: '' }
  const parts = {}
  for (const match of raw.matchAll(/([A-Za-z]+)\s*=\s*(-?[\d.]+)/g)) {
    parts[match[1].toLowerCase()] = Number.parseFloat(match[2])
  }
  const nameMatch = /name\s*=\s*([A-Za-z_][\w.]*)/.exec(raw)
  const name = nameMatch === null ? '' : nameMatch[1]
  if (!Number.isFinite(parts.red) || !Number.isFinite(parts.green) || !Number.isFinite(parts.blue)) {
    return { css: '', name, raw }
  }
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value * 255)))
  const alpha = Number.isFinite(parts.alpha) ? Math.max(0, Math.min(1, parts.alpha)) : 1
  return {
    css: `rgba(${channel(parts.red)}, ${channel(parts.green)}, ${channel(parts.blue)}, ${alpha})`,
    name,
    raw,
  }
}

/** The layer class out of `layer = <CALayer: 0x…>`. */
export function parseLayerClass(text) {
  const match = /<\s*([A-Za-z_][\w.]*)\s*:/.exec(String(text ?? ''))
  return match === null ? '' : match[1]
}

/**
 * The rows the detail pane lists, in the order a person reads them: what it is, then where it is,
 * then how it looks.
 *
 * Empty values are dropped rather than shown as blanks, because a detail pane of "—" tells nobody
 * anything; and `alpha` is folded into the hidden row, since "hidden" and "half transparent" are
 * the same question.
 *
 * @param {object} record - a node from the tree the host sent.
 * @param {object} node - the host's answer for this node: `{ chain, image, className }`.
 * @returns {Array<{label: string, value: string}>}
 */
export function detailRows(record, node) {
  const source = record ?? {}
  const attributes = source.attributes ?? {}
  const rows = []
  const push = (label, value) => {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text !== '') rows.push({ label, value: text })
  }
  push('Class', node?.className !== undefined && node.className !== '' ? node.className : source.className)
  push('Address', source.address)
  const frame = source.frame
  if (frame !== undefined && frame !== null) {
    const size = (number) => (Number.isFinite(number) ? String(Math.round(number * 1000) / 1000) : '?')
    push('Frame', `${size(frame.x)}, ${size(frame.y)}  ${size(frame.width)}×${size(frame.height)}`)
  }
  push('Bounds', attributes.bounds)
  const alpha = Number.parseFloat(attributes.alpha ?? '')
  if (source.hidden === true) push('Hidden', 'yes')
  // Only worth a row when it is not the default: `alpha = 1` is every view.
  if (Number.isFinite(alpha) && alpha < 1) push('Alpha', String(alpha))
  push('Tag', attributes.tag === undefined || attributes.tag === '0' ? '' : attributes.tag)
  push('Text', source.text)
  push('Background', attributes.backgroundColor)
  push('Tint', attributes.tintColor)
  push('Corner', attributes.cornerRadius === undefined || attributes.cornerRadius === '0' ? '' : attributes.cornerRadius)
  push('Layer', parseLayerClass(attributes.layer))
  const chain = Array.isArray(node?.chain) ? node.chain.filter((name) => typeof name === 'string' && name !== '') : []
  push('Inherits', chain.length === 0 ? '' : chain.slice(1).join(' → '))
  return rows
}
