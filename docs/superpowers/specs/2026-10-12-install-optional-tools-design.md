# Install the optional tools from the panel, after the user confirms

## Problem

The panel's doctor row says `optional, for iOS 16 and earlier devices: …` and prints the
install commands. Users asked for the plugin to install them, with their permission,
instead of making them copy commands into a terminal.

## Scope

- Optional tools only: everything in `DEPENDENCIES` with `required: false` and an
  installer this plugin can run (`brew install …`, `pipx install …`).
- Never: Xcode or anything `required`, `sudo`, Homebrew itself, or a script from the
  network.
- Never without a click on "Install" in a confirmation that lists every command.
- No agent tool. The panel is the only entry point.

## Design

### `lib/install-tools.js` (new, pure)

`installPlan(tools, resolve)` takes the doctor's `tools` rows and a `resolve(command)`
lookup, and returns:

```js
{
  steps: [{ argv: ['/opt/homebrew/bin/brew', 'install', 'libimobiledevice', …], display: 'brew install …', tools: [...] }],
  skipped: [{ tools: ['pymobiledevice3'], reason: 'pipx is not installed — brew install pipx, …' }],
  missing: ['…every optional tool not ready'],
}
```

- Package names come only from each entry's own `install` string, parsed against
  `^(brew|pipx) install <pkg>( <pkg>)*$`. Anything else is skipped, so a future entry
  with a different shape cannot become a command by accident.
- All brew packages are merged into one deduplicated `brew install`; each pipx package
  is its own step, after brew (so `brew install pipx`, if a user does it first, helps).
- The installer is resolved to an absolute path, so a GUI app's thin PATH still finds
  `/opt/homebrew/bin/brew`. A missing installer turns its packages into a `skipped`
  entry with a reason and the manual fix.

### Host routes (`lib/index.js`)

- `installPlan`: `installPlan(doctor.tools, resolveTool)`.
- `install`: recomputes the plan on the host — the browser's copy is never executed —
  and starts a run with `action: 'install'`. Steps run in order with `spawnStreaming`;
  the first non-zero exit fails the run. Output streams into the run's log, so the
  panel's existing log, filter and Stop work unchanged. One install at a time.
  `HOMEBREW_NO_AUTO_UPDATE` is not set: brew's own behaviour is kept.
- `resolveTool` is not cached, so the next doctor read sees the new tools.

### Panel (`lib/client.js`)

- The doctor row gets an `Install…` button when the plan has steps.
- The button opens a confirmation popup (`popupShell`) listing each command, the
  skipped tools with reasons, and a note that it downloads from the network and may
  take minutes. `Install` starts it; `Cancel` closes and does nothing.
- While an install runs the button reads `Installing…` and is disabled. When the run
  ends, the doctor is asked again, so the row updates or disappears.
- The copyable command line stays for users who prefer a terminal.

## Testing

`test/install-tools.test.mjs`:
- all optional tools missing → one brew step with every formula, one pipx step;
- some missing → only those packages;
- brew missing → brew packages skipped with a reason, pipx still planned;
- pipx missing → pymobiledevice3 skipped with a reason;
- nothing missing → no steps;
- required tools are never planned;
- every planned package appears in its entry's `install` string.

Plus the existing suite (`npm test`).
