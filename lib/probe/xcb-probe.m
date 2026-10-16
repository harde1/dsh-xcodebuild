//
// xcb-probe.m — the helper this plugin loads INTO the app under test.
//
// Why it exists: reading a view tree through LLDB means stopping the app, and an app that stops
// every time someone clicks a view is an app that stutters, drops animation frames and loses the
// state that was being looked at. The debugger is only needed ONCE, to `dlopen` this file; after
// that the app answers for itself, from a background thread, while it keeps running.
//
// What it is: one thread, one loopback socket, one JSON object per line. Every op answers with the
// SAME TEXT the LLDB expressions print (`recursiveDescription`, `S <addr> bg=…`, `MASK …`, `I <addr>
// <base64>`), so the host parses a probe answer with the parsers it already has — nothing is
// duplicated in a second format, and the two paths can be compared against each other.
//
// Three rules this file is written to:
//
//   * UIKit is touched on the MAIN thread only, so every op hops there with `dispatch_sync`. The
//     app is blocked for the length of one read (a tree is ~20 ms) and never for the length of a
//     debugger stop (an attach is 4–20 s), which is the whole point.
//   * Nothing may crash the app. An op is wrapped in @try/@catch, and an address is resolved by
//     WALKING the window rather than dereferenced: a view the app has since replaced answers
//     "gone" instead of messaging freed memory.
//   * Nothing may hang the app. A request that cannot be answered is an error reply, never a wait.
//
// Built and injected by lib/probe.js; spoken to by lib/probe-link.js.
//
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <arpa/inet.h>
#import <netinet/in.h>
#import <sys/socket.h>
#import <unistd.h>

/** Longest request line accepted, and longest reply sent. A tree of a huge app is ~1 MB. */
static const NSUInteger XCB_MAX_LINE = 8u * 1024u * 1024u;

static int xcbListenFD = -1;
static int xcbPort = 0;
static BOOL xcbStopping = NO;

#pragma mark - the app, read the way this plugin reads it

/** The first window of the app — the same one `VIEW_HIERARCHY_EXPRESSION` dumps. Main thread only. */
static UIView *xcbRoot(void) {
  id application = [(id)NSClassFromString(@"UIApplication") performSelector:@selector(sharedApplication)];
  NSArray *windows = [application valueForKey:@"windows"];
  return [windows isKindOfClass:[NSArray class]] && windows.count > 0 ? (UIView *)windows[0] : nil;
}

/** A private selector's string answer, or nil — the cast keeps ARC quiet about unknown selectors. */
static NSString *xcbString(id object, NSString *selectorName) {
  SEL selector = NSSelectorFromString(selectorName);
  if (object == nil || ![object respondsToSelector:selector]) return nil;
  id (*send)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
  id value = send(object, selector);
  return [value isKindOfClass:[NSString class]] ? (NSString *)value : nil;
}

/**
 * Every view in the first window, depth first, in `recursiveDescription` order.
 *
 * A walk rather than a dereference of an address from an earlier read: between one read and the
 * next the app runs, views come and go, and a stale address is freed memory.
 */
static NSArray<UIView *> *xcbWalk(void) {
  UIView *root = xcbRoot();
  if (root == nil) return @[];
  NSMutableArray<UIView *> *ordered = [NSMutableArray array];
  NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:root];
  while (stack.count > 0) {
    UIView *view = stack.lastObject;
    [stack removeLastObject];
    [ordered addObject:view];
    NSArray *children = view.subviews;
    for (NSInteger index = (NSInteger)children.count - 1; index >= 0; index -= 1) {
      [stack addObject:children[(NSUInteger)index]];
    }
  }
  return ordered;
}

/** The view at one address, or nil when the walk no longer finds it. */
static UIView *xcbFind(NSString *address) {
  if (![address isKindOfClass:[NSString class]] || ![address hasPrefix:@"0x"]) return nil;
  uintptr_t wanted = (uintptr_t)strtoull(address.UTF8String, NULL, 16);
  if (wanted == 0) return nil;
  for (UIView *view in xcbWalk()) {
    if ((uintptr_t)(__bridge void *)view == wanted) return view;
  }
  return nil;
}

/** `r,g,b,a` for a colour resolved in the given traits, or nil when it cannot be resolved. */
static NSString *xcbColour(UIColor *colour, UITraitCollection *traits) {
  if (![colour isKindOfClass:[UIColor class]]) return nil;
  if ([colour respondsToSelector:@selector(resolvedColorWithTraitCollection:)]) {
    colour = [colour resolvedColorWithTraitCollection:traits];
  }
  CGFloat red = 0, green = 0, blue = 0, alpha = 0;
  if (![colour getRed:&red green:&green blue:&blue alpha:&alpha]) return nil;
  return [NSString stringWithFormat:@"%g,%g,%g,%g", (double)red, (double)green, (double)blue, (double)alpha];
}

/** The `S <decimal address> key=value …` lines the canvas reads. Main thread only. */
static NSString *xcbStyles(void) {
  NSMutableString *out = [NSMutableString string];
  for (UIView *view in xcbWalk()) {
    CALayer *layer = view.layer;
    [out appendFormat:@"S %llu", (unsigned long long)(uintptr_t)(__bridge void *)view];
    NSString *background = xcbColour(view.backgroundColor, view.traitCollection);
    if (background != nil) [out appendFormat:@" bg=%@", background];
    [out appendFormat:@" op=%g", (double)view.alpha];
    if (layer.cornerRadius > 0) [out appendFormat:@" cr=%g", (double)layer.cornerRadius];
    if (layer.borderWidth > 0) {
      [out appendFormat:@" bw=%g", (double)layer.borderWidth];
      NSString *border = layer.borderColor == NULL
        ? nil
        : xcbColour([UIColor colorWithCGColor:layer.borderColor], view.traitCollection);
      if (border != nil) [out appendFormat:@" bc=%@", border];
    }
    if (view.clipsToBounds) [out appendString:@" cl=1"];
    if (layer.contents != NULL) [out appendString:@" ct=1"];
    if ([view isKindOfClass:[UIImageView class]] && ((UIImageView *)view).image != nil) {
      [out appendFormat:@" img=1 im=%llu", (unsigned long long)(uintptr_t)(__bridge void *)((UIImageView *)view).image];
      NSString *tint = xcbColour(view.tintColor, view.traitCollection);
      if (tint != nil) [out appendFormat:@" tc=%@", tint];
    }
    if ([view respondsToSelector:@selector(textColor)] && [view respondsToSelector:@selector(font)]) {
      NSString *foreground = xcbColour([view valueForKey:@"textColor"], view.traitCollection);
      if (foreground != nil) [out appendFormat:@" fg=%@", foreground];
      UIFont *font = [view valueForKey:@"font"];
      if ([font isKindOfClass:[UIFont class]]) {
        [out appendFormat:@" fs=%g", (double)font.pointSize];
        NSString *name = font.fontName;
        if ([name containsString:@"Bold"] || [name containsString:@"Semibold"] || [name containsString:@"Heavy"]) {
          [out appendString:@" fb=1"];
        }
      }
      if ([view respondsToSelector:@selector(textAlignment)]) {
        id alignment = [view valueForKey:@"textAlignment"];
        if ([alignment respondsToSelector:@selector(integerValue)]) {
          [out appendFormat:@" ta=%ld", (long)[alignment integerValue]];
        }
      }
    }
    [out appendString:@"\n"];
  }
  return out;
}

/**
 * The layout report: `MASK`, `AMBIGUOUS`, `INTRINSIC`, `HUG`, `RESIST`, then the constraints the
 * view owns and the ones that place it (which live on an ancestor).
 *
 * Written as Objective-C rather than as an LLDB expression on purpose: the expression had to avoid
 * `CGFloat`, variadic calls and fast enumeration because the evaluator has no headers, and every one
 * of those restrictions disappears in code the compiler is allowed to see.
 */
static NSString *xcbLayout(UIView *view) {
  NSMutableString *out = [NSMutableString string];
  [out appendFormat:@"MASK %d\n", view.translatesAutoresizingMaskIntoConstraints ? 1 : 0];
  [out appendFormat:@"AMBIGUOUS %d\n", view.hasAmbiguousLayout ? 1 : 0];
  CGSize intrinsic = view.intrinsicContentSize;
  [out appendFormat:@"INTRINSIC %g %g\n", (double)intrinsic.width, (double)intrinsic.height];
  [out appendFormat:@"HUG %g %g\n",
    (double)[view contentHuggingPriorityForAxis:UILayoutConstraintAxisHorizontal],
    (double)[view contentHuggingPriorityForAxis:UILayoutConstraintAxisVertical]];
  [out appendFormat:@"RESIST %g %g\n",
    (double)[view contentCompressionResistancePriorityForAxis:UILayoutConstraintAxisHorizontal],
    (double)[view contentCompressionResistancePriorityForAxis:UILayoutConstraintAxisVertical]];
  NSArray<NSLayoutConstraint *> *own = view.constraints;
  [out appendFormat:@"OWN %lu\n", (unsigned long)own.count];
  for (NSLayoutConstraint *constraint in own) [out appendFormat:@"C %@\n", constraint.description];
  NSMutableArray<NSLayoutConstraint *> *referencing = [NSMutableArray array];
  for (UIView *node = view.superview; node != nil; node = node.superview) {
    for (NSLayoutConstraint *constraint in node.constraints) {
      if (constraint.firstItem == view || constraint.secondItem == view) [referencing addObject:constraint];
    }
  }
  [out appendFormat:@"REF %lu\n", (unsigned long)referencing.count];
  for (NSLayoutConstraint *constraint in referencing) [out appendFormat:@"C %@\n", constraint.description];
  return out;
}

/**
 * One view rendered ALONE and printed as `I <decimal address> <base64 png>`.
 *
 * The sublayers are hidden for the render and put back, which is what makes it the control's own
 * pixels rather than the control with its children (Lookin's "solo" image). Views too large for a
 * bitmap context are skipped, exactly as the expression skipped them.
 */
static NSString *xcbImage(UIView *view, double maxPixels) {
  CGSize size = view.bounds.size;
  if (size.width <= 0 || size.height <= 0 || size.width > 20000 || size.height > 20000) return nil;
  CGFloat scale = UIScreen.mainScreen.scale;
  CGFloat longest = MAX(size.width, size.height);
  if (maxPixels > 0 && longest * scale > maxPixels) scale = (CGFloat)(maxPixels / longest);
  size_t width = (size_t)(size.width * scale + 0.5);
  size_t height = (size_t)(size.height * scale + 0.5);
  if (width == 0 || height == 0) return nil;
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, space,
    (CGBitmapInfo)(kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little));
  CGColorSpaceRelease(space);
  if (context == NULL) return nil;
  NSMutableArray<CALayer *> *hidden = [NSMutableArray array];
  for (CALayer *sublayer in view.layer.sublayers) {
    if (!sublayer.hidden) {
      sublayer.hidden = YES;
      [hidden addObject:sublayer];
    }
  }
  CGContextTranslateCTM(context, 0, (CGFloat)height);
  CGContextScaleCTM(context, scale, -scale);
  [view.layer renderInContext:context];
  CGImageRef image = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  for (CALayer *sublayer in hidden) sublayer.hidden = NO;
  if (image == NULL) return nil;
  UIImage *rendered = [UIImage imageWithCGImage:image];
  CGImageRelease(image);
  NSData *png = UIImagePNGRepresentation(rendered);
  if (png == nil) return nil;
  return [NSString stringWithFormat:@"I %llu %@", (unsigned long long)(uintptr_t)(__bridge void *)view,
    [png base64EncodedStringWithOptions:0]];
}

/** `SCREEN <width> <height> <scale>` then one `CHAIN A,B,NSObject` line per class asked about. */
static NSString *xcbFacts(NSArray *classNames) {
  CGSize size = UIScreen.mainScreen.bounds.size;
  NSMutableString *out = [NSMutableString stringWithFormat:@"SCREEN %g %g %g\n",
    (double)size.width, (double)size.height, (double)UIScreen.mainScreen.scale];
  for (id wanted in classNames) {
    if (![wanted isKindOfClass:[NSString class]]) continue;
    NSMutableArray<NSString *> *chain = [NSMutableArray array];
    for (Class klass = NSClassFromString(wanted); klass != Nil; klass = class_getSuperclass(klass)) {
      [chain addObject:NSStringFromClass(klass)];
    }
    [out appendFormat:@"CHAIN %@\n", [chain componentsJoinedByString:@","]];
  }
  return out;
}

/** The boxed value for one edit, by kind — the same kinds `editExpression` accepts. */
static id xcbValue(NSString *kind, id value) {
  if ([kind isEqualToString:@"bool"]) return @([value boolValue]);
  if ([kind isEqualToString:@"number"]) return @([value doubleValue]);
  if ([kind isEqualToString:@"text"]) return [value isKindOfClass:[NSString class]] ? value : [value description];
  if ([kind isEqualToString:@"color"]) {
    NSArray *parts = [value isKindOfClass:[NSArray class]] ? value : nil;
    if (parts.count != 4) return nil;
    return [UIColor colorWithRed:[parts[0] doubleValue] green:[parts[1] doubleValue]
      blue:[parts[2] doubleValue] alpha:[parts[3] doubleValue]];
  }
  if ([kind isEqualToString:@"rect"] || [kind isEqualToString:@"point"]
    || [kind isEqualToString:@"size"] || [kind isEqualToString:@"insets"]) {
    NSArray *parts = [value isKindOfClass:[NSArray class]] ? value : nil;
    if (parts.count != 2 && parts.count != 4) return nil;
    double a = [parts[0] doubleValue], b = [parts[1] doubleValue];
    double c = parts.count == 4 ? [parts[2] doubleValue] : 0;
    double d = parts.count == 4 ? [parts[3] doubleValue] : 0;
    if ([kind isEqualToString:@"rect"]) return [NSValue valueWithCGRect:CGRectMake(a, b, c, d)];
    if ([kind isEqualToString:@"point"]) return [NSValue valueWithCGPoint:CGPointMake(a, b)];
    if ([kind isEqualToString:@"size"]) return [NSValue valueWithCGSize:CGSizeMake(a, b)];
    return [NSValue valueWithUIEdgeInsets:UIEdgeInsetsMake(a, b, c, d)];
  }
  return nil;
}

#pragma mark - the protocol

/**
 * One request, on the main thread, answered as a dictionary.
 *
 * Ops answer with the text the LLDB expressions print, so the host reuses its parsers:
 * `tree` (recursiveDescription), `style` (`S …`), `attr` (_ivarDescription), `layout` (`MASK …`),
 * `images` (`I …`), `facts` (`SCREEN`/`CHAIN`), `edit`, `info`, `bye`, `ping`.
 */
static NSDictionary *xcbHandle(NSDictionary *request) {
  NSString *op = [request[@"op"] isKindOfClass:[NSString class]] ? request[@"op"] : @"";
  @try {
    if ([op isEqualToString:@"ping"]) {
      return @{ @"ok": @1, @"version": @1, @"pid": @(getpid()), @"port": @(xcbPort),
        @"bundle": NSBundle.mainBundle.bundleIdentifier ?: @"" };
    }
    if ([op isEqualToString:@"bye"]) {
      xcbStopping = YES;
      if (xcbListenFD >= 0) { close(xcbListenFD); xcbListenFD = -1; }
      return @{ @"ok": @1 };
    }
    if ([op isEqualToString:@"tree"]) {
      UIView *root = xcbRoot();
      if (root == nil) return @{ @"ok": @0, @"note": @"the app has no window yet" };
      NSString *text = xcbString(root, @"recursiveDescription");
      if (text == nil) return @{ @"ok": @0, @"note": @"this app does not answer recursiveDescription" };
      return @{ @"ok": @1, @"text": text };
    }
    if ([op isEqualToString:@"style"]) return @{ @"ok": @1, @"text": xcbStyles() };
    if ([op isEqualToString:@"facts"]) {
      return @{ @"ok": @1, @"text": xcbFacts([request[@"classes"] isKindOfClass:[NSArray class]] ? request[@"classes"] : @[]) };
    }
    if ([op isEqualToString:@"attr"]) {
      UIView *view = xcbFind(request[@"address"]);
      if (view == nil) return @{ @"ok": @0, @"note": @"that view is not in the window any more" };
      NSString *text = xcbString(view, @"_ivarDescription");
      if (text == nil) return @{ @"ok": @0, @"note": @"this object does not answer _ivarDescription" };
      return @{ @"ok": @1, @"text": text };
    }
    if ([op isEqualToString:@"layout"]) {
      UIView *view = xcbFind(request[@"address"]);
      if (view == nil) return @{ @"ok": @0, @"note": @"that view is not in the window any more" };
      return @{ @"ok": @1, @"text": xcbLayout(view) };
    }
    if ([op isEqualToString:@"images"]) {
      NSMutableString *out = [NSMutableString string];
      double maxPixels = [request[@"max"] isKindOfClass:[NSNumber class]] ? [request[@"max"] doubleValue] : 360;
      NSArray *addresses = [request[@"addresses"] isKindOfClass:[NSArray class]] ? request[@"addresses"] : @[];
      for (NSString *address in addresses) {
        UIView *view = xcbFind(address);
        if (view == nil) continue;
        NSString *line = xcbImage(view, maxPixels);
        if (line != nil) [out appendFormat:@"%@\n", line];
      }
      return @{ @"ok": @1, @"text": out };
    }
    if ([op isEqualToString:@"edit"]) {
      UIView *view = xcbFind(request[@"address"]);
      if (view == nil) return @{ @"ok": @0, @"note": @"that view is not in the window any more" };
      NSString *key = [request[@"key"] isKindOfClass:[NSString class]] ? request[@"key"] : @"";
      id value = xcbValue([request[@"kind"] isKindOfClass:[NSString class]] ? request[@"kind"] : @"", request[@"value"]);
      if (key.length == 0 || value == nil) return @{ @"ok": @0, @"note": @"that value is not one this plugin can set" };
      [view setValue:value forKey:key];
      [CATransaction flush];
      id after = [view valueForKey:key];
      return @{ @"ok": @1, @"value": [after isKindOfClass:[NSString class]] ? after : [after description] ?: @"" };
    }
    return @{ @"ok": @0, @"note": [NSString stringWithFormat:@"no such op: %@", op] };
  } @catch (NSException *exception) {
    // The app's own code runs inside these calls (`hasAmbiguousLayout`, a getter, a render), so an
    // exception is an answer about the view, not a reason to take the app down with the read.
    return @{ @"ok": @0, @"note": [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @""] };
  }
}

/** Write every byte of `data`, or give up on a peer that stopped reading. */
static void xcbSend(int fd, NSData *data) {
  const uint8_t *bytes = data.bytes;
  size_t left = data.length;
  while (left > 0) {
    ssize_t written = send(fd, bytes, left, 0);
    if (written <= 0) return;
    bytes += written;
    left -= (size_t)written;
  }
}

/** Read one `\n`-terminated line. Returns nil on EOF, oversize input or error. */
static NSData *xcbReadLine(int fd) {
  NSMutableData *buffer = [NSMutableData data];
  uint8_t chunk[4096];
  while (buffer.length < XCB_MAX_LINE) {
    ssize_t got = recv(fd, chunk, sizeof(chunk), 0);
    if (got <= 0) return buffer.length == 0 ? nil : buffer;
    [buffer appendBytes:chunk length:(NSUInteger)got];
    NSRange newline = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
      options:0 range:NSMakeRange(0, buffer.length)];
    if (newline.location != NSNotFound) return [buffer subdataWithRange:NSMakeRange(0, newline.location)];
  }
  return nil;
}

/** One connection: one line in, one line out, then close. */
static void xcbServe(int fd) {
  NSData *line = xcbReadLine(fd);
  if (line == nil) { close(fd); return; }
  NSDictionary *request = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
  if ([parsed isKindOfClass:[NSDictionary class]]) request = parsed;
  // Every UIKit call the op makes has to be on the main thread, and the answer comes back here.
  // A debugger holding the process stopped freezes this hop as well, which is why the host gives a
  // request a deadline and falls back to reading through the debugger when it expires.
  __block NSDictionary *reply = nil;
  if (request == nil) {
    reply = @{ @"ok": @0, @"note": @"the request was not a JSON object" };
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{ reply = xcbHandle(request); });
  }
  NSData *body = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
  NSMutableData *out = [NSMutableData dataWithData:body ?: [NSData data]];
  [out appendBytes:"\n" length:1];
  xcbSend(fd, out);
  close(fd);
}

/** The loopback listener, on its own thread, for as long as the app lives. */
static void xcbAcceptLoop(void) {
  while (!xcbStopping && xcbListenFD >= 0) {
    int fd = accept(xcbListenFD, NULL, NULL);
    if (fd < 0) {
      if (xcbStopping) break;
      continue;
    }
    struct timeval timeout = { 30, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    xcbServe(fd);
  }
}

/**
 * Start listening, and return the port actually used — `0` asks for any free one.
 *
 * Called by the debugger right after `dlopen`, which is the only time the app is stopped. Calling it
 * twice is not an error: the second call answers with the port the first one chose.
 */
int xcb_probe_start(int port) {
  if (xcbListenFD >= 0) return xcbPort;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int yes = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  // Loopback only: on a device this is reached through a forwarded port, on a simulator directly,
  // and in neither case is there a reason to accept a connection from the network the phone is on.
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return -1; }
  if (listen(fd, 8) != 0) { close(fd); return -1; }
  if (port == 0) {
    socklen_t length = sizeof(address);
    if (getsockname(fd, (struct sockaddr *)&address, &length) != 0) { close(fd); return -1; }
  }
  xcbListenFD = fd;
  xcbPort = ntohs(address.sin_port);
  xcbStopping = NO;
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{ xcbAcceptLoop(); });
  return xcbPort;
}
