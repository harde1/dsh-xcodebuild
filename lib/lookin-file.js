// Turn the view records LLDB printed into the archive Lookin.app opens.
//
// Lookin's file is an NSKeyedArchiver binary plist of a `LookinHierarchyFile`:
//   LookinHierarchyFile { serverVersion, hierarchyInfo, soloScreenshots, groupScreenshots }
//   LookinHierarchyInfo { displayItems, colorAlias, collapsedClassList, appInfo, serverVersion }
//   LookinDisplayItem   { hidden, alpha, frame, bounds, viewObject, layerObject, subitems, … }
//   LookinObject        { oid, memoryAddress, classChainList, ivarTraces, specialTrace }
//
// Neither the keys nor the value encodings here are guesses. The keys come from
// `LookinServer/Src/Main/Shared/LookinDisplayItem.m -encodeWithCoder:`, and a simulator run
// of the real UIKit showed what `encodeCGRect:forKey:` actually writes: the STRING
// `{{12, 55}, {366, 747}}`, with numbers and booleans inline and every string and array
// reachable only through the archive's object table.
//
// This module is deliberately pure: it maps records to a graph and a graph to text. Writing
// the bytes, running `plutil` and opening Lookin all belong to the host half, which is what
// keeps this file testable without a device.
import { buildViewTree } from './view-hierarchy.js'

/** The LookinServer protocol version whose file format this writes. */
export const LOOKIN_SERVER_VERSION = 7

/**
 * Two of Lookin's classes do not archive under their property names.
 *
 * `-encodeWithCoder:` in `LookinHierarchyInfo.m` and `LookinAppInfo.m` encodes these fields
 * under the strings "1".."8" (the constants are right there in the source), while every other
 * class uses its property names. The difference is invisible until a real decoder runs: a file
 * written with the property names decodes to the right CLASS and the right `serverVersion`
 * with a null `hierarchyInfo` payload, which in Lookin.app is a window that opens and shows
 * nothing. Measured by decoding our own file with Lookin.app's LookinShared.framework.
 */
const INFO_KEYS = { displayItems: '1', appInfo: '2', colorAlias: '3', collapsedClassList: '4' }
const APP_INFO_KEYS = {
  appIcon: '1',
  screenshot: '2',
  deviceDescription: '3',
  osDescription: '4',
  appName: '5',
  screenWidth: '6',
  screenHeight: '7',
  deviceType: '8',
}

/**
 * `NSStringFromCGRect`-shaped text, which is what `CGRectFromString` (and so Lookin) reads.
 *
 * Three decimals is well inside a device pixel and keeps the file readable.
 */
function rectString(x, y, width, height) {
  const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0')
  return `{{${num(x)}, ${num(y)}}, {${num(width)}, ${num(height)}}}`
}

/**
 * A number Lookin reads with `decodeDoubleForKey:`.
 *
 * It must reach the plist as a REAL. An integer-valued double written as `<integer>` makes
 * NSKeyedUnarchiver answer `value for key (alpha) is not a 64-bit float` and abandon the whole
 * object — measured by decoding our own file with Lookin.app's own classes, where `alpha: 1` as
 * an integer lost every field of the node and `1.0` kept all of them. In Lookin.app that is the
 * difference between a tree and a window that opens empty.
 */
function real(value) {
  return { $real: Number.isFinite(value) ? value : 0 }
}

/**
 * A whole number that has to be an OBJECT in the archive rather than an inline value.
 *
 * The screenshot dictionaries are keyed by oid, and a dictionary's keys are objects: the real
 * files hold them as bare numbers in `$objects` that the arrays reference by UID, which
 * NSKeyedUnarchiver reads back as NSNumber.
 */
function numberObject(value) {
  return { $number: Number.isFinite(value) ? value : 0 }
}

/**
 * PNG bytes, interned by identity.
 *
 * One crop can be referenced twice (a node's solo and group image, and the dictionary entry),
 * and a real capture of a 130-node tree is tens of megabytes of image data: writing the same
 * buffer once per reference would multiply the file for nothing. Marking the buffer rather than
 * the reference is what lets the archive writer dedupe it.
 */
const imageInterner = new WeakMap()
function imageBytes(buffer) {
  let mark = imageInterner.get(buffer)
  if (mark === undefined) {
    mark = { $data: buffer }
    imageInterner.set(buffer, mark)
  }
  return mark
}

/** The runtime id Lookin keys a node's details by. The address LLDB printed is exactly that. */
export function oidFromAddress(address) {
  const digits = /^0x([0-9a-fA-F]+)$/.exec(String(address ?? ''))
  if (digits === null) return 0
  const value = Number.parseInt(digits[1], 16)
  return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : 0
}

/** A class chain: what was probed for this class, else the class and its printed base class. */
function classChainFor(node, chains) {
  const probed = chains[node.className]
  if (Array.isArray(probed) && probed.length > 0) return probed
  const base = typeof node.baseClass === 'string' && node.baseClass !== '' && node.baseClass !== node.className ? [node.baseClass] : []
  return [node.className, ...base]
}

function lookinObject(node, chains) {
  return {
    $class: 'LookinObject',
    oid: oidFromAddress(node.address),
    memoryAddress: String(node.address ?? ''),
    classChainList: classChainFor(node, chains),
    ivarTraces: null,
    specialTrace: null,
  }
}

function displayItem(node, chains, images) {
  const frame = node.frame ?? {}
  const x = Number.isFinite(frame.x) ? frame.x : 0
  const y = Number.isFinite(frame.y) ? frame.y : 0
  const width = Number.isFinite(frame.width) ? frame.width : 0
  const height = Number.isFinite(frame.height) ? frame.height : 0
  const rendered = (images ?? {})[String(oidFromAddress(node.address))] ?? {}
  const solo = rendered.solo === undefined ? null : imageBytes(rendered.solo)
  const group = rendered.group === undefined ? null : imageBytes(rendered.group)
  return {
    $class: 'LookinDisplayItem',
    customInfo: null,
    subitems: (node.children ?? []).map((child) => displayItem(child, chains, images)),
    hidden: node.hidden === true,
    alpha: real(Number.isFinite(node.alpha) ? node.alpha : 1),
    viewObject: lookinObject(node, chains),
    // Left nil on purpose: recursiveDescription names the VIEW's class and says nothing about
    // its layer, and a layer object invented from the view's chain is a lie Lookin would show.
    layerObject: null,
    hostViewControllerObject: null,
    attributesGroupList: null,
    customAttrGroupList: null,
    representedAsKeyWindow: false,
    eventHandlers: null,
    shouldCaptureImage: true,
    // 1 is LookinDisplayItemImageEncodeTypeNSData; 0 is "no image encoded".
    screenshotEncodeType: solo === null && group === null ? 0 : 1,
    // Rendered inside the app, exactly like LookinServer's own two images: `solo` is the control
    // on its own (its sublayers hidden while it is drawn) and `group` is the control with its
    // subtree. A crop of a flat screenshot can be neither.
    soloScreenshot: solo,
    groupScreenshot: group,
    customDisplayTitle: typeof node.text === 'string' && node.text !== '' ? node.text : null,
    danceuiSource: null,
    // SUPERVIEW-relative, exactly as printed — NOT accumulated to the window. LookinServer
    // stores `layer.frame` and converts to window coordinates only to sanity-check it
    // (`LKS_HierarchyDisplayItemsMaker`), and a real capture proves the client expects that
    // same space: it holds a view at x = 66528, which is a scroll view's content coordinate
    // and impossible as a window coordinate in a 390-wide window.
    frame: rectString(x, y, width, height),
    bounds: rectString(0, 0, width, height),
    backgroundColor: null,
  }
}

function appInfoFor(app) {
  const text = (value) => (typeof value === 'string' ? value : '')
  const number = (value) => (Number.isFinite(value) ? value : 0)
  return {
    $class: 'LookinAppInfo',
    appInfoIdentifier: 1,
    shouldUseCache: false,
    serverVersion: LOOKIN_SERVER_VERSION,
    // Where the file came from, in the field Lookin shows as the server's version.
    serverReadableVersion: 'dsh-xcodebuild',
    swiftEnabledInLookinServer: 0,
    [APP_INFO_KEYS.screenshot]: null,
    [APP_INFO_KEYS.appIcon]: null,
    [APP_INFO_KEYS.appName]: text(app.appName),
    appBundleIdentifier: text(app.appBundleIdentifier),
    [APP_INFO_KEYS.deviceDescription]: text(app.deviceDescription),
    [APP_INFO_KEYS.osDescription]: text(app.osDescription),
    osMainVersion: number(app.osMainVersion),
    [APP_INFO_KEYS.deviceType]: 0,
    [APP_INFO_KEYS.screenWidth]: real(number(app.screenWidth)),
    [APP_INFO_KEYS.screenHeight]: real(number(app.screenHeight)),
    screenScale: real(number(app.screenScale)),
  }
}

/**
 * Build the object graph one `.lookin` file holds.
 *
 * @param {Array<object>} records - from `parseViewHierarchy`, in printed order.
 * @param {object} [options] - `appInfo` (the strings and numbers Lookin shows in its header)
 *   and `classChains` (a `className -> string[]` map the caller probed over the debugger).
 * @returns {object} the `LookinHierarchyFile` graph.
 */
export function buildLookinFile(records, options = {}) {
  const chains = options.classChains ?? {}
  const images = options.images ?? {}
  const tree = buildViewTree(records)
  // Keyed by oid, in the same order the tree walks, so a file's dictionaries line up with its
  // items. Both dictionaries hold the same crops: see the note on soloScreenshot.
  const soloShots = new Map()
  const groupShots = new Map()
  for (const node of flattenByOid(tree)) {
    const rendered = images[String(node.oid)]
    if (rendered === undefined || soloShots.has(node.oid)) continue
    if (rendered.solo !== undefined) soloShots.set(node.oid, imageBytes(rendered.solo))
    if (rendered.group !== undefined) groupShots.set(node.oid, imageBytes(rendered.group))
  }
  return {
    $class: 'LookinHierarchyFile',
    serverVersion: LOOKIN_SERVER_VERSION,
    hierarchyInfo: {
      $class: 'LookinHierarchyInfo',
      [INFO_KEYS.displayItems]: tree.map((node) => displayItem(node, chains, images)),
      [INFO_KEYS.colorAlias]: {},
      [INFO_KEYS.collapsedClassList]: [],
      [INFO_KEYS.appInfo]: appInfoFor(options.appInfo ?? {}),
      serverVersion: LOOKIN_SERVER_VERSION,
    },
    soloScreenshots: screenshotDictionary(soloShots),
    groupScreenshots: screenshotDictionary(groupShots),
  }
}

/** Every view in the tree with the oid its record carries, in printed order. */
function flattenByOid(tree) {
  const flat = []
  const walk = (nodes) => {
    for (const node of nodes) {
      flat.push({ oid: oidFromAddress(node.address) })
      walk(node.children ?? [])
    }
  }
  walk(tree)
  return flat
}

/**
 * The `oid -> PNG` dictionary Lookin looks a node's image up in.
 *
 * A plain object here rather than an NSArray entry: the archive's own encoders (and the files
 * that open in Lookin.app) store it as `NS.keys`/`NS.objects`, two plist arrays of objects,
 * with the oids as numbers and the images as data.
 */
function screenshotDictionary(shots) {
  if (shots.size === 0) return null
  return {
    $class: 'NSDictionary',
    'NS.keys': { $inline: [...shots.keys()].map(numberObject) },
    'NS.objects': { $inline: [...shots.values()] },
  }
}

/**
 * Where each node sits on the screen, in the device's points.
 *
 * Frames in the file are superview-relative, exactly as LLDB prints them, so cropping an
 * image needs this walk to know where a node actually is. Kept out of the items on purpose:
 * this is a cropper's coordinate, not something Lookin reads.
 *
 * @param {Array<object>} records - from `parseViewHierarchy`.
 * @returns {Array<{oid: number, address: string, className: string, frame: object}>}
 */
export function absoluteFrames(records) {
  const out = []
  const walk = (nodes, originX, originY) => {
    for (const node of nodes) {
      const frame = node.frame ?? {}
      const width = Number.isFinite(frame.width) ? frame.width : 0
      const height = Number.isFinite(frame.height) ? frame.height : 0
      const x = originX + (Number.isFinite(frame.x) ? frame.x : 0)
      const y = originY + (Number.isFinite(frame.y) ? frame.y : 0)
      out.push({ oid: oidFromAddress(node.address), address: String(node.address ?? ''), className: node.className, frame: { x, y, width, height } })
      walk(node.children ?? [], x, y)
    }
  }
  walk(buildViewTree(records), 0, 0)
  return out
}

/** XML-escape a plist string the way an XML plist needs it. */
function xmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render one plist value. `{$uid: n}` is a reference into the archive's object table. */
function plistValue(value) {
  if (value === null || value === undefined) return '<string>$null</string>'
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`
  if (typeof value === 'string') return `<string>${xmlText(value)}</string>`
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`
  if (typeof value.$real === 'number') return `<real>${value.$real}</real>`
  // Both the marker (before `encode` unwraps it) and the raw buffer that lands in `$objects`.
  if (Buffer.isBuffer(value)) return `<data>${value.toString('base64')}</data>`
  if (Buffer.isBuffer(value.$data)) return `<data>${value.$data.toString('base64')}</data>`
  if (Number.isInteger(value.$uid)) return `<dict><key>CF$UID</key><integer>${value.$uid}</integer></dict>`
  if (Array.isArray(value.$inline)) return `<array>${value.$inline.map(plistValue).join('')}</array>`
  const entries = Object.entries(value).map(([key, part]) => `<key>${xmlText(key)}</key>${plistValue(part)}`)
  return `<dict>${entries.join('')}</dict>`
}

/**
 * Serialize the graph as the XML plist that `plutil -convert binary1` turns into a `.lookin`.
 *
 * The archive is written in NSKeyedArchiver's shape: `$objects` is the object table, every
 * string and array becomes an entry in it (that is what `encodeObject:forKey:` does), a
 * class is named once by a descriptor object that its instances point at, and primitives
 * stay inline because `encodeFloat:forKey:` and `encodeBool:forKey:` write no object.
 *
 * Writing XML and converting with `plutil` is deliberate: a binary plist writer is a hundred
 * lines of byte offsets for no gain, and `plutil` ships with macOS. The conversion was
 * checked to preserve UID references rather than flattening them into dictionaries.
 *
 * @param {object} file - from `buildLookinFile`.
 * @returns {string} XML plist text.
 */
export function toArchiveXml(file) {
  const objects = ['$null']
  const classIndexes = new Map()
  const stringIndexes = new Map()
  // Markers that stand for one non-string object: reachable twice, written once.
  const objectIndexes = new Map()

  const classRef = (name) => {
    if (!classIndexes.has(name)) {
      classIndexes.set(name, objects.length)
      objects.push({ $classname: name, $classes: [name, 'NSObject'] })
    }
    return { $uid: classIndexes.get(name) }
  }
  const stringRef = (text) => {
    if (!stringIndexes.has(text)) {
      stringIndexes.set(text, objects.length)
      objects.push(text)
    }
    return { $uid: stringIndexes.get(text) }
  }
  const encode = (value) => {
    if (value === null || value === undefined) return { $uid: 0 }
    if (typeof value === 'string') return stringRef(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    // A `real` marker stays inline: `encodeFloat:forKey:` writes no object.
    if (typeof value.$real === 'number') return value
    // A number that has to BE an object (a dictionary key) becomes one entry in the table.
    if (typeof value.$number === 'number') {
      objects.push(value.$number)
      return { $uid: objects.length - 1 }
    }
    // An array as a PLIST array rather than an NSArray object. NSDictionary's own decoder reads
    // `NS.keys`/`NS.objects` this way and refuses the object form outright — "value for key
    // (NS.objects) is not an array" — while every other array in the file is an NSArray object.
    if (Array.isArray(value.$inline)) return { $inline: value.$inline.map(encode) }
    // Image data is an object like any other; the marker is shared by identity, so the same
    // buffer reached twice is written once.
    if (Buffer.isBuffer(value.$data)) {
      if (!objectIndexes.has(value)) {
        objects.push(value.$data)
        objectIndexes.set(value, objects.length - 1)
      }
      return { $uid: objectIndexes.get(value) }
    }
    if (Array.isArray(value)) {
      objects.push({ $class: classRef('NSArray'), 'NS.objects': value.map(encode) })
      return { $uid: objects.length - 1 }
    }
    const body = { $class: classRef(typeof value.$class === 'string' ? value.$class : 'NSDictionary') }
    for (const [key, part] of Object.entries(value)) {
      if (key !== '$class') body[key] = encode(part)
    }
    objects.push(body)
    return { $uid: objects.length - 1 }
  }

  const root = encode(file)
  const archive = { $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root }, $objects: objects }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">${plistValue(archive)}</plist>\n`
}

/**
 * A `po` expression that prints one class's whole superclass chain.
 *
 * One expression per distinct class, not per view: a dump holds hundreds of views but a
 * dozen classes. `[c superclass]` rather than `class_getSuperclass` so the expression needs
 * no runtime header, and the walk ends at nil because NSObject's superclass is nil.
 *
 * @param {string} className - as LLDB printed it.
 * @returns {string} the command to send.
 */
export function classChainExpression(className) {
  const name = String(className ?? '').replace(/["\\]/g, '')
  // The two casts are not decoration. Without them LLDB's expression parser refuses both
  // calls, because the headers are not in scope for an expression:
  //     error: 'NSStringFromClass' has unknown return type; cast the call to its declared return type
  //     error: no known method '-superclass'; cast the message send to the method's return type
  // Measured on a simulator against a live app; `po` then answers
  // `UILabel,UIView,UIResponder,NSObject` for UILabel.
  return 'po (NSString *)({ Class c = NSClassFromString(@"' + name + '"); NSMutableArray *a = [NSMutableArray array];'
    + ' while (c) { [a addObject:(NSString *)NSStringFromClass(c)]; c = (Class)[c superclass]; }'
    + ' [a componentsJoinedByString:@","]; })'
}

/**
 * ONE `po` expression that prints the superclass chain of many classes, and the screen's size.
 *
 * A read stops the app, and what used to keep it stopped was not the tree: it was the questions
 * asked after it — one expression per distinct class (up to 30) and three for the screen, each a
 * round trip to the device while the app sat frozen. They are all asked here at once, so the app is
 * stopped for exactly two expressions (the tree and this) and let go before anything is written.
 *
 * Output, one line each: `SCREEN <width> <height> <scale>`, then `CHAIN <Class>,<Super>,…,NSObject`
 * in the order asked. A class the runtime does not know prints `CHAIN ` with nothing after it, which
 * `parseChainsReport` maps to null, so the answers still line up with the names.
 *
 * The same constraints as every expression here, all measured: no `stringWithFormat:` (variadic, the
 * parser refuses it), casts on every call whose header is not in scope, a single line.
 *
 * @param {string[]} classNames - as LLDB printed them.
 * @returns {string} the command to send.
 */
export function classChainsExpression(classNames) {
  const names = (Array.isArray(classNames) ? classNames : []).map((name) => String(name ?? '').replace(/["\\]/g, ''))
  // Joined into ONE string literal and split again inside the app, rather than
  // `arrayWithObjects:…, nil`: that one is variadic too, which is the shape LLDB's parser refuses.
  const names2 = names.filter((name) => /^[A-Za-z_][\w.]*$/.test(name))
  const list = names2.join(',')
  // Every local is prefixed: an expression's names share a scope with the app's own symbols, and a
  // plain `names` answered `Multiple internal symbols found for 'names'` against a live app.
  // The bounds are read as `NSValue` into four doubles, never as a `CGRect`: a struct may not be a
  // VALUE in an LLDB expression on Xcode 26 (`error: attempt to use a deleted function`), and a
  // declaration whose type the evaluator does not know is dropped outright on a target without
  // headers — which is how a local ends up unresolved and reported as a symbol collision instead.
  return 'po (NSString *)({ NSMutableString *o = [NSMutableString string];'
    + ' NSValue *xcbBounds = (NSValue *)[(id)[UIScreen mainScreen] valueForKey:@"bounds"];'
    + ' double xcbBox[4] = {0, 0, 0, 0}; [xcbBounds getValue:(void *)xcbBox];'
    + ' double xcbScale = (double)[(id)[UIScreen mainScreen] scale];'
    + ' [o appendString:@"SCREEN "]; [o appendString:(NSString *)[(id)[NSNumber numberWithDouble:xcbBox[2]] stringValue]];'
    + ' [o appendString:@" "]; [o appendString:(NSString *)[(id)[NSNumber numberWithDouble:xcbBox[3]] stringValue]];'
    + ' [o appendString:@" "]; [o appendString:(NSString *)[(id)[NSNumber numberWithDouble:xcbScale] stringValue]]; [o appendString:@"\\n"];'
    + ` NSArray *xcbNames = ${list === '' ? '(NSArray *)[NSArray array]' : `(NSArray *)[@"${list}" componentsSeparatedByString:@","]`};`
    + ' for (NSString *xcbName in xcbNames) { [o appendString:@"CHAIN "]; Class c = NSClassFromString(xcbName); NSMutableArray *a = [NSMutableArray array];'
    + ' while (c) { [a addObject:(NSString *)NSStringFromClass(c)]; c = (Class)[c superclass]; }'
    + ' [o appendString:(NSString *)[a componentsJoinedByString:@","]]; [o appendString:@"\\n"]; }'
    + ' o; })'
}

/**
 * Read `classChainsExpression`'s answer back.
 *
 * @param {string} text - the expression's output.
 * @param {string[]} classNames - the names asked about, in the same order.
 * @returns {{screen: {width: number, height: number, scale: number}|null, chains: Object<string, string[]|null>}|null}
 *   null when the answer is not this report at all (an `error:`, an empty answer).
 */
export function parseChainsReport(text, classNames) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim())
  const screenLine = lines.find((line) => line.startsWith('SCREEN '))
  const chainLines = lines.filter((line) => line === 'CHAIN' || line.startsWith('CHAIN '))
  if (screenLine === undefined && chainLines.length === 0) return null
  let screen = null
  if (screenLine !== undefined) {
    const [width, height, scale] = screenLine.slice('SCREEN '.length).split(/\s+/).map(Number)
    if ([width, height, scale].every((value) => Number.isFinite(value) && value > 0)) screen = { width, height, scale }
  }
  // The same filter the expression applied, so answer N still belongs to name N.
  const names = (Array.isArray(classNames) ? classNames : []).filter((name) => /^[A-Za-z_][\w.]*$/.test(String(name ?? '')))
  const chains = {}
  names.forEach((name, index) => {
    const line = chainLines[index]
    chains[name] = line === undefined ? null : parseClassChain(line.slice('CHAIN'.length))
  })
  return { screen, chains }
}

/**
 * Read a chain back, or null when the answer is not a chain.
 *
 * Strict on purpose: this feeds a chain into a file another app renders, so a failed probe
 * (LLDB's own `error:` text, a half-printed line) has to fall back to the class name rather
 * than be written out as if it were a hierarchy.
 *
 * @param {string} text - the expression's output.
 * @returns {string[]|null} class names, the class itself first.
 */
export function parseClassChain(text) {
  const parts = String(text ?? '').trim().split(',').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return null
  if (!parts.every((part) => /^[A-Za-z_][\w.]*$/.test(part))) return null
  if (new Set(parts).size !== parts.length) return null
  return parts
}

/** The file name one export uses. It sorts with time, so pruning can trust the order. */
export function lookinArchiveName(stamp) {
  return `lookin-${String(stamp)}.lookin`
}

/** Which of these names to delete so that at most `keep` archives remain. Oldest first. */
export function staleLookinFiles(names, keep) {
  const archives = names.filter((name) => String(name).endsWith('.lookin')).sort()
  return archives.slice(0, Math.max(0, archives.length - keep))
}
