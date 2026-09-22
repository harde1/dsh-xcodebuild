# XcBuild

An Xcode build and development loop for [DeepSeek Harness](https://github.com/deepseek-ai): build,
test, clean, archive and run an iOS/macOS project, with a live build log you can filter — driven
either by the agent through five tools, or by hand from a panel inside the conversation.

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
| `xcode_device_log` | The unified log of a simulator (`simctl spawn`, snapshot or a bounded live window) or of **physical hardware** (`idevicesyslog`, always a bounded live window). |

**A panel**, in two seats:

- **Docked** — via `ctx.betterSidebar.registerTab`, so it appears as a tab in that plugin's workbench
  (right sidebar or bottom panel) with a title chip and a close button supplied by the host. The tab is
  added from better-sidebar's own list; there is deliberately **no permanent header button**, because a
  second fixed entry beside the session title would only be clutter once the sidebar can host it.
- **Floating** — the fallback for a shell without `dsh-better-sidebar`: the same panel in
  `shell.overlay`, with its own head row and close button, and a header button to open it — that button
  is the only way in when there is no sidebar to add the tab from, so it survives for exactly that case
  and renders nothing otherwise.

The dock is reached through `ctx.inject(['betterSidebar'], …)` and deliberately **not** through
`dsh.client.inject`. That list is a hard dependency: naming `dsh-better-sidebar` there would stop this
plugin's client half from loading for anyone who does not have it, which is the opposite of having a
fallback. Both seats are covered by `test/client-interaction.test.mjs`.

Either seat gives you: a project picker (below), scheme / destination / configuration selectors,
Build / Run / Test / Clean / Archive / Stop, a colour-coded streaming log, and a filter bar.

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

## Filtering

Two independent axes, combined:

- **Text** — committed **on blur**, not on every keystroke. Typing a filter is one intent and running
  it is another; a per-keystroke filter would re-query the host and repaint the list on every
  character, churning the log under the caret while the pattern is still half-written. Press Enter or
  click anywhere else to apply (the field outlines in amber while uncommitted). `Esc` clears.
- **Severity** — `Errors` / `Warnings` / `Info` toggles apply immediately, plus a `Problems`
  shortcut for "errors and warnings only".

Text filtering runs **on the host**, not in the browser. The panel keeps a rendering window of the
log; the host retains the last 20 000 lines per run. A filter that only searched the browser window
would silently miss the beginning of a large build — exactly the case where you reach for a filter.
The `.*` button switches the pattern to a regular expression; an invalid one falls back to the local
substring match instead of erroring on every poll.

## What it needs on the machine

Run the `xcode_doctor` tool — or open the panel, which says the same thing in a warning row — to see
which of these are present, with the version of Xcode in use. Missing entries are reported with the
command that installs them; a tool that is absent is never left to surface later as
`spawn … ENOENT` or as a device-not-found that blames the phone.

| Tool | Provided by | Needed for |
| --- | --- | --- |
| `xcodebuild`, `xcrun`, `xcode-select`, `plutil` | Xcode and macOS | everything |
| `idevice_id`, `ideviceinfo`, `idevicesyslog` | `brew install libimobiledevice` | seeing, identifying, and reading the log of an iOS 16 or earlier device |
| `ideviceinstaller` | `brew install ideviceinstaller` | **installing** onto such a device |
| `ios-deploy` | `brew install ios-deploy` | **launching** on such a device |

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
dsh plugin --profile web add file:/absolute/path/to/dsh-xcodebuild-0.1.0.tgz
```

## Notable behaviour

- **Derived data is Xcode's own**, so builds stay warm for Xcode.app as well. Pass
  `derivedDataPath` to redirect it.
- **The built `.app` is located via `-showBuildSettings`**, not by constructing a path: with the
  default derived data the product directory contains a per-project hash.
- **Log lines are classified in-process** (see `lib/classify.js`) rather than piped through
  `xcbeautify`. The panel colours errors, warnings and tasks, and the severity filter groups them, so
  the kind has to be attached to each line as it arrives.
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
- **The legacy install and launch are two different tools on purpose.**
  `ideviceinstaller -u <udid> -i <app>` installs. Launching uses
  `ios-deploy --noinstall --justlaunch`, because ios-deploy's own install path fails against this
  generation of AMDevice with `0xe8000067` while its lldb-driven launch works — `--noinstall` is the
  entire point of the pairing. Neither tool reports its outcome in words, so neither is read for one;
  the launch gate below is what decides.
  Both tools are brewed rather than shipped by Xcode, so they are resolved from the Homebrew prefixes
  instead of assumed to be on the PATH the harness was launched with.
- **A launch is a launch only when something says the app is running.** `--justlaunch` hands the
  launch to lldb, and the command that decides it is `safequit`: it detaches a process it saw in
  `eStateRunning` and exits `0`, and otherwise exits non-zero. What it prints is useless — the
  `success` line comes from `str(startup_error)` the moment `Launch()` returns, i.e. before the
  process is known to be alive, and safequit's own failure line never arrives at all, because Python
  block-buffers stdout when it is a pipe and `os._exit` discards the buffer
  (`python3 -c "print('x'); import os; os._exit(1)" | cat` captures zero bytes). An iPhone X on
  iOS 16.7.12 does exactly that: `success`, then silence, then exit `1`. Judging it on the `success`
  line — the old `exitCode !== 0 && !/^success$/m.test(stdout)` — reported every legacy run as
  launched, with `artifact.pid === null` and nothing on the device, and a launch that hung for five
  minutes as a nine-second run. `lib/legacy-launch.js` now holds the verdict: the exit code decides, a
  live `ios-deploy --get_pid` short-circuits to success, and the probe's silence never vetoes, since
  this toolchain reports no pid even for a running SpringBoard. A `run` whose install or launch fails
  reports `failed`, with the reason in `note` and `errors`, even though `xcodebuild` itself exited `0`.
- **A physical device's log is not a simulator's.** There is no `simctl spawn` on hardware, and
  `idevicesyslog` keeps no history to query — it only relays the syslog live. `xcode_device_log`
  therefore returns a bounded live window for hardware and says so, rather than implying a snapshot
  the device never had.
- **The panel's default path is the session's workspace**, read from `ctx.sessions.get(id).header.cwd`.
  The host's own `process.cwd()` is the harness directory and has nothing to do with the project the
  user opened, so the client sends its `sessionId` with every request. The path field is seeded once
  the answer arrives, and never overwrites what has been typed.
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
lib/projects.js   which Xcode project a directory holds, and which ones it offers
lib/parse-destinations.js  `-showdestinations` parsing, and destination kind, testable in isolation
lib/listing.js    folding `-list -json` answers (a workspace needs two) into one listing
lib/legacy-launch.js  whether an iOS 16 launch actually happened — pure, so the `success` trap stays pinned
lib/index.js      host: run registry, the five tools, the panel's JSON routes
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
- `test/destinations.test.mjs` parses captured `-showdestinations` output for a 24-scheme
  CocoaPods workspace. Two bugs are pinned here: a value can contain a comma
  (`variant:Designed for [iPad,iPhone]`), so fields must be split on commas that begin another
  `key:` rather than on every comma; and `platform:macOS` is printed FIRST, so a "first entry wins"
  default silently targets My Mac for an iOS app.
- `test/find-projects.test.mjs` builds a synthetic checkout holding exactly the noise a real one
  does — a wrapped `.xcodeproj`, a workspace inside a bundle, `Pods`, `PodCache`, a dot-directory, a
  project past the depth limit — and pins which of them a search may offer.
- `test/client-interaction.test.mjs` mounts the browser half in jsdom and drives it, in both seats:
  as a better-sidebar tab (asserting the contributed descriptor and that the header button opens the
  tab and mirrors it) and as the overlay fallback (open, close, reopen, and commit a filter on blur).
  It also walks the picker: two candidates are offered, clicking one adopts it, and Change brings the
  choice back. This one earns its keep twice over — it caught the store draining its subscriber list
  on the first emit, which left every later click deaf.
- `test/dependencies.test.mjs` scrapes every externally-run command out of `lib/index.js` and fails if one is not in `DEPENDENCIES` with a purpose and an install command — the table above cannot silently fall behind the code. `test/device-channel.test.mjs` pins the CoreDevice boundary at iOS 17 — the real iPhone X
  (`16.7.12`, iPhone10,3) that exposed it included — and the rule that an unreadable version is never
  routed to the legacy channel, because a wrong guess that way shells out to a toolchain that may not
  be installed at all.
- `test/legacy-launch.test.mjs` feeds the launch verdict the exact tail a real iPhone X produced —
  `success`, then `safequit`, then nothing, exit `1` — and asserts it is a failure. Its other half
  guards the opposite mistake: a silent `--get_pid` must never fail a run, because that probe reports
  nothing for a running SpringBoard either.
- `test/host-mount.test.mjs` mounts the plugin and asserts what it contributed: five tools with
  correctly compiled schemas, eight routes, and the route guards (405 / 400 / 200 / 500).
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
