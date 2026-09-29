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
 *     `UIGraphicsGetCurrentContext()` and `-stringValue` are rejected outright without one, and the
 *     parse failure cascades into "expected identifier" errors further down the expression.
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
 * @param {object} [options]
 * @param {number} [options.scale] - render scale; defaults to the screen's own.
 * @returns {string} an Objective-C statement expression whose value is a multi-line report.
 */
export function viewShotsExpression(options = {}) {
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 0
  const scaleSource = scale === 0 ? '[UIScreen mainScreen].scale' : String(scale)
  const body = `({
  NSString *dir = (NSString *)[NSTemporaryDirectory() stringByAppendingPathComponent:@"${SHOT_DIR_NAME}"];
  [[NSFileManager defaultManager] removeItemAtPath:dir error:NULL];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
  CGFloat scale = ${scaleSource};
  if (!(scale > 0)) { scale = 1; }
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
    for (NSInteger child = (NSInteger)[children count] - 1; child >= 0; child = child - 1) {
      [stack addObject:(id)[children objectAtIndex:(NSUInteger)child]];
    }
    [report appendString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]];
    [report appendString:@" "];
    [report appendString:(NSString *)[view description]];
    [report appendString:@"\\n"];
    CALayer *layer = (CALayer *)[view layer];
    CGSize size = (CGSize)[layer frame].size;
    CGFloat viewScale = scale;
    CGFloat longest = size.width > size.height ? size.width : size.height;
    if (longest * viewScale > ${MAX_RENDER_SCALE}) { viewScale = ${MAX_RENDER_SCALE} / longest; }
    if (size.width <= 0 || size.height <= 0 || size.width > 20000 || size.height > 20000) {
      skipped = skipped + 1;
      index = index + 1;
      continue;
    }
    NSString *stem = (NSString *)[dir stringByAppendingPathComponent:(NSString *)[@"solo-" stringByAppendingString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]]];
    NSString *soloPath = (NSString *)[stem stringByAppendingString:@".png"];
    NSString *groupStem = (NSString *)[dir stringByAppendingPathComponent:(NSString *)[@"group-" stringByAppendingString:(NSString *)[[NSNumber numberWithUnsignedLong:index] stringValue]]];
    NSString *groupPath = (NSString *)[groupStem stringByAppendingString:@".png"];
    NSArray *sublayers = (NSArray *)[[layer sublayers] copy];
    NSMutableArray *wereVisible = (NSMutableArray *)[NSMutableArray array];
    for (CALayer *sublayer in sublayers) {
      if (![sublayer isHidden]) {
        [sublayer setHidden:YES];
        [wereVisible addObject:sublayer];
      }
    }
    UIGraphicsBeginImageContextWithOptions(size, NO, viewScale);
    [layer renderInContext:(CGContextRef)UIGraphicsGetCurrentContext()];
    UIImage *solo = (UIImage *)UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    for (CALayer *sublayer in wereVisible) {
      [sublayer setHidden:NO];
    }
    NSData *soloData = (NSData *)UIImagePNGRepresentation(solo);
    [soloData writeToFile:soloPath atomically:YES];
    UIGraphicsBeginImageContextWithOptions(size, NO, viewScale);
    [layer renderInContext:(CGContextRef)UIGraphicsGetCurrentContext()];
    UIImage *group = (UIImage *)UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    NSData *groupData = (NSData *)UIImagePNGRepresentation(group);
    [groupData writeToFile:groupPath atomically:YES];
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
  return `po ${body.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ')}`
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
