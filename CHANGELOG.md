# Changelog

## 0.3.0

### Added

- **The view tree the debugger reads is now a `.lookin` file Lookin.app opens.** `xcode_lldb`'s
  `view-hierarchy` writes `/tmp/dsh-xcodebuild/lookin-<when>.lookin` as it reads, returns its path,
  and a new `lookin` action opens it; the drawer grows a `Lookin` button that appears once there is a
  tree to open. This is for the app that only a debugger can reach — no `LookinServer` in it, or none
  that can be added — which now gets Lookin's tree view instead of a text dump. Ten files are kept.

  The format was not guessed at. The keys are LookinServer's own, read off
  `LookinDisplayItem.m -encodeWithCoder:`, and the encodings were measured by archiving the same
  values with the real UIKit on a simulator: `encodeCGRect:forKey:` stores the **string**
  `{{12, 55}, {366, 747}}` (not a geometry object), numbers and booleans stay inline, and strings and
  arrays live in the archive's object table. A synthesized 4-node file was then opened by Lookin.app
  to confirm it unarchives without complaint, and the XML is converted to the binary archive by
  `plutil`, which was checked to keep `CF$UID` references as UID objects.

  Three deliberate narrowings, each because a text dump cannot answer: `layerObject` is left nil
  rather than invented from the view's chain, frames are accumulated to window coordinates, and the
  superclass chain is probed over the debugger (one expression per distinct class, cached per
  session) and falls back to the class name and its printed base class. Screenshots are not in this
  version.


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
