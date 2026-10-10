/**
 * The images of the views themselves, rendered inside the app rather than cut out of a screenshot.
 *
 * Lookin shows two images per node, and they mean different things:
 *
 *   - `soloScreenshot` is the control ALONE: LookinServer hides the layer's sublayers, renders,
 *     and puts the hidden flags back (`CALayer+LookinServer.m -lks_soloScreenshotWithLowQuality:`).
 *   - `groupScreenshot` is the control WITH its subviews.
 *
 * A screen capture can produce neither: cropping the screen gives one region of one flat image, so
 * a solo crop still contains every child that was drawn on top. The only way to get the control's
 * own pixels is to render its layer, which has to happen inside the app — hence one expression that
 * walks the view tree, renders each view twice, and writes PNGs into the app's own sandbox for the
 * host to pull out.
 *
 * The expression is deliberately plain Objective-C:
 *
 *   - No `stringWithFormat:`: LLDB's expression parser rejects variadic ObjC methods outright
 *     ("too many arguments to method call, expected 1, have 4"). Names are built with `snprintf`
 *     (a C variadic, which is fine) and `stringByAppendingString:`.
 *   - No blocks: `enumerateObjectsUsingBlock:` and friends are avoided in favour of plain loops,
 *     which the expression parser handles.
 *   - `renderInContext:` rather than `drawViewHierarchyInRect:afterScreenUpdates:`: the latter asks
 *     for a screen update, and this runs while the app is stopped by the debugger, so no update can
 *     arrive. `renderInContext:` draws the layer tree synchronously.
 *   - A cast on every call whose return type LLDB says it does not know. That is not politeness:
 *     `-stringValue` is rejected outright without one, and the parse failure cascades into
 *     "expected identifier" errors further down the expression.
 *   - NO CoreGraphics STRUCT IS EVER A VALUE. This is the trap that made the whole render fail on
 *     Xcode 26's lldb while looking like a syntax problem: `CGSize size = [layer frame].size`,
 *     `CGRect r = CGRectMake(…)`, `CGSize s = CGSizeMake(…)` and even reading `.size.width` off a
 *     temporary are all refused by the evaluator with `error: attempt to use a deleted function`, in
 *     `po`, `expression -l objc` and `expression -l objc++` alike (measured on an iPhone 17
 *     simulator, iOS 26). Pointers, scalars, arrays and message sends are unaffected. So the
 *     geometry comes out of `NSValue` into a `double[4]`, the context is a `CGBitmapContextCreate`
 *     at a pixel size computed from those doubles, and the image is read back with
 *     `CGBitmapContextCreateImage`.
 *   - `@import UIKit; @import QuartzCore;` ahead of the expression. `po` evaluates in the target's
 *     language with no headers, so ObjC classes resolve through the runtime while every typedef is
 *     an undeclared identifier (`error: use of undeclared identifier 'CGFloat'`).
 *
 * It goes to the debugger as ONE line behind `po`: LLDB's command interpreter reads input a line at
 * a time, so a multi-line expression is rejected as `'({' is not a valid command` — measured, not
 * guessed. That is also why the emitted code carries no `//` comments: they would swallow the rest.
 */

/** Directory inside the app sandbox the PNGs are written to. */
export const SHOT_DIR_NAME = 'dsh-lookin-shots'

/**
 * Most pixels a rendered edge may have.
 *
 * LookinServer renders at the screen's scale and caps a rendered edge at 16384 px
 * (`LookinNodeImageMaxLengthInPx`), which for a whole tree is hundreds of megabytes of PNG in one
 * file. 1024 keeps a control's own pixels legible while the file stays something you can open and
 * mail — the same tradeoff as LookinServer's own low-quality mode, which renders at scale 1.
 */
export const MAX_RENDER_SCALE = 1024

/**
 * The expression that renders every view in the first window and writes the PNGs out.
 *
 * Views too large to render are skipped (CoreGraphics refuses contexts past ~20000 points, and
 * LookinServer caps a rendered edge at 16384 pixels the same way), as are empty ones, which would
 * only produce blank files.
 *
 * Files are named by WALK INDEX, never by address, and each is reported with the view's
 * `description` so the host can match it back to the node it belongs to. The address route is a
 * dead end that cost a round of live debugging: `snprintf` is a C variadic, and a variadic call
 * from an LLDB expression reads the wrong register — all 32 renders were written to
 * `solo-93ccf4258ac9d1ca.png`, one constant garbage value, overwriting each other. `description`
 * goes through the same object path as everything else and carries the real address.
 *
 * The same walk is written in two spellings, and that is not redundancy.
 *
 * `typed: true` (the default) names its C types, which is what a target with usable headers wants, and
 * is what keeps a rendered image's point size equal to the view's frame. `typed: false` names no type
 * that a header declares: every local is a builtin (`double`, `size_t`, `int`), every C pointer is a
 * `void *`, and the C functions are called as the implicit declarations a headerless translation unit
 * gets. It exists because of what a missing module does to the typed spelling. On a target whose
 * UIKit module cannot be imported — a device running an iOS the installed Xcode has no SDK for is the
 * usual one — `CGFloat` is an unknown type name, `clang` RECOVERS by dropping the declaration that
 * used it, and every later use of that variable becomes an external symbol lookup. That is how a
 * render failure arrived as `error: Multiple external symbols found for 'scale'`: the dropped local
 * was called `scale`, and several images in the process export a symbol by that name. Measured on an
 * iPhone 17 simulator, in a session that had imported nothing:
 *
 *   error: unknown type name 'CGFloat'                                (the type is the problem)
 *   po ({ double xcbS = 1.5; xcbS; })                                 ok 1.5
 *   po ({ unsigned long xcbU = 3; xcbU; })                            ok 3
 *   po ({ size_t xcbN = 3; xcbN; })                                   ok 3
 *   po ({ CGColorSpaceRef s = CGColorSpaceCreateDeviceRGB(); … })      unknown type name 'CGColorSpaceRef'
 *   po ({ void *s = (void *)CGColorSpaceCreateDeviceRGB(); … })        ok <CGColorSpace>
 *   po ({ … CGBitmapContextCreate(0, 4, 4, 8, 0, s, 8194) … })         ok <CGContext> (kCGContextTypeBitmap)
 *   po ({ … CGContextScaleCTM(ctx, 2.0, 2.0); … })                    ok
 *   po ({ id i = [[UIImage alloc] initWithCGImage:img scale:1.0 orientation:0]; i; })  ok <UIImage:0x… {4, 4}>
 *   po ({ (double)[(id)[UIScreen mainScreen] scale]; })               ok 3
 *
 * So the host tries the typed spelling and falls back to this one, and a target without headers
 * renders its views instead of falling back to cropping a screen capture.
 *
 * @param {object} [options]
 * @param {number} [options.scale] - render scale; defaults to the screen's own.
 * @param {boolean} [options.typed] - name C types (default) or use only builtin ones.
 * @returns {string} an Objective-C statement expression whose value is a multi-line report.
 */
export function viewShotsExpression(options = {}) {
  const typed = options.typed !== false
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 0
  // The scale is the one value both spellings must read, and they read it differently: the property
  // is a `CGFloat`, so the headerless spelling casts the message send instead of naming the type.
  const scaleSource = scale !== 0
    ? String(scale)
    : typed ? '[UIScreen mainScreen].scale' : '(double)[(id)[UIScreen mainScreen] scale]'
  const cgColorSpace = typed ? 'CGColorSpaceRef' : 'void *'
  const cgContext = typed ? 'CGContextRef' : 'void *'
  const cgImage = typed ? 'CGImageRef' : 'void *'
  // `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little` are enum constants from a header;
  // a translation unit without one spells the same word as the number those two names add up to.
  const bitmapInfo = typed
    ? '(kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little)'
    : '(2 | 8192)'
  // `NSInteger` and `NSUInteger` are Foundation typedefs and `YES`/`NO` are macros: all four are
  // unknown to a headerless translation unit, and all four are spelled as their builtin equivalents
  // (on 64-bit Apple platforms `NSInteger` IS `long`).
  const integer = typed ? 'NSInteger' : 'long'
  const uinteger = typed ? 'NSUInteger' : 'unsigned long'
  const yes = typed ? 'YES' : '1'
  const no = typed ? 'NO' : '0'
  // The scale argument is a `CGFloat` and the orientation a `UIImageOrientation`: the typed spelling
  // casts both, the headerless one passes a double and a plain 0, which the evaluator accepts once
  // there is no declaration to contradict it.
  const imageOf = (name) => (typed
    ? `UIImage *${name} = (UIImage *)[[UIImage alloc] initWithCGImage:${name}Image scale:xcbViewScale orientation:(UIImageOrientation)0];`
    : `id ${name} = (id)[[UIImage alloc] initWithCGImage:${name}Image scale:xcbViewScale orientation:0];`)
  const dataOf = (name) => (typed
    ? `NSData *${name}Data = (NSData *)UIImagePNGRepresentation(${name});`
    : `id ${name}Data = (id)UIImagePNGRepresentation(${name});`)
  const contextOf = (name) => (typed
    ? `CGContextRef ${name}Context = CGBitmapContextCreate(NULL, pixelWidth, pixelHeight, 8, 0, ${name}Space, ${bitmapInfo});`
    : `void *${name}Context = (void *)CGBitmapContextCreate(NULL, pixelWidth, pixelHeight, 8, 0, ${name}Space, ${bitmapInfo});`)
  const spaceOf = (name) => (typed
    ? `CGColorSpaceRef ${name}Space = CGColorSpaceCreateDeviceRGB();`
    : `void *${name}Space = (void *)CGColorSpaceCreateDeviceRGB();`)
  const imageRefOf = (name) => (typed
    ? `CGImageRef ${name}Image = CGBitmapContextCreateImage(${name}Context);`
    : `void *${name}Image = (void *)CGBitmapContextCreateImage(${name}Context);`)
  // A batch is a window of the walk: every view is still WALKED (so indexes stay the same across
  // batches and the report still lists all of them), but only those in [start, start+limit) are
  // rendered. The first batch clears the directory; later ones add to it. That is what lets a full
  // export stop the app for one short batch at a time, report progress between batches, and be
  // cancelled between them, instead of one opaque multi-minute freeze.
  const start = Number.isInteger(options.start) && options.start > 0 ? options.start : 0
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0
  const end = limit === 0 ? 0 : start + limit
  const reset = start === 0
    ? `[[NSFileManager defaultManager] removeItemAtPath:dir error:NULL];
  `
    : ''
  const window = limit === 0
    ? ''
    : `if (index < ${start} || index >= ${end}) { index = index + 1; continue; }
    `
  // Nothing in `body` may be a `//` comment: the body is joined into ONE line before it is sent, so a
  // comment inside it would swallow every statement after it. That was measured, not feared — the
  // index loops below carry their reason here instead.
  //
  // The sublayer walks are index loops rather than `for (CALayer *sublayer in sublayers)`: fast
  // enumeration is a protocol, and a translation unit without headers is warned that the collection
  // "may not respond to countByEnumeratingWithState:objects:count:" — a warning the headerless
  // spelling cannot afford, because the loop it wraps is the one that hides the sublayers.
  const body = `({
  NSString *dir = (NSString *)[NSTemporaryDirectory() stringByAppendingPathComponent:@"${SHOT_DIR_NAME}"];
  ${reset}[[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
  double xcbScale = ${scaleSource};
  if (!(xcbScale > 0)) { xcbScale = 1; }
  UIView *root = (UIView *)[[[UIApplication sharedApplication] windows] firstObject];
  NSMutableArray *stack = (NSMutableArray *)[NSMutableArray array];
  if (root != nil) { [stack addObject:root]; }
  NSMutableString *report = (NSMutableString *)[NSMutableString string];
  unsigned long index = 0;
  unsigned long rendered = 0;
  unsigned long skipped = 0;
  while ([stack count] > 0) {
    UIView *view = (UIView *)[stack lastObject];
    [stack removeLastObject];
    NSArray *children = (NSArray *)[view subviews];
    for (${integer} child = (${integer})[children count] - 1; child >= 0; child = child - 1) {
      [stack addObject:(id)[children objectAtIndex:(${uinteger})child]];
    }
    [report appendString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]];
    [report appendString:@" "];
    [report appendString:(NSString *)[view description]];
    [report appendString:@"\\n"];
    ${window}CALayer *layer = (CALayer *)[view layer];
    double box[4] = {0, 0, 0, 0};
    NSValue *frameBox = (NSValue *)[view valueForKey:@"frame"];
    [frameBox getValue:(void *)box];
    double pointWidth = box[2];
    double pointHeight = box[3];
    double xcbViewScale = xcbScale;
    double longest = pointWidth > pointHeight ? pointWidth : pointHeight;
    if (longest * xcbViewScale > ${MAX_RENDER_SCALE}) { xcbViewScale = ${MAX_RENDER_SCALE} / longest; }
    if (pointWidth <= 0 || pointHeight <= 0 || pointWidth > 20000 || pointHeight > 20000) {
      skipped = skipped + 1;
      index = index + 1;
      continue;
    }
    size_t pixelWidth = (size_t)(pointWidth * xcbViewScale + 0.5);
    size_t pixelHeight = (size_t)(pointHeight * xcbViewScale + 0.5);
    NSString *stem = (NSString *)[dir stringByAppendingPathComponent:(NSString *)[@"solo-" stringByAppendingString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]]];
    NSString *soloPath = (NSString *)[stem stringByAppendingString:@".png"];
    NSString *groupStem = (NSString *)[dir stringByAppendingPathComponent:(NSString *)[@"group-" stringByAppendingString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]]];
    NSString *groupPath = (NSString *)[groupStem stringByAppendingString:@".png"];
    NSArray *sublayers = (NSArray *)[[layer sublayers] copy];
    NSMutableArray *wereVisible = (NSMutableArray *)[NSMutableArray array];
    for (unsigned long xcbAt = 0; xcbAt < (unsigned long)[sublayers count]; xcbAt = xcbAt + 1) {
      CALayer *sublayer = (CALayer *)[sublayers objectAtIndex:xcbAt];
      if (![sublayer isHidden]) {
        [sublayer setHidden:${yes}];
        [wereVisible addObject:sublayer];
      }
    }
    ${spaceOf('solo')}
    ${contextOf('solo')}
    CGColorSpaceRelease(soloSpace);
    if (soloContext != NULL) {
      CGContextScaleCTM(soloContext, xcbViewScale, xcbViewScale);
      [layer renderInContext:soloContext];
      ${imageRefOf('solo')}
      CGContextRelease(soloContext);
      ${imageOf('solo')}
      CGImageRelease(soloImage);
      ${dataOf('solo')}
      [soloData writeToFile:soloPath atomically:YES];
    }
    for (unsigned long xcbAt = 0; xcbAt < (unsigned long)[wereVisible count]; xcbAt = xcbAt + 1) {
      [(CALayer *)[wereVisible objectAtIndex:xcbAt] setHidden:${no}];
    }
    ${spaceOf('group')}
    ${contextOf('group')}
    CGColorSpaceRelease(groupSpace);
    if (groupContext != NULL) {
      CGContextScaleCTM(groupContext, xcbViewScale, xcbViewScale);
      [layer renderInContext:groupContext];
      ${imageRefOf('group')}
      CGContextRelease(groupContext);
      ${imageOf('group')}
      CGImageRelease(groupImage);
      ${dataOf('group')}
      [groupData writeToFile:groupPath atomically:YES];
    }
    rendered = rendered + 1;
    index = index + 1;
  }
  NSMutableString *header = (NSMutableString *)[NSMutableString string];
  [header appendString:@"RENDERED "];
  [header appendString:(NSString *)[[NSNumber numberWithUnsignedLong:rendered] stringValue]];
  [header appendString:@" SKIPPED "];
  [header appendString:(NSString *)[[NSNumber numberWithUnsignedLong:skipped] stringValue]];
  [header appendString:@" DIR "];
  [header appendString:dir];
  [header appendString:@"\\n"];
  [header appendString:report];
  header;
})`
  // The module imports are not decoration for the typed spelling: `po` runs in the target's language
  // with no headers, so ObjC classes resolve through the runtime while `CGFloat`, `CGSize` and
  // `CGContextRef` are undeclared identifiers, and the whole render fails to compile without them.
  // The headerless spelling asks for no modules on purpose — asking for one it cannot have is the
  // failure it exists to survive.
  const prefix = typed ? 'po @import UIKit; @import QuartzCore; ' : 'po '
  return `${prefix}${body.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ')}`
}

/**
 * Read the expression's report.
 *
 * The first line is the summary; every line after it is one walked view, in walk order, as
 * `<index> <Class: 0xADDR; …>`. The address is what the host matches a node by, so a desync
 * between the walk and the tree costs an image rather than mis-assigning one.
 *
 * @param {string} text - what the debugger printed.
 * @returns {{rendered: number, skipped: number, dir: string, views: Array<{index: number, address: string, className: string}>}|null}
 */
export function parseShotsReport(text) {
  const lines = String(text ?? '').split('\n')
  const header = /RENDERED (\d+) SKIPPED (\d+) DIR (\S+)/.exec(lines[0] ?? '')
  if (header === null) return null
  const views = []
  for (const line of lines.slice(1)) {
    const view = /^(\d+) <([A-Za-z_][\w.]*):\s*(0x[0-9a-fA-F]+)/.exec(line.trim())
    if (view !== null) views.push({ index: Number(view[1]), className: view[2], address: view[3] })
  }
  return { rendered: Number(header[1]), skipped: Number(header[2]), dir: header[3], views }
}

/** `solo-<index>.png` / `group-<index>.png`; `null` for an index that is not a whole number. */
export function shotFileName(kind, index) {
  return Number.isInteger(index) && index >= 0 ? `${kind}-${index}.png` : null
}
