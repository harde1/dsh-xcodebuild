# Changelog

## 0.3.8

### Fixed

- The two commands the cleanup uses are registered in the dependency list (`ps`, `pgrep`, both
  `ships with macOS`), so the doctor keeps telling the truth about what the plugin runs.
- The note now names what was cleared: the sentence about a leftover debugger reaching the user was
  composed but never attached to the failure, so a device that had just been freed looked like an
  unexplained one.

## 0.3.7

### Fixed

- **A debugger this plugin left behind is cleared before a new attach.** A failed attach does not
  always take its processes with it, and the one that is easy to miss is the CoreDevice helper lldb
  causes to launch (`.../CoreDevice.framework/.../bin/device`), which is what owns the channel to the
  phone. Both keep the device busy, so the next attempt dies at the first step —
  `device select <udid>: no answer within 30000 ms` — a message that names no cause, while the cause
  is a process this plugin started minutes earlier. Measured on 蜜语-Dev: an `lldb` 2m57s old and its
  helper 3m17s old, still holding the device, after which nothing could attach.

  Only processes inside this plugin's own process tree are candidates, because Xcode and `devicectl`
  run the same two programs and their sessions are not ours to end (and `pid 1`, the ancestor of
  everything, is refused outright). The note now also says what was ended.

- **The "the run still holds it" half of that message is only said when it is true.** `ios-deploy`
  is checked for, rather than trusted from the run record: a record can outlive the console session
  it describes, and blaming a session that is not there sends the user to stop a run that already
  ended. A device that does not answer the first command is now described as busy or locked.

## 0.3.6

### Changed

- **A read lets the app run again afterwards.** A dump stops the app — it has to, the layers are only
  readable in that state — but a frozen app is a side effect of debugging rather than something
  anyone asked for, and reading the tree is usually the only reason it was stopped. The app is now
  resumed the moment the tree is in hand, and the result carries `continued` saying whether it is
  running again. Best effort on purpose: a debugger that has already gone cannot be told to continue,
  and that must not turn a good tree into a failed read. `continue: false` keeps the app stopped for
  a caller that wants to poke at it, and the drawer's `Interrupt` does the same by hand at any time.

## 0.3.5

### Fixed

- **A read that failed no longer leaves the app frozen.** A dump stops the app so its layers can be
  read — that part is unavoidable, and Xcode's own view debugger does the same — so a read that
  hangs or produces nothing used to leave a phone whose app could not be touched at all, until an
  `lldb` process was killed by hand on the Mac. The failure path now releases it: interrupt first
  (the expression can be hung, because a real app's tree is slow and a device connection can stall),
  then a clean detach if the debugger still answers, and `dispose` otherwise, which ends the child
  and takes the stop with it. The note says the app is running again.

  A read that SUCCEEDS still leaves the app stopped on purpose, because that is the state the
  drawer's `Interrupt`, `Continue` and command box exist for — `Continue` is what lets it go.

## 0.3.4

### Fixed

- **The plugin now picks its debugger instead of trusting `xcrun`.** It ran `xcrun lldb` and nothing
  else, and `xcrun` follows `xcode-select`: with the Command Line Tools selected, the lldb it finds
  has no iOS device support at all — it starts, cannot do the one thing it was asked for, and exits,
  which reads as `lldb exited (status dead)` while the good debugger inside Xcode.app sits untouched
  on the same disk. Candidates are now listed — Xcode's own lldb first, `xcrun lldb` after it, the
  Command Line Tools' lldb last and labelled *simulators only* — and each is TRIED
  (`lldb --version`, short timeout) so that present and working are not confused. The first that
  answers is used; the ones that failed are kept so a failure can name what was tried. With only the
  Command Line Tools installed, a device read says so instead of pretending.

## 0.3.3

### Fixed

- **A dead lldb session was reused, which locked the whole LLDB route.** After a failed attach the
  session object stays behind in state `dead`, and `lldbEnsureAttached` accepted it: `attach`
  answered `ok: true, reused: true` while its own summary said `lldb exited (status dead)`, and every
  operation after that answered *"the lldb session is dead"* until the plugin was restarted. A dead
  or exited session is now disposed and replaced instead of reused.
- **A debugger that attached and then went silent was left holding the device.** That is what makes
  the next attempt hang in exactly the same way. Measured on 蜜语-Dev: two stuck `lldb` processes
  (one of them an orphan over an hour old, whose parent had died), after which every attach stayed
  silent for 90 s — while the build itself was perfectly debuggable (`get-task-allow = true`, a
  Debug build). A silent failure now ends its own child before reporting, and the note says the
  device has been released and a retry will work, instead of leaving the user to guess.

  This also corrects a wrong diagnosis: the anti-debugging-guard explanation was reached for an app
  that has no such guard. The guard case is still recognised (see 0.3.2) — it is just not the first
  thing to assume when a build is debuggable and a previous debugger never let go.

## 0.3.2

### Fixed

- **A debugger that cannot attach is no longer offered a takeover that cannot work.** An app that
  refuses debuggers — `ptrace(PT_DENY_ATTACH)`, or a check of its own — cannot be attached to, and
  `mode=launch` cannot help either, because the guard turns away the debugger that launches it just
  as firmly. The failure note used to say exactly that and then suggest taking the app over in the
  same breath, with a **Take over** button beside it, which sends the user into the same refusal
  again. Measured on 蜜语-Dev: 90 s of attaching and not one line back.

  The two failures now have separate diagnoses, in `lib/attach-failure.js` where they are tested:
  the console-session case keeps both remedies (*stop the run*, *take the app over*), and the
  refusal case drops takeover entirely and points at the routes that need no debugger — a build
  without the guard, or reading the tree from inside the app (LookinServer, or a debug-only hook
  that logs `recursiveDescription`). The drawer offers no **Take over** button for a refusal, and
  the app, not the plugin, is named as the reason.

## 0.3.1

### Fixed

- **A workspace stopped restoring the device you chose.** Two separate causes, both of which
  replaced an explicit choice with a guess, and both now have tests — the host's `preferred` branch
  had none at all, which is how the first one survived.

  1. `pickDefaultDestination` refused to honour a remembered destination whose record said
     `available: false`. A **shut-down simulator** is exactly that, and Xcode starts one on demand —
     so the panel forgot the simulator the moment it was shut down and fell back to the
     recommendation. Reachability is now asked of the source rather than of the choice: an
     unavailable simulator is still a destination, an unreachable phone still falls through.
  2. The panel stores the last destination LIST as well, so a return visit can paint before
     `-showdestinations` answers. That cache carries the recommendation of the day, and painting
     from it overwrote `state.destination` with that guess — which then travelled to the host as
     `preferred`. On every return visit the host was therefore told to prefer the guess over the
     workspace's own choice. The remembered choice now wins whenever it is still in the cached
     list; only a choice that is gone falls through to the recommendation, as before.

## 0.3.0

### Added

- **A detail pane in the drawer: Lookin's view of one node, without Lookin.** Clicking a view in the
  tree asks the host about that one view and opens a pane beside it — the control's own `Solo` image
  and its `Group` image, its frame and bounds, its background colour as a swatch, its layer class and
  its inheritance chain. `xcode_lldb` gained a `node` op for it: the images come out of the last
  read's renders held in memory (bounded at 12 MB) and are handed over as data URLs, one view per
  click, because the tree is text and a screenful of renders is not. The rows are built by the host
  (`lib/view-details.js`), which is where `recursiveDescription`'s object descriptions — a colour
  printed either as components or as a dynamic colour's *name*, a layer as another object — are
  parsed, so they are covered by tests rather than by eye.
- **The Lookin action appears only where Lookin.app does.** `/Applications/Lookin.app` and
  `~/Applications/Lookin.app` are checked directly, with `mdfind -name Lookin.app` as the fallback
  for an install somewhere unusual, and the answer travels with every read and every state poll.
  With the app the drawer offers `Lookin`; without it the same slot offers `Reveal` — the `.lookin`
  file in Finder — because a button that says Lookin and quietly opens Finder is a lie. The file is
  written either way: it is a useful artifact on its own, and a machine without Lookin is exactly
  where opening it elsewhere starts.

- **The view tree the debugger reads is now a `.lookin` file Lookin.app opens.** `xcode_lldb`'s
  `view-hierarchy` writes `/tmp/dsh-xcodebuild/lookin-<when>.lookin` as it reads, returns its path,
  and a new `lookin` action opens it; the drawer grows a `Lookin` button that appears once there is a
  tree to open. This is for the app that only a debugger can reach — no `LookinServer` in it, or none
  that can be added — which now gets Lookin's tree view instead of a text dump. Ten files are kept.

  The format was not guessed at, and three separate checks were needed before Lookin's classes would
  decode the file — each of which a well-formed-looking file passes while showing an empty tree:

  1. **Keys.** `LookinHierarchyInfo` and `LookinAppInfo` archive under the numeric keys `"1"`..`"8"`
     rather than their property names; every other class uses its property names. Written the wrong
     way round, the file decodes to the right class and `serverVersion` with a null payload.
  2. **Value types.** `alpha`, `screenWidth`, `screenHeight` and `screenScale` are read with
     `decodeDoubleForKey:`, so an integer-valued double must be a plist `<real>`.
     NSKeyedUnarchiver's answer to `<integer>1</integer>` is "value for key (alpha) is not a 64-bit
     float", and it then abandons the entire object: the node keeps its structure and loses every
     field.
  3. **Frame space.** Frames are the superview-relative numbers LLDB prints, not window coordinates:
     LookinServer stores `layer.frame` and converts to the window only to sanity-check it, and a real
     capture holds a view at `x = 66528` — a scroll view's content coordinate, impossible as a window
     coordinate in a 390-wide window.

  What was checked and found right: `frame`/`bounds` are the **string** `{{12, 55}, {366, 747}}`
  (which is what the real UIKit writes for `encodeCGRect:forKey:` and what the client writes too),
  numbers and booleans stay inline, `oid` is an inline integer, strings and arrays live in the
  archive's object table, and `plutil` keeps `CF$UID` references as UID objects.

  The method is the part worth keeping: load Lookin.app's own `LookinShared.framework` and decode the
  file with the classes that will read it. Its classes now decode the whole tree — every node, its
  class chain, frame, alpha, hidden flag and label text — with no unarchiver error. `layerObject` is
  still left nil, because a text dump names the view's class and says nothing about its layer.

  **The views' own images.** Each node carries the two images Lookin shows, and both are rendered
  *inside* the app, because one screen capture can produce neither: `solo` is the control alone,
  with its sublayers hidden while its layer is drawn — exactly what
  `CALayer+LookinServer.m -lks_soloScreenshotWithLowQuality:` does — and `group` is the control with
  its subtree. A crop of a screenshot was the first attempt and it is the wrong shape of thing: a
  region of a flat image is never the control alone, and for anything scrolled off screen it is not
  even a faithful view of the control.

  Measured on a real tree: the window's solo image is 8.7 KB of mostly transparency against a 66 KB
  group image of the whole screen, and for a `UIStackView` the solo render covers 0.0% of its pixels
  against the group's 92.0%. Across the 33-node tree, 12 of 31 nodes have solo and group that
  differ — the containers — while self-drawing leaves (a status light, a text view) are identical,
  which is what both should be.

  Two dead ends are worth recording, because both looked like they worked:

  1. Naming each file after the view's address needed `(uintptr_t)(__bridge void *)view` through the
     C variadic `snprintf`, and a variadic call from an LLDB expression reads the wrong register:
     all 32 renders were written to `solo-93ccf4258ac9d1ca.png`, one constant garbage address,
     overwriting each other. Files are now named by walk index and the report carries each view's
     `description`, which is how the host matches one to its node.
  2. The expression must reach the debugger as ONE line behind `po` — a multi-line statement
     expression is refused as `'({' is not a valid command` — and every call whose return type LLDB
     says it does not know needs a cast (`UIGraphicsGetCurrentContext`, `-stringValue`,
     `-firstObject`), because one of those failures cascades into "expected identifier" errors
     further down.

  The screen-capture path is still there, and still checked: on a simulator it is `xcrun simctl io
  screenshot`, on hardware `idevicescreenshot`, cropped per view with `sips`. It is now only the
  fallback, for a device with no `devicectl` or a render the app refused. The crop offsets were checked the only way
  that settles it: cropping a view's computed rectangle and comparing it against the same region
  taken out of the capture pixel by pixel — 0 of 115668 pixels differ, while a centre crop of the
  same size differs in 115610. Frames are relative and a capture is absolute, so this is also what
  proves the walk that turns one into the other.

  Either way the images land in the same three shapes the real files use, and each was measured
  rather than assumed: PNG bytes as plist `<data>`; the two `oid -> image` dictionaries as
  `NS.keys`/`NS.objects` **plist arrays** with the oids as bare numbers in the object table
  (NSKeyedUnarchiver reads them back as NSNumber, and refuses an NSArray *object* there — "value for
  key (NS.objects) is not an array"); and one entry per node in each dictionary, since solo and group
  are now genuinely different images.

  Bounded on purpose: the archive writes a buffer referenced from the item, its sibling field and
  both dictionaries exactly once; the fallback's crops below 8 points are skipped and resampled to at
  most 480 pixels, covering at most 200 nodes. A 33-node tree with 31 rendered views makes a 1.0 MB
  file. A capture that fails — a locked device, a missing tool — leaves the tree intact and reports
  itself beside the file.


## 0.2.3

### Fixed

- **An attach that gets nothing back is now named for what it is.** A device attach that is merely
  slow says something eventually; an app that refuses a debugger — `ptrace(PT_DENY_ATTACH)`, or a
  check of its own — says nothing at all, ever. Measured on an iPhone 13 in the same minute: a
  known-good app attached in 8.5 s and answered `po`, while the app in question produced not one line
  in 46 s. The note now says so, and points at the two routes that can still work (a build without
  the guard, or reading the hierarchy without a debugger, as Lookin does), instead of leaving the
  user to guess whether the plugin or the app is at fault.
- **A non-ASCII app name is found in the process list.** devicectl reports the path
  percent-encoded — an app called 蜜语-Dev arrives as
  `.../%E8%9C%9C%E8%AF%AD-Dev.app/%E8%9C%9C%E8%AF%AD-Dev` — so matching the name as the panel prints
  it against the URL as it arrives found nothing, and a running app was reported as not running.
  Names and paths are decoded before they are matched or quoted back.
- **The device attach cap is 90 s** instead of 120 s. The slowest successful attach measured here was
  40.7 s, so 90 s still covers a cold device while a refusal is reported in a minute and a half.

## 0.2.2

### Fixed

- **The debugger finds the app before attaching to it, instead of waiting for it.**
  `device process attach -n <name>` does not mean "attach to the process with this name" — it means
  "wait for a process with this name to appear", and it holds LLDB's command interpreter while it
  waits. Measured on an iPhone 13: a View Hierarchy press for an app that was not running left the
  transcript at `device process attach -n 蜜语-Dev` with no answer at all, not even to the
  `process status` probe sent eight seconds later, because the probe was queued behind it. The
  drawer never filled in, and the session could not be interrupted out of it either. The pid is now
  resolved first from what is actually running — `devicectl device info processes` on hardware,
  `simctl spawn launchctl list` on a simulator — and the attach is by pid, so an app that is not
  running becomes one sentence naming what is missing, in 0.3 s instead of never. A pid taken from a
  run that has since restarted is retried once after re-resolving.
- **Build & Run boots a simulator that is not booted.** `simctl install` on a Shutdown device fails
  with "Unable to lookup in current state: Shutdown", and Xcode boots it for you; `simctl
  bootstatus -b` now runs first, about ten seconds cold and nothing when the device is already up.

## 0.2.1

### Added

- **`Continue`**, in the drawer and as `xcode_lldb action=continue`. Reading a view tree stops the
  app and leaves it stopped, so without this the only way to let it go again was to detach — which
  also ends the session. It appears exactly when the app is being held stopped, which is the state
  a dump leaves behind, and `Interrupt` appears in its place while it runs.

## 0.2.0

### Added

- **A debugger drawer, and the app's view hierarchy as text.** `⌘L` — or the `LLDB` button in the
  panel's status row — opens a strip along the bottom of the panel that is hidden the rest of the
  time. Its `View Hierarchy` button attaches LLDB to the app this workspace last ran, stops it, and
  draws the key window's view tree: class, address, frame, text, hidden flag, and a stack view's
  `axis`/`distribution`/`alignment`, filterable by class or text. A box at the bottom takes any raw
  LLDB command, and the transcript is the same session the model uses.
- **`xcode_lldb`**, a seventh tool: `view-hierarchy`, `command`, `attach`, `interrupt`, `detach`,
  `status`. The session persists between calls — a device attach measured 6-25 s while every question
  after it is immediate — and one session is kept per plugin instance, because two debuggers on one
  app fight over it. A session the model starts opens the drawer, transcript and all.
- **The prompt section and the `xcode-build-loop` skill route to it**, so "why does this screen look
  wrong" reaches the view tree without the user naming a tool.

### Fixed

- **A thread's `stop reason = …` line no longer counts as the process being stopped.** LLDB prints
  one while it still reports `Process N is running`, so trusting it made the session claim it could
  run expressions when every one of them was refused with "the process must be stopped because the
  expression might require allocating memory". Only `Process N stopped` and a settled
  `Target 0: (name) stopped.` mean stopped now. (Measured attaching a second debugger to an app a
  Build & Run session was holding.)
- **An LLDB expression error is noticed wherever it is indented.** LLDB aligns the `error:` line
  under the caret it draws, so matching only column 0 made a compile failure look like an expression
  that evaluated to nothing — which is how an empty view hierarchy was reported for a command that
  never ran.
- **A sentinel from another command no longer appears in a command's output.** The `process status`
  probes sent while an attach settles print their senders later, in the middle of whatever command
  comes next; the first `po` after an attach came back with a foreign `<<<xcb-lldb:4>>>` line ahead
  of its real answer.
- **`mode=launch` starts the app running rather than suspended.** A process stopped before its first
  line has no windows and no Objective-C runtime: with `devicectl --start-stopped` the dump came back
  `error: use of undeclared identifier 'UIApplication'`. The app is now started for real, given time
  to build its UI, and stopped by the attach itself.

## 0.1.3

### Fixed

- **A plugged-in phone is no longer lost when `xcodebuild -showdestinations` omits it.** Measured on
  an iPhone 13 (iOS 26.6.2) under Xcode 26.0.1: the device disappeared from `-showdestinations` while
  `xcrun xcdevice list` still reported it available, `devicectl` still reported its tunnel connected,
  and `xcodebuild -destination id=<udid>` still built — so the panel offered a simulator for a phone
  on the desk. Destination discovery now merges four channels (`-showdestinations`, `xcdevice`,
  `devicectl`, the classic USB channel) by device id, records which sources saw each device, and only
  ever raises reachability: a channel that cannot see a device has no vote.

### Changed

- **The classic channel is no longer filtered to iOS 16 and earlier when listing devices.** That
  version gate belongs to the install path (`needsLegacyChannel` decides the channel per run), not to
  discovery, where it hid any modern device that only lockdown could still see.
- **Reachability leads the destination order**, ahead of "every device before every simulator": paired
  phones that are not connected sort to the end and show as `(not connected)` in the panel, and the
  `recommended` default is never an unreachable device.

## 0.1.2

### Added

- **The model knows when to use the tools.** A short system-prompt section
  (`ctx.systemPrompt.section`) routes Xcode work to the `xcode_*` tools instead of
  raw `xcodebuild`/`simctl`/`devicectl` in the shell, and names the tool for each
  situation. The full procedure is a runtime skill, `xcode-build-loop`
  (`ctx.skills.register`), which the model loads only when an Xcode task comes up.
  Both are optional services, so a profile without them still mounts the tools.
- **The panel follows runs the model starts.** `xcode_run` tags its run with the
  calling session's working directory, so the panel on that project adopts it: the
  log restarts and streams, scheme / configuration / destination follow what is
  building, and the status row says `by agent`. Stop works on it as on any run.

### Fixed

- **An app that dies after launch fails the run** instead of settling green
  (`lib/app-death.js`); the panel shows `app died` with the reason.

## 0.1.1

The first tagged release. `0.1.0` went out with the listing but was never tagged, so
everything below has been on `main` since then and a `github:` install has been picking
it up already — this release marks a point and names what is in it.

### Added

- **The panel docks into the shell's own right sidebar**, for a shell without
  `dsh-better-sidebar` — via `ctx.sidebarRightTabs.register`, the same registry the
  shell's **Files** tab uses. The panel is a tab type there, offered in that sidebar's
  **Guide** and in its add-tab menu, with the chip and the close button drawn by the
  shell. Because each of the two sidebars arrives whenever it arrives, `syncSeats()`
  reads both and gives a seat back when it has to, so the arrival order cannot leave the
  panel docked in two places, or in none.
- **One mark in every seat.** The plugin is recognised by the same four-blade drawing as
  the header control, the icon `dsh-better-sidebar` draws in its tab strip, the shell's
  Guide capsule, the shell's tab chip, and the floating panel's head row. Each drawing
  declares its own gradient, because several seats are on screen at once and `url(#…)`
  would otherwise resolve to whichever identical definition the document happens to hold
  first. `test/client-interaction.test.mjs` compares the drawn path across the seats, so
  "the same mark" is a test result rather than a claim.
- **`xcode_device_log` on an iOS 16 device.** CoreDevice covers iOS 17 and later; a
  device older than that is absent from it, so `xcrun devicectl device copy from` does
  not exist there. Pass `bundleId` and the app's **own** per-launch log
  (`Documents/PPCrashLog/log_<timestamp>.log`) is read out of its sandbox — the file that
  survives a crash and is readable while the device is locked — and `mode: "syslog"`
  gives the live `idevicesyslog` window instead.
- **`xcbeautify`, when it is installed** — the raw output when it is not. The plugin
  ships no formatter and requires none: the build works either way, and only the reading
  of it changes.
- **Filtering and searching, kept apart.** A filter changes which lines exist as far as
  the panel is concerned, and can reach lines the browser no longer holds by asking the
  host. A search changes nothing: it marks the hits inside the lines already on screen.
  `⌘F` opens the bar, `Esc` clears it, `↑`/`↓` walk the filters used before, and a
  `Problems` shortcut joins the severity toggles.
- **Session-file cleanup.** The per-launch console files, the paths they are redirected
  to, and the classic channel's leftovers all accumulate in the temporary directory and
  are cleaned by whoever wrote them — which is nobody. The plugin now prunes its own.
- **Locked-device detection.** A launch onto a locked screen fails without saying why, so
  both channels are asked the question that explains it — is a passcode being demanded
  right now? — and `xcode_doctor` reports the answer.

### Changed

- **The header control is an emblem, not the word `XcBuild`.** A drawn X rather than a
  typed one, so the weight does not follow whatever font the shell has: four tapered
  blades with the crossing left slightly open. A word beside a status dot reads as
  clutter in a row of icon controls, and a small thin X reads as *close*, so the drawing
  is oversized for its tile on purpose. The name survives in the tooltip and the
  accessible label; the run's status rides the corner of the tile.

### Fixed

- **The panel never invents a workspace.** `workspaceFor` answered with `process.cwd()`
  when it had nothing, which made an absent project look like a valid one; it now answers
  nothing, and the panel asks instead of guessing.
- **The session is named from either seat**, the header seat naming it whenever the dock
  cannot — previously the panel could show one session's title while another session's
  log streamed underneath it.

### Tests

3,405 checks — 3,328 across 17 unit suites, plus 77 in the mount suite — up from 2,876
(2,804 + 72) at 0.1.0, with eight suites added. Every suite is a plain `node` script run
by `npm test`; the mount suite is `npm run test:mount`.
