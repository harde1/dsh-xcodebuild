# 在 DSH 里镜像 Lookin 的窗口（设计）

日期：2026-09-29
状态：V1 已实现并实测（"一次做到可点"：镜像 + 点击/拖拽/滚轮转发 + 权限缺失时如实拒绝）

## 目标

用户要的是"**打开它，在 DSH 里面展示**"：不切到 Lookin.app，也能在 DSH 的界面里看到 Lookin 的
窗口，并且能直接在上面点。落地为插件右侧边栏的**第二个 tab**（不是塞进已有的 LLDB 抽屉）：

1. 面板 tab（已有）负责"读层级、导出 .lookin"；镜像 tab 负责"看 Lookin、操作 Lookin"；
2. 两个 tab 是**两个独立注册**（各自的 id / kind / body / chip），因为它们是两个主题；同一个
   kind 只能有一个 type 生效，共用会让两者互相顶掉。

## 非目标（YAGNI）

- 不做"任意 macOS 应用"的通用镜像：只针对 Lookin，窗口挑选规则也只为它写死（进程名 + layer 0 + 面积下限）。
- 不做多窗口/多显示器挑选 UI：取面积最大的那个 layer 0 窗口。
- 不做键盘转发：Lookin 的主要操作是点选与滚动；键盘要先解决焦点与快捷键冲突，V1 不做。
- 不内置 Lookin.app 本体：目标应用仍然由用户自己安装并授权。

## 已核实的事实（都有实测证据）

| 事实 | 证据 |
| --- | --- |
| 窗口枚举 30 ms，含 id / bounds / layer / owner | `wininfo list` 走 `CGWindowListCopyWindowInfo`，1451×1172 的 Lookin 窗口实测 44 ms 冷、30 ms 热 |
| `screencapture -x -o -l<windowid> -t jpg` 抓的是**窗口自身**的像素，不受遮挡影响 | 把 Lookin 压到别的窗口后面再抓，内容仍是 Lookin 自己的画面；`-o` 去阴影，图片正好是窗口 frame |
| Retina 上抓图是 2× 点尺寸 | 1451×1172 pt 实测出来 2902×2344 px，比例精确 2.0，无取整 |
| 一帧的成本主要是**传输与解码**，不是抓图 | 同一窗口：PNG 810 KB / JPEG 775 KB（2902×2344），抓图本身 130–190 ms |
| `sips -Z 1280` 原地缩放 95–100 ms，1 MB base64 → 232 KB | 实测：2902×2344 775 KB → 1280×1034 231,585 bytes（`-Z` 只缩不放） |
| 端到端（走插件自己的路由）：warm 状态 57 ms，一帧 270–275 ms / 308 KB base64 | `/tmp` 探针脚本驱动 `lookinState`、`lookinFrame`，见"实测记录" |
| **跨进程投递事件需要"责任进程"的辅助功能授权** | TCC 库：`kTCCServiceAccessibility\|io.dsh.desktop = 2`、`kTCCServiceAccessibility\|io.dsh.desktop.helper = 0`（拒绝）、`kTCCServiceScreenCapture\|io.dsh.desktop = 2` |
| 缺授权时事件**静默丢弃**，不报错 | 自建 AppKit 点击靶子（`mouseDown` 写文件）：`postToPid` 与系统级投递都没有反应，`wininfo click` 仍返回 0 |
| 裸路径的 `swiftc` 编译失败，`xcrun swiftc` 成功 | macOS 26.5 / Xcode 26.0.1：`…/usr/bin/swiftc -O` 报 `unable to load standard library for target 'arm64-apple-macosx26.0'`；`xcrun swiftc` 正常（SDKROOT 由 xcrun 设置） |
| 窗口在 DSH 里点不到的原因不是坐标，而是授权 | 坐标映射用**窗口内比例**（0–1），与 2× 抓图、缩放、pane 宽度都无关 |

## 结构

```
lib/lookin-window.js   纯逻辑：窗口列表解析、窗口挑选、比例→全局坐标、helper 状态解析、权限文案（67 项测试）
native/wininfo.swift   list / status / activate / click / move / drag / scroll（CGWindowList + CGEvent.postToPid）
lib/index.js           helper 首次使用编译进 ~/Library/Caches/dsh-xcodebuild/wininfo；五个路由
lib/client.js          第二个 tab：LookinPane + LookinDockTab / LookinRightBarTab / LookinRightBarTitle
```

### 宿主五个路由

| 路由 | 作用 |
| --- | --- |
| `lookinState` | Lookin 是否安装/运行、pid、要镜像的窗口、三项权限状态、`.lookin` 上次导出的路径、helper 编译错误 |
| `lookinFrame` | 一帧 base64 JPEG（抓图 → 必要时 `sips -Z 1280` → 读文件），串行化（`frameQueue`）避免两帧抢同一个临时文件 |
| `lookinInput` | `click` / `drag` / `scroll`，参数是**窗口内比例**；缺辅助功能授权时直接返回 `{ok:false, reason:'accessibility'}` |
| `lookinOpen` | 打开/聚焦 Lookin（有上次导出的 `.lookin` 就一并载入） |
| `lookinPrivacy` | 打开系统设置的辅助功能面板，省掉用户自己找路 |

### 客户端两个 tab

- `LOOKIN_TAB_ID = 'dsh-xcodebuild-lookin'`、`LOOKIN_TAB_KIND = 'xcodebuild-lookin'`、order 41（面板是 40）。
- 座位与面板共用 `syncSeats()`：better-sidebar 在时两个 tab 都注册到它，官方右侧边栏在时两个
  type/body/chip 都注册到它，都不在时不给镜像 tab 留浮层入口（镜像只在侧边栏里有意义）。
- 状态轮询 1.5 s，帧轮询 320 ms 且有 `inFlight` 守卫（慢帧不会堆积）。
- 滚轮用**非 passive** 监听并合并 60 ms：React 的 `onWheel` 是 passive 的，`preventDefault` 无效，
  不接管就会变成"滚 pane 而不是滚 Lookin"。
- 拖拽阈值 4 px：小于它是点击，超过就是 drag（Lookin 树里拖是拖动分栏）。

## 三处踩过的坑（都已修，值得留档）

1. **首次读取不带 sessionId**：`adoptSession` 在父座位的 effect 里，而子组件 effect 先跑。修法是
   面板直接把自己座位的 session 显式带上，并让 `api()` 尊重调用方显式指定的 session（原来的
   `{...body, sessionId}` 会把**上一个座位的 session 覆盖上去**，实测首次请求发成了 `s2`）。
2. **写入落到了旧 store**：`const slice = state.lookin` 捕获的是首次渲染时的 store 对象，而
   `adoptSession` 之后会把 `state` 换成"该 session 的 store"，异步回调全写进了旧对象——界面一直显示
   "Reading…"，直到下一次轮询。修法：写的时候按**该座位自己的 store** 写（`storeFor(seat)`），
   与 `state` 何时切过去解耦。
3. **`xcrun --find swiftc` 再执行那个路径编译不了**：SDKROOT 是 xcrun 设的，drv 自己找不到标准库。
   改成一条命令 `xcrun swiftc -O …`。这个坑的代价是"第一次抓帧 1.3 s 后报编译失败"。

## 权限：能做什么、不能做什么（如实说明）

- **抓图**需要 Harness 进程（`io.dsh.desktop`）的"屏幕录制"，本机已授予。
- **点击/滚动**需要"责任进程"（`io.dsh.desktop.helper`）的"辅助功能"，本机**未授予**：面板会显示
  说明并提供"打开设置"按钮，点击被**拒绝并给出原因**，而不是假装成功。
- 用户授权路径：系统设置 → 隐私与安全性 → 辅助功能 → 打开 **DSH Desktop Helper**，然后重启 DSH。
  重启是必须的：TCC 在进程启动时判定。

## 实测记录

```
wininfo list --pid 42794        → 42794  2452  571 43 1451 1172  0  Lookin  (44 ms 冷 / 30 ms 热)
wininfo status                  → accessibility=0 screenCapture=1 frontmostPid=42794
screencapture -x -o -l2452 …    → 2902×2344, 775,045 bytes, 162 ms
sips -Z 1280                    → 1280×1034, 231,585 bytes, ~100 ms
lookinState (冷, 编译 helper)    → 1297 ms   (此后 warm 57 ms)
lookinFrame ×3                  → 270/275/274 ms, 308,780 bytes base64 每帧
lookinInput click/scroll        → {ok:false, reason:'accessibility'}  ← 未授权时的诚实回答
```

## 后续（明确未做）

- 键盘转发（需要先决定焦点与 `⌘` 冲突策略）。
- 只在 pane 可见时抓帧（现在是 tab 挂载即抓，切走 tab 由 shell 卸载组件，已经间接做到）。
- 帧率自适应（按 pane 宽度请求更小的上限，省掉一次 `sips`）。
- 多窗口挑选 UI。
