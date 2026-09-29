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
 * `NSStringFromCGRect`-shaped text, which is what `CGRectFromString` (and so Lookin) reads.
 *
 * Three decimals is well inside a device pixel and keeps the file readable.
 */
function rectString(x, y, width, height) {
  const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0')
  return `{{${num(x)}, ${num(y)}}, {${num(width)}, ${num(height)}}}`
}

/** The runtime id Lookin keys a node's details by. The address LLDB printed is exactly that. */
function oidFromAddress(address) {
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

function displayItem(node, parentOrigin, chains) {
  const frame = node.frame ?? {}
  const origin = {
    x: parentOrigin.x + (Number.isFinite(frame.x) ? frame.x : 0),
    y: parentOrigin.y + (Number.isFinite(frame.y) ? frame.y : 0),
  }
  const width = Number.isFinite(frame.width) ? frame.width : 0
  const height = Number.isFinite(frame.height) ? frame.height : 0
  return {
    $class: 'LookinDisplayItem',
    customInfo: null,
    subitems: (node.children ?? []).map((child) => displayItem(child, origin, chains)),
    hidden: node.hidden === true,
    alpha: Number.isFinite(node.alpha) ? node.alpha : 1,
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
    screenshotEncodeType: 1,
    soloScreenshot: null,
    groupScreenshot: null,
    customDisplayTitle: typeof node.text === 'string' && node.text !== '' ? node.text : null,
    danceuiSource: null,
    // Absolute, accumulated from the ancestors: LLDB prints a frame relative to its
    // superview, and Lookin draws every item in the window's coordinates.
    frame: rectString(origin.x, origin.y, width, height),
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
    screenshot: null,
    appIcon: null,
    appName: text(app.appName),
    appBundleIdentifier: text(app.appBundleIdentifier),
    deviceDescription: text(app.deviceDescription),
    osDescription: text(app.osDescription),
    osMainVersion: number(app.osMainVersion),
    deviceType: 0,
    screenWidth: number(app.screenWidth),
    screenHeight: number(app.screenHeight),
    screenScale: number(app.screenScale),
    cachedTimestamp: 0,
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
  const tree = buildViewTree(records)
  return {
    $class: 'LookinHierarchyFile',
    serverVersion: LOOKIN_SERVER_VERSION,
    hierarchyInfo: {
      $class: 'LookinHierarchyInfo',
      displayItems: tree.map((node) => displayItem(node, { x: 0, y: 0 }, chains)),
      colorAlias: {},
      collapsedClassList: [],
      appInfo: appInfoFor(options.appInfo ?? {}),
      serverVersion: LOOKIN_SERVER_VERSION,
    },
    soloScreenshots: null,
    groupScreenshots: null,
  }
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
  if (Number.isInteger(value.$uid)) return `<dict><key>CF$UID</key><integer>${value.$uid}</integer></dict>`
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
  return 'po (NSString *)({ Class c = NSClassFromString(@"' + name + '"); NSMutableArray *a = [NSMutableArray array];'
    + ' while (c) { [a addObject:NSStringFromClass(c)]; c = [c superclass]; } [a componentsJoinedByString:@","]; })'
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
