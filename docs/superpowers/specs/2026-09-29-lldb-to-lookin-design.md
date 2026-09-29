# LLDB 图层 → Lookin 可读归档（设计）

日期：2026-09-29
状态：设计已确认（V1 不带截图；每次取树自动导出 + 面板按钮在 Lookin 里打开）

## 目标

把插件用 LLDB 读到的视图层级，转成一份 `.lookin` 文件，让 macOS 的 Lookin.app 能直接打开浏览——
即"用调试器读到的树，在 Lookin 的图形界面里看"。这解决两件事：

1. 抽屉里那棵文本树不够直观（缩进 + frame 字符串），Lookin 有可折叠的树、坐标系、每个节点的类与属性面板；
2. 有些 App 不能或不便接 LookinServer，但**能挂调试器**——这类 App 也能得到 Lookin 的浏览体验。

## 非目标（YAGNI）

- 不依赖 LookinServer、不依赖 `ios-dev-test` 技能的 Python 脚本；这条通道是给"只有调试器"的场景用的。
- 不做属性面板的颜色/字体/约束（`recursiveDescription` 的文本里没有这些；真实快照里 `attributesGroupList` 也常为 `$null`）。
- 不做编辑回写、不做双向同步。
- V1 不做逐视图截图（见最后一节「后续」）。

## 已核实的事实（都有实测证据）

| 事实 | 证据 |
| --- | --- |
| `.lookin` = `LookinHierarchyFile` 的 NSKeyedArchiver 二进制 plist | 解码真实快照：`$archiver: NSKeyedArchiver`、`$version: 100000`、`$top.root` 为 UID |
| 顶层键：`serverVersion`(int)、`hierarchyInfo`、`soloScreenshots`、`groupScreenshots` | `LookinServer/Src/Main/Shared/LookinHierarchyFile.{h,m}` |
| `hierarchyInfo` = `LookinHierarchyInfo{displayItems, colorAlias, collapsedClassList, appInfo, serverVersion}` | 同上 `LookinHierarchyInfo.h` |
| 节点 = `LookinDisplayItem{hidden, alpha, frame, bounds, viewObject, layerObject, hostViewControllerObject, attributesGroupList, customAttrGroupList, representedAsKeyWindow, eventHandlers, shouldCaptureImage, screenshotEncodeType, soloScreenshot, groupScreenshot, customDisplayTitle, customInfo, danceuiSource, backgroundColor, subitems}` | `LookinDisplayItem.m -encodeWithCoder:` |
| `frame`/`bounds` 存**字符串**（`'{{0, 0}, {390, 390}}'`），不是对象 | 真实快照解码 |
| `viewObject` = `LookinObject{oid, memoryAddress, classChainList, ivarTraces, specialTrace}` | `LookinObject.h` |
| 版本门禁 `LOOKIN_SUPPORTED_SERVER_MIN..MAX`，协议版本 7 被接受 | `LookinHierarchyFile.m + verifyHierarchyFile:`；真实快照 `serverVersion: 7` |
| **Lookin.app 接受合成归档**（非其服务端产物） | 我合成的 4 节点文件被 `NSKeyedUnarchiver` 解码（统一日志可见），无错误、进程存活 |
| **Node 可独立产出**：XML plist（`CF$UID` 字典）→ `plutil -convert binary1`，UID 语义完整保留 | plistlib 回读：`$top.root`、`$class` 均为 `UID` 类型 |

## 架构

新纯模块 `lib/lookin-file.js`（无副作用、可单测），加一处宿主接线：

```
LLDB 会话 ──po recursiveDescription──> lib/view-hierarchy.js (已有)
                                            │ records[]
                                            ▼
                              lib/lookin-file.js  buildLookinFile(records, {appInfo})
                                            │ 对象图（Lookin 类形状）
                                            ▼
                                  toArchiveXml(file)  → XML plist 文本（CF$UID 引用）
                                            │
                                  writeArchive(xml, path)  → plutil -convert binary1
                                            ▼
                       /tmp/dsh-xcodebuild/lookin-<stamp>.lookin
                                            │
                    工具结果 lookinPath ──┬── 抽屉按钮「Lookin」→ open -a Lookin <path>
                                          └── 客户端显示路径
```

### 模块边界

- `lib/lookin-file.js`：只做"记录数组 → Lookin 对象图"和"对象图 → NSKeyedArchiver XML"。
  不知道 LLDB、不知道文件系统（写盘由调用方注入 `writeFn`，测试里换成内存函数）。
- `lib/index.js`：在 `lldbViewHierarchy` 成功取树后调用导出，负责路径、清理、`open`、错误降级。

### 字段映射

| Lookin 键 | 来源 | 说明 |
| --- | --- | --- |
| `oid` | 行内地址 `0x101607b40` | 解析为十进制数；地址是 LLDB 给的稳定标识，不是伪造的自增号 |
| `memoryAddress` | 同上 | 原样字符串 |
| `classChainList` | 类名 + 继承链 | 见下"继承链" |
| `frame` | 行内 frame **累加祖先 origin** | Lookin 的 `frame` 是窗口坐标系；`recursiveDescription` 给的是相对父视图 |
| `bounds` | `{{0,0},{w,h}}` | 文本里没有真实 bounds，按 frame 尺寸合成并在注释里写明 |
| `hidden` | 行内 `hidden=YES` | 缺省 false |
| `alpha` | 1.0 | 文本里没有 alpha |
| `customDisplayTitle` | `null` | 文本里没有控件文本（属性面板才需要，V1 没有） |
| `subitems` | 解析出的子节点 | 递归 |
| `attributesGroupList` / `customAttrGroupList` / `backgroundColor` / `customInfo` / `danceuiSource` / `eventHandlers` / `hostViewControllerObject` | `$null` | 与真实快照一致 |
| `shouldCaptureImage` / `screenshotEncodeType` | `true` / `1` | 与真实快照一致；V1 不带图 |
| `soloScreenshot` / `groupScreenshot` | `$null` | V1 不带图 |
| `appInfo` | 目标信息 + 会话 | App 名、bundle id、机型/系统（能拿到就给）、screen 尺寸、`serverVersion: 7` |
| `colorAlias` / `collapsedClassList` | `{}` / `[]` | 真实快照同为空 |

### 继承链

`recursiveDescription` 只有类名，Lookin 要的是整条链。做法：**每个去重类名一条表达式**，
形如 `expression -O -- (NSString *)({ Class c = NSClassFromString(@"UIStackView"); ... })`，
用 `class_getSuperclass` 走到 `NSObject`，逗号拼接返回。

- 每个会话缓存已查过的类名（一次取树付一次成本，后续免费）；
- 单次取树最多补 N 个新类（默认 30），失败或超时**只让该节点退化为 `[className]`**，绝不让取树失败；
- 表达式编译不过就整体退回 `[className]` 并记一条 note（不算错误）。

## 出口与交互

- **自动导出**：`lldbViewHierarchy` 成功（`ok: true` 且有记录）后写文件，路径
  `/tmp/dsh-xcodebuild/lookin-<stamp>.lookin`（沿用插件既有临时产物约定）；
  工具结果新增 `lookinPath`（失败时为 `null` + `lookinNote` 说明原因）。
- **清理**：同目录保留最近 10 份 `.lookin`（无图时每份几十 KB；为 V2 带图预留）。
- **抽屉按钮**：头部新增 `Lookin`，取树成功后可用：
  - 点击 → 宿主 `op=lookin`（`open: true`）→ `open -a Lookin <path>`；
  - 路径显示在状态行/提示里（悬停或短文本）；
  - Lookin.app 不存在时退化为 `open -R`（Finder 显示），并在 note 里说明。

## 错误处理

- 导出失败**不得**写 `state.error`（抽屉/路由的既有红线）；进 `state.lldb.note`。
- `plutil` 非 0 退出 → 保留 XML 到 `/tmp` 便于排查，note 带上首行错误。
- 没有记录（空树）→ 不导出，note 说明。
- 导出与打开互相独立：打开失败不影响已导出的文件。

## 测试

- **纯模块单测**（`test/lookin-file.test.mjs`）：映射（含隐藏视图、深层嵌套、非 ASCII 类名、无地址的行）、
  绝对 frame 累加、XML 形状（`$objects` 池化、`$class` 描述符、`CF$UID` 引用正确）、
  与真实快照**逐键对比**（用真实 .lookin 解出的键集合驱动断言，防止漏必填键）。
- **客户端测试**：新按钮出现/可用条件、点击发出 `op=lookin`、失败进 note 不进 error。
- **宿主测试**：路由 `op=lookin` 的参数与降级（Lookin 不存在）。
- **真机实测**：对 HIDProbe 与用户 App 各导出一份 → `plutil -lint` + plistlib 回读 → 在 Lookin.app 打开确认树形正确。

## 风险

- `frame` 语义若与 Lookin 预期不符（相对 vs 绝对），表现是"树有了但位置不对"；用真实快照的同名控件 frame 对账可判定。
- 类链表达式在多线程/受限进程可能编译失败；已设计为可退化。
- Lookin.app 版本门禁：文件固定写 `serverVersion: 7`（当前真实快照同值）。

## 后续（不在 V1）

逐视图截图：整屏截图按每个 frame 裁剪注入 `soloScreenshots`/`groupScreenshots`，是 Lookin 直观感的主要来源；
模拟器走 `simctl io screenshot`，真机走 `idevicescreenshot` 或让 LLDB 在进程内 `UIGraphicsImageRenderer` 渲染。
