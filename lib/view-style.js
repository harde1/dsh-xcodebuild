/**
 * How each view LOOKS, read in one expression: the attributes a canvas needs to draw a control
 * without its pixels — resolved colours, corner radius, border, text style — and which views draw
 * content of their own, whose pixels are worth fetching afterwards.
 *
 * Why not `recursiveDescription`: it prints a dynamic colour by NAME (`name = systemGreenColor`),
 * which only the app can resolve, prints no text colour, font, corner radius or border at all, and
 * says nothing about whether a view has an image. Measured on a real dump (HIDProbe, iOS 26
 * simulator): 8 of 12 background colours were names.
 *
 * Why the pixels come back INLINE (base64 on the debugger's own output) rather than as files: a file
 * in the app's sandbox has to be copied off the phone, and the only copier this plugin has is
 * `devicectl`, which an iOS 16 device does not have. Text out of lldb works everywhere lldb does.
 *
 * Both expressions WALK the window rather than dereferencing addresses from an earlier read. Between
 * the tree read and an image batch the app runs, views come and go, and messaging a freed pointer
 * crashes the app. A walk only ever touches views that exist, and matches them against the wanted set.
 *
 * The same constraints as `view-shots.js` apply, for the same measured reasons — one line behind
 * `po`, no variadic ObjC calls, no CoreGraphics struct held by value — plus one more: no headers at
 * all (see `WALK_OPEN`).
 *
 * @module dsh-xcodebuild/view-style
 */

/** Longest rendered edge of an inline image, in pixels: icons stay sharp, a photo stays small. */
export const INLINE_IMAGE_MAX_PX = 360

/** Views per image batch: one batch is one short stop of the app. */
export const IMAGE_BATCH = 12

const join = (source) => source.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ')

/**
 * The walk both expressions share: the first window, depth-first, in `recursiveDescription` order.
 *
 * HEADER-FREE, every word of it. On the classic channel (an iOS 16 phone through the debugserver
 * forwarder) `@import UIKit` fails with `Header search couldn't locate module 'UIKit'` and takes the
 * whole expression with it — measured on the iPhone X — while `recursiveDescription` works, because
 * it names no type. So: every object is `id`, every message carries its return type as a cast, no
 * typedef (`CGFloat`, `NSInteger`, `BOOL`, `size_t`) and no macro (`nil`, `YES`, `NSNotFound`)
 * appears, and C functions are called through a function-pointer cast, which lldb resolves from the
 * symbol table without a declaration.
 */
const WALK_OPEN = `id root = (id)[(id)[(id)[(id)NSClassFromString(@"UIApplication") sharedApplication] windows] firstObject];
  id stack = (id)[(id)NSClassFromString(@"NSMutableArray") array];
  if (root != 0) { (void)[stack addObject:root]; }
  id out = (id)[(id)NSClassFromString(@"NSMutableString") string];
  while ((unsigned long)[stack count] > 0) {
    id view = (id)[stack lastObject];
    (void)[stack removeLastObject];
    id children = (id)[view subviews];
    for (long child = (long)[children count] - 1; child >= 0; child = child - 1) {
      (void)[stack addObject:(id)[children objectAtIndex:(unsigned long)child]];
    }
    unsigned long long here = (unsigned long long)view;`

const append = (text) => `(void)[out appendString:${text}];`
const numberText = (expression) => `(id)[(id)[(id)NSClassFromString(@"NSNumber") numberWithDouble:(double)(${expression})] stringValue]`

/** Append ` key=r,g,b,a` for a colour resolved in the view's own traits, or nothing for none. */
function colourField(key, expression) {
  return `{
      id c = (id)(${expression});
      if (c != 0) {
        if ((signed char)[c respondsToSelector:@selector(resolvedColorWithTraitCollection:)]) { c = (id)[c resolvedColorWithTraitCollection:(id)[view traitCollection]]; }
        double r = 0; double g = 0; double b = 0; double a = 0;
        if ((signed char)[c getRed:&r green:&g blue:&b alpha:&a]) {
          ${append(`@" ${key}="`)}
          ${append(numberText('r'))} ${append('@","')}
          ${append(numberText('g'))} ${append('@","')}
          ${append(numberText('b'))} ${append('@","')}
          ${append(numberText('a'))}
        }
      }
    }`
}

function numberField(key, expression) {
  return `${append(`@" ${key}="`)} ${append(numberText(expression))}`
}

/**
 * One line per view: `S <decimal address> bg=r,g,b,a fg=… fs=17 fb=1 ta=1 cr=8 bw=1 bc=… op=1 ct=1 img=1`.
 *
 * `ct=1` marks a layer with contents of its own (an image, a label's glyphs, custom drawing) — the
 * views a box of colour cannot stand in for. `img=1` marks an image view that has an image, `im=`
 * is that UIImage's address and `tc=` its tint — what its cached picture is keyed on (`imageKey`).
 *
 * @returns {string} the `po` command.
 */
export function viewStyleExpression() {
  const body = `({
  ${WALK_OPEN}
    id layer = (id)[view layer];
    ${append('@"S "')}
    ${append('(id)[(id)[(id)NSClassFromString(@"NSNumber") numberWithUnsignedLongLong:here] stringValue]')}
    ${colourField('bg', '[view backgroundColor]')}
    ${numberField('op', '(double)[view alpha]')}
    ${numberField('cr', '(double)[layer cornerRadius]')}
    if ((double)[layer borderWidth] > 0) {
      ${numberField('bw', '(double)[layer borderWidth]')}
      ${colourField('bc', '(void *)[layer borderColor] == 0 ? (id)0 : (id)[(id)NSClassFromString(@"UIColor") colorWithCGColor:(void *)[layer borderColor]]')}
    }
    if ((signed char)[view clipsToBounds]) { ${append('@" cl=1"')} }
    if ((id)[layer contents] != 0) { ${append('@" ct=1"')} }
    if ((signed char)[view isKindOfClass:(id)NSClassFromString(@"UIImageView")] && (id)[view image] != 0) {
      ${append('@" img=1 im="')}
      ${append('(id)[(id)[(id)NSClassFromString(@"NSNumber") numberWithUnsignedLongLong:(unsigned long long)(id)[view image]] stringValue]')}
      ${colourField('tc', '[view tintColor]')}
    }
    if ((signed char)[view respondsToSelector:@selector(textColor)] && (signed char)[view respondsToSelector:@selector(font)]) {
      ${colourField('fg', '[view textColor]')}
      id font = (id)[view font];
      if (font != 0) {
        ${numberField('fs', '(double)[font pointSize]')}
        id fontName = (id)[font fontName];
        if ((signed char)[fontName containsString:@"Bold"] || (signed char)[fontName containsString:@"Semibold"] || (signed char)[fontName containsString:@"Heavy"]) { ${append('@" fb=1"')} }
      }
      if ((signed char)[view respondsToSelector:@selector(textAlignment)]) { ${numberField('ta', '(long)[view textAlignment]')} }
    }
    ${append('@"\\n"')}
  }
  out;
})`
  return `po ${join(body)}`
}

/** `0x…` for the decimal address the expressions print. */
export function hexAddress(decimal) {
  try {
    return `0x${BigInt(String(decimal)).toString(16)}`
  } catch {
    return ''
  }
}

function rgba(text) {
  const parts = String(text ?? '').split(',').map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return ''
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value * 255)))
  const alpha = Math.max(0, Math.min(1, parts[3]))
  return `rgba(${channel(parts[0])}, ${channel(parts[1])}, ${channel(parts[2])}, ${Number(alpha.toFixed(3))})`
}

/**
 * The style report, by address.
 *
 * @param {string} text - what `viewStyleExpression` printed.
 * @returns {Record<string, {bg?: string, fg?: string, border?: string, borderWidth?: number,
 *   radius?: number, opacity?: number, fontSize?: number, bold?: boolean, align?: string,
 *   clips?: boolean, content?: boolean, image?: boolean}>}
 */
export function parseViewStyles(text) {
  const styles = {}
  for (const line of String(text ?? '').split('\n')) {
    const match = /^S (\d+)((?: [a-z]+=[^\s]*)*)\s*$/.exec(line.trim())
    if (match === null) continue
    const address = hexAddress(match[1])
    if (address === '') continue
    const fields = {}
    for (const pair of match[2].trim().split(' ')) {
      const at = pair.indexOf('=')
      if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1)
    }
    const style = {}
    const bg = rgba(fields.bg)
    if (bg !== '' && !bg.endsWith(', 0)')) style.bg = bg
    const fg = rgba(fields.fg)
    if (fg !== '') style.fg = fg
    const bw = Number(fields.bw)
    if (Number.isFinite(bw) && bw > 0) {
      style.borderWidth = bw
      const bc = rgba(fields.bc)
      if (bc !== '') style.border = bc
    }
    const cr = Number(fields.cr)
    if (Number.isFinite(cr) && cr > 0) style.radius = cr
    const op = Number(fields.op)
    if (Number.isFinite(op) && op < 1) style.opacity = Math.max(0, op)
    const fs = Number(fields.fs)
    if (Number.isFinite(fs) && fs > 0) style.fontSize = fs
    if (fields.fb === '1') style.bold = true
    // NSTextAlignment: 0 left, 1 center, 2 right, 3 justified, 4 natural.
    const ta = Number(fields.ta)
    if (ta === 1) style.align = 'center'
    else if (ta === 2) style.align = 'right'
    if (fields.cl === '1') style.clips = true
    if (fields.ct === '1') style.content = true
    if (/^\d+$/.test(fields.im ?? '') && fields.im !== '0') style.imageObject = fields.im
    const tc = rgba(fields.tc)
    if (tc !== '') style.tint = tc
    if (fields.img === '1') style.image = true
    styles[address] = style
  }
  return styles
}

/**
 * What a view's rendered image is cached under, or '' when it must be fetched every time.
 *
 * Only views whose look can be named from what was read are cached, because the obvious key does
 * not work: a layer's `contents` object is NOT replaced when the view redraws. Measured on an iOS 26
 * simulator: a UILabel's text set twice, its colour once, each followed by a forced redraw — the
 * contents address stayed the same through all of it, so keying on it would have shown the old text.
 *
 *   - An image view: its UIImage object (UIImage is immutable, so another picture is another
 *     object), its tint (a template image is drawn in it), class and size.
 *   - A text view (a label, a button title, a field): the text itself and everything it is drawn
 *     in — colour, size, weight, alignment, background — plus class and size.
 *   - Anything else that draws (custom `drawRect:`, a layer given contents in code): no key. Nothing
 *     read says whether it changed, so it is fetched again on every read.
 *
 * Class and size are in every key because a freed object's address can be handed out again.
 *
 * @param {{className?: string, text?: string, frame?: {width?: number, height?: number}}} record - the view.
 * @param {object} [style] - from `parseViewStyles`.
 * @returns {string}
 */
export function imageKey(record, style) {
  if (style === undefined || style === null) return ''
  const w = Math.round((Number(record?.frame?.width) || 0) * 10) / 10
  const h = Math.round((Number(record?.frame?.height) || 0) * 10) / 10
  const shape = `${String(record?.className ?? '')}|${String(w)}x${String(h)}`
  if (typeof style.imageObject === 'string' && style.imageObject !== '') {
    return `image|${style.imageObject}|${style.tint ?? ''}|${shape}`
  }
  const text = String(record?.text ?? '')
  if (text !== '' && typeof style.fg === 'string') {
    return `text|${JSON.stringify([text, style.fg, style.fontSize ?? 0, style.bold === true, style.align ?? '', style.bg ?? ''])}|${shape}`
  }
  return ''
}

/**
 * The loose key: THIS view, by its address, class and size — whatever it draws.
 *
 * Valid only inside one process (the cache is dropped when the pid changes), where an address
 * names one live object. It cannot see a label whose text changed, which is the point: it is what a
 * first look uses to put pictures on the canvas at once, and an explicit refresh uses the strict
 * `imageKey` instead.
 *
 * @param {{address?: string, className?: string, frame?: {width?: number, height?: number}}} record - the view.
 * @returns {string}
 */
export function looseImageKey(record) {
  const address = String(record?.address ?? '').toLowerCase()
  if (address === '') return ''
  const w = Math.round((Number(record?.frame?.width) || 0) * 10) / 10
  const h = Math.round((Number(record?.frame?.height) || 0) * 10) / 10
  return `view|${address}|${String(record?.className ?? '')}|${String(w)}x${String(h)}`
}

/**
 * The views whose own pixels are worth fetching, in the order to fetch them: image views first —
 * an icon is what a box most fails to stand in for — then anything else with contents, top of the
 * tree first. A view with no contents is fully described by its colours and is never rendered.
 *
 * @param {Array<{address: string}>} records - the tree, in order.
 * @param {Record<string, object>} styles - from `parseViewStyles`.
 * @returns {string[]} addresses.
 */
export function imageQueue(records, styles) {
  const images = []
  const others = []
  for (const record of Array.isArray(records) ? records : []) {
    const style = styles?.[record.address]
    if (style === undefined || style.content !== true) continue
    const w = Number(record.frame?.width) || 0
    const h = Number(record.frame?.height) || 0
    if (w <= 0 || h <= 0) continue
    ;(style.image === true ? images : others).push(record.address)
  }
  return [...images, ...others]
}

/**
 * Render the views named in `addresses` ALONE (sublayers hidden, as Lookin's solo image) and print
 * each as `I <decimal address> <base64 png>`. Views not found in the walk are simply not printed.
 *
 * @param {string[]} addresses - `0x…` addresses, at most a batch.
 * @param {{maxPx?: number}} [options]
 * @returns {string} the `po` command.
 */
export function viewImagesExpression(addresses, options = {}) {
  const maxPx = Number.isFinite(options.maxPx) && options.maxPx > 0 ? options.maxPx : INLINE_IMAGE_MAX_PX
  const wanted = (Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address).trim())
    .filter((address) => /^0x[0-9a-fA-F]+$/.test(address))
  const list = wanted.length === 0 ? '0x0' : wanted.join(', ')
  // kCGImageAlphaPremultipliedFirst (2) | kCGBitmapByteOrder32Little (2 << 12): the constants are
  // enum values in a header this expression cannot import.
  const bitmapInfo = 2 | (2 << 12)
  const body = `({
  unsigned long long wanted[${String(Math.max(1, wanted.length))}] = { ${list} };
  unsigned long wantedCount = ${String(wanted.length)};
  double screenScale = (double)[(id)[(id)NSClassFromString(@"UIScreen") mainScreen] scale];
  ${WALK_OPEN}
    int hit = 0;
    for (unsigned long w = 0; w < wantedCount; w = w + 1) { if (wanted[w] == here) { hit = 1; } }
    if (hit == 0) { continue; }
    id layer = (id)[view layer];
    double box[4] = {0, 0, 0, 0};
    (void)[(id)[view valueForKey:@"bounds"] getValue:(void *)box];
    double pointWidth = box[2];
    double pointHeight = box[3];
    if (pointWidth <= 0 || pointHeight <= 0 || pointWidth > 20000 || pointHeight > 20000) { continue; }
    double xcbImageScale = screenScale;
    double longest = pointWidth > pointHeight ? pointWidth : pointHeight;
    if (longest * xcbImageScale > ${String(maxPx)}) { xcbImageScale = ${String(maxPx)} / longest; }
    unsigned long pixelWidth = (unsigned long)(pointWidth * xcbImageScale + 0.5);
    unsigned long pixelHeight = (unsigned long)(pointHeight * xcbImageScale + 0.5);
    if (pixelWidth == 0 || pixelHeight == 0) { continue; }
    id sublayers = (id)[(id)[layer sublayers] copy];
    id wereVisible = (id)[(id)NSClassFromString(@"NSMutableArray") array];
    for (id sublayer in sublayers) { if (!(signed char)[sublayer isHidden]) { (void)[sublayer setHidden:1]; (void)[wereVisible addObject:sublayer]; } }
    void *xcbSpace = ((void *(*)(void))CGColorSpaceCreateDeviceRGB)();
    void *xcbContext = ((void *(*)(void *, unsigned long, unsigned long, unsigned long, unsigned long, void *, unsigned int))CGBitmapContextCreate)((void *)0, pixelWidth, pixelHeight, 8, 0, xcbSpace, ${String(bitmapInfo)});
    ((void (*)(void *))CGColorSpaceRelease)(xcbSpace);
    if (xcbContext != 0) {
      ((void (*)(void *, double, double))CGContextTranslateCTM)(xcbContext, 0, (double)pixelHeight);
      ((void (*)(void *, double, double))CGContextScaleCTM)(xcbContext, xcbImageScale, 0 - xcbImageScale);
      (void)[layer renderInContext:xcbContext];
      void *xcbImage = ((void *(*)(void *))CGBitmapContextCreateImage)(xcbContext);
      ((void (*)(void *))CGContextRelease)(xcbContext);
      id picture = (id)[(id)[(id)NSClassFromString(@"UIImage") alloc] initWithCGImage:xcbImage];
      ((void (*)(void *))CGImageRelease)(xcbImage);
      id png = ((id (*)(id))UIImagePNGRepresentation)(picture);
      if (png != 0) {
        ${append('@"I "')}
        ${append('(id)[(id)[(id)NSClassFromString(@"NSNumber") numberWithUnsignedLongLong:here] stringValue]')}
        ${append('@" "')}
        ${append('(id)[png base64EncodedStringWithOptions:0]')}
        ${append('@"\\n"')}
      }
    }
    for (id sublayer in wereVisible) { (void)[sublayer setHidden:0]; }
  }
  out;
})`
  return `po ${join(body)}`
}

/**
 * The images an image batch printed, by address, as data URLs.
 *
 * @param {string} text - what `viewImagesExpression` printed.
 * @returns {Record<string, string>}
 */
export function parseViewImages(text) {
  const images = {}
  for (const line of String(text ?? '').split('\n')) {
    const match = /^I (\d+) ([A-Za-z0-9+/=]+)\s*$/.exec(line.trim())
    if (match === null) continue
    const address = hexAddress(match[1])
    if (address !== '') images[address] = `data:image/png;base64,${match[2]}`
  }
  return images
}
