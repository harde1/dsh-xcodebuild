# LLDB 图层 → Lookin 归档 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件用 LLDB 读到的视图层级，转成 Lookin.app 能直接打开的 `.lookin` 文件。

**Architecture:** 新增纯模块 `lib/lookin-file.js`（记录 → Lookin 对象图 → NSKeyedArchiver 形状的 XML plist），
宿主半负责落盘（`plutil -convert binary1`）、继承链补齐、清理与 `open -a Lookin`，客户端加一颗按钮。
Lookin 的键名与取值编码不是猜的：键名取自 `LookinServer/Src/Main/Shared/LookinDisplayItem.m -encodeWithCoder:`，
`frame`/`bounds` 存字符串这一点由「在模拟器里用真 UIKit 归档一个 CGRect」实测确认。

**Tech Stack:** Node ESM（无新增依赖，`plutil` 是 macOS 自带）、Cordis 插件（宿主 + 客户端两半）、自定义测试小框架。

**Spec:** `docs/superpowers/specs/2026-09-29-lldb-to-lookin-design.md`

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `lib/lookin-file.js`（新建） | 纯函数：记录 → Lookin 对象图；对象图 → XML plist；继承链表达式与解析；文件名与清理选择 |
| `test/lookin-file.test.mjs`（新建） | 上述纯函数的单测，含与真实归档键集合的对账 |
| `lib/index.js`（修改） | 取树成功后导出、继承链缓存与探测、`op=lookin` 打开、清理、`xcode_lldb` 增加 `lookin` 动作 |
| `lib/client.js`（修改） | 抽屉头部 `Lookin` 按钮 + 路径显示 |
| `test/client-interaction.test.mjs`（修改） | 按钮行为的客户端测试 |
| `test/host-mount.test.mjs`（修改） | 路由 / 工具动作的宿主测试 |
| `package.json`（修改） | 新测试入链、`exports['./lookin-file']`、版本号 |

---

### Task 1: 记录 → Lookin 对象图

**Files:**
- Create: `lib/lookin-file.js`
- Test: `test/lookin-file.test.mjs`
- Modify: `package.json`（把新测试加进 `test` 链，并加 `exports`）

- [ ] **Step 1: 写失败的测试（顶层形状 + 一个节点的全部键）**

```js
// test/lookin-file.test.mjs
//
// The fixture is the shape `lib/view-hierarchy.js` produces (checked against a real dump),
// and the EXPECTED keys are the ones LookinServer itself archives, read off
// `LookinDisplayItem.m -encodeWithCoder:` — a missing key here is a node Lookin.app draws
// wrong, which is exactly the failure this suite exists to catch.
//
// Run: node test/lookin-file.test.mjs
import {
  LOOKIN_SERVER_VERSION,
  buildLookinFile,
  toArchiveXml,
  classChainExpression,
  parseClassChain,
  lookinArchiveName,
  staleLookinFiles,
} from '../lib/lookin-file.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
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

/** Every key LookinDisplayItem archives, in -encodeWithCoder: order. */
const ITEM_KEYS = [
  'customInfo', 'subitems', 'hidden', 'alpha', 'viewObject', 'layerObject',
  'hostViewControllerObject', 'attributesGroupList', 'customAttrGroupList',
  'representedAsKeyWindow', 'eventHandlers', 'shouldCaptureImage', 'screenshotEncodeType',
  'soloScreenshot', 'groupScreenshot', 'customDisplayTitle', 'danceuiSource',
  'frame', 'bounds', 'backgroundColor',
]

section('a view record becomes a Lookin display item')
{
  const records = [
    { depth: 0, className: 'UIWindow', address: '0x101607b40', frame: { x: 0, y: 0, width: 390, height: 844 }, text: '', hidden: false, alpha: null, baseClass: '' },
    { depth: 1, className: 'UIStackView', address: '0x101420fb0', frame: { x: 12, y: 55, width: 366, height: 747 }, text: '', hidden: false, alpha: 0.5, baseClass: '' },
    { depth: 2, className: 'Example.StatusLight', address: '0x10141a3d0', frame: { x: 0, y: 4, width: 116.667, height: 44 }, text: '● GC 键盘', hidden: true, alpha: null, baseClass: 'UIView' },
  ]
  const file = buildLookinFile(records, {
    appInfo: { appName: '蜜语-Dev', appBundleIdentifier: 'com.suishoubo.ppmain3', screenWidth: 390, screenHeight: 844, screenScale: 3 },
    classChains: { UIStackView: ['UIStackView', 'UIView', 'UIResponder', 'NSObject'] },
  })

  eq(file.$class, 'LookinHierarchyFile', 'the root is a LookinHierarchyFile')
  eq(file.serverVersion, LOOKIN_SERVER_VERSION, 'with the protocol version Lookin.app accepts')
  eq(file.hierarchyInfo.$class, 'LookinHierarchyInfo', 'holding a LookinHierarchyInfo')
  eq(file.hierarchyInfo.colorAlias, {}, 'with the alias table Lookin expects')
  eq(file.hierarchyInfo.collapsedClassList, [], 'and the collapsed list')
  eq(file.hierarchyInfo.appInfo.appName, '蜜语-Dev', 'and the app it came from')
  eq(file.soloScreenshots, null, 'V1 carries no screenshots')
  eq(file.groupScreenshots, null, 'in either dictionary')

  const root = file.hierarchyInfo.displayItems[0]
  eq(Object.keys(root).sort(), ITEM_KEYS.slice().sort(), 'the item archives exactly the keys LookinServer archives')
  eq(root.frame, '{{0, 0}, {390, 844}}', 'frame is a STRING, the way UIKit archives a CGRect')
  eq(root.bounds, '{{0, 0}, {390, 844}}', 'and so is bounds')
  eq(root.subitems.length, 1, 'the child hangs off the parent')

  const stack = root.subitems[0]
  // LLDB prints a frame relative to its superview; Lookin draws in window coordinates.
  eq(stack.frame, '{{12, 55}, {366, 747}}', 'a child frame is accumulated with its ancestors')
  eq(stack.alpha, 0.5, 'alpha comes through when the dump printed one')
  eq(stack.viewObject.$class, 'LookinObject', 'the view object is a LookinObject')
  eq(stack.viewObject.classChainList, ['UIStackView', 'UIView', 'UIResponder', 'NSObject'], 'with the real chain when one was probed')
  eq(stack.viewObject.oid, Number.parseInt('101420fb0', 16), 'and an oid derived from the address LLDB printed')
  eq(stack.viewObject.memoryAddress, '0x101420fb0', 'keeping the address as printed')

  const light = stack.subitems[0]
  eq(light.frame, '{{12, 59}, {116.667, 44}}', 'frames accumulate through every level')
  eq(light.hidden, true, 'hidden comes through')
  eq(light.alpha, 1, 'and a missing alpha means 1')
  eq(light.customDisplayTitle, '● GC 键盘', 'text becomes the title Lookin shows')
  eq(light.viewObject.classChainList, ['Example.StatusLight', 'UIView'], 'without a probed chain it falls back to the class and its base class')
  eq(light.layerObject, null, 'the layer object is left nil rather than invented')
  eq(root.representedAsKeyWindow, false, 'and nothing claims to be the key window')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
console.log('lookin-file OK')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/lookin-file.test.mjs`
Expected: FAIL — `Cannot find module '../lib/lookin-file.js'`

- [ ] **Step 3: 实现 `buildLookinFile`**

```js
// lib/lookin-file.js
//
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
import { buildViewTree } from './view-hierarchy.js'

/** The LookinServer protocol version whose file format this writes. */
export const LOOKIN_SERVER_VERSION = 7

/**
 * `NSStringFromCGRect`-shaped text, which is what `CGRectFromString` (and so Lookin) reads.
 * Three decimals is well inside a device pixel and keeps the file readable.
 */
function rectString(x, y, width, height) {
  const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0')
  return `{{${num(x)}, ${num(y)}}, {${num(width)}, ${num(height)}}}`
}

/** The runtime id Lookin keys its detail requests by. LLDB prints the address; it is unique. */
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
  const origin = { x: parentOrigin.x + (Number.isFinite(frame.x) ? frame.x : 0), y: parentOrigin.y + (Number.isFinite(frame.y) ? frame.y : 0) }
  const width = Number.isFinite(frame.width) ? frame.width : 0
  const height = Number.isFinite(frame.height) ? frame.height : 0
  const viewObject = lookinObject(node, chains)
  return {
    $class: 'LookinDisplayItem',
    customInfo: null,
    subitems: (node.children ?? []).map((child) => displayItem(child, origin, chains)),
    hidden: node.hidden === true,
    alpha: Number.isFinite(node.alpha) ? node.alpha : 1,
    viewObject,
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
    // Says where the file came from, in the field Lookin shows as the server version.
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
 * @param {object} [options] - `appInfo` (strings and numbers for Lookin's header) and
 *   `classChains` (a `className -> string[]` map the caller probed over the debugger).
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/lookin-file.test.mjs`
Expected: PASS（模块里其余导出此时还不存在，用 Step 3 同批补上 Task 3 的桩会更好；若报缺导出，先按 Task 2/3 的代码补齐再跑）

- [ ] **Step 5: 新测试入链并提交**

```bash
cd /Users/mac/Project/dsh-xcodebuild
python3 - <<'PY'
import json
p='package.json'; d=json.load(open(p))
d['exports']['./lookin-file'] = {'default': './lib/lookin-file.js'}
d['scripts']['test'] = d['scripts']['test'].replace('node test/running-app.test.mjs &&', 'node test/running-app.test.mjs && node test/lookin-file.test.mjs &&')
json.dump(d, open(p,'w'), indent=2, ensure_ascii=False); open(p,'a').write('\n')
PY
node test/lookin-file.test.mjs
git add lib/lookin-file.js test/lookin-file.test.mjs package.json
git commit -m "feat(lookin): map an LLDB view tree onto Lookin's object graph"
```

---

### Task 2: 写出 NSKeyedArchiver 形状的 XML plist

**Files:**
- Modify: `lib/lookin-file.js`
- Test: `test/lookin-file.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
section('the archive is written the way NSKeyedArchiver writes one')
{
  const file = buildLookinFile([
    { depth: 0, className: 'UIWindow', address: '0x1', frame: { x: 0, y: 0, width: 10, height: 20 }, text: '', hidden: false, alpha: null },
    { depth: 1, className: 'UILabel', address: '0x2', frame: { x: 1, y: 2, width: 3, height: 4 }, text: 'hi', hidden: false, alpha: null },
  ])
  const xml = toArchiveXml(file)

  check(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'it is an XML plist')
  check(xml.includes('<key>$archiver</key><string>NSKeyedArchiver</string>'), 'declaring the archiver')
  check(xml.includes('<key>$version</key><integer>100000</integer>'), 'and the archive version')
  check(xml.includes('<key>CF$UID</key>'), 'with object references as CF$UID, which is how an XML plist carries them')
  check(xml.includes('<key>$classname</key><string>LookinDisplayItem</string>'), 'and a class descriptor per class')
  eq((xml.match(/<string>LookinDisplayItem<\/string>/g) ?? []).length, 2, 'the class name appears in its descriptor and in $classes only')

  // Two nodes, one class descriptor: without interning, a real dump writes its class
  // descriptors tens of thousands of times and Lookin reads a needlessly huge file.
  const descriptorCount = (xml.match(/<key>\$classname<\/key>/g) ?? []).length
  eq(descriptorCount, 6, 'one descriptor per distinct class, not one per node')
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/lookin-file.test.mjs`
Expected: FAIL — `toArchiveXml is not a function`

- [ ] **Step 3: 实现 `toArchiveXml`**

```js
/** XML-escape a plist string the way CoreFoundation does. */
function xmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render one plist value. `{$uid: n}` is a reference into `$objects`. */
function plistValue(value) {
  if (value === null || value === undefined) return '<string>$null</string>'
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`
  }
  if (typeof value === 'string') return `<string>${xmlText(value)}</string>`
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`
  if (Number.isInteger(value.$uid)) {
    return `<dict><key>CF$UID</key><integer>${value.$uid}</integer></dict>`
  }
  const entries = Object.entries(value).map(([key, part]) => `<key>${xmlText(key)}</key>${plistValue(part)}`)
  return `<dict>${entries.join('')}</dict>`
}

/**
 * Serialize the graph as the XML plist `plutil -convert binary1` turns into a `.lookin`.
 *
 * The archive is written in NSKeyedArchiver's shape: `$objects` is the object table, every
 * string and array is an entry in it, primitives stay inline (`encodeFloat:forKey:` and
 * friends write no object), and a class is named once by a descriptor object that its
 * instances point at. Writing the XML and converting with `plutil` is deliberate: a binary
 * plist writer is a hundred lines of offsets for no gain, and `plutil` ships with macOS.
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
      const body = { $class: classRef('NSArray'), 'NS.objects': value.map(encode) }
      objects.push(body)
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0">${plistValue(archive)}</plist>\n`
}
```

- [ ] **Step 4: 跑测试确认通过，并用 plutil 做一次真实往返**

Run:
```bash
node test/lookin-file.test.mjs
node --input-type=module -e "
const { buildLookinFile, toArchiveXml } = await import('./lib/lookin-file.js')
const { writeFileSync } = await import('node:fs')
writeFileSync('/tmp/lookin-roundtrip.xml', toArchiveXml(buildLookinFile([
  { depth: 0, className: 'UIWindow', address: '0x1', frame: { x: 0, y: 0, width: 390, height: 844 }, text: '', hidden: false, alpha: null },
])))
"
plutil -convert binary1 -o /tmp/lookin-roundtrip.lookin /tmp/lookin-roundtrip.xml && python3 -c "
import plistlib
d = plistlib.load(open('/tmp/lookin-roundtrip.lookin','rb'))
print('root 是 UID:', type(d['\$top']['root']).__name__)
print('objects[1] 的 \$class:', d['\$objects'][1]['\$class'])
"
```
Expected: 测试 PASS；`plutil` 退出 0；python 打印 `root 是 UID: UID` 与 `objects[1] 的 $class: UID`（UID 语义没被拍平）

- [ ] **Step 5: 提交**

```bash
git add lib/lookin-file.js test/lookin-file.test.mjs
git commit -m "feat(lookin): serialize the graph as an NSKeyedArchiver plist"
```

---

### Task 3: 继承链探测与文件清理（纯函数）

**Files:**
- Modify: `lib/lookin-file.js`
- Test: `test/lookin-file.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
section('the class chain is probed once per class')
{
  const expression = classChainExpression('UIStackView')
  check(expression.startsWith('po '), 'the probe is a po command, which is what the session runs')
  check(expression.includes('NSClassFromString(@"UIStackView")'), 'naming the class it is asked about')
  check(expression.includes('[c superclass]'), 'walking superclasses with a message, so no runtime header is needed')
  check(!expression.includes('"'), 'and quoting the class name so it cannot break out of the literal')

  check(classChainExpression('Evil"Class').includes('NSClassFromString(@"EvilClass")'), 'a quote in the name is stripped rather than injected')
  eq(parseClassChain('UILabel,UIView,UIResponder,NSObject'), ['UILabel', 'UIView', 'UIResponder', 'NSObject'], 'a printed chain parses')
  eq(parseClassChain('  UILabel , UIView '), ['UILabel', 'UIView'], 'with whitespace tolerated')
  eq(parseClassChain(''), null, 'an empty answer is no answer')
  eq(parseClassChain('lol;;error: something'), null, 'and so is junk, so a failed probe cannot become a chain')
  eq(parseClassChain('UIView,UIView'), null, 'a chain that repeats itself is rejected')
}

section('exports are named and pruned')
{
  eq(lookinArchiveName('2026-09-29T14-50-01'), 'lookin-2026-09-29T14-50-01.lookin', 'the file is named for when it was taken')
  eq(staleLookinFiles(['a.lookin', 'b.lookin', 'c.lookin'], 2), ['a.lookin'], 'the oldest beyond the cap are the ones to delete')
  eq(staleLookinFiles(['a.lookin'], 2), [], 'nothing to delete while under the cap')
  eq(staleLookinFiles([], 2), [], 'and nothing for an empty directory')
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/lookin-file.test.mjs`
Expected: FAIL — `classChainExpression is not a function`

- [ ] **Step 3: 实现**

```js
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
 * Strict on purpose: this feeds a chain into a file another app renders, and a failed probe
 * (LLDB's own `error:` text, a half-printed line) must fall back to the class name rather
 * than be written out as if it were a hierarchy.
 *
 * @param {string} text - the expression's output.
 * @returns {string[]|null} class names, outermost first.
 */
export function parseClassChain(text) {
  const parts = String(text ?? '').trim().split(',').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return null
  if (!parts.every((part) => /^[A-Za-z_][\w.]*$/.test(part))) return null
  if (new Set(parts).size !== parts.length) return null
  return parts
}

/** The file name one export uses. Sorts with time, so pruning can trust the order. */
export function lookinArchiveName(stamp) {
  return `lookin-${String(stamp)}.lookin`
}

/** Which of these names to delete to keep at most `keep` files. Oldest first, sorted by name. */
export function staleLookinFiles(names, keep) {
  const sorted = names.filter((name) => name.endsWith('.lookin')).sort()
  return sorted.slice(0, Math.max(0, sorted.length - keep))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/lookin-file.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/lookin-file.js test/lookin-file.test.mjs
git commit -m "feat(lookin): add the class-chain probe and export pruning"
```

---

### Task 4: 宿主接线（取树后导出、打开、工具动作）

**Files:**
- Modify: `lib/index.js`（导入区、LLDB 块、`lldbOp`、工具定义）
- Modify: `test/host-mount.test.mjs`

- [ ] **Step 1: 写失败的宿主测试**

在 `test/host-mount.test.mjs` 的工具断言附近加：

```js
check(/lookin/.test(JSON.stringify(toolSpecs.find((spec) => spec.name === 'xcode_lldb')?.parameters ?? {})), 'xcode_lldb offers the Lookin export')
```

在路由区加：

```js
// Nothing has been dumped in this process, so the panel is told to read a tree first
// rather than being handed a stale file from a previous run.
{
  const answer = await callRoute('/lldb', { sessionId: 'lookin-none', op: 'lookin', open: false })
  check(answer.ok === false && /View Hierarchy/.test(String(answer.note)), 'op=lookin without a dump explains what to do first', JSON.stringify(answer))
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/host-mount.test.mjs`
Expected: FAIL — 工具参数里没有 `lookin`；`op=lookin` 返回未知动作

- [ ] **Step 3: 实现宿主接线**

导入：
```js
import {
  buildLookinFile,
  classChainExpression,
  lookinArchiveName,
  parseClassChain,
  staleLookinFiles,
  toArchiveXml,
} from './lookin-file.js'
```

LLDB 块内新增（放在 `lldbViewHierarchy` 之前）：
```js
  /** Chains probed this session: a dump has hundreds of views but a dozen classes. */
  const lookinChains = new Map()
  /** The last file exported, so the panel's button can open what the last dump produced. */
  let lastLookinPath = null

  /** Where exports live, beside this plugin's other transient files. */
  function lookinDir() {
    return join(tmpdir(), 'dsh-xcodebuild')
  }

  /**
   * The superclass chain of every class in this dump, probed once each.
   *
   * A failure is cached as a miss, so a class the runtime will not answer for costs one
   * expression per session rather than one per dump.
   */
  async function lookinClassChains(records, session) {
    const names = [...new Set(records.map((record) => record.className))].slice(0, 30)
    const chains = {}
    for (const name of names) {
      if (lookinChains.has(name)) {
        const cached = lookinChains.get(name)
        if (cached !== null) chains[name] = cached
        continue
      }
      const probed = await session.evaluate(classChainExpression(name), { timeoutMs: 8000 })
      const chain = probed.ok ? parseClassChain(probed.text) : null
      lookinChains.set(name, chain)
      if (chain !== null) chains[name] = chain
    }
    return chains
  }

  /**
   * Write the tree LLDB just read as the file Lookin.app opens.
   *
   * Never throws and never fails the dump: a missing export is a note on a tree that is
   * still in the drawer, and the panel's own red line is that a debugger problem must not
   * paint itself across a healthy build.
   */
  async function exportLookin(records, target, workspace, session) {
    try {
      const chains = await lookinClassChains(records, session)
      const app = await appInfoForLookin(target, session)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const dir = lookinDir()
      await mkdir(dir, { recursive: true })
      const name = lookinArchiveName(stamp)
      const xmlPath = join(dir, `${name}.xml`)
      await writeFile(xmlPath, toArchiveXml(buildLookinFile(records, { appInfo: app, classChains: chains })), 'utf8')
      const converted = await capture(['plutil', '-convert', 'binary1', '-o', join(dir, name), xmlPath], workspace === '' ? '/' : workspace, 30000)
      await rm(xmlPath, { force: true })
      if (converted.exitCode !== 0) {
        const said = String(converted.stderr !== '' ? converted.stderr : converted.stdout).trim().split('\n')[0] ?? ''
        return { path: null, note: `could not convert the archive: ${said}` }
      }
      const names = await readdir(dir).catch(() => [])
      for (const stale of staleLookinFiles(names, 10)) await rm(join(dir, stale), { force: true }).catch(() => {})
      lastLookinPath = join(dir, name)
      return { path: lastLookinPath, note: '' }
    } catch (error) {
      return { path: null, note: `could not write the Lookin file: ${messageOf(error)}` }
    }
  }

  /** What Lookin shows in its header: the app it came from, and the device size. */
  async function appInfoForLookin(target, session) {
    const screen = await screenSizeFor(session)
    return {
      appName: target.bundleId === '' ? target.name : target.bundleId,
      appBundleIdentifier: target.bundleId,
      deviceDescription: target.kind === 'device' ? target.name : target.id,
      osDescription: '',
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenScale: screen.scale,
    }
  }

  /**
   * The device's logical size, asked over the debugger that is already attached.
   *
   * Lookin scales its coordinates by this, so it is read from the running app rather than
   * guessed from the model name — and the same expression answers for a device and a
   * simulator, which is why neither `simctl list` nor a device-info query is involved.
   * `{0, 0, 0}` is what an unanswerable question leaves: Lookin renders without scaling
   * rather than refusing the file.
   */
  async function screenSizeFor(session) {
    const asked = await session.evaluate('po (NSString *)[NSString stringWithFormat:@"%g,%g,%g", [UIScreen mainScreen].bounds.size.width, [UIScreen mainScreen].bounds.size.height, [UIScreen mainScreen].scale]', { timeoutMs: 8000 })
    if (!asked.ok) return { width: 0, height: 0, scale: 0 }
    const parts = String(asked.text).trim().split(',').map((part) => Number.parseFloat(part))
    if (parts.length < 3 || !parts.every((part) => Number.isFinite(part))) return { width: 0, height: 0, scale: 0 }
    return { width: parts[0], height: parts[1], scale: parts[2] }
  }
```

取树成功后接线（`lldbViewHierarchy` 的返回处）：
```js
    const lookin = await exportLookin(records, target, workspace, ready.session)
    return {
      // …既有字段…
      lookinPath: lookin.path,
      lookinNote: lookin.note,
    }
```

`lldbOp` 增加：
```js
    if (op === 'lookin') return lldbOpenLookin(body, workspace)
```

新函数：
```js
  /**
   * Open the last export in Lookin.app.
   *
   * `open -a Lookin` needs the app; without it the file is revealed in Finder instead, which
   * is still the useful half — the file exists either way, and the note says which happened.
   */
  async function lldbOpenLookin(body, workspace) {
    if (lastLookinPath === null) {
      return { ok: false, path: null, note: 'nothing exported yet: read the view hierarchy first — View Hierarchy — and the file is written as it is read', session: lldb === null ? null : lldb.summary() }
    }
    const cwd = workspace === '' ? '/' : workspace
    if (body?.open === false) return { ok: true, path: lastLookinPath, note: '', session: lldb === null ? null : lldb.summary() }
    const opened = await capture(['open', '-a', 'Lookin', lastLookinPath], cwd, 30000)
    if (opened.exitCode === 0) return { ok: true, path: lastLookinPath, note: 'opened in Lookin', session: lldb === null ? null : lldb.summary() }
    const revealed = await capture(['open', '-R', lastLookinPath], cwd, 30000)
    return {
      ok: revealed.exitCode === 0,
      path: lastLookinPath,
      note: revealed.exitCode === 0 ? 'Lookin.app is not installed, so the file is shown in Finder instead' : 'could not open the file; its path is above',
      session: lldb === null ? null : lldb.summary(),
    }
  }
```

`xcode_lldb` 工具：动作枚举加 `lookin`，描述里写明「每次读取视图树都会自动导出 .lookin，`lookin` 动作只负责在 Lookin.app 里打开」。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/host-mount.test.mjs && node test/lookin-file.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/host-mount.test.mjs
git commit -m "feat(lookin): export Lookin's file after every view-tree read"
```

---

### Task 5: 抽屉按钮

**Files:**
- Modify: `lib/client.js`
- Modify: `test/client-interaction.test.mjs`

- [ ] **Step 1: 写失败的客户端测试**

在 `section('the LLDB drawer')` 内加（沿用该 fixture 的 `serve`/`runLldb` 触发方式）：
```js
  // The export happens on read; the button opens what the read wrote. Without a tree
  // there is nothing to open, so the button must not be there.
  const noTree = renderDrawer({})                       // fixture 的默认状态：还没有树
  check(findByClass(noTree, 'xcb-lldb-lookin') === null, 'no Lookin button before a tree is read')
  const withTree = renderDrawer({ lldbTree: TREE })      // fixture 里已有树的状态
  const button = findByClass(withTree, 'xcb-lldb-lookin')
  check(button !== null, 'the Lookin button appears once a tree is there')
  check(button.props.children === 'Lookin', 'and says what it opens', JSON.stringify(button.props.children))
  await click(withTree, 'xcb-lldb-lookin')
  eq(calls.filter((call) => call.path === '/lldb' && call.body.op === 'lookin').length, 1, 'clicking it asks the host to open the export')
  eq(calls.at(-1).body.open, true, 'with open, so the host launches Lookin.app')
```

（`renderDrawer`/`findByClass`/`click` 若与该文件既有的辅助函数不同名，按既有名字改写；断言意图不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/client-interaction.test.mjs`
Expected: FAIL — 找不到 `.xcb-lldb-lookin`

- [ ] **Step 3: 实现按钮**

`blankStore` 的 `lldb` 里加 `lookinPath: ''`；`runLldb` 里：
```js
          if (op === 'view') state.lldb.lookinPath = typeof result.lookinPath === 'string' ? result.lookinPath : ''
          if (op === 'lookin') {
            if (typeof result.path === 'string' && result.path !== '') state.lldb.lookinPath = result.path
            if (typeof result.note === 'string' && result.note !== '') state.lldb.note = result.note
          }
```

抽屉头部，`View Hierarchy` 之后加：
```js
          state.lldb.tree === null ? null : button('Lookin', () => { void runLldb('lookin', { open: true }) }, {
            key: 'lookin',
            className: 'xcb-btn xcb-lldb-lookin' + (state.lldb.lookinPath === '' ? '' : ' live'),
            title: state.lldb.lookinPath === '' ? 'Open this tree in Lookin.app' : state.lldb.lookinPath,
            disabled: busy !== '',
          }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/client-interaction.test.mjs && node --run test`
Expected: 全部套件 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/client.js test/client-interaction.test.mjs
git commit -m "feat(panel): open the exported tree in Lookin from the drawer"
```

---

### Task 6: 文档、版本与发布

**Files:**
- Modify: `README.md`、`CHANGELOG.md`、`package.json`

- [ ] **Step 1: 写文档**

`README.md`：在抽屉那一节后加一段「A tree Lookin can open」，说明每次读取视图树都会写出 `/tmp/dsh-xcodebuild/lookin-*.lookin`，抽屉的 `Lookin` 按钮用 Lookin.app 打开它，并写明这是给「只能挂调试器、没有 LookinServer」的 App 用的。

`CHANGELOG.md`：`## 0.3.0` + `### Added`，写清键名/编码来源与实测结论（frame 是字符串等）。

- [ ] **Step 2: 版本与全量测试**

```bash
python3 - <<'PY'
import json
p='package.json'; d=json.load(open(p)); d['version']='0.3.0'
json.dump(d, open(p,'w'), indent=2, ensure_ascii=False); open(p,'a').write('\n')
PY
node --run test 2>&1 | grep -E "checks passed|FAIL" | tail -4
```

- [ ] **Step 3: 提交并发布**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "chore(release): 0.3.0"
git push -q origin main && git tag v0.3.0 && git push -q origin v0.3.0
/usr/local/bin/npm publish --userconfig .analysis/.npmrc --access public 2>&1 | tail -2
```

---

### Task 7: 真机与模拟器实测

**Files:** 无（验证）

- [ ] **Step 1: 模拟器上跑一遍完整链路**

用已在模拟器上跑过的 HIDProbe（普通 Debug 包）触发一次取树，导出后校验并打开：
```bash
ls -la /tmp/dsh-xcodebuild/*.lookin | tail -3
plutil -lint /tmp/dsh-xcodebuild/$(ls -t /tmp/dsh-xcodebuild | grep lookin | head -1)
python3 -c "
import plistlib, glob, os
p = max(glob.glob('/tmp/dsh-xcodebuild/*.lookin'), key=os.path.getmtime)
d = plistlib.load(open(p,'rb')); o = d['\$objects']
root = o[d['\$top']['root'].data]
print('root:', o[root['\$class'].data]['\$classname'], '| serverVersion:', root['serverVersion'])
hi = o[root['hierarchyInfo'].data]
items = o[hi['displayItems'].data]
print('windows:', len(items['NS.objects']))
"
open -a Lookin "$(ls -t /tmp/dsh-xcodebuild/*.lookin | head -1)"
```
Expected: `plutil -lint` 报 OK；打印出 `LookinHierarchyFile` 与窗口数；Lookin.app 打开后左树里能看到与 `recursiveDescription` 一致的层级（人工确认：类名、frame 数值与面板里的树逐行一致）

- [ ] **Step 2: 与真实快照对账**

把合成文件与技能产出的真实快照（`/tmp/lookin-gt/*/snapshot.lookin`）做键集合与 frame 值的对比：
```bash
python3 - <<'PY'
import plistlib, glob, os
def items(path):
    d = plistlib.load(open(path,'rb')); o = d['$objects']
    root = o[d['$top']['root'].data]
    hi = o[root['hierarchyInfo'].data]
    return root, o[hi['displayItems'].data]
synth = max(glob.glob('/tmp/dsh-xcodebuild/*.lookin'), key=os.path.getmtime)
real = glob.glob('/tmp/lookin-gt/*/snapshot.lookin')[0]
for label, path in (('synth', synth), ('real', real)):
    root, top = items(path)
    first = o = plistlib.load(open(path,'rb'))['$objects'][top['NS.objects'][0].data]
    print(label, '顶层键:', sorted(k for k in root if k != '$class'))
PY
```
Expected: 两者的 `LookinHierarchyFile` 顶层键集合一致；差异只应出现在 V1 明确不做的字段（截图）

- [ ] **Step 3: 记录结论并提交**

把实测结论（含 frame 与面板树逐行一致的人工确认）写进 CHANGELOG 的那一节，提交。

---

## 备注

- 每次取树都会多花约 0.3–1 s（继承链首次探测 + 一次 `plutil`），第二次起缓存命中。
- `layerObject` 故意留 nil：`recursiveDescription` 不含 layer 的类信息，编一个比留空更糟。
- V2（截图）另起 spec：整屏截图按 frame 裁剪注入 `soloScreenshots`/`groupScreenshots`。
