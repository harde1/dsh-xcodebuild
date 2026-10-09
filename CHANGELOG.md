# Changelog

## 0.5.2

### Added

- **↑/↓ in the LLDB prompt walks the command history.**
  - The history holds every command the drawer sent: typed ones, and the ones a picked view's quick
    buttons sent. A typed `$v` appears already expanded, so a recalled command still names its view.
  - ↑ starts at the newest command. ↓ past the newest puts back what was being typed.
  - Typing leaves the walk.
  - The history keeps the last 100 commands; a command repeated back to back is kept once.

## 0.5.1

### Added

- **A picked view is the command bar's object.**
  - A chip above the prompt names the selected view (class and address). Its × deselects it.
  - One-click commands act on the view: `po`, `frame`, `superview`, `subviews`, `controller`, `tree`
    (`recursiveDescription`), `hide` (toggles hidden and redraws), and `flash` (a red border to show
    where it is).
  - Each button sends an ordinary lldb command, shown in the transcript as typed.
  - In a typed command `$v` stands for the view, e.g. `po [$v alpha]`.
  - A Swift class is addressed through `UIView *`.
- **Clicking the picked row again deselects it.** This closes its details and lets the command bar go,
  without a round trip to the host.

### Fixed

- **Two reads in a row no longer wait out a 15 s timeout.**
  - An interrupt sent before lldb had confirmed the previous `continue` fell into the gap and never
    stopped the app. On the simulator, every second quick command in a row timed out.
  - The session now treats the app as running as soon as it sends `continue`. A read that follows
    waits for lldb's `resuming` before it interrupts.
  - Ten quick commands in a row, live on the simulator: each paused the app for 215–304 ms.

## 0.5.0

### Changed

- **The app keeps running under the debugger, and each read or expression takes the shortest stop
  it can.** Measured with the plugin's own session on the iPhone 17 simulator:

  | | before | now |
  |---|---|---|
  | `po` while the app runs | refused, or the app held until Continue | 220–300 ms pause, then running again |
  | View Hierarchy (96 views) | app frozen from the read until Continue | 220–310 ms pause, then running again |
  | `process status`, `breakpoint list` while running | queued behind `continue` | 0–2 ms, no pause |

- **The interpreter runs asynchronously** (`SetAsync(True)` before anything else). In synchronous
  mode `continue` does not return until the app stops again, so every later command waited behind a
  running app. Asynchronous, `process interrupt` stops it in about 110 ms.
- **`pauseFor(work)` is the one way to read a running app.** It interrupts, runs `work`, and
  continues.
  - The quick View Hierarchy reads the tree and the class/screen facts inside one stop.
  - The full Lookin export holds one stop for its whole render.
  - A drawer command that needs a stopped process (`po`, `p`, `expr`, `call`, `v`, `frame`, `bt`,
    `thread backtrace`, `x`, `memory read`, `register`) uses it too. Anything else is sent as it is.
  - An app that was already stopped (a breakpoint, a manual Interrupt) is read as it is and left
    stopped.
- **Reusing an attached session no longer stops the app.** Only the read that needs a stop takes one.
- **The expression engine is warmed inside the attach's own stop.** The first ObjC expression of a
  session parses the runtime's types: cold, it held the app 873–2404 ms; warm, 6–80 ms.

## 0.4.13

### Fixed

- **The state light no longer contradicts the transcript.**
  - A drawer operation (a command, a read, a mount) answers with the session as it was when that
    operation finished.
  - That answer could land after a poll that had already read a newer state line, and paint the light
    back: green over a `Process N resuming` the transcript was already showing.
  - The panel now keeps an operation's session only when it is at least as new as the one it holds,
    judged by the host's line count.
- **A SIGKILL stop shows red, not green.**
  - Measured on 蜜语-Dev: after the app had been held stopped, the system killed it. lldb printed
    `Process N stopped`, then `stop reason = signal SIGKILL`, then `Target 0: (蜜语-Dev) stopped.`
  - Those lines read as a stop that expressions can run in, so the light turned green.
  - It is now reported as gone, with the reason in the light's hover text. The settled stop line that
    follows does not turn it back, and no expression is sent into the dying process.

## 0.4.12

### Fixed

- **View Hierarchy reuses the session that is already attached, instead of attaching again.**
  - A phone has two names, and they never matched:
    - the session keeps the CoreDevice identifier, the one lldb accepts (`B7485956-…`);
    - every later request arrives with the destination's hardware UDID (`00008110-…`).
  - Compared as plain strings, every read threw a working session away and attached from scratch,
    15–23 s on 蜜语-Dev each time.
  - The two names learned when the attach resolved them now count as the same phone.
- **No more stream of `Process N resuming`.**
  - Mounting, every read and an Apps pick each sent `continue` to "make sure" the app runs, even
    when it already did.
  - On a device lldb answers each one with another `resuming` line, or `Process must be launched.`
    while attaching.
  - `resume()` now continues only a stopped process.

## 0.4.11

### Fixed

- **The LLDB drawer no longer shows the same line two or three times.**
  - The cause: the host answered each poll with `lineCount` as the cursor, and `readLines(from)`
    includes line `from`, so every poll returned the newest line again.
  - As a result, `device select`, `device process attach` and `Process N resuming` appeared once per
    poll until the next line arrived.
  - The cursor is now the session's own `summary().next`, one past the last line. A test fails if
    polling ever repeats a line.

## 0.4.10

### Fixed

- **A device attach that was about to succeed is no longer cut off at 30 s.** Measured on 蜜语-Dev
  (iPhone 13, iOS 26.6.2):
  - `device process attach` returns in 1 s.
  - From then on, `process status` answers `Process N is running.` with
    `thread #1, stop reason = signal SIGSTOP`. The kernel has already paused the app while lldb loads
    its images.
  - The real `Process N stopped` / `Target 0: (蜜语-Dev) stopped.` arrives 15–23 s after the attach.
    `process interrupt` answers `Process must be launched.` the whole time. That is lldb's state, not a
    stale one in the plugin.
- **The state is probed from the first second, every 3 s, instead of from the eighth.**
  - Back to back on the same pid: probing from 8 s timed out at 30 s having heard nothing but
    `Process must be launched.`, while probing from the start stopped at 15–23 s.
  - Without those early answers, the stop was not noticed in time.
- **Seeing a SIGSTOPped thread extends the wait to 90 s.**
  - An attach that is visibly finishing gets time to finish.
  - One that shows no such sign still gives up at 30 s.

## 0.4.9

### Changed

- **View Hierarchy stops the app for as short a time as it can.**
  - The app is now held for exactly two expressions: the tree, and one batched question for the class
    chains and the screen size. It runs again before the Lookin file is built, converted and saved.
  - Before, it stayed stopped through up to 33 more round trips (one per class, three for the
    screen), and then through the file writing.
  - Classes already known from an earlier read are not asked again, so a second read of the same
    screen asks for the screen size alone.
  - If the batched expression is not understood, the read falls back to the per-class questions.
  - Measured against a live app on a simulator (10 classes plus the screen): 0.06–0.20 s batched,
    against 0.38 s one by one. A physical device, where each round trip costs more, gains more.
  - An empty tree also lets the app go at once.
  - The result reports `stoppedMs`, how long the app was held.

## 0.4.8

### Changed

- **Opening the LLDB drawer after a Build & Run mounts the launched app at once.** Before, the attach
  (the slow part, and the part that fails) only happened behind the first View Hierarchy, against a
  pid that could be gone by then.
  - The app is left running.
  - This happens once per launch. A mount that failed says why in the drawer and is not retried in a
    loop.

### Fixed

- **The pid is looked up on the device before every attach**, instead of being trusted from the run
  or the Apps list.
  - Such a pid goes stale as soon as the app restarts. lldb attaching to a pid that is gone answers
    only `Process must be launched.` (measured: 704 asked for while 754 was running).
  - A retry happens only when the device names a different pid, and uses a fresh lldb: the failed
    one is left `exited` and refuses every command.

## 0.4.7

### Added

- **The run log (build output and app log) has the same right-click menu as the LLDB transcript:
  Select All, Copy, Clear.**
  - Clear there is the toolbar's Clear. It drops the lines and moves the baseline, so neither the next
    poll nor a filter brings them back.
  - Both logs now share one menu, a fixed layer at the pointer that flips at the window's edge, so
    they cannot drift apart.

## 0.4.6

### Fixed

- **The LLDB transcript's right-click menu is no longer cut off when the log is short.**
  - It was positioned inside the drawer, and both the transcript (`overflow:auto`) and the panel
    (`overflow:hidden`) clipped it.
  - It is now a fixed layer at the pointer, above everything else.
  - Near the window's edge it opens toward the room there is, like a native menu.

## 0.4.5

### Added

- **Right-click menu on the LLDB transcript: Select All, Copy, Clear.**
  - The browser's own menu cannot take an extra entry, so the panel draws one.
  - Copy takes the selection, or the whole transcript when nothing is selected.
  - Clear empties the transcript in the panel. Its read cursor is not rewound, so what LLDB says next
    still arrives and the cleared lines do not come back.
  - The menu closes on a choice, on a click elsewhere, or on Esc.

## 0.4.4

### Fixed

- **Lookin cannot be pressed while the debugger is attaching** (the blinking yellow light).
  - Both exports read the tree, which needs the app stopped, and an attach in flight is exactly what
    has not delivered that stop yet. Clicking then only queued a second attach behind the first.
  - The button is now disabled while attaching, and while another drawer operation holds the debugger
    (the same rule View Hierarchy follows). Its title says what it is waiting for.
  - It becomes usable again as soon as the light turns green.

## 0.4.3

### Changed

- **The debugger's own state probes no longer print in the LLDB transcript.**
  - While an attach waits for the app to stop, the session asks LLDB on its own (`process interrupt`
    every 3 s, `process status` every 4 s). Each probe and its answer went into the transcript, so a
    failed attach filled it with `error: Process must be launched.` and buried what the user was
    typing.
  - Those probes are now quiet. Their lines still set the session state, and are still read when
    judging whether the attach failed, but the transcript no longer shows them. The user's own
    commands are unaffected.
- **A state light in the drawer head** is where that state shows now:
  - green: stopped, so expressions and View Hierarchy can run;
  - yellow: running;
  - yellow, blinking: attaching;
  - red: the process is gone for the debugger, or the debugger ended;
  - grey: no session.
  - Hovering it says the state in words.

## 0.4.2

### Fixed

- **The LLDB transcript's `↓ Latest` button floats over the lines, like the build log's.**
  - On the log tab the drawer body was the scroller. The transcript therefore grew to its content's
    height and never scrolled itself, so its scroll handler never ran, following was never switched
    off, and the button never appeared. Had it appeared, it sat inside the scrolled content and would
    have scrolled away with the lines.
  - On the log tab the body now holds the transcript to the visible height. The transcript scrolls
    itself, and the button is a sibling of it in a positioned wrapper: the same pill as the build log's
    (blur, fade, `↓ N new`), tucked into the corner.

## 0.4.1

### Changed

- **The LLDB transcript behaves like the build log.**
  - It follows its tail only while the reader is at the bottom. Scrolling up to read leaves the view
    where it is, instead of snapping back to the end on every new line.
  - A `↓ N new` / `↓ Latest` button brings it back and resumes following.
  - Returning to the log tab re-arms following.
  - Lines get the build log's number gutter and colours by kind: the echoed `(lldb)` command, `error:`
    lines, warnings, and process state changes (`Process N stopped / resuming / exited`).

## 0.4.0

### Added

- **Lookin offers a quick and a full export.** `View Hierarchy` now writes the tree alone, which is fast
  and stops the app only to read it. `Lookin` opens a choice:
  - **Quick** opens that file.
  - **Full** renders every view's own images in the background, in batches of 40. The app is stopped
    only while a batch renders, so the phone stays usable between batches. Progress is shown as stage,
    views rendered and percent, and stays in the drawer when the popup is closed. When everything is
    pulled, the file opens in Lookin by itself. `Cancel` stops after the batch in hand, releases the
    app and writes nothing.
- **History of the view trees read.** Exports are kept in `~/Library/Caches/dsh-xcodebuild/lookin/` with
  a metadata file beside each, so `History` can list them (kind, app, time, views, images, size) and
  open or delete each one. Only the newest three are kept, so disk use stays bounded. A delete accepts
  only names this cache writes, so it cannot step outside the directory.

### Changed

- `View Hierarchy` no longer renders images on every read. Rendering was most of a read's time, and
  most reads only want the structure.

## 0.3.29

### Fixed

- **The debugger drawer sits on the bottom edge even when the log above it is empty.** The empty log is
  its own element, `.xcb-empty`, and it had no `flex:1` — it was only as tall as its text, so the drawer
  below it drifted up and the panel's leftover height collected *under* the drawer. The empty state now
  takes the height the log would have taken, so the drawer is pinned to the bottom edge whether or not
  anything has been logged.

## 0.3.28

### Added

- **Closing the debugger drawer releases the debugger.** A session left attached holds the device and
  leaves the app stopped — the state that makes the next attach answer `already being debugged` — and a
  closed panel is not using it, so every way of closing the drawer now goes through one place that
  disposes the session (which detaches before it quits, so the app keeps running) and clears the
  panel's own picture of it. The host's `dispose` is idempotent, so a session this panel never knew
  about — one the model opened — is released as well. `Stop` already did this; closing now does too, so
  "I am done looking" and "I am done running" leave the device in the same state.

## 0.3.27

### Fixed

- **The app-log read no longer freezes the debugger.** Both went through `runLldb`, which takes one
  `busy` lock for the whole drawer: every 15 s the log read held it, and every button in the drawer is
  disabled while it does — up to half a minute when the fallback copies a log file over CoreDevice — so
  presses meant for the debugger were swallowed and the environment felt intermittent. Reading a log
  never touches lldb, so it now has its own lock (`appLogBusy`, which also refuses to start a second
  read) and its own message area: the log panel's error line carries the log's notes, the drawer's
  carries the debugger's. A click meant for `View Hierarchy`, `Interrupt` or `Continue` can no longer
  land while a log read is in flight.

## 0.3.26

### Added

- **The device list says how each phone is connected: `<name> (usb)` or `<name> (wifi)`.** A phone on
  Wi-Fi and a phone on a cable were the same row, and the difference decides what works — the classic
  channel (the live log reader, `ios-deploy`) needs the cable, while attaching and the view tree ride
  CoreDevice either way. `idevice_id -l` is the usbmuxd view of what is plugged in, measured empty with
  the phone on Wi-Fi and listing its udid the moment the cable went in, so it is the answer to "plugged
  in?" and nothing else has to be asked. A device no source could reach keeps its bare name instead of
  being labelled with a guess, and a row that already says how it is connected is left alone.

## 0.3.25

### Added

- **The app's log now arrives over CoreDevice, so a phone with no cable still has logs.** `idevicesyslog`
  speaks the classic USB channel, and a phone paired for Wi-Fi is absent from it (`idevice_id -l` empty
  while `devicectl list devices` reports it available) — reporting that was not a fix. CoreDevice has no
  live log stream and does not need one: the app writes its own log, and `devicectl device copy from`
  takes it out of the app's data container over the same tunnel that attaching uses. Measured on
  蜜语-Dev with no cable: the container listed `log_2026-10-08-10-19-16.683.log` (103 KB) and the copy
  came back with its last 300 lines, classified for the panel's level buttons like any other log. The
  bundle id is taken from the build the panel remembers, and looked up in the installed apps when it is
  not known. The refresh interval is 15 s rather than 5 because one of these reads takes tens of seconds.

## 0.3.24

### Fixed

- **`idevicesyslog`'s complaints were printed as if the app had logged them.** `Device with udid
  <udid> not found!` and `Could not start logger for udid <udid>` appeared in the log panel as app
  output. They are the reader failing to start, not the app talking: the app log needs the classic USB
  channel, and a phone reachable over CoreDevice alone (paired for Wi-Fi, no cable) is not on it —
  measured with `idevice_id -l` empty and `system_profiler SPUSBDataType` showing no iPhone while
  `devicectl list devices` reported the phone as available. That is now one sentence naming the channel
  and the fix, and the panel says it instead of showing lines the app never produced. Attaching and the
  view tree never needed this channel.

## 0.3.23

### Changed

- **The console hugs its bottom, and follows its own tail.** The debugger drawer keeps no bottom
  margin, its log area takes the height that is left and scrolls, and every new line scrolls it to the
  newest one — a terminal that does not follow its tail makes the reader scroll to find out what just
  happened.
- **An attached app's log arrives readable.** The device's line is
  `Sep 30 19:28:57 蜜语-Dev(libxpc.dylib)[751] <Notice>: activating connection: ...`: the process name is
  what the reader filtered BY, the library is a subsystem, and the level is already the line's kind, so
  the panel's colour says it. What is kept is `19:28:57 activating connection: ...`.

### Fixed

- **`Stop` ends the debugger as well as the work.** A session left attached holds the device and leaves
  the app stopped — the state nobody asked for, and the one that makes the next attach answer `already
  being debugged`. `Stop` now disposes the session (which detaches before quitting, so the app runs on)
  and only then stops the run, so it works even when there was no run to stop.

## 0.3.22

### Fixed

- **A refused attach now names WHO is holding the app.** "Another debugger already owns it" is half an
  answer, and the half it withholds is a fact this Mac holds: the plugin now reads `ps` and names the
  owner of the offending debugger — `Xcode is holding an app on this Mac right now (lldb pid 42159)` —
  and says the remedy with that name in it (`stop Xcode's debug session (⌘.), then attach again`).
  Xcode's debugger is a path, not a name, so the parent process is what identifies it
  (`/Applications/Xcode.app/Contents/Developer/usr/bin/lldb` → Xcode). Only this plugin's own tree is
  excluded; nothing belonging to anyone else is ever touched, because the point is to say the name,
  not to take the session.

## 0.3.21

### Fixed

- **A view read refused by the device now says which session is holding the app.** The device's answer
  is `Process <pid> exited with status = -1 (0xffffffff) tried to attach to process already being
  debugged`, and on iOS exactly one debugger can own a process, so this is not something to retry
  around: the other session must let go. Measured while diagnosing a stuck read, `ps -o pid,ppid,command`
  showed `/Applications/Xcode.app/Contents/Developer/usr/bin/lldb` parented by Xcode — Xcode was holding
  蜜语-Dev. The note now names Xcode and the one action that clears it (⌘. leaves the app running, so
  nothing has to be rebuilt or relaunched), instead of reporting an attach that never settled.

## 0.3.20

### Fixed

- **The selected app's log was put in the wrong panel.** It was drawn inside the debugger drawer, as a
  second log view of its own — which split one app's output across two places and hid it from the log
  panel's filtering, searching and following. It now goes into the log panel, which is the panel that
  already speaks this format: its four level buttons ARE a device log's four levels, and the host
  classifies each line with `lib/syslog.js` (`verbose`/`info`/`warning`/`error`, `plain` for anything
  else) exactly as the launch path does. An empty window and a missing reader are also told apart now:
  a failed read says so in the panel instead of looking like a quiet app.

## 0.3.19

### Fixed

- **The app log came back empty while the device had answered.** `tailLog` returns its lines JOINED
  into one capped string, because the tool that reads it prints it; the new app-log route handed that
  string to the panel, which reads lines, so it saw none — a window that had really captured 31 lines
  of 蜜语-Dev showed `nothing said in this window`. The route now splits it back into lines (the cap
  still applied), and the panel accepts a joined block as well as an array, because answering "no
  lines" to a log with content is worse than answering nothing. The window is 6 s by default, which is
  what a quiet app needs to say something.

## 0.3.18

### Added

- **A second press of `View Hierarchy` stops the read.** A view read is a device attach driving a
  debugger and can take half a minute; a read that cannot be called off is a panel that looks hung.
  While it is reading, the button says so and a press ends it: the debugger is released (`dispose`,
  which detaches before it quits, so the app is left running and the device is free for the next try)
  rather than the spinner merely being hidden. The answer already on its way is dropped by an attempt
  counter, so a cancelled read cannot repaint the panel with a tree nobody asked for any more. The
  button is disabled while ANOTHER action runs, but never while its own does — the click that stops it
  has to reach the button.

## 0.3.17

### Added

- **Choosing an app in the `Apps` panel also hooks its log.** The question that follows "which app is
  it?" is "what is it saying?", so the selection now opens the `Log` tab on that app's own log instead
  of leaving it to be asked for separately. The filter is the process name the running-app list already
  gives, so no bundle id has to be resolved first; each read is a bounded window off the device
  (`idevicesyslog -u <udid> -p <name>`), and the panel asks again every few seconds while the log is on
  screen — "live" is the panel reading again, not a reader left running on the phone, which would
  outlive the panel and hold the device open.

## 0.3.16

### Changed

- **The running-app list is a panel of its own, not a row of buttons.** A phone runs a few hundred
  processes and `Apps` returns the app ones, which is still a list to read and choose from: it now
  opens as a centred panel with one row per app — name on the left, pid on the right, the full bundle
  path on hover — the current choice marked, `Close` in its corner and a click on the backdrop
  dismissing it. Picking a row attaches to that app and closes the panel.

## 0.3.15

### Added

- **An `Apps` button lists the apps running on the device, and a pick is what gets attached to.** Which
  app is it? The device knows every process it runs, so that question no longer needs a build: the list
  gives each app process a pid, and the pid travels with the read. It is narrowed to app processes,
  because a phone runs a few hundred system ones and the app would have to be read past to be found —
  measured on 蜜语-Dev: 265 processes, one of them the app.

### Changed

- **A build IS a choice.** The app a successful run produced becomes the attach target by itself — name
  and pid — so `View Hierarchy` reads the app you just built without being told, and a process picked
  from the `Apps` list gives way to it. The target is remembered per workspace, so a reload or a DSH
  restart does not send you back to the list.

## 0.3.14

### Fixed

- **A running app can be read without building it again.** `View Hierarchy` sent only `continue`, so
  the host fell back to the last run for its destination and app bundle; after a restart, or in any
  workspace that had not been built in that session, there was nothing to attach to and the only way
  forward was another build or a relaunch. Attaching needs exactly two things — the device and the app
  bundle, whose file name is the process name — and the panel already knows both. They are now sent
  with the request and remembered per workspace, so `Attach to Process` on the app that is already
  running is the normal path: no build, no relaunch, no stopping the app first (it is stopped by the
  debugger asking, as in 0.3.13).

## 0.3.13

### Fixed

- **The session never asked the app to stop, so attaching to a running app waited forever.** Attaching
  to an app that is already running does not stop it — the debugger has to ask, which is what Xcode
  does. Worse, while the process runs, `process status` is QUEUED behind it and never answered:
  measured on 蜜语-Dev through this very session, both commands completed and then not one line came
  back for 30 s. The stop is now asked for with `process interrupt` (the one command LLDB answers
  while the inferior runs) and re-asked every few seconds until it arrives.
- **A session that goes away detaches before its debugger dies.** Quitting while attached leaves the
  phone believing a debugger still holds the process, and the measured cost is the next attach
  answering `tried to attach to process already being debugged`, after which even
  `devicectl device process launch --terminate-existing` stopped returning and the app could no longer
  be relaunched. That is the "always hangs" this plugin kept being blamed for, and part of it was this
  plugin's own exit path.
- **A state LLDB has already reported is no longer overwritten.** `running` was being replaced by
  `attaching` on the way into the wait, which hid the one state that says the attach WORKED.

## 0.3.12

### Changed

- **A silent attach is waited on for 30 s, not 90.** A refusal never answers at all, so waiting
  longer cannot turn it into a success, and 90 s of nothing is indistinguishable from a wedged
  channel while costing the user a minute and a half per try. `devicectl device process launch` is
  bounded at 30 s too, and says when it was the launch itself that never returned — launching is the
  device's control channel, one step before any debugger, and it was measured running past 84 s with
  no answer while `devicectl device info details` answered in 2 s in the same minute.
- **The silent failure names both real causes and the one test that separates them**, instead of
  asserting one. This note has now claimed an anti-debugging guard and then denied one for the same
  app; an app that refuses debuggers and a device with a wedged debug channel look identical from
  here. It now says to attach the same app from Xcode: if Xcode attaches, the app is turning
  debuggers away; if Xcode cannot either, the device's channel is wedged. On 蜜语-Dev the static
  evidence pointed at the first: `Error: sysctl, take 1|2` and the Cydia and MobileSubstrate paths
  in `Enshi/SDK/UMessage_Sdk_1.5.0a/libUMessage_Sdk_1.5.0a.a`, whose `+[UMessageProtocolData
  isDeviceJailBreak]` does the sysctl P_TRACED check. That reading was wrong as well, and this time
  it was settled by the object file rather than by reasoning: `UMProtocolData.o` references no
  `exit`, `kill`, `abort`, `raise` or `ptrace`, so the check detects and reports a debugger and
  cannot end the process — and a detector that cannot kill the app cannot make an attach hang
  silently. No `ptrace` import and no inline `svc #0x80` exist anywhere in the app either, so this
  build carries no blocking guard at all, and the silent attach is not an app-side refusal. What the
  same measurements DO show is the device's own control channel: `devicectl device process launch`
  ran past 84 s with no answer while `devicectl device info details` answered in 2 s in the same
  minute, and the same launch had returned in about 2 s earlier in the session. A guard is no longer
  offered as the likely cause.

## 0.3.11

### Fixed

- **0.3.9 matched the phone against the app's name, so every device read failed with
  "蜜语-Dev is not a device lldb can attach to".** Its fallback compared lldb's device names with
  the target's `name`, which is the process name, not the phone's. The hardware udid is now bridged
  to lldb's identifier through `devicectl list devices`, which reports both names of each phone
  (`hardwareProperties.udid` and `identifier`); the phone's own name is only a fallback, and the app's
  name is never used for it.

## 0.3.10

### Fixed

- **An attach error that arrived late was never read, so a 3-second answer became a 90-second
  "silence".** `device process attach -p` returns at once and its outcome is printed afterwards,
  asynchronously — after the command's own output slice has closed. The session judged "LLDB said
  nothing" from those slices alone, so it never saw the answer. Measured by hand on 蜜语-Dev with
  the same phone: lldb answered within 3 s — `error: attach failed: no such process` (debugserver
  `E96`). The attach now watches everything LLDB prints from the moment it begins, fails the moment
  an attach error arrives, quotes LLDB's words, and hands back what it printed. A probe's "not yet"
  error does not cut a slow attach short.
- **The anti-debugging-guard diagnosis is gone, because it was wrong.** It was reached from that
  false silence. 蜜语-Dev imports no `ptrace`, is signed `get-task-allow = true` with a Team
  Provisioning profile, and the phone reported Developer Mode enabled, DDI services available,
  paired and tunnel connected. The note now reports what LLDB said; for `no such process` it says
  the refusal comes from the phone's debugserver and offers the relaunch (`mode=launch`, the drawer's
  `Take over`), and real silence is reported as silence, with no cause invented.
- **The failure path threw.** It read `ready.cleared` inside the function that creates `ready`,
  which is a ReferenceError the moment an attach failed. It uses its own `cleared` now.
- **Every failed attach ends its own debugger**, not only a silent one, so no path leaves the app
  stopped or the device held.

## 0.3.9

### Fixed

- **The device was named to lldb in a way lldb does not accept, so every physical-device read hung
  and no tree ever appeared.** A phone has two names: `xcodebuild -showdestinations`, `xcdevice` and
  `devicectl` call it by hardware UDID (`00008110-000078242EBB801E`), while lldb's `device list` and
  `device select` know it only by its CoreDevice identifier (`B7485956-FD06-57E9-ACFD-D6D1E41EF111`).
  Handing lldb the first is the worst kind of failure, because it is silent: lldb does not report an
  unknown device, it selects nothing, and the `process attach` that follows waits forever. Measured
  on the same phone, same session: `device select` on the name lldb knows returned in **4 s**; the
  hardware UDID produced no answer in 90 s, every time.

  Before attaching to a device, the target is now resolved against lldb's own `device list` — by
  identifier, then by name — and used in the form lldb accepts. A device lldb does not have fails
  immediately, naming what lldb *can* attach to, instead of freezing the app and then reporting a
  timeout.

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
