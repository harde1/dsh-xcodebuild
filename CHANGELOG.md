# Changelog

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
