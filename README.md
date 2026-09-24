# XcBuild

An Xcode build and development loop for [DeepSeek Harness](https://github.com/deepseek-ai): build,
test, clean, archive and run an iOS/macOS project, with a live build log you can filter — driven
either by the agent through six tools, or by hand from a panel inside the conversation.

Inspired by the SweetPad VS Code extension. The package and composition row keep the id
`dsh-xcodebuild`; **XcBuild** is the name shown in the UI.

## What it adds

**Five model-facing tools**

| Tool | Purpose |
| --- | --- |
| `xcode_doctor` | What this machine has and what it lacks, with the install command for each gap, plus the Xcode in use. Run this first when a device will not install or launch. |
| `xcode_project` | Detect a `.xcworkspace` / `.xcodeproj` / `Package.swift`; list schemes, configurations, targets, and any SweetPad defaults in `.vscode/settings.json`. |
| `xcode_destinations` | `xcodebuild -showdestinations` — simulators, USB devices, My Mac — each with a ready-to-use destination string, plus iOS 16 hardware that `-showdestinations` omits. |
| `xcode_run` | `build` / `test` / `clean` / `archive` / `run`. Streams the full log into a background run and returns the collected compiler errors. `run` installs with `simctl` on a simulator, `devicectl` on a device CoreDevice knows, `ideviceinstaller` + `ios-deploy` on iOS 16 and earlier, and does neither for macOS. |
| `xcode_log` | The run's log: buffered tail, incremental slice by line number, or a regex-filtered view. Safe to call mid-build. |
| `xcode_device_log` | The log of a simulator (`simctl spawn`, snapshot or a bounded live window) or of **physical hardware**. On iOS 16 and earlier, pass `bundleId` and the app's **own** per-launch log (`Documents/PPCrashLog/log_<timestamp>.log`) is read out of its sandbox — the file that survives a crash, readable while the device is locked; `mode: "syslog"` gives the live `idevicesyslog` window instead. |

**A panel**, in three seats, taking whichever sidebar the shell has:

- **Docked in `dsh-better-sidebar`**, when that plugin is installed — via
  `ctx.betterSidebar.registerTab`, so it appears as a tab in its workbench (right sidebar or bottom
  panel) with a title chip and a close button supplied by the host. The tab is added from
  better-sidebar's own list; there is deliberately **no permanent header button**, because a second
  fixed entry beside the session title would only be clutter once a sidebar can host it.
- **Docked in the shell's own right sidebar**, when better-sidebar is *not* installed — via
  `ctx.sidebarRightTabs.register`, the same tab registry the shell's **Files** tab uses. The panel
  becomes a tab type there, listed in that sidebar's **Guide** (a capsule carrying the title and
  description) and in its add-tab menu; the shell draws the chip and the close button. Same rule: no
  header button, because the sidebar offers the tab itself.
- **Floating** — the fallback for a shell with neither sidebar: the same panel in `shell.overlay`,
  with its own head row and close button, and a header button to open it — that button is the only way
  in when there is no sidebar to add the tab from, so it survives for exactly that case and renders
  nothing otherwise.

**One mark wherever it is docked.** The plugin is recognised by the same four-blade drawing in
every seat: the header button's emblem, the icon better-sidebar draws in its tab strip, the shell's
Guide capsule, the shell's tab chip, and the floating panel's head row. The seats disagree about how
a size is handed over — better-sidebar calls `icon(size)`, the shell's Guide renders `entry.icon` as
a component and passes `{size, className}` — so one component (`Mark`) is the drawing and a one-line
adapter answers the first shape. Each drawing declares its own gradient, because several seats are on
screen at once and `url(#…)` would otherwise resolve to whichever identical definition the document
happens to hold first. `test/client-interaction.test.mjs` compares the drawn path across the seats,
so "the same mark" is a test result rather than a claim.

The two sidebars are alternatives rather than layers: better-sidebar wins when it is there, and the
official right sidebar is the fallback. Because each service arrives whenever it arrives,
`syncSeats()` reads both and gives back a seat it has to, so the arrival order cannot leave the panel
in two places or in none.

Both are reached through `ctx.inject([…], …)` and deliberately **not** through `dsh.client.inject`.
That list is a hard dependency: naming `dsh-better-sidebar` (or the right sidebar's package) there
would stop this plugin's client half from loading for anyone who does not have it, which is the
opposite of having a fallback. All three seats are covered by `test/client-interaction.test.mjs`.

Whichever seat it lands in, the panel gives you: a project picker (below), scheme / destination / configuration selectors with a
`⟳` beside the destination list that re-reads it on demand, Build / Run / Test / Clean / Archive / Stop,
a colour-coded streaming log, and a filter bar.

## Choosing a project

Naming a directory is not enough to name a project. A real iOS checkout offers several, and almost
all of the extra candidates are noise:

```
Gemoy.xcworkspace                     ← the one you want
Gemoy.xcodeproj                       ← the target list that workspace already wraps
Gemoy.xcodeproj/project.xcworkspace   ← inside the bundle above
PodCache/MLeaksFinder/*.xcodeproj     ← a cached pod
OtherProject/YNLive/YNLive.xcworkspace ← a genuinely different project
```

So the path field **searches** rather than asserts, and the search result decides:

- one hit — adopted outright, no question asked;
- several — a picker listing each by name and relative path, so the choice is informed rather than a
  guess made for you;
- none — said plainly, as an empty answer rather than an error.

A chosen project keeps a **Change** button that brings the picker back. Two rules remove the noise:
a search never descends *into* a `.xcodeproj` / `.xcworkspace` (they are bundles, not containers of
other projects), and a `.xcodeproj` sharing a basename with a `.xcworkspace` beside it is dropped as
the workspace's own target list. `Pods`, `PodCache`, `Carthage`, `build`, `DerivedData`, `node_modules`
and dot-directories are skipped, the walk is depth-limited, and it is capped so a huge tree cannot
stall the panel.

## Filtering, and searching

**Filtering and searching are different questions, and the panel keeps them apart.** A filter changes
which lines exist as far as the panel is concerned — they disappear, and it can reach lines the
browser no longer holds by asking the host. A search changes nothing: it marks the hits inside the
lines already on screen and takes you to them.

### Filtering — which lines

Two axes, combined:

- **Text** — committed **on blur**, not on every keystroke. Typing a filter is one intent and running
  it is another; a per-keystroke filter would re-query the host and repaint the list on every
  character, churning the log under the caret while the pattern is still half-written. Press Enter or
  click anywhere else to apply (the field outlines in amber while uncommitted). `Esc` clears. `↑`/`↓`
  walk the filters used before, without committing one.
- **Severity** — the four levels a system log has, in its own words: `verbose`, `info`, `warning`,
  `error` (see the table below for how the app's `LogLevel` is written to the device). A build log has
  more kinds of line than that, so the build-only ones join the level they belong to: the compiler's
  `note`s are part of a diagnostic and sit with the warnings, the progress chatter (`CompileSwift`,
  `Ld`, …) is the lowest level there is, and sections, test results and "BUILD SUCCEEDED" are
  information. How a line is *drawn* does not change — a note is still grey, a finished build is
  still green. The toggles apply immediately, joined by a `Problems` shortcut for "the diagnostics
  only" (which keeps notes with their warnings). The levels are drawn from one table in
  `lib/client.js`, and the suite walks the buttons and proves that between them they reach every kind
  the classifier can produce — a kind with no button would be a line nothing could ever show again
  once it was off.

Text filtering runs **on the host**, not in the browser. The panel keeps a rendering window of the
log; the host retains the last 20 000 lines per run. A filter that only searched the browser window
would silently miss the beginning of a large build — exactly the case where you reach for a filter.
The `.*` button switches the pattern to a regular expression; an invalid one falls back to the local
substring match instead of erroring on every poll.

### Searching — where in those lines

**`⌘F`** (or `Ctrl`+`F`) opens the search bar at the top of the log. It is hidden the rest of the
time: a whole row of the panel is a lot to spend on a job that usually takes a second, and the
binding is the one a browser's own find has already taught everyone. While it is open the caret is
in the box — a second `⌘F` selects what is there, so typing replaces it. **An empty bar closes
itself when focus leaves it** — clicking away, or `Esc` — because an empty search box is a row of
the panel with nothing in it. The judgement is made on blur and never on the keystroke: deleting a
character to retype it is not the user saying they are done, and a bar that vanished mid-edit would
be a bar you could not type in. Focus moving to the same box in another seat of the panel (docked
and floating can both be mounted over one store) is not "leaving" either. The bar searches **what is on screen**, live, and hides nothing:

- The **count is live** — `3 / 17` — because "is this string in this build at all" is the question
  you are asking while typing, and making you press Enter to find it out would be the filter's
  behaviour applied to the wrong question.
- Every occurrence is **highlighted**, and the line you are currently on is highlighted differently,
  so the number in the count and the mark on screen always agree.
- **`↑` / `↓`** (and `Enter` / `Shift`+`Enter`) walk the hits and **wrap around** the ends; they are
  greyed out when nothing matches, and the count says `no hits` rather than `0 / 0`.
- Moving to a hit **scrolls it to the middle of the view** and stops the view following the tail —
  the `↓ Latest` button appears, which is how you get back to watching the build. Typing alone never
  moves the log; only asking to go somewhere does.
- The needle is **literal text, case-insensitive**, never a pattern: a build log is full of `[`, `(`
  and `*`, and `(` has to find a bracket rather than be compiled. `Esc` clears.
- Hits **past the render window are still reachable**: the window (last 2 500 lines by default)
  follows the current hit, so pressing `↓` cannot walk into lines that are no longer in the DOM.

### ↑/↓ walk what each box was given before

Both boxes keep their own history — the filter's and the search's are separate, because a filter and
a search are different questions — and `↑`/`↓` walk it the way a shell does: `↑` is back in time and
`↓` is forward, at the oldest entry it stays rather than wrapping, and `↓` past the newest puts back
the half-written text that was in the box when the walk started. **Only finished inputs are
remembered**: a filter when it is committed (Enter or clicking away), a search when it is finished
with (Enter, or `Esc`). So `↑` never offers a prefix of what is being typed, and typing again ends
the walk — which is what makes `↓` mean "my draft" again.

## What it needs on the machine

Run the `xcode_doctor` tool — or open the panel, which says the same thing in a warning row — to see
which of these are present, with the version of Xcode in use. Missing entries are reported with the
command that installs them; a tool that is absent is never left to surface later as
`spawn … ENOENT` or as a device-not-found that blames the phone. The classic channel's three formulae
are the only optional gap the doctor offers an install command for: a missing `xcbeautify` changes how
the log reads and nothing else, so it is reported without being turned into advice to install the
device toolchain.

| Tool | Provided by | Needed for |
| --- | --- | --- |
| `xcodebuild`, `xcrun`, `xcode-select`, `plutil` | Xcode and macOS | everything |
| `idevice_id`, `ideviceinfo`, `idevicesyslog` | `brew install libimobiledevice` | seeing, identifying, and reading the log of an iOS 16 or earlier device |
| `ideviceinstaller` | `brew install ideviceinstaller` | **installing** onto such a device |
| `ios-deploy` | `brew install ios-deploy` | **launching** on such a device |
| `xcbeautify` | `brew install xcbeautify` | turning build output into one line per task, with warnings and errors marked. Optional, and used automatically when it is installed |

**These are three separate formulae, and that is the trap.** `brew install libimobiledevice`
provides neither `ideviceinstaller` nor `ios-deploy`, so following the obvious instruction leaves
both install and launch broken:

```sh
brew install libimobiledevice ideviceinstaller ios-deploy
```

The device tools are optional in a strict sense — simulators, macOS, and every device Xcode manages
through CoreDevice (iOS 17 and later) need none of them. They are not optional if you plug in an
iPhone X, because `devicectl` cannot see it at all: it is not merely refused there, it is absent from
`xcrun devicectl list devices`, which is why such a device used to fail as one that does not exist.

`test/dependencies.test.mjs` scrapes every command `lib/index.js` can run out of its own source and
fails if one is not registered, so this table cannot silently fall behind the code.

## Installation

```sh
dsh plugin --profile web add /path/to/this/directory
```

Then restart the profile.

### A `link:` install needs the host package linked too — or DSH lands in Safe Mode

`lib/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` as a runtime **value**. Host
packages are deliberately not dependencies: a plugin installed normally resolves them by walking up
the directory tree into `profiles/node_modules`, where the deployment puts them.

A development install from a directory is recorded as `link:`, which puts the plugin's real path
somewhere outside the profile tree — so that walk never reaches `profiles/node_modules`, the import
fails, the plugin tree fails to load, and **DSH treats a failed plugin load as fatal: it recovers into
Safe Mode with every third-party plugin disabled.** The tell is in
`~/Library/Logs/DSH Desktop/harness.log`:

```
plugin recovery detection: dsh-xcodebuild
[desktop] safe mode: third-party web profile bundles are blocked
```

The loader's own message is misleading — it reports the outermost specifier, because its retry path
swallows the real error:

```
Cannot find package 'dsh-xcodebuild'        ← not the actual problem
Cannot find package '@deepseek-ai/dsh-tools' imported from .../lib/index.js   ← the actual problem
```

So after any `rm -rf node_modules`, run:

```sh
npm run link-host
```

`node_modules/` is gitignored, so a fresh clone needs this once. To avoid the fragile link entirely,
install the plugin as a real package instead — pack it and add the tarball, so it lands under the
profile where host packages resolve on their own:

```sh
npm pack
dsh plugin --profile web add file:/absolute/path/to/dsh-xcodebuild-0.1.1.tgz
```

## Notable behaviour

- **Derived data is Xcode's own**, so builds stay warm for Xcode.app as well. Pass
  `derivedDataPath` to redirect it.
- **The built `.app` is located via `-showBuildSettings`**, not by constructing a path: with the
  default derived data the product directory contains a per-project hash.
- **Log lines are classified in-process** (see `lib/classify.js`): the panel colours errors, warnings
  and tasks, and the severity filter groups them, so the kind has to be attached to each line as it
  arrives.
- **`xcbeautify` is used automatically when the machine has it**, and is invisible when it does not.
  Nothing is configured: `xcodebuild`'s output is piped through it, and the panel prints the pipeline
  it is running. Three details make that safe rather than clever:
  - Only the **flags that version lists in `--help`** are passed, and the resulting argv is then run
    once on a trivial line before any build relies on it. A formatter that rejects its argv exits at
    once and leaves the build writing into a pipe nobody drains; whatever that does to the build, it
    is not something a log formatter is allowed to cause. When the probe fails, the formatter is
    simply not used.
  - `NSUnbufferedIO=YES` is set on the formatter. Measured on xcbeautify 2.28.0: with stdout on a pipe
    rather than a terminal its own output is **block buffered**, so the panel would receive the whole
    build log at the moment the build ended — no progress, and no errors while they still mattered.
    With it, lines arrive as the build produces them (measured at 0.8s / 1.5s / 2.2s against a producer
    printing every 0.7s, versus one 6000-byte burst at the end).
  - `--preserve-unbeautified` is included, because xcbeautify silently **drops** the task lines it does
    not recognize (`CompileSwift`, `Ld`) without it, and `--disable-colored-output` keeps escape
    sequences out of a panel that does its own colouring.
  Set `DSH_XCODEBUILD_NO_BEAUTIFY=1` to leave it off on a machine that has it. If the formatter dies
  mid-build the run keeps going with raw output and says so on its own line.
- Archives land in `~/Library/Developer/Xcode/Archives/` so Xcode's Organizer lists them.
- **A workspace is asked twice for its configurations.** `xcodebuild -list -json -workspace X.xcworkspace`
  answers with `{ workspace: { name, schemes } }` and reports **no configurations at all** — the
  configurations belong to the `.xcodeproj` inside. Asking only the workspace therefore makes every
  project look like it has nothing but `Debug` and `Release`; a project that also builds `Test-Release`
  silently loses it from the picker. `listSchemes` follows up with the wrapped `.xcodeproj` (named
  after the workspace, or the only one in the directory) and merges the two answers. The merge is a
  pure function in `lib/listing.js`, pinned against real captured output by `test/list-schemes.test.mjs`.
- **`run` picks its install tool from the destination**, not from a default.
  `platform=iOS Simulator,…` installs with `xcrun simctl`, `platform=macOS,…` with neither (the
  built `.app` is already the runnable artifact), and `platform=iOS,…` splits further by asking the
  device its own version. `simctl` cannot see hardware at all and answers `Invalid device: <udid>` —
  which is how `run` used to report failure *after* a successful device build.
- **Two device channels, split by iOS version rather than by the shape of the id.** `devicectl` is
  CoreDevice, and CoreDevice begins at iOS 17: an iPhone X on iOS 16 is not merely refused there, it
  is absent from `devicectl list devices`, so an install against it failed as a device that does not
  exist. The same generation is still reachable over the classic lockdown protocol, so the device's
  own `ProductVersion` decides (`< 17` → libimobiledevice). The threshold governs the destination
  list too, because `-showdestinations` omits exactly the devices CoreDevice does not manage;
  `showDestinations` appends what xcodebuild left out, so hardware that is not yet prepared for
  development can still be chosen at all.
- **Both channels launch as an attached session, and the modern one was wrong about that.** A one-shot
  `devicectl device process launch` returns in a second and leaves the panel with nothing to read: the
  app's own logging only exists while something is connected to it. `--console` is the modern equivalent
  of the classic attached session — it connects the app's standard streams and waits for it to exit — and
  measured on the iPhone 12 it put **128 KB** of the app's own `[I]`/`[D]`/`[V]` lines into the panel in
  the first twelve seconds, live, in the same format the classic channel only ever had in a file. A signal
  sent to that session is forwarded to the app, and which one ends it was measured rather than assumed:
  devicectl **ignores SIGINT** (it survived it, and so did the app), while **SIGTERM** terminates the app
  — devicectl reported `App terminated due to signal 15` — and then ends devicectl itself. ios-deploy's
  handler treats SIGTERM like SIGINT and SIGKILLs its own group, so one signal now means the same thing on
  both channels: Stop sends SIGTERM, escalates to SIGKILL after five seconds if the session has not ended
  by itself — a hung devicectl would otherwise be a run that can never leave `running` — and
  `settleAttachedRun` settles both channels the same way, with the run `running` for as long as the app is.
- **The modern container reader is a different tool, and it is 55 times faster.** iOS 17 and later reach
  the app's data container with `devicectl device copy from --domain-type appDataContainer
  --domain-identifier <bundleId>`, which needs no debug session and no developer disk image: measured,
  the whole log directory — four files, 348 KB — arrived in **0.9 seconds**, against 50 seconds for the
  2.4 MB the classic `ios-deploy --download` moved. That is what makes it a fallback rather than a last
  resort, and it is armed only by continued console silence: devicectl's own launch line arrives whether
  or not the app ever writes, so the *app's* own line — the one carrying its pid — is the proof that the
  console is carrying its logging, and a reader that starts anyway would put every line in the panel
  twice. Both channels read the same file with the same helpers in `lib/legacy-applog.js`, because it is
  the same app writing it.
- **Every look at the device list shows the cache and then refreshes it.** A test bench plugs and
  swaps hardware all day, so the list has to be re-read on every look or it goes stale invisibly — and
  `xcodebuild -showdestinations` takes seconds, so waiting for it before drawing anything is what made
  the control feel dead. Both happen instead, in that order: the cached list is painted immediately with
  its age on screen (`cached 2m5s ago · refreshing…`, in the stale colour), and the command runs
  regardless and replaces it. A look at the list *is* a refresh — the panel, adopting a project, changing
  the scheme, opening the dropdown and the `⟳` button each re-read it, and the only thing skipped is a
  second read while the first is still running. A read that lands while the dropdown is open is held and
  applied when it shuts, because rebuilding an open `<select>`'s options can close the list the user is
  choosing from. The cache is keyed by scheme, because destinations follow the scheme — a
  scheme that only builds for simulators must not be shown another scheme's hardware. The selection is
  re-validated against the live list, so a phone unplugged since the cache was written disappears from
  the list and the selection moves to the host's recommendation instead of pointing at nothing.
- **The list is ordered, and re-ordered on every refresh.** xcodebuild's own order is neither grouped nor
  stable for a bench: `platform:macOS` is printed first, and the iOS 16 devices this plugin discovers
  itself are appended after everything — so a phone plugged in a moment ago appeared last, below a dozen
  simulators, exactly when it was the thing being looked for. `sortDestinations` imposes a total,
  deterministic order — connected hardware, then simulators, then a Mac; concrete entries before generic
  placeholders; names read the way a person reads them (`iPhone 9` before `iPhone 12`, numbers before
  letters so `iPhone 16` precedes `iPhone X`); newest OS first; and the host's own order as the final
  tiebreak, so two records that agree on everything never swap under the pointer. Being total is what
  makes a newly connected device take its place in the list rather than appearing at the end.
- **The legacy install and launch are two different tools on purpose.**
  `ideviceinstaller -u <udid> -i <app>` installs. Launching uses
  `ios-deploy --noinstall --noninteractive`, because ios-deploy's own install path fails against this
  generation of AMDevice with `0xe8000067` while its lldb-driven launch works — `--noinstall` is the
  entire point of the pairing. Neither tool reports its outcome in words, so neither is read for one;
  the launch witness below is what decides.
  Both tools are brewed rather than shipped by Xcode, so they are resolved from the Homebrew prefixes
  instead of assumed to be on the PATH the harness was launched with.
- **A launch is a launch only when something says the app is running.** What decides is the app's own
  new log file: an iOS 16 app writes `Documents/PPCrashLog/log_<timestamp>.log` as its process starts, so
  a name that was not in the container before the launch is a device fact, not a claim. Nothing
  ios-deploy prints can be read instead — the `success` line comes from `str(startup_error)` the moment
  `Launch()` returns, i.e. before the process is known to be alive, and the message that would contradict
  it is never printed at all, because Python block-buffers stdout when it is a pipe and `os._exit`
  discards the buffer (`python3 -c "print('x'); import os; os._exit(1)" | cat` captures zero bytes). The
  old `exitCode !== 0 && !/^success$/m.test(stdout)` test let that line veto a real failure and reported
  every legacy run as launched, with `artifact.pid === null` and nothing on the device. A `run` whose
  install or launch fails reports `failed`, with the reason in `note` and `errors`, even though
  `xcodebuild` itself exited `0`. `lib/legacy-launch.js` holds the wording of that failure, and
  `lib/legacy-applog.js` the witness it is built on.
- **`--justlaunch` is not passed, because it interrupts the app it just launched.** It implies `--debug`
  (ios-deploy.m:3688-3692) and then makes the attached path unreachable (:3400-3401): lldb `run`s the app,
  `safequit` detaches, the CLI returns — and on a real iPhone X the app comes up and is closed again as
  that happens, which is the "launches, then instantly goes away" symptom. An attached session is what
  keeps it up, so the launch is spawned **detached, in the background, with its console redirected to a
  file**, and the run stays `running` for as long as the session is attached. The flag is
  `--noninteractive` (`-I`) rather than `--debug`: it needs no stdin — a detached child has none — and
  `autoexit_command` reports the app's own fate as machine-readable markers (`PROCESS_EXITED`,
  `PROCESS_CRASHED`, `PROCESS_STOPPED`, `PROCESS_DETACHED`, `PROCESS_NOT_STARTED`) with a stack trace
  under the bad ones, which the panel colours as errors. `-O/--output` is still not passed: measured on
  the iPhone X with `-I -O <file> -E <file>`, both files stayed at **0 bytes** while the app's own log
  grew, because the app's output reaches the console through lldb rather than through the process's
  stdout — the console file this plugin redirects is the real capture, and the app's own log below is the
  live one. Stop ends
  it by signalling the child's process group, which is also why the child is detached: ios-deploy answers
  SIGTERM/SIGINT/SIGHUP by SIGKILLing its own group (:1460-1464), so a child sharing this host's group
  would take the host down with it. `-O/--output` is still not passed — that file is opened only by
  `autoexit` (lldb.py:103-106, ios-deploy.m:1143-1156) and would be an inert flag pretending to capture a
  console — the plugin redirects the child's own stdout and stderr instead.
- **The console is pulled into the panel by a separate reader.** `lib/log-tap.js` reads the file the
  launch writes to, every 300ms, and pushes complete lines into the run log the panel already streams:
  a fragment at the end of the file is carried rather than printed, a multi-byte character split across
  two reads is decoded with a streaming decoder, and a file that shrank (`>` instead of `>>`, a rotated
  log, a reused path) is read again from the start. The file stays on disk after the session, and the
  reader cannot block the launch or lose output the way a closed pipe would. Reading a file that a
  long-lived child owns is the whole reason this exists: nothing awaits that child.
- **The panel's live reader is the device's own log relay, not the app's log file.** The obvious source
  is the file the app appends to in its container, and it is the wrong one to read on a timer: measured on
  the iPhone X, `ios-deploy --download` of `Documents/PPCrashLog` took **50 seconds** for 2.4 MB, of which
  the current launch's log was **2 MB after ten minutes** of running. Nothing about that reader can be
  made fast — it moves the whole file to learn one new line, and the file only grows. `idevicesyslog
  -p <app>` instead streams lines as the app writes them: six seconds of that same app produced **289
  lines**. `lib/syslog.js` turns the stream back into text (`idevicesyslog` escapes every byte outside
  ASCII in the `cat -v` notation, so `\M-p\M^_\M^_\M-)` is 🟩 and `\M-e\M^F\M^E` is 内), and that
  decoder was checked against an independent implementation over **288 captured lines with zero
  disagreements**. Severity the device declared itself is the only thing painted as a diagnostic, and the
  app's system log has exactly **four levels**, read back the way the app writes them:

  | the app's level | written as `OSLogType` | on the relay | the panel |
  | --- | --- | --- | --- |
  | `verbose` (its `.verbose`/`.debug`) | `.debug` | `<Debug>:` or `[V]`/`[D]` | `verbose` |
  | `info` | `.info` | `<Info>:` or `[I]` | `info` |
  | `warning` | `.default` | `<Notice>:` or `[W]` | `warning` |
  | `error` | `.fault` | `<Fault>:`/`<Error>:` or `[E]` | `error` |

  `.default` is the one that has to be spelled out: the device calls it `<Notice>`, which reads like an
  ordinary line and is in fact the app's **warning** — the mapping is `osLogType(_:)`'s, and the token to
  level table in `lib/syslog.js` was read off libimobiledevice's own source rather than guessed (its
  os_trace path prints the header's raw level: `0` Notice, `0x01` Info, `0x02` Debug, `0x10` Error,
  `0x11` Fault). The app also marks every line with its own level itself, and that spelling is read too,
  because it is the only one the modern console carries: measured on the iPhone 12, a launch line reads
  `… Demo-Dev[29303:4901955] 🟦 [I] 11:41:19.145 PPTaskQueue[38] cpu:7 内存:40`. A line that declares no
  level at all leaves the question open for the text classifier, rather than being called `verbose` on no
  evidence. The feed is spawned with `-x`, so a phone that goes away ends the reader instead of leaving a
  process that looks alive and delivers nothing, and it is reconnected a few times before anything else
  takes over — but a stream that never delivered a line is not retried three times, because that is a
  relay refusing the device rather than a dropped cable: measured, `idevicesyslog` connects and exits
  immediately on an iPhone 12 running iOS 26.6.2, the same version split that routes that device to
  `devicectl` instead.
- **The container-file reader is the fallback, and only one of the two ever runs.** They carry the same
  lines in different formats, so running both would double every line in the panel. When the live stream
  cannot be had — an older toolchain, a relay that refuses, a phone that keeps disconnecting — the pump
  starts instead (`startAppLogPump`, with the marker-based diff in `newLinesSince`): it downloads
  `Documents/PPCrashLog` and streams what the newest log gained, no longer pausing ten seconds on top of a
  fetch that already takes tens of seconds, and retrying every five seconds rather than every second when
  the fetch fails, so a disconnected phone cannot turn it into a spin loop. The diff cannot count lines or
  track an offset, because each look is a fresh download of a file whose tail window slides; the last line
  already pushed is the marker, and a marker that has scrolled away is reported as "cannot tell" instead of
  reprinting a tail as if it were new.
- **The console file is still read, and lldb's buffering is defeated by the environment, not by a flag.**
  `lib/log-tap.js` reads the file the launch redirects its console to, every 300ms, and pushes complete
  lines into the same run log: a fragment at the end of the file is carried rather than printed, a
  multi-byte character split across two reads is decoded with a streaming decoder, and a file that shrank
  (`>` instead of `>>`, a rotated log, a reused path) is read again from the start. That reader is why the
  launch does not have to be awaited, and the file stays on disk after the session. What it cannot fix is
  lldb's own buffering: its output goes through an embedded Python that block-buffers when stdout is a
  file, and measured, the console file sat at a **half-written line for six minutes** while the app logged.
  A pty would line-buffer it, but the sandbox refuses `openpty` (which is what `script` needs), so the
  child gets `PYTHONUNBUFFERED=1` — verified to turn "nothing until exit" into "a line per print" — which
  is what makes the lifecycle markers (`PROCESS_CRASHED` and friends) arrive while they are news.
- **The lock is asked of the device, and only `true` stops a run.** Both channels answer the same
  question — is a passcode being demanded right now — with their own tool. On iOS 16 and earlier that is
  `ideviceinfo -k PasswordProtected`; on iOS 17 and later, where the destination is a CoreDevice
  identifier that libimobiledevice cannot resolve, it is `xcrun devicectl device info lockState`, read
  from the `--json-output` file because devicectl documents that file as the only interface meant for a
  program. Both are device facts: no developer image, no pairing session, nothing that has to be up. The
  classic key is not legacy-only either — measured, an `00008110-...` device answers it over the network
  (`-n`), so `devicePasscodeRequired` retries with `-n` when the plain lookup says "not found". A `true`
  stops the run before the launch, with the field it read named in the message; `false` launches, and so
  does an answer that could not be read, because a question that went unanswered is not evidence of a
  lock. `PasswordProtected=false` is *not* "the screen is on": this iPhone X reports `false` while its
  screen is locked, since no passcode is set, so the key answers "is a passcode being demanded" rather
  than "is the display lit". `lib/lock-state.js` holds both parsers and that rule.
- **Every launch tidies up after the last one.** Three kinds of file pile up in the temporary
  directories and none of them is removed by whoever wrote it: a console file per attached launch
  (`<tmp>/dsh-xcodebuild/xr1-<epoch>-ios-deploy.log`, which grows for as long as the app logs and whose
  name repeats because run ids restart at `xr1`), a `<tmp>/<UUID>/` per launch from ios-deploy — its
  prep-cmds path is a hard-coded `#define PREP_CMDS_PATH @"/tmp/%@"` (`src/ios-deploy/ios-deploy.m:29`),
  so that litter lands in `/tmp` whichever process starts it — and an app-log download directory that
  survives only if the host is killed mid-read. So a launch prunes first, from `lib/session-files.js`:
  the newest five console files stay (age then overrides keeping, at three days), and a leftover
  directory goes only once it has not been touched for **an hour** — a session being started writes its
  files within seconds, so silence that long is proof it is gone. Deletion is also attribution, never
  just age: a console file must carry a launch stamp, and an ios-deploy directory must name *this*
  device in its `fruitstrap_<udid>.py`/`fruitstrap-lldb-prep-cmds-<udid>` files. A file someone put in
  the plugin's own directory on purpose, another device's session, and macOS's own temporary
  directories are all left alone. Measured on the real `/tmp`: a three-hour-old directory for this
  device was deleted while the same-age one for another device, a ten-minute-old one, and the running
  session's own directory all stayed.
- **`idevicescreenshot` is not a lock oracle, and using it was a mistake worth recording.** It reports
  `Could not connect to screenshotr!` on a locked iPhone X, which makes it look like one — but screenshotr
  needs the developer disk image mounted, and mounting that image is exactly what ios-deploy's own launch
  does. The probe therefore failed for a reason the launch would have fixed, and it refused launches that
  would have worked.
- **The app's own log is the second positive witness on the classic channel.** Alongside the pid probe,
  the launch samples `Documents/PPCrashLog/` before and after and reports a file that was not there
  before. It is the strongest evidence available because it does not depend on the toolchain answering
  anything, and it obeys the same rule as the pid: presence decides, silence never does — the file is
  written as the process starts, so it can lag the detach. `artifact.appLog` names it when it appeared.
- **A physical device's log is not a simulator's, and an iOS 16 device has a third route.** There is no
  `simctl spawn` on hardware, and `idevicesyslog` keeps no history to query — it only relays the syslog
  live. On an iOS 17 and later device `xcode_device_log` therefore returns a bounded live window and
  says so, rather than implying a snapshot the device never had.
- **The app's own log is the one that survives, so on iOS 16 and earlier that is what is read.**
  CoreDevice cannot reach that generation at all, so `xcrun devicectl device copy from` — the route the
  modern channel uses to move files — does not exist there. The app does keep its own log, one file per
  launch, at `Documents/PPCrashLog/log_<timestamp>.log` in its container, and `xcode_device_log` reads
  the newest one when it is given `bundleId` (which is what selects the container). Two device facts
  decide the implementation, both measured on the iPhone X **while it was locked**: `ios-deploy --list`
  is a silent no-op on this toolchain — exit `0`, zero bytes, even for a path that does not exist — so
  the directory is downloaded whole (`--download=Documents/PPCrashLog --to <dir> --non-recursively`,
  3.4s for 420 KB) and enumerated on the host; and the download does not preserve the device mtime, so
  the file NAME, which the app stamps with its own launch instant, is the ordering key. Because a launch
  that failed leaves its evidence in the file rather than in the tool's output, this is the log that
  answers "it says it launched, so where is the app" — and it can be read while the device is locked,
  which is exactly when a launch cannot be attempted at all. `lib/legacy-applog.js` holds the pure half.
- **The panel's default path is the session's workspace**, read from `ctx.sessions.get(id).header.cwd`.
  The host's own `process.cwd()` is the harness directory and has nothing to do with the project the
  user opened, so the client sends its `sessionId` with every request. The path field is seeded once
  the answer arrives, and never overwrites what has been typed.
- **Naming that session is a two-seat job, and neither seat invents one.** The dock tab's `scope`
  carries the session and is authoritative, but a tab opened without a scope carries nothing — and
  session adoption used to be gated on the header seat also *displaying* the panel, a gate that closes
  permanently once better-sidebar owns it. The panel was then left with no session, the host was asked
  to guess, and it answered with its own launch directory: the visible result was a search of
  `…/dsh-desktop/launch-root` and "No .xcworkspace or .xcodeproj under launch-root". Now the header
  seat — mounted in every shell, and the one seat that always knows which session it was rendered for
  — names the session whenever the dock cannot, while an unscoped tab never clears what the other seat
  established. On the host side `workspaceFor` returns `''` when no session can be resolved rather
  than the process directory, so the worst case is an empty path field the user can fill, not a wrong
  directory the panel searches on their behalf.
- **Parked above the tail, the panel offers the way back in one click.** A semi-transparent button
  floats at the bottom right of the log whenever following is off, saying how many lines have arrived
  since the reader stopped — which is the difference between knowing it is worth clicking and
  guessing. One click puts the newest output on screen and re-arms following, which is what dragging a
  scrollbar to the end was doing by hand. It is anchored to a wrapper rather than to the scrolling
  element, because a button inside the scroller would scroll away with the content it exists to
  escape.
- **The log follows the tail until the reader leaves the bottom.** Returning to the bottom — and
  letting go there — re-arms it, so the panel keeps showing the newest line. The tolerance is 2px on
  purpose: with slack, parking a line or two above the end while reading would silently re-arm and
  yank the view away.
- **`Clear` empties the output, and the filter has its own clear.** They cannot be the same button:
  while a filter is active the rows come from the host searching the *whole* run, so clearing only the
  local buffer would let the next search pull every discarded line straight back. `Clear` therefore
  also sends a line-number baseline (`since`), and Esc clears the filter.
- **Reading the log is not the UI's job.** Polling starts in `apply()`, not from a component's
  effect. Tying it to a surface made the log's freshness depend on which slot happened to be
  mounted, so a build could be running with nothing advancing the view. Every surface can now come
  and go without the log stalling, and a component that renders nothing (the retired header entry)
  no longer adopts a session out from under the surface the user is watching.
- **A connected device is the default destination, and a remembered one outranks both.** The
  order is: what this project used last time, then connectable hardware, then a simulator, then
  macOS. Hardware leads because a plugged-in phone is the thing being tested on; the previous
  policy preferred a simulator, so the panel offered one with a device attached. The preference is
  validated against the live `-showdestinations` output, so hardware that has since been unplugged
  falls through instead of being offered stale. The host owns this order and the panel adopts the
  `recommended` it is given, so the panel and the `xcode_destinations` tool cannot disagree.
- **A workspace remembers its project, scheme, configuration and destination.** Switching away and
  back used to reset the panel, so the same four choices were re-made every time. The memory lives
  in `localStorage` keyed by workspace root — the only store that survives both a page reload and a
  DSH restart — and a browser that refuses storage loses the convenience, never the panel. A
  remembered project is adopted outright only when it is an exact match among the candidates; with
  several unseen projects the user still chooses, because guessing there would silently build the
  wrong one. A remembered scheme or configuration the project no longer offers is skipped rather
  than carried over.
- **Opening the panel searches the workspace by itself.** It used to land on a path with nothing
  behind it, so the project only appeared after clicking into the field and back out, or pressing
  search — a step the user had to remember every single time. The workspace is already known, so
  searching it is not a decision to hand over. It runs once per workspace, never on every repaint:
  the flag that gates it is what keeps a filter keystroke from starting another walk of the
  directory.
- **A workspace seen before paints from the store instead of walking the directory.** What is cached
  is the project's own description — its location, schemes and configurations — which changes only
  when the project is edited. The host is still asked in the background afterwards, so a project
  edited on disk corrects itself, and if the stored location has gone stale the panel falls back to a
  real search rather than showing an error where the project used to be. Destinations are
  deliberately **not** cached: hardware comes and goes, and a remembered device list would hide a
  phone plugged in since.
- **The panel names the revision of the host half it reached.** The profile mounts the host half
  once at boot and keeps it in memory, so an edit on disk is invisible until DSH restarts — and a
  stale process is indistinguishable from a broken fix from inside the UI. The harness log records
  warnings and errors only, so an `info` line would never be seen; `/state` therefore carries the
  source mtime and the panel renders it as a dim `rev <instant>`. Three separate reports in one
  sitting were all the same stale process, each diagnosed by hand-comparing timestamps.
- **`/start` answers at once; the run carries on detached.** That route used to `await` the whole
  run, which held a single HTTP request open for the entire build and — because the workspace tag was
  applied only *after* that await — left `/state` unable to report an active run while the build was
  happening. The panel therefore never polled, and a successful `Build & Run` showed neither an
  install nor a launch: those lines were written into a log the client had already stopped reading.
  The run is now tagged when it is created and returned immediately, with `run.done` settling when the
  work has. For the same reason the status stays `running` through install and launch — a poller stops
  at the first non-running status, so publishing `succeeded` before the product was on the destination
  is what hid the second half of the action.
- **A poll still in flight is not overlapped by the next tick.** `logNext` advances only once a
  response lands, so a `/poll` slower than the 500ms interval used to let the following tick ask for
  the same range and append it again: the same line twice, duplicate React keys, and a log growing
  twice as fast. The guard is per instance deliberately — each window that owns a log owns its `poll`.
- **`Build & Run` is labelled for what it does.** The action is a build followed by an install and a
  launch; a button reading only "Run" hid the expensive half, which is also the half that fills the log.
- **The install step reports itself.** `run` tees `devicectl`/`simctl` output into the log as it
  arrives, so a device install shows `Acquired tunnel connection…` and `App installed: bundleID: …`
  rather than a command line followed by silence. Collecting that output instead made a slow install
  look like a hang, and left the real reason visible only on failure.
- **`run` refuses Xcode's generic placeholder.** `Any iOS Device` names no hardware; passed on to
  `devicectl` it fails as a device-not-found, which points at the wrong thing. It is reported as the
  placeholder it is, and the fix is to pick the connected device.
- **Each workspace's panel is its own.** State is kept per session rather than shared, so opening a
  panel in one project never shows another's scheme, build or log; and a run records the workspace that
  started it, so the panel only ever lists — or silently adopts — its own. A run started by a *tool*
  carries no workspace and is claimed by none: the panel is for the builds the user starts.

## Layout

```
lib/ring.js       fixed-capacity per-run log buffer (O(1) push; see the test for why)
lib/classify.js   one kind per log line — drives colour, filtering and the error summary
lib/beautify.js   `xcbeautify`'s flags, the escape sequences to strip, and the pipeline line shown
lib/projects.js   which Xcode project a directory holds, and which ones it offers
lib/parse-destinations.js  `-showdestinations` parsing, destination kind, and the order the list is shown in
lib/listing.js    folding `-list -json` answers (a workspace needs two) into one listing
lib/legacy-launch.js  whether an iOS 16 launch actually happened — pure, so the `success` trap stays pinned
lib/legacy-applog.js  which `log_<timestamp>.log` is the newest launch, and where the AFC download lands it
lib/lock-state.js     whether the device is asking for its passcode, per channel
lib/syslog.js         the live feed: the device log relay's argv, its escaping, and its severity
lib/modern-launch.js  the CoreDevice launch: the console-attached argv, and how a launch is witnessed
lib/session-files.js  which files a previous launch left behind, and when they may be deleted
lib/log-tap.js        the separate reader that pulls a live launch's console into the panel
lib/index.js      host: run registry, the six tools, the panel's JSON routes
lib/client.js     browser: header toggle, dock tab, overlay fallback
test/             plain-node suites (no test framework) run by `npm test`
```

## Tests

```sh
npm test           # ring buffer, classifier, destinations, project search, listing, client, device channel
npm run test:mount # mounts the host half against a fake context (needs one link, see below)
npm run test:live  # real build against a real project (slow; needs Xcode)
```

- `test/ring-buffer.test.mjs` imports the shipped `lib/ring.js` (not a copy) and cross-checks it
  against a reference implementation over 300 randomised trials, then measures the eviction path the
  buffer exists to replace.
- `test/classify.test.mjs` pins the classification rules against real xcodebuild output — including
  the `file:line:col: note:` form that a line-start anchor never matches.
- `test/beautify.test.mjs` runs the **real** `xcbeautify` where it is installed: that it accepts exactly
  the flags passed to it, that its output still classifies as errors, warnings and tasks, that
  `--preserve-unbeautified` keeps the task lines it would otherwise drop, that a line is delivered
  while the build is still running rather than in one burst at the end, and that a formatter which
  dies mid-build leaves the run reporting the build's own exit code.
- `test/destinations.test.mjs` parses captured `-showdestinations` output for a 24-scheme
  CocoaPods workspace. Two bugs are pinned here: a value can contain a comma
  (`variant:Designed for [iPad,iPhone]`), so fields must be split on commas that begin another
  `key:` rather than on every comma; and `platform:macOS` is printed FIRST, so a "first entry wins"
  default silently targets My Mac for an iOS app.
- `test/find-projects.test.mjs` builds a synthetic checkout holding exactly the noise a real one
  does — a wrapped `.xcodeproj`, a workspace inside a bundle, `Pods`, `PodCache`, a dot-directory, a
  project past the depth limit — and pins which of them a search may offer.
- `test/client-interaction.test.mjs` mounts the browser half in jsdom and drives it, in all three
  seats: as a better-sidebar tab (asserting the contributed descriptor and that the header button opens
  the tab and mirrors it), as a tab of the shell's own right sidebar (asserting the registered type —
  id, kind, band, title, Guide capsule — that the body renders the docked panel, that the tab names its
  session, and that the header button goes away), and as the overlay fallback (open, close, reopen, and
  commit a filter on blur). The two sidebars are also mounted together in both arrival orders, proving
  the fallback seat is given back when the dock turns out to be in charge.
  It also walks the picker: two candidates are offered, clicking one adopts it, and Change brings the
  choice back. The device list is driven the same way, with a transport that answers late on purpose:
  the cached list and its age are on screen while `-showdestinations` is still running, the command is
  issued anyway, and the live list then replaces the cache — including a selection that no longer exists. This one earns its keep twice over — it caught the store draining its subscriber list
  on the first emit, which left every later click deaf.
- `test/destinations.test.mjs` pins the order the device list is shown in — hardware before simulators
  before a Mac, concrete before generic, natural name order, newest OS first, and the host's order as the
  final tiebreak — and then runs the same sort over the real 100+ entry fixture, asserting that every
  device precedes every simulator and that the list opens on concrete hardware.
- `test/dependencies.test.mjs` scrapes every externally-run command out of `lib/index.js` and fails if one is not in `DEPENDENCIES` with a purpose and an install command — the table above cannot silently fall behind the code. `test/device-channel.test.mjs` pins the CoreDevice boundary at iOS 17 — the real iPhone X
  (`16.7.12`, iPhone10,3) that exposed it included — and the rule that an unreadable version is never
  routed to the legacy channel, because a wrong guess that way shells out to a toolchain that may not
  be installed at all.
- `test/legacy-launch.test.mjs` feeds the launch verdict the exact tail a real iPhone X produced —
  `success`, then `safequit`, then nothing, exit `1` — and asserts it is a failure now that it means a
  session which ended before the app wrote its launch log. Its other half guards the opposite mistake: a
  silent `--get_pid` must never fail a run, because that probe reports nothing for a running SpringBoard
  either. The session's lifecycle markers (`PROCESS_CRASHED` and friends) are pinned as errors, so a crash
  cannot read as ordinary prose in the panel.
- `test/legacy-applog.test.mjs` pins the app-log route against the device it was measured on: the real
  `Documents/PPCrashLog` listing (three launch logs plus `watchdog_stall.log`, which must not be
  mistaken for one), the newest-by-name rule across an hour boundary, the exact `ios-deploy --download`
  argv, the local path that download produces under `--to`, the byte ceiling, and the marker diff the
  pump uses — including a repeated line, which must match its last occurrence so nothing already pushed
  comes back.
- `test/host-mount.test.mjs` mounts the plugin and asserts what it contributed: six tools with
  correctly compiled schemas, nine routes, and the route guards (405 / 400 / 200 / 500).
- `test/lock-state.test.mjs` pins both lock oracles against real output: the classic `false` the iPhone X
  printed **while its screen was locked** (which is why `false` never becomes "the device is unlocked"),
  the `00008110-...` device that answers the same key over the network, and the `passcodeRequired` JSON
  `devicectl` writes. The refusals are checked per channel too, so the classic one keeps its `43s` cost and
  the modern one does not borrow it.
- `test/modern-launch.test.mjs` pins the modern channel against the iPhone 12's real output: the
  `--console` argv, the container-copy argv with its domain pair, the app's own line recognized by name
  and pid (and a name like `App+Pro` staying literal instead of becoming a quantifier), the two
  witnesses and why the app's own line is the stronger one, and that a failed launch is not witnessed.
- `test/syslog.test.mjs` pins the live feed's decoding against lines captured byte-for-byte from the
  iPhone X: the emoji and the Chinese, the caret form that carries no dash (`\M^_` against `\M-p`, whose
  confusion silently eats three of a character's four bytes), a lone high byte reading as the replacement
  character rather than being dropped, an unrecognised escape surviving verbatim, the process name coming
  from the bundle, and `<Error>`/`<Fault>` being the only severity that paints a line red.
- `test/session-files.test.mjs` pins the cleanup policy as decisions about names and times: the launch
  stamp inside a console file's name beating its mtime, the keep-five rule, age overriding keeping, the
  one-hour boundary from both sides, and the three-way distinction that keeps a prune from being a
  danger — an ios-deploy UUID or this plugin's download versus macOS's own temporary directories, and
  one device's `fruitstrap` files versus another's. `test/prune-session-files.test.mjs` then runs the
  same prune against a real tree and asserts what survived as much as what went: `notes.txt` in the
  plugin's own directory, a two-minute-old session, another device's, and a marker-less directory all
  outlive it.
- `test/log-tap.test.mjs` pins the reader against the shapes a console file takes while it is being
  written: a partial line carried and joined to the next read, a Chinese line split mid-character by a
  byte boundary, `\r\n`, one line that never ends and must not be buffered without bound, and a file
  that shrank under the reader.
- `test/live-gemoy.mjs` drives the real tools against a project and checks a successful build, the
  log volume, warning classification, incremental reads, and the `-showBuildSettings` lookup.

The client test borrows `react` and `jsdom` from the deployment, so it expects the app at the
default `/Applications/DSH Desktop.app` path. The host half imports `@deepseek-ai/dsh-tools`, which
the running harness aliases for a mounted row rather than installing into the plugin. `test:mount`
therefore needs it resolvable — link the deployment's own copy, not a second install, or the module
instance under test is not the host's:

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools" \
  node_modules/@deepseek-ai/dsh-tools
```

`node_modules/` is gitignored, and the runtime never needs it.

## Security

The panel's routes are served by the profile's `webServer`, and every request is put through the
composition's `connection.requestRejection` first — the Host/Origin fence that defeats DNS
rebinding and cross-site calls, plus the browser auth cookie. No bespoke trust logic lives here, so
it cannot drift away from the rest of the GUI.
