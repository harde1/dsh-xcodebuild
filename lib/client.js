/**
 * dsh-xcodebuild — browser half.
 *
 * Three additive contributions, all into existing slots, so nothing in the shell
 * is replaced: the build panel as an overlay entry, a small X emblem in
 * the session header, and — when a sidebar can host it — a tab in that sidebar,
 * either `dsh-better-sidebar`'s workbench or the shell's own right sidebar. The
 * toggle is what is left when neither sidebar exists; see `syncSeats`.
 *
 * The panel talks to its own host over the plugin's JSON routes rather than any
 * private channel — durable client plugins get no host-call primitive, and the
 * routes carry the composition's own trust fence. `fetch` is same-origin.
 *
 * Log filtering is split on purpose:
 *
 * - **Text** is committed on blur, not on every keystroke. Typing a filter is
 *   one intent; running it is another. Live-per-keystroke would re-issue a host
 *   query and repaint the log on every character — the list churns under the
 *   caret while the pattern is still half-written. Blur (or Enter) is the commit
 *   point, and clicking anywhere else blurs the field, so there is no lost work.
 * - **Severity** toggles apply immediately: they are one click with no partial
 *   state, and the count is right there to show the effect.
 *
 * @module dsh-xcodebuild/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-xcodebuild',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Slot the panel occupies; owned by the layout package. */
    const OVERLAY_SLOT = 'shell.overlay'
    /** Slot the toggle occupies, beside the other session-header utilities. */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** Route prefix served by this plugin's host half. */
    const ROUTE_PREFIX = '/_dsh/dsh-xcodebuild/'
    /** Where the panel remembers the last project path, across reloads. */
    /** Panel poll cadence while a build is running, and while idle. */
    const POLL_MS = 500
    /** Browser-side rendering window; the host retains far more than this. */
    const CLIENT_LINE_CAP = 10000
    /** Rows rendered at once — enough to scroll, few enough to stay smooth. */
    const RENDER_CAP = 2500

    // The tab type this plugin registers with better-sidebar. It doubles as the
    // tab's `type` in that plugin's state, which is how the header button knows
    // whether the panel is already showing.
    const TAB_ID = 'dsh-xcodebuild'
    /** What the plugin is called wherever a surface has to name it. */
    const TAB_TITLE = 'XcBuild'
    /** One line saying what the panel is for: the new-tab lists and the Guide show it. */
    const TAB_DESCRIPTION = 'Build, run and test a project with a live, filterable log'
    /** The official right sidebar's slots: a tab type's body, and its chip title. */
    const RIGHT_TAB_SLOT = 'sidebar.right.pane.tab'
    /** The chip (and a floating panel's header) that sidebar draws for a tab. */
    const RIGHT_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /**
     * The kind the official right sidebar dispatches our tab under.
     *
     * A kind is a tab discriminator, not an identity: the registry keeps one type
     * in force per kind, and `id` — which is also the key our body registers
     * under — is what names this implementation. Only the body is registered, so
     * the chip falls back to the title on the tab record itself.
     */
    const RIGHT_TAB_KIND = 'xcodebuild'

    // The severity levels the panel filters on, in the order they are drawn, and the one
    // place a kind is attached to a button.
    //
    // Data rather than a chain of if-branches, because a kind with no level is a line the
    // user can never bring back on screen or hide once it is off — and adding a kind to
    // the classifier would quietly create one. The suite walks these buttons and proves
    // that between them they reach every kind the classifier can produce.
    // The four levels of a system log, which is also what a build's lines are grouped by
    // so that one row of buttons covers both. The app's own logging has exactly these four
    // — `LogLevel` maps `.verbose`/`.debug` to OSLogType `.debug`, `.info` to `.info`,
    // `.warning` to `.default` and `.error` to `.fault` — and `lib/syslog.js` reads them
    // back off the device under these names.
    //
    // A build log has more kinds than that, so the build-only ones join the level they
    // belong to: the compiler's notes are part of a diagnostic and sit with the warnings,
    // and the progress chatter (`CompileSwift`, `Ld`, …) is the lowest level there is.
    // Nothing about how a line is drawn changes — a note is still grey and a finished
    // build is still green.
    const LEVELS = [
      { id: 'verbose', label: 'verbose', tone: '', kinds: ['verbose', 'task'], title: "Show the lowest level: the app's verbose/debug lines and the build's progress lines (CompileSwift, Ld, …)" },
      { id: 'info', label: 'info', tone: '', kinds: ['info', 'plain', 'section', 'test', 'success'], title: 'Show information: the app\'s info lines, sections, test results, and everything else that is not a diagnostic' },
      { id: 'warning', label: 'warning', tone: ' warn', kinds: ['warning', 'note'], title: "Show warnings — the app's own, and the compiler's, with the notes that explain them" },
      { id: 'error', label: 'error', tone: ' err', kinds: ['error'], title: 'Show errors' },
    ]
    const ALL_KINDS = LEVELS.flatMap((level) => level.kinds)
    /** Kinds the two diagnostics do not own: what `Problems` turns off. */
    const OTHER_KINDS = LEVELS
      .filter((level) => level.id !== 'error' && level.id !== 'warning')
      .flatMap((level) => level.kinds)

    const CSS = [
      '.xcb-panel.docked{position:static;inset:auto;width:100%;height:100%;border:0;border-radius:0;box-shadow:none;resize:none}',
      '.xcb-panel{position:fixed;right:16px;bottom:16px;width:min(840px,calc(100vw - 32px));height:min(520px,64vh);',
      'display:flex;flex-direction:column;background:#1b1d21;color:#dfe1e5;border:1px solid #33363d;border-radius:12px;',
      'box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden;resize:both;pointer-events:auto;z-index:60;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}',
      '.xcb-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#24262b;border-bottom:1px solid #33363d;user-select:none}',
      '.xcb-title{font-weight:600;font-size:12.5px}.xcb-sub{color:#8b949e;font-size:11px}',
      '.xcb-spacer{flex:1}',
      '.xcb-btn{appearance:none;border:1px solid #3a3e46;background:#2b2e34;color:#dfe1e5;border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer;white-space:nowrap}',
      '.xcb-btn:hover:not(:disabled){background:#343841}',
      '.xcb-btn:disabled{opacity:.45;cursor:default}',
      '.xcb-btn.primary{background:#2f6feb;border-color:#2f6feb;color:#fff}',
      '.xcb-btn.primary:hover:not(:disabled){background:#3b7bf5}',
      '.xcb-btn.danger{background:#8c2f2f;border-color:#8c2f2f;color:#fff}',
      '.xcb-btn.tiny{padding:2px 7px;font-size:11px}',
      '.xcb-btn.on{background:#2f6feb;border-color:#2f6feb;color:#fff}',
      '.xcb-btn.on.err{background:#8c2f2f;border-color:#8c2f2f}',
      '.xcb-btn.on.warn{background:#8a6d1f;border-color:#8a6d1f}',
      '.xcb-btn.on.ok{background:#1f6f43;border-color:#1f6f43}',
      '.xcb-row{display:flex;gap:6px;align-items:center;padding:7px 10px;flex-wrap:wrap;border-bottom:1px solid #2b2e34}',
      '.xcb-input,.xcb-select{appearance:none;background:#16181c;border:1px solid #3a3e46;color:#dfe1e5;border-radius:6px;padding:4px 7px;font:inherit;min-width:0}',
      '.xcb-input:focus,.xcb-select:focus{outline:1px solid #2f6feb}',
      '.xcb-input.path{flex:1;min-width:170px}',
      '.xcb-input.filter{flex:1;min-width:130px}',
      '.xcb-input.pending{border-color:#e0a33a}',
      '.xcb-select.scheme{max-width:190px}.xcb-select.dest{max-width:250px}',
      '.xcb-destnote{color:#8b949e;font-size:11px;white-space:nowrap}',
      '.xcb-destnote.stale{color:#b08948}',
      '.xcb-count{font-size:11px;color:#8b949e;white-space:nowrap;margin-left:auto}',
      '.xcb-hint{font-size:10.5px;color:#6b7280;white-space:nowrap}',
      '.xcb-status{display:flex;gap:9px;align-items:center;padding:5px 10px;background:#202226;border-bottom:1px solid #2b2e34;font-size:11px;color:#9aa0a8;flex-wrap:wrap}',
      '.xcb-note{color:#8b949e}',
      // The one fact in the status row that must not be read past: the app is gone.
      '.xcb-note.died{color:#ff8f7a;font-weight:600}',
      '.xcb-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:0 0 auto}',
      '.xcb-dot.running{background:#e0a33a}.xcb-dot.starting{background:#e0a33a}',
      '.xcb-dot.succeeded{background:#3fb950}.xcb-dot.failed{background:#f0553d}',
      '.xcb-dot.cancelled{background:#8b8f96}.xcb-dot.sm{width:7px;height:7px}',
      '.xcb-err{padding:6px 10px;background:#3a1d1d;color:#ff9c92;font-size:11px;border-bottom:1px solid #522626}',
      // The jump button floats over the log, so the log needs a positioned box:
      // anchored to the scrolling element itself, the button would scroll away
      // with the content it exists to escape.
      '.xcb-logwrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}',
      '.xcb-log{flex:1;overflow:auto;margin:0;padding:7px 0;background:#131518;',
      'font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-line{display:flex;gap:9px;padding:0 10px}',
      '.xcb-num{flex:0 0 46px;text-align:right;color:#4a4f57;user-select:none}',
      '.xcb-txt{flex:1;white-space:pre-wrap;word-break:break-word;min-width:0}',
      '.xcb-k-error .xcb-txt{color:#ff6b5e}',
      // The lowest level is drawn dimmer than ordinary text, which is what makes turning
      // it off worth doing: it is the noise you read past.
      '.xcb-k-verbose .xcb-txt{color:#6e7681}',
      '.xcb-k-info .xcb-txt{color:#9fb3c8}',
      '.xcb-k-warning .xcb-txt{color:#e3b341}',
      '.xcb-k-success .xcb-txt{color:#56d364;font-weight:600}',
      '.xcb-k-task .xcb-txt{color:#79c0ff}',
      '.xcb-k-test .xcb-txt{color:#d2a8ff}',
      '.xcb-k-note .xcb-txt{color:#8b949e}',
      '.xcb-k-section .xcb-txt{color:#7ee787;font-weight:600}',
      '.xcb-rev{color:#4b5563;font-size:10px;letter-spacing:.02em}',
      '.xcb-doctor{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap;padding:5px 10px;background:#2c2718;',
      'border-bottom:1px solid #4a4022;font-size:11px;color:#d9bf7a}',
      '.xcb-doctor.required{background:#3a1d1d;border-bottom-color:#522626;color:#ff9c92}',
      '.xcb-doctor code{color:#e8e2d0;background:#00000044;padding:0 4px;border-radius:3px;',
      'font:10.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-doctor-tools{color:#a89a72}',
      '.xcb-find{padding:6px 10px;border-bottom:1px solid #2b2e34}',
      '.xcb-input.find{flex:1;min-width:120px}',
      '.xcb-findcount{color:#8b949e;font-size:11px;white-space:nowrap;min-width:52px;text-align:right}',
      '.xcb-findcount.none{color:#b08948}',
      '.xcb-hit{background:#6b5312;color:#ffd98a;border-radius:2px}',
      '.xcb-hit.now{background:#e3b341;color:#1b1d21}',
      '.xcb-line-current{background:#ffffff0a}',
      '.xcb-note-row{padding:3px 10px;color:#6b7280;font-size:11px;background:#17191d;border-bottom:1px solid #23262b}',
      // The empty log takes the height the log WOULD have taken. Without `flex:1` it was only as
      // tall as its text, so the debugger drawer below it drifted up and the panel's leftover
      // space collected under the drawer instead of the drawer sitting on the bottom edge.
      '.xcb-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:#6b7280}',
      '.xcb-jump{position:absolute;right:14px;bottom:14px;z-index:2;padding:4px 11px;',
      'border:1px solid #3d434c;border-radius:999px;background:#2b3038cc;color:#d4d9e0;opacity:.74;',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;',
      'backdrop-filter:blur(4px);box-shadow:0 4px 14px rgba(0,0,0,.35);transition:opacity .12s ease}',
      '.xcb-jump:hover{opacity:1;background:#39404acc;border-color:#4d545e}',
      '.xcb-picker{max-height:210px;overflow:auto;background:#1a1c20;border-bottom:1px solid #2b2e34}',
      '.xcb-picker-head{padding:5px 10px;font-size:10.5px;color:#8b949e;background:#202226;position:sticky;top:0}',
      '.xcb-picker-note{padding:5px 10px;font-size:10.5px;color:#6b7280}',
      '.xcb-candidate{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;appearance:none;',
      'border:0;border-bottom:1px solid #23262b;background:transparent;color:#dfe1e5;font:inherit;',
      'padding:6px 10px;cursor:pointer}',
      '.xcb-candidate:hover{background:#252932}',
      '.xcb-candidate-name{font-weight:600}',
      '.xcb-candidate-kind{font-size:10px;border-radius:4px;padding:0 5px;background:#2b2e34;color:#9aa0a8;flex:0 0 auto}',
      '.xcb-candidate-kind.workspace{background:#1f3a5f;color:#9ecbff}',
      '.xcb-candidate-path{color:#6b7280;font-size:10.5px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // The header seat is an emblem, not a control icon. Two things separate it
      // from a close button, which is what a small thin round-capped X reads as:
      // scale, and the fact that it is drawn as four tapered blades with a pin
      // of light left at the crossing rather than as one bar crossed by another.
      // The tile gives it somewhere to be a mark.
      '.xcb-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;',
      'appearance:none;border:1px solid rgba(120,160,255,.30);background:linear-gradient(150deg,#262c3a,#0e1015);',
      'color:inherit;border-radius:8px;width:26px;height:26px;padding:0;font:inherit;cursor:pointer;',
      'transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}',
      '.xcb-trigger:hover{border-color:rgba(120,160,255,.60);box-shadow:0 0 0 1px rgba(120,160,255,.18),0 2px 8px rgba(0,0,0,.35)}',
      '.xcb-trigger:active{transform:translateY(.5px)}',
      '.xcb-trigger.on{border-color:#5b8cff;box-shadow:0 0 0 1px rgba(91,140,255,.35),0 0 12px rgba(91,140,255,.40)}',
      '.xcb-mark{display:block;pointer-events:none;filter:drop-shadow(0 0 2.5px rgba(91,140,255,.55))}',
      // In a tab chip the mark is one item in a row the shell lays out, and must not be
      // the item that shrinks when the title is long. The shell spaces it itself.
      '.xcb-mark.chip{flex:none}',
      '.xcb-trigger .xcb-dot{position:absolute;right:.5px;bottom:.5px;box-shadow:0 0 0 1.5px #0e1015}',

      // -- the LLDB drawer ---------------------------------------------------
      //
      // A terminal strip that opens below the log and takes at most half the panel: the
      // log is still the main event, and a debugger is something reached for. It borrows
      // the panel's own monospace metrics rather than inventing a second set, so a line of
      // LLDB output and a line of build output read alike.
      // A fixed share of the panel, not just a cap: the tree and the log split it, and a drawer sized
      // to its content would give the log no room under a tall tree.
      '.xcb-lldb{flex:0 0 auto;display:flex;flex-direction:column;height:52%;max-height:52%;min-height:96px;margin-bottom:0;',
      'border-top:1px solid rgba(120,160,255,.22);background:rgba(10,12,16,.66)}',
      '.xcb-lldb-head{display:flex;align-items:center;gap:6px;padding:4px 8px 2px;flex:0 0 auto;flex-wrap:wrap}',
      '.xcb-lldb-title{font-weight:600;letter-spacing:.08em;font-size:10.5px;opacity:.85}',
      '.xcb-lldb-state{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.6;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}',
      '.xcb-lldb-state.running{color:#f0b34a;opacity:.95}',
      '.xcb-lldb-light{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#4b5058;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
      '.xcb-lldb-light.green{background:#3fb950;box-shadow:0 0 6px rgba(63,185,80,.75)}',
      '.xcb-lldb-light.yellow{background:#e3b341;box-shadow:0 0 6px rgba(227,179,65,.7)}',
      '.xcb-lldb-light.red{background:#f0553d;box-shadow:0 0 6px rgba(240,85,61,.75)}',
      '.xcb-lldb-light.blink{animation:xcb-lldb-blink 1s ease-in-out infinite}',
      '@keyframes xcb-lldb-blink{50%{opacity:.25}}',
      '.xcb-lldb-state.stopped{color:#5fd39a;opacity:.95}',
      '.xcb-lldb-tab{appearance:none;border:0;background:none;color:inherit;opacity:.5;font:inherit;font-size:10.5px;',
      'padding:1px 3px;cursor:pointer;border-bottom:1px solid transparent}',
      '.xcb-lldb-tab.on{opacity:.95;border-bottom-color:currentColor}',
      '.xcb-lldb-stats{display:flex;align-items:center;gap:6px;padding:0 8px 3px;font-size:10.5px;opacity:.7;flex:0 0 auto}',
      // The tree and the log stacked on one page. The body itself never scrolls: each section does,
      // so the log keeps its own tail-following scroller (see below) and the tree scrolls apart from it.
      '.xcb-lldb-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.xcb-lldb-treesec{flex:1 1 55%;min-height:60px;display:flex;flex-direction:column;overflow:hidden;border-bottom:1px solid rgba(120,160,255,.18)}',
      '.xcb-lldb-treesec>.xcb-lldb-tree,.xcb-lldb-treesec>.xcb-lldb-pane,.xcb-lldb-treesec>.xcb-lldb-note{flex:1 1 auto;min-height:0;overflow:auto}',
      '.xcb-lldb-logsec{flex:1 1 45%;min-height:48px;display:flex;flex-direction:column;overflow:hidden}',
      // The log section must NOT be a scroller itself. When it was, the transcript grew to its
      // content's height inside it, so the transcript itself never scrolled: its onScroll never
      // fired, following was never switched off, and the ↓ Latest button — positioned inside the
      // scrolled content — would have scrolled away with the lines instead of floating over them.
      // As a flex column that does not scroll, the transcript is held to the visible height and
      // scrolls itself, the way the build log does, and the button sits on its bottom-right corner.
      '.xcb-lldb-logsec>.xcb-lldb-logwrap{flex:1 1 auto}',
      '.xcb-lldb-pane{display:flex;gap:8px;align-items:flex-start}',
      // A view's own image is usually mostly transparent, so the pane shows it over a checkerboard:
      // white-on-white would hide the edges of exactly the controls worth looking at.
      'background-image:linear-gradient(45deg,#00000018 25%,transparent 25%,transparent 75%,#00000018 75%),linear-gradient(45deg,#00000018 25%,transparent 25%,transparent 75%,#00000018 75%);',
      'background-size:12px 12px;background-position:0 0,6px 6px}',
      '.xcb-lldb-shot img{max-width:100%;max-height:210px;image-rendering:-webkit-optimize-contrast}',
      '.xcb-lldb-swatch{display:inline-block;width:11px;height:11px;border-radius:2px;border:1px solid #8888;vertical-align:-1px;margin-right:5px}',
      '.xcb-lldb-detail-row{display:flex;gap:6px;align-items:baseline;white-space:pre-wrap}',
      '.xcb-lldb-detail-row .xcb-lldb-label{flex:0 0 64px;opacity:.62}',
      '.xcb-lldb-apps-popup{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
      '.xcb-lldb-apps-card{min-width:320px;max-width:560px;max-height:70vh;overflow:auto;border-radius:8px;padding:8px 10px;background:#1b1d22;border:1px solid rgba(120,160,255,.3);box-shadow:0 12px 40px rgba(0,0,0,.5)}',
      '.xcb-lldb-apps-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11.5px;opacity:.85}',
      '.xcb-lldb-apps-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:4px 6px;border-radius:5px;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer}',
      '.xcb-lldb-apps-row:hover{background:rgba(120,160,255,.14)}',
      '.xcb-lldb-apps-row.on{background:rgba(120,160,255,.22)}',
      '.xcb-lldb-apps-pid{flex:none;opacity:.5;font-size:10.5px}',
      '.xcb-lldb-apps-note{padding:2px 2px 6px;font-size:10.5px;opacity:.6}',
      '.xcb-lookin-choice{display:flex;flex-direction:column;gap:6px;margin:4px 0 2px}',
      '.xcb-lookin-option{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:8px 10px;border-radius:6px;background:#23262c;border:1px solid #33363d;color:inherit;font:inherit;cursor:pointer}',
      '.xcb-lookin-option:hover:not(:disabled){background:#2b2f37;border-color:rgba(120,160,255,.45)}',
      '.xcb-lookin-option:disabled{opacity:.5;cursor:default}',
      '.xcb-lookin-option b{font-size:12px}',
      '.xcb-lookin-option span{font-size:10.5px;opacity:.65}',
      '.xcb-lookin-progress{display:flex;flex-direction:column;gap:5px;margin:6px 0 2px}',
      '.xcb-lookin-bar{height:6px;border-radius:3px;background:#2b2e34;overflow:hidden}',
      '.xcb-lookin-fill{height:100%;background:linear-gradient(90deg,#3d7bfd,#79c0ff);transition:width .3s}',
      '.xcb-lookin-stage{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;opacity:.75}',
      '.xcb-lookin-job{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;opacity:.8}',
      '.xcb-lookin-mini{display:inline-block;width:46px;height:4px;border-radius:2px;background:#2b2e34;overflow:hidden}',
      '.xcb-lookin-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px}',
      '.xcb-lookin-row:hover{background:rgba(120,160,255,.1)}',
      '.xcb-lookin-row-main{flex:1;min-width:0;display:flex;flex-direction:column}',
      '.xcb-lookin-row-main b{font-size:11.5px;font-weight:600}',
      '.xcb-lookin-row-main span{font-size:10.5px;opacity:.6}',
      '.xcb-lookin-kind{flex:none;font-size:9.5px;padding:1px 6px;border-radius:9px;background:#2b2e34;opacity:.85}',
      '.xcb-lookin-kind.full{background:rgba(86,211,100,.18);color:#7ee787}',
      'font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-lldb-dim{flex:none;opacity:.48}',
      // The transcript borrows the build log's row: a line number gutter, the text beside it, and
      // a colour per kind of line, so the two logs read alike.
      '.xcb-lldb-logwrap{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '.xcb-lldb-log{flex:1 1 auto;overflow:auto;padding:3px 0 2px;background:#131518}',
      '.xcb-lldb-line{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-lldb-line .xcb-num{flex:0 0 36px}',
      '.xcb-lldb-k-out .xcb-txt{color:#c9d1d9}',
      '.xcb-lldb-k-cmd .xcb-txt{color:#79c0ff;font-weight:600}',
      '.xcb-lldb-k-error .xcb-txt{color:#ff6b5e}',
      '.xcb-lldb-k-warning .xcb-txt{color:#e3b341}',
      '.xcb-lldb-k-state .xcb-txt{color:#56d364}',
      // The same floating pill as the build log's — same shape, blur and fade — tucked closer to the
      // corner because the drawer is short and the pill must not sit over most of its lines.
      '.xcb-ctxmenu{position:fixed;z-index:2147483000;min-width:150px;padding:4px;border-radius:7px;background:#25282ef2;',
      'border:1px solid #3d434c;box-shadow:0 8px 24px rgba(0,0,0,.45);backdrop-filter:blur(6px)}',
      '.xcb-ctxmenu-item{display:flex;justify-content:space-between;align-items:center;gap:16px;width:100%;padding:4px 10px;',
      'border:0;border-radius:4px;background:none;color:#d4d9e0;font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;text-align:left;cursor:default}',
      '.xcb-ctxmenu-item:hover:not(:disabled){background:#3d7bfd;color:#fff}',
      '.xcb-ctxmenu-item:disabled{opacity:.4}',
      '.xcb-ctxmenu-item.danger:hover:not(:disabled){background:#d9534a}',
      '.xcb-ctxmenu-key{opacity:.55;font-size:11px}',
      '.xcb-ctxmenu-sep{height:1px;margin:4px 6px;background:#3d434c}',
      '.xcb-lldb-jump{right:12px;bottom:8px;padding:2px 10px;font-size:10.5px}',
      '.xcb-lldb-note{padding:1px 8px;font-size:10.5px;opacity:.6}',
      '.xcb-lldb-error{padding:1px 8px;font-size:10.5px;color:#ff8d8d}',
      '.xcb-lldb-target{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px 8px 0;flex:0 0 auto}',
      '.xcb-lldb-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 2px 1px 7px;border-radius:10px;background:#4c8bf533;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:50%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.xcb-lldb-chip-addr{opacity:.6}',
      '.xcb-lldb-chip-x{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 5px;font-size:13px;line-height:1;opacity:.7}',
      '.xcb-lldb-chip-x:hover{opacity:1}',
      '.xcb-lldb-quick{padding:1px 7px;font-size:11px}',
      '.xcb-lldb-cmdrow{display:flex;align-items:center;gap:6px;padding:3px 8px 5px;flex:0 0 auto;',
      'border-top:1px solid rgba(120,160,255,.14)}',
      '.xcb-lldb-prompt{flex:none;opacity:.45;font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-lldb-cmd{flex:1 1 auto;font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:2px 6px}',
      '.xcb-lldb-toggle{font-size:10.5px;padding:1px 6px;opacity:.72}',
      '.xcb-lldb-toggle.on{opacity:1;border-color:rgba(120,160,255,.55)}',
      '.xcb-lldb-toggle.live{opacity:1;border-color:rgba(95,211,154,.6)}',
      '.xcb-lldb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;',
      'background:#5fd39a;vertical-align:middle}',
      // -- the debugger's workspace ------------------------------------------
      //
      // Lookin's own numbers, where they mean the same thing here: rows 28 high, 14 pixels of
      // indentation per level, a 15-pixel class icon, a 13-point title with a 12-point subtitle
      // beside it, `#434345` separators and `#2e2f30` surfaces over a `#131415` canvas. The panel
      // is dark whatever the app's theme is, so the dark half of each pair is the one used.
      '.xcb-lldb{flex:0 0 auto;display:flex;flex-direction:column;height:52%;max-height:52%;min-height:96px;margin-bottom:0;',
      'border-top:1px solid rgba(120,160,255,.22);background:rgba(10,12,16,.66)}',
      // Maximised: the same drawer with the whole panel instead of 52% of it.
      '.xcb-lldb.max{flex:1 1 auto;height:auto;max-height:none;min-height:0;border-top:0}',
      '.xcb-lldb-max{flex:0 0 auto}',
      '.xcb-lldb-workspace{flex:1 1 auto;min-height:0;display:flex;align-items:stretch;overflow:hidden}',
      '.xcb-lldb-treecol{flex:1 1 46%;min-width:210px;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      // The tree is one scrolling element with the rows placed inside it. `position:relative` on the
      // padding div is what lets a row sit at `index * 28` without the rows above it existing.
      '.xcb-lldb-tree{flex:1 1 auto;min-height:0;overflow:auto;position:relative}',
      // `overflow:hidden` on the row, and shrinkable text inside it: a deep row in a real app can be
      // wider than the column, and the alternative to truncating the class name is a horizontal
      // scrollbar in a tree, or a frame value painted over the inspector.
      '.xcb-lldb-row{position:absolute;left:0;right:0;display:flex;align-items:center;gap:5px;overflow:hidden;',
      'font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;border-radius:0;padding-right:8px}',
      '.xcb-lldb-row:hover{background:rgba(255,255,255,.07)}',
      '.xcb-lldb-row.picked{background:rgba(74,144,226,.42);color:#fff}',
      '.xcb-lldb-row.picked .xcb-lldb-sub,.xcb-lldb-row.picked .xcb-lldb-frame,.xcb-lldb-row.picked .xcb-lldb-icon{opacity:.85}',
      '.xcb-lldb-row.invisible{font-style:italic}',
      '.xcb-lldb-row.context{opacity:.45}',
      // The false result of a search is not hidden but marked: a filter that shows only hits loses
      // the shape of the tree, and the shape is what the tree is for.
      '.xcb-lldb-row.hit .xcb-lldb-class{background:#be7800;color:#fff;border-radius:2px;padding:0 2px}',
      '.xcb-lldb-tw{flex:0 0 12px;opacity:.5;font-size:9px;text-align:center}',
      '.xcb-lldb-tw.empty{visibility:hidden}',
      '.xcb-lldb-icon{flex:0 0 15px;opacity:.72;fill:none;stroke:currentColor;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}',
      '.xcb-lldb-row.picked .xcb-lldb-icon{opacity:1}',
      '.xcb-lldb-class{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px}',
      '.xcb-lldb-sub{flex:0 1 auto;min-width:0;font-size:12px;opacity:.55;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
      '.xcb-lldb-grow{flex:1 1 auto;min-width:4px}',
      '.xcb-lldb-frame{flex:none;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.4}',
      '.xcb-lldb-badge{flex:none;font-size:9.5px;padding:0 4px;border-radius:8px;background:rgba(255,255,255,.12);opacity:.8}',
      '.xcb-lldb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px;opacity:.5}',
      // The filter is a bar at the foot of the list it filters, which is where Lookin puts it.
      '.xcb-lldb-filterbar{flex:0 0 auto;display:flex;align-items:center;gap:5px;height:25px;padding:0 6px;',
      'border-top:1px solid #434345;background:rgba(255,255,255,.03)}',
      '.xcb-lldb-magnifier{flex:none;opacity:.5;font-size:12px}',
      '.xcb-lldb-filterinput{flex:1 1 auto;min-width:0;background:none;border:0;outline:none;color:inherit;font-size:13px}',
      '.xcb-lldb-hitcount{flex:none;font-size:10.5px;opacity:.6}',
      '.xcb-lldb-hitcount.none{color:#f0553d;opacity:.9}',
      // The inspector: the chain of ancestors, then the panes.
      '.xcb-lldb-insp{flex:1 1 54%;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;',
      'border-left:1px solid #434345;background:rgba(255,255,255,.02)}',
      '.xcb-lldb-insp-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:13px}',
      '.xcb-lldb-chain{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:1px;padding:0 8px 4px;font-size:11.5px}',
      '.xcb-lldb-chain-sep{opacity:.35;padding:0 2px}',
      '.xcb-lldb-chain-link{appearance:none;border:0;background:none;color:inherit;font:inherit;cursor:pointer;',
      'padding:0 3px;border-radius:3px;opacity:.6;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xcb-lldb-chain-link:hover{background:rgba(120,160,255,.16);opacity:.95}',
      '.xcb-lldb-chain-link.on{background:rgba(74,144,226,.42);opacity:1;color:#fff}',
      '.xcb-lldb-tabs{flex:0 0 auto;display:flex;align-items:center;gap:2px;padding:0 8px 3px;border-bottom:1px solid #434345}',
      '.xcb-lldb-insp-body{flex:1 1 auto;min-height:0;overflow:auto}',
      '.xcb-lldb-attrs{padding:2px 0 8px}',
      '.xcb-lldb-attr-sum{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11.5px;opacity:.8}',
      '.xcb-lldb-editnote{padding:3px 8px;font-size:11px;color:#e3b341}',
      '.xcb-lldb-attrgroup-head{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;',
      'background:rgba(255,255,255,.05);font-size:11.5px;font-weight:600;position:sticky;top:0}',
      '.xcb-lldb-attrgroup-head:hover{background:rgba(120,160,255,.14)}',
      '.xcb-lldb-attr{display:flex;align-items:center;gap:8px;padding:1px 8px;min-height:21px;',
      'font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-lldb-attr:hover{background:rgba(255,255,255,.04)}',
      '.xcb-lldb-attr-name{flex:0 0 34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xcb-lldb-attr-type{flex:0 0 22%;opacity:.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px}',
      '.xcb-lldb-attr-val{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:5px;overflow:hidden}',
      '.xcb-lldb-val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe3ea}',
      '.xcb-lldb-attr.editable .xcb-lldb-val{color:#9fd0ff}',
      '.xcb-lldb-num,.xcb-lldb-textinput{background:#454545;border:1px solid transparent;border-radius:4px;color:inherit;',
      'font:inherit;padding:1px 4px;min-width:0;width:100%;max-width:190px}',
      '.xcb-lldb-num:focus,.xcb-lldb-textinput:focus{border-color:rgba(120,160,255,.7);outline:none}',
      '.xcb-lldb-check{flex:none;accent-color:#4a90e2}',
      '.xcb-lldb-color{flex:none;width:18px;height:18px;padding:0;border:1px solid rgba(255,255,255,.25);border-radius:50%;background:none;cursor:pointer}',
      '.xcb-lldb-geom{display:flex;gap:4px;align-items:center}',
      '.xcb-lldb-geom label{display:flex;align-items:center;gap:2px}',
      '.xcb-lldb-geom label>span{opacity:.45;font-size:10px}',
      '.xcb-lldb-geom input{width:54px;background:#454545;border:1px solid transparent;border-radius:4px;color:inherit;font:inherit;padding:1px 3px}',
      // The layout pane: a row of verdicts, then the constraints as the runtime prints them.
      '.xcb-lldb-layout{padding:6px 8px 10px;font-size:11.5px}',
      '.xcb-lldb-badges{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}',
      '.xcb-lldb-badge-box{display:flex;flex-direction:column;gap:1px;padding:4px 7px;border-radius:5px;min-width:74px;',
      'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.07)}',
      '.xcb-lldb-badge-box.ok{border-color:rgba(63,185,80,.5)}',
      '.xcb-lldb-badge-box.warn{border-color:rgba(227,179,65,.55)}',
      '.xcb-lldb-badge-box.bad{border-color:rgba(240,85,61,.6)}',
      '.xcb-lldb-badge-label{font-size:10px;opacity:.55}',
      '.xcb-lldb-badge-value{font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-lldb-sec-title{margin:8px 0 3px;font-size:10.5px;font-weight:600;opacity:.6;text-transform:uppercase;letter-spacing:.06em}',
      '.xcb-lldb-constraint{display:flex;align-items:center;gap:6px;padding:2px 0;',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden}',
      '.xcb-lldb-constraint>span{overflow:hidden;text-overflow:ellipsis}',
      '.xcb-lldb-jump{flex:none;appearance:none;border:0;border-radius:3px;background:rgba(74,144,226,.25);color:inherit;',
      'font:inherit;font-size:10px;padding:0 4px;cursor:pointer;opacity:.7}',
      '.xcb-lldb-jump:hover{opacity:1;background:rgba(74,144,226,.5)}',
      // The preview pane: the image on a canvas, zoomed with the wheel and panned by the buttons.
      '.xcb-lldb-preview{display:flex;flex-direction:column;min-height:0;height:100%}',
      '.xcb-lldb-preview-bar{display:flex;align-items:center;gap:5px;padding:4px 8px;flex:0 0 auto}',
      '.xcb-lldb-preview-canvas{flex:1 1 auto;min-height:140px;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;',
      'background-image:linear-gradient(45deg,#00000018 25%,transparent 25%,transparent 75%,#00000018 75%),linear-gradient(45deg,#00000018 25%,transparent 25%,transparent 75%,#00000018 75%);',
      'background-size:12px 12px;background-position:0 0,6px 6px;border-top:1px solid #434345;border-bottom:1px solid #434345}',
      '.xcb-lldb-preview-canvas.dragging{cursor:grabbing}',
      '.xcb-lldb-preview-canvas img{max-width:100%;max-height:100%;transform-origin:center center;image-rendering:-webkit-optimize-contrast;user-select:none;-webkit-user-drag:none}',
      '.xcb-lldb-pane{display:flex;gap:8px;align-items:flex-start}',
    ].join('')

    function installStyles() {
      const tagId = 'dsh-xcodebuild/panel.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-xcodebuild'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Same-origin base; the fallback mirrors the harness's null-origin carrier. */
    /**
     * The session whose header (or dock tab) this panel is rendered in.
     *
     * Lives out here because `api` needs it and `api` is not inside `apply`.
     */
    let sessionId = null

    function baseUrl() {
      const origin = globalThis.location?.origin
      return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    async function api(method, body) {
      // The session rides along on every call. The host cannot infer it — its own
      // `process.cwd()` is the harness directory, not the project the user
      // opened — and the session header is where the workspace root lives.
      const request = sessionId === null ? body : { ...(body ?? {}), sessionId }
      const response = await fetch(new URL(`${ROUTE_PREFIX}${method}`, baseUrl()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request ?? null),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${String(response.status)}`)
      return payload
    }

    function freshKinds() {
      const kinds = {}
      for (const kind of ALL_KINDS) kinds[kind] = true
      return kinds
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    function formatDuration(ms) {
      const seconds = Math.round((ms ?? 0) / 1000)
      if (seconds < 60) return `${String(seconds)}s`
      return `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`
    }



    function apply(ctx) {
      installStyles()

      /**
       * Which seat named the session currently on screen.
       *
       * The dock tab is authoritative — it is the surface the user is looking at.
       * The header seat only fills the gap when the dock cannot name one.
       */
      let sessionSource = ''

      /**
       * Whether a seat is authoritative about which session it shows.
       *
       * Both sidebars render the panel inside one session — a dock tab carries its
       * `scope`, and the official right sidebar's tab carries `sessionId` — so
       * either is a better answer than the header, which is mounted for every
       * session and only fills the gap.
       *
       * @param {string} side - the seat that named a session.
       * @returns {boolean} true for a sidebar seat.
       */
      function seated(side) {
        return side === 'dock' || side === 'rightbar'
      }

      /**
       * Adopt the session a seat was rendered for, and re-read state for it.
       *
       * A slot hands its session down as a prop, and each seat renders once per
       * session, so the first render carrying an id is the moment the workspace
       * becomes knowable.
       *
       * `source` arbitrates between the seats that know a session. A sidebar seat
       * is the better answer when it has one; the header seat is the fallback,
       * because it is mounted in every shell — including the one where a sidebar
       * renders the panel and this seat renders nothing at all.
       *
       * An empty id means "this seat cannot name a session", NOT "forget the one
       * another seat named": an unscoped dock tab must not wipe what the header
       * already established.
       */
      function adoptSession(id, source) {
        const next = typeof id === 'string' && id !== '' ? id : ''
        if (next === '') {
          // A seat that cannot name a session must not clear one another seat
          // named — but it may be the only seat there is, and an unnamed read is
          // how the panel learns it has no workspace to show yet. That read is
          // safe now: the host answers with an empty workspace rather than its own
          // directory, which is what used to fill the field with launch-root.
          void refreshState()
          return
        }
        if (seated(sessionSource) && !seated(source)) return
        if (next !== sessionId) {
          sessionId = next
          sessionSource = source
          state = storeFor(next)
          // Repaint before the host answers, so the previous workspace's project
          // and log never linger under the new session's name.
          emit()
        } else if (seated(source) && !seated(sessionSource)) {
          // The same id, now confirmed by the authoritative seat.
          sessionSource = source
        }
        // Always read, even with no session to name: the host then answers with
        // an empty workspace, which the panel shows as "nothing chosen yet".
        void refreshState()
      }

      /**
       * A blank store for one session.
       *
       * The path starts empty on purpose: the session's workspace fills it, and a
       * path remembered from another project would be exactly the kind of
       * cross-workspace leak this separation exists to prevent.
       */
      /**
       * Paint a workspace's project from the store, when it has been seen before.
       *
       * The panel used to ask the host for facts it had already been told, which
       * meant waiting on `xcodebuild -list` — and on a walk of the directory before
       * that — every single time it opened.
       *
       * What is cached is the project's own description: its location, schemes and
       * configurations, which change only when the project is edited. Destinations
       * are deliberately NOT cached: hardware comes and goes, and a remembered
       * device list would hide a phone that was plugged in since.
       *
       * @param {string} root - the workspace root to look up.
       * @returns {boolean} true when a stored project was adopted.
       */
      function adoptCached(root) {
        if (typeof root !== 'string' || root === '') return false
        const cached = readSelections()[storeKey(root)]
        const info = cached?.info
        if (info === null || typeof info !== 'object') return false
        if (typeof info.location !== 'string' || info.location === '') return false
        state.project = info
        state.path = info.location
        state.schemes = Array.isArray(info.schemes) ? info.schemes : []
        const listed = Array.isArray(info.configurations)
          ? info.configurations.filter((name) => typeof name === 'string' && name !== '')
          : []
        state.configurations = listed.length > 0 ? listed : ['Debug', 'Release']
        state.configuration = pickConfiguration(state.configurations, cached.configuration)
        state.scheme = state.schemes.includes(cached.scheme) ? cached.scheme : (state.schemes[0] ?? '')
        state.candidates = []
        state.searchRoot = root
        // The cached list is painted now and refreshed immediately after, so the control
        // is never empty while the command runs. It is marked as cached until the live
        // list lands, and the refresh re-checks the selection — a phone that has since
        // been unplugged disappears from the list and the selection moves with it, which
        // is the safety the empty list used to provide, without the seconds of nothing.
        const cachedList = cachedDestinations(cached, state.scheme)
        const rememberedDestination = typeof cached.destination === 'string' ? cached.destination : ''
        state.destinations = cachedList === null ? [] : cachedList.list
        state.destinationsAt = cachedList?.at ?? 0
        state.destinationsStale = cachedList !== null
        state.destination = cachedList === null
          ? ''
          : cachedList.list.some((entry) => entry.destination === rememberedDestination)
            ? rememberedDestination
            : (cachedList.recommended || cachedList.list[0]?.destination || '')
        return true
      }

      function blankStore() {
        return {
        open: false,
        path: '',
        project: null,
        schemes: [],
        scheme: '',
        configurations: ['Debug', 'Release'],
        configuration: 'Debug',
        destinations: [],
        destination: '',
        /** When the shown destination list was fetched, and whether it came from the cache. */
        destinationsAt: 0,
        destinationsStale: false,
        destinationsRefreshing: false,
        /**
         * Set while the destination dropdown is open, with the fresh list held aside.
         *
         * A refresh that lands while the popup is open would rebuild the options under the
         * user's pointer, which can close the dropdown they are choosing in. The list is
         * therefore read immediately but applied only once the dropdown shuts.
         */
        destinationsHeld: false,
        destinationsNext: null,
        runId: null,
        activeRunId: null,
        /** Who started the shown run: 'panel' (a button here) or 'agent' (the xcode_run tool). */
        runOrigin: 'panel',
        log: [],
        logNext: 0,
        /**
         * The log search: its text, which hit is current, and a counter that ticks
         * every time the user asks to move.
         *
         * Separate from `filter` on purpose. A filter changes WHICH lines exist as far as
         * the panel is concerned — it hides them, and can reach lines the browser no
         * longer holds by asking the host. A search changes nothing: it marks the hits
         * inside the lines already on screen, so "where is that line" and "show me only
         * these lines" stay two different questions.
         */
        /**
         * Whether the find bar is on screen at all.
         *
         * Hidden by default: it is a row of the panel's height for a job that is usually
         * done and finished in a second, so it costs nothing until `⌘F` asks for it —
         * the same way a browser's own find works, which is where the habit comes from.
         */
        findOpen: false,
        /** Bumped on every `⌘F`, so a second press re-focuses and re-selects the bar. */
        findFocus: 0,
        /**
         * What has been typed into each box before, oldest first.
         *
         * One history per box: a filter and a search are different questions, and mixing
         * them would offer a regular expression as a search or a search as a filter.
         */
        filterHistory: [],
        searchHistory: [],
        /**
         * Every lldb command the drawer has sent, oldest first: typed ones and the ones a picked view's
         * buttons sent, as they were sent (with `$v` already expanded), so ↑ in the prompt brings back
         * any of them to run again or edit.
         */
        commandHistory: [],
        /**
         * Where ↑/↓ has walked to, or null while the box holds what the user typed.
         *
         * The draft is carried along so that ↓ past the newest entry puts back the text
         * that was there before the walk started — the way a shell does it, rather than
         * leaving the user's half-written filter replaced by history.
         */
        filterRecall: null,
        searchRecall: null,
        search: '',
        searchIndex: 0,
        /**
         * Bumped when the user moves to another hit, never when the text changes.
         *
         * Typing must count and mark hits without the view jumping around under the
         * caret; pressing ↓ or Enter is the request to go somewhere, and this is what
         * tells the log view that one of those happened.
         */
        searchJump: 0,
        status: 'idle',
        exitCode: null,
        durationMs: 0,
        warningCount: 0,
        errors: [],
        artifact: null,
        note: '',
        // The host's verdict on what the app did once it was launched: null while nothing
        // has been said about its end. See `lib/app-death.js`.
        death: null,
        revision: '',
        doctor: null,
        doctorAsked: false,
        error: '',
        busy: false,
        // Filter: `filterDraft` is what the field shows, `filter` is committed.
        filterDraft: '',
        filter: '',
        regex: false,
        kinds: freshKinds(),
        searchLines: null,
        searchTotal: 0,
        searchKey: '',
        // Project choice. A directory usually offers more than one Xcode
        // project, so the search result — not the typed path — is what decides.
        candidates: [],
        searchRoot: '',
        truncated: false,
        workspace: '',
        // The workspace the automatic search has already run for. Without it every
        // repaint that touches the path would start another walk of the directory.
        autoSearched: '',
        // Line number the output was last cleared at. Everything before it is
        // gone as far as this panel is concerned, including for the filter.
        clearedAt: 0,
        // -- the LLDB drawer ------------------------------------------------
        /**
         * Hidden until asked for: by `⌘L`, by the LLDB button, or by the moment a
         * session appears. The panel's bottom edge belongs to the log the rest of the
         * time, and a debugger is something you reach for.
         */
        lldbOpen: false,
        /**
         * Bumped when the USER opens the drawer, and only then: focusing the command box
         * is right for a press of `⌘L` and wrong when the model's own session opens it,
         * which would take the caret out of whatever the user was typing.
         */
        lldbFocus: 0,
        /**
         * Set when the app the last run launched has been let go — Stop, or a Detach in the drawer.
         * Until then that app IS the drawer's app, mounted by the build itself.
         */
        appReleased: false,
        lldb: {
          /** Whether the host holds a session at all — the button says so while closed. */
          active: false,
          session: null,
          lines: [],
          next: 0,
          firstAvailable: 1,
          /**
           * The drawer's own error, kept out of `state.error` on purpose: a dump that
           * failed is not a build that failed, and a red row across a healthy panel
           * would say it was.
           */
          error: '',
          note: '',
          /** Which operation is in flight, so a button cannot double-fire. */
          busy: '',
          /** The last view hierarchy (the host's `view` result), or null. */
          tree: null,
          /**
           * Whether the last attempt to read the tree failed. A failing dump usually means
           * the app is held by the run that launched it, which is a thing the user can do
           * something about — so the drawer offers to take the app over instead of just
           * reporting the failure.
           */
          viewFailed: false,
          // Set when the failure was the app refusing a debugger outright: then there IS no
          // takeover to offer, and the drawer says what to do instead rather than tempting
          // anyone into a relaunch that the guard will refuse just as firmly.
          refused: false,
          // The file the last read wrote, so the head can offer to open it.
          lookinPath: '',
          // The node the panel is showing details for, and the host's answer for it. `node` is
          // fetched per click rather than shipped with the tree: the tree is text, the images are
          // not.
          selected: '',
          node: null,
          /** Which of the two images is on screen: the control alone, or with its subtree. */
          shot: 'solo',
          // null until a read says: whether Lookin.app exists on the host. Unknown is not the same
          // as absent, and before the first read there is nothing to open anyway.
          lookinAvailable: null,
          /** Which popup is over the drawer: '' | 'lookin' (choose quick or full) | 'history'. */
          lookinPopup: '',
          /** The background full export, as the host last reported it, or null. */
          lookinJob: null,
          /** The kept view trees, newest first, as the host last listed them. */
          lookinHistory: [],
          /** A note for the Lookin popups, apart from the drawer's own error line. */
          lookinNote: '',
          /** Which history row is being opened or deleted right now. */
          lookinRowBusy: '',
          /** Which half of the drawer is showing: the tree, or the session transcript. */
          /** Whether the tree section shows above the log. The log is always there; the tree folds away. */
          treeShown: true,
          /** The drawer's filter over the tree it already holds. */
          filter: '',
          /**
           * Whether the inspector is filling the panel.
           *
           * The drawer is a strip at the bottom of a 520-pixel panel — 52% of it, at most — and a
           * hierarchy plus an attribute list plus a preview do not fit in that. Maximising hands the
           * whole panel to the debugger and is the same drawer, not a second one: the panel keeps
           * one place where the debugger lives, and it can be made big when it is being used.
           */
          maximized: false,
          /** Which inspector pane is showing: 'attrs' | 'layout' | 'preview'. */
          inspector: 'attrs',
          /**
           * The attributes read for one address, keyed by address, so flipping between two views the
           * user has already opened costs nothing. Cleared when a new tree arrives, because new
           * addresses are different views.
           */
          attrs: {},
          /**
           * The layout report for one address, keyed by address like the attribute lists — a tree
           * read brings every view's with it, so flipping between views costs nothing.
           */
          layout: {},
          /** How many views the last tree read pulled attributes and layout for, and whether it stopped early. */
          detailsViews: 0,
          detailsCapped: false,
          /**
           * The attribute row being edited, as `address:name`, so only that row shows a spinner. Held
           * for the length of the round trip and cleared by the answer, whatever it said.
           */
          editBusy: '',
          /** What an edit reported when the app did not keep the value, or ''. */
          editNote: '',
          /** The search hit count of the last filter, so "3 of 812" can be said and not guessed. */
          filterHits: 0,
          /**
           * Which class groups the attribute list has folded shut, by group name.
           *
           * Kept across selections on purpose: `UIView` declares thirty attributes and most of them
           * are never the question, so a user who folds it away does not want to fold it away again
           * on the next view.
           */
          attrCollapsed: {},
          /** The subtree focus: the address one double-click zoomed into, or ''. */
          focusAddress: '',
          /** The preview's zoom factor and pan offset, in image pixels. */
          zoom: 1,
          pan: { x: 0, y: 0 },
        },
        }
      }

      // One store per session. A panel belongs to one workspace, and it must not
      // show another's project, build or log — so state is kept apart rather
      // than shared, and `state` points at the one being rendered.
      // What each project was last set up with, keyed by workspace root.
      //
      // Switching workspaces used to reset the panel, so coming back to one meant
      // re-picking the same scheme, configuration and destination every time.
      // localStorage is the only store that survives both a page reload and a DSH
      // restart; a browser that refuses it just loses the convenience, never the
      // panel.
      const SELECTIONS_KEY = 'dsh-xcodebuild:selections'

      /**
       * The key one directory is remembered under.
       *
       * A root reaches this module in more than one shape — the host reports a
       * session workspace, a search resolves a typed path — and a trailing slash was
       * enough to miss a stored choice and ask the user to pick a project they had
       * already picked.
       *
       * @param {string} path - directory to key.
       * @returns {string} the key, or '' when there is no directory to key.
       */
      function storeKey(path) {
        const text = typeof path === 'string' ? path : ''
        if (text === '') return ''
        const trimmed = text.replace(/\/+$/, '')
        return trimmed === '' ? '/' : trimmed
      }

      /**
       * The destination list this workspace last saw, when it still applies.
       *
       * Devices are plugged, unplugged and swapped all day, so the list has to be
       * refreshed on every look — but `xcodebuild -showdestinations` takes seconds to
       * answer, and showing nothing for those seconds is what made the control feel
       * broken. Both are done instead: this is painted immediately, marked with its age,
       * and the command then replaces it.
       *
       * It is keyed by scheme, because the list really is scheme-dependent: a scheme that
       * supports only simulators must not be shown another scheme's hardware.
       *
       * @param {object} remembered - what this workspace last stored.
       * @param {string} scheme - the scheme being shown.
       * @returns {{list: object[], recommended: string, at: number}|null} the cache, or null when there is none for this scheme.
       */
      function cachedDestinations(remembered, scheme) {
        const cache = remembered !== null && typeof remembered === 'object' ? remembered.destinations : null
        if (cache === null || typeof cache !== 'object') return null
        if (typeof cache.scheme !== 'string' || cache.scheme === '' || cache.scheme !== scheme) return null
        const list = Array.isArray(cache.list) ? cache.list : []
        if (list.length === 0) return null
        return {
          list,
          recommended: typeof cache.recommended === 'string' ? cache.recommended : '',
          at: Number.isFinite(cache.at) ? cache.at : 0,
        }
      }

      function readSelections() {
        try {
          const raw = window.localStorage.getItem(SELECTIONS_KEY)
          const parsed = raw === null ? null : JSON.parse(raw)
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        } catch {
          return {}
        }
      }

      function remember(root, patch) {
        const key = storeKey(root)
        if (key === '') return
        try {
          const all = readSelections()
          const current = all[key] !== null && typeof all[key] === 'object' ? all[key] : {}
          all[key] = { ...current, ...patch }
          window.localStorage.setItem(SELECTIONS_KEY, JSON.stringify(all))
        } catch {
          /* remembering is a convenience, never a requirement */
        }
      }

      const stores = new Map()
      let state = blankStore()

      function storeFor(key) {
        let store = stores.get(key)
        if (store === undefined) {
          store = blankStore()
          stores.set(key, store)
        }
        return store
      }

      // The better-sidebar service, when the shell has it. Null means the
      // floating overlay is the only surface available.
      let dock = null

      // The official right sidebar's tab registry, when the shell has it and
      // better-sidebar does not. The two are alternatives, not layers: this one
      // is the fallback for a shell that has the right sidebar and no docking
      // plugin, and `syncSeats` keeps exactly one of them in charge.
      let rightBar = null

      /** Whatever `syncSeats` registered with the right sidebar, so it can be taken back. */
      let rightBarSeat = null

      let listeners = []
      let lastStateReadAt = 0

      function emit() {
        // Iterate a copy and leave the live list intact. Draining it here would
        // make the first emit the last one that reached anybody: subscribers are
        // added once from `useEffect(..., [])`, so nothing re-registers them, and
        // the overlay's mount-time `refreshState()` emits before the user has
        // clicked anything at all. Copying also keeps a listener that unsubscribes
        // mid-notification from skipping the next one.
        for (const notify of listeners.slice()) {
          try {
            notify()
          } catch (error) {
            console.error(error)
          }
        }
      }

      function useStore() {
        const [, bump] = React.useState(0)
        React.useEffect(() => {
          let live = true
          const notify = () => {
            if (live) bump((value) => value + 1)
          }
          listeners.push(notify)
          return () => {
            live = false
            const index = listeners.indexOf(notify)
            if (index >= 0) listeners.splice(index, 1)
          }
        }, [])
        return state
      }

      /**
       * Empty the output.
       *
       * This is not the filter's clear — it drops the lines themselves. The
       * baseline is what makes it real: while a filter is active the rows come
       * from the host searching the WHOLE run, so emptying only the local buffer
       * would let the next search pull every discarded line straight back.
       * The filter's own clear is Esc.
       */
      function clearLog() {
        state.log = []
        state.searchLines = null
        state.searchKey = ''
        state.clearedAt = state.logNext
        emit()
      }

      // -- filter ----------------------------------------------------------

      /** Commit the field's current text as the active filter. */
      function commitFilter() {
        const next = state.filterDraft.trim()
        if (next !== '') state.filterHistory = rememberInput(state.filterHistory, next)
        state.filterRecall = null
        if (next !== state.filter) state.filter = next
        // Either way the host-side result is stale: re-run it on the next tick.
        state.searchLines = null
        state.searchKey = ''
        emit()
      }

      function clearFilter() {
        state.filterDraft = ''
        state.filter = ''
        state.regex = false
        state.kinds = freshKinds()
        state.searchLines = null
        state.searchKey = ''
        emit()
      }

      /** Show the find bar, and put the caret in it. */
      function openFind() {
        state.findOpen = true
        state.findFocus += 1
        emit()
      }

      /**
       * Hide the find bar, and drop the search with it.
       *
       * A hidden search would keep marking lines and keeping the log window parked on a
       * hit with nothing on screen to explain either.
       */
      function closeFind() {
        // Closing with something in the box is the other way a query is finished with.
        if (state.search !== '') state.searchHistory = rememberInput(state.searchHistory, state.search)
        state.findOpen = false
        state.search = ''
        state.searchIndex = 0
        state.searchJump = 0
        state.searchRecall = null
        emit()
      }

      // -- search ----------------------------------------------------------
      //
      // The text is live, not committed on blur: the count and the highlights are the
      // answer to "is it in this build at all", and making the user press Enter to find
      // that out would be the filter's behaviour applied to the wrong question.

      function setSearch(text) {
        // Typing is the user's own text again, so the ↑/↓ walk starts over from here.
        state.searchRecall = null
        state.search = text
        // A new query has new hits: the first one is current, and nothing moves until
        // the user asks to move.
        state.searchIndex = 0
        state.searchJump = 0
        emit()
      }

      /**
       * Note the current query as something worth recalling.
       *
       * Called when the box is done with it — Enter, clicking away, or closing the bar —
       * and never while typing, because every prefix of a query is not a query.
       */
      function rememberSearch() {
        state.searchHistory = rememberInput(state.searchHistory, state.search)
        state.searchRecall = null
      }

      /**
       * Walk one box's history with ↑ or ↓.
       *
       * @param {'filter'|'search'} which - the box whose history to walk.
       * @param {number} delta - -1 for ↑ (older), +1 for ↓ (newer).
       */
      function recallInput(which, delta) {
        if (which === 'filter') {
          const step = stepRecall(state.filterHistory, state.filterRecall, state.filterDraft, delta)
          state.filterDraft = step.value
          state.filterRecall = step.recall
          emit()
          return
        }
        const step = stepRecall(state.searchHistory, state.searchRecall, state.search, delta)
        state.search = step.value
        state.searchRecall = step.recall
        // A recalled query is a new query: its hits are counted from the first one, and
        // the view does not move — recalling is not asking to go somewhere.
        state.searchIndex = 0
        state.searchJump = 0
        emit()
      }

      /**
       * Move to the next or previous hit, wrapping around the ends.
       *
       * Wrapping is what makes repeated presses a loop through every hit rather than a
       * walk that stops at one end with no way to tell it did.
       *
       * @param {number} delta - +1 for the next hit, -1 for the previous one.
       * @param {number} total - how many hits there are; 0 leaves the index alone.
       */
      function stepSearch(delta, total) {
        if (total <= 0) return
        const current = Math.min(Math.max(state.searchIndex, 0), total - 1)
        state.searchIndex = (current + delta + total) % total
        state.searchJump += 1
        emit()
      }

      /**
       * Whether a level is showing.
       *
       * `some`, not `every`: a level that owns several kinds is one button, and it reads
       * as on while any of them is on. Clicking it then turns them all the same way, so
       * the two can never drift into a state no button can express.
       */
      function levelOn(level) {
        return level.kinds.some((kind) => state.kinds[kind])
      }

      function toggleLevel(level) {
        const on = !levelOn(level)
        for (const kind of level.kinds) state.kinds[kind] = on
        emit()
      }

      /**
       * Lines to render.
       *
       * When a text filter is committed and the host answered, the host already
       * matched across the whole retained run, so only severity is applied here.
       * Otherwise (no text, or the host answer is still in flight, or the regex
       * was rejected) fall back to filtering the local window, which keeps the
       * panel responsive and never shows a false empty state.
       */
      function visibleLines() {
        const out = []
        if (state.filter !== '' && state.searchLines !== null) {
          for (const line of state.searchLines) if (state.kinds[line.k]) out.push(line)
          return out
        }
        let pattern = null
        if (state.filter !== '' && state.regex) {
          try {
            pattern = new RegExp(state.filter)
          } catch {
            pattern = null
          }
        }
        const needle = state.filter !== '' && pattern === null ? state.filter.toLowerCase() : ''
        for (const line of state.log) {
          if (!state.kinds[line.k]) continue
          if (state.filter !== '') {
            if (pattern !== null) {
              if (!pattern.test(line.t)) continue
            } else if (!line.t.toLowerCase().includes(needle)) continue
          }
          out.push(line)
        }
        return out
      }

      /**
       * Where `needle` occurs in `text`, case-insensitively, left to right, without
       * overlapping itself.
       *
       * The needle is literal, never a pattern: this box is for finding a line you half
       * remember (`GMWalletService`), and a build log is full of `[`, `(` and `*` that a
       * regex interpretation would turn into an error or a wrong hit. Non-overlapping is
       * what makes the highlights read as a sequence, and it is what a text editor does
       * with `aaaa` / `aa`.
       *
       * @param {string} text - the line to search.
       * @param {string} needle - what to look for; empty means nothing is highlighted.
       * @returns {Array<{start: number, end: number}>} half-open ranges into `text`.
       */
      function hitRanges(text, needle) {
        const ranges = []
        const haystack = String(text ?? '').toLowerCase()
        const wanted = String(needle ?? '').toLowerCase()
        if (wanted === '') return ranges
        let at = haystack.indexOf(wanted)
        while (at !== -1) {
          ranges.push({ start: at, end: at + wanted.length })
          at = haystack.indexOf(wanted, at + wanted.length)
        }
        return ranges
      }

      /**
       * Is this node the find box of one of the panel's seats?
       *
       * The panel can be on screen more than once at a time — docked and floating are two
       * mountings of the same component over one store — and they all render this box. A
       * blur that hands focus to another one of them is the two seatings settling which
       * box has the caret, not the user leaving the box, and the difference matters: the
       * second one closes an empty bar, which would take the bar away the instant ⌘F
       * opened it.
       *
       * @param {unknown} node - an event's `relatedTarget`.
       * @returns {boolean} true when focus went to another rendering of the same box.
       */
      function isFindBox(node) {
        const name = node === null || node === undefined ? '' : String(node.className ?? '')
        return name.split(/\s+/).includes('xcb-input') && name.split(/\s+/).includes('find')
      }

      /** How many past inputs each box remembers. */
      const INPUT_HISTORY = 25
      const COMMAND_HISTORY = 100

      /**
       * Add a value to one box's history, newest last.
       *
       * Empty is not a value to remember — it is the absence of one, and an entry for it
       * would make ↑ walk onto a blank line. Repeating the newest entry is not remembered
       * either: pressing Enter twice on the same filter should not need two ↑ to pass it.
       */
      function rememberInput(history, value, cap = INPUT_HISTORY) {
        const text = String(value ?? '')
        if (text === '') return history
        if (history[history.length - 1] === text) return history
        return history.concat([text]).slice(-cap)
      }

      /**
       * Where ↑ or ↓ takes a box, given its history and where the walk already is.
       *
       * ↑ is back in time and ↓ is forward, so ↑ starts at the newest entry and ↓ past it
       * restores the draft. Walking off the old end stays on the oldest entry instead of
       * wrapping: a history is a list to look through, not a ring to cycle.
       *
       * @param {string[]} history - the box's past inputs, oldest first.
       * @param {{index: number, draft: string}|null} recall - the walk's position, or null.
       * @param {string} current - what the box holds now.
       * @param {number} delta - -1 for ↑, +1 for ↓.
       * @returns {{value: string, recall: {index: number, draft: string}|null}} the box's
       *   next text and position.
       */
      function stepRecall(history, recall, current, delta) {
        if (history.length === 0) return { value: current, recall: null }
        if (recall === null) {
          // Nothing newer than what is being typed, so ↓ has nowhere to go.
          if (delta > 0) return { value: current, recall: null }
          const index = history.length - 1
          return { value: history[index], recall: { index: index, draft: current } }
        }
        const index = recall.index + delta
        if (index >= history.length) return { value: recall.draft, recall: null }
        const at = Math.max(0, index)
        return { value: history[at], recall: { index: at, draft: recall.draft } }
      }

      // -- actions ---------------------------------------------------------

      /**
     * Which configuration to select after a project changes.
     *
     * A selection the new project also offers is kept: switching projects must
     * not quietly change the build you are about to run. Otherwise `Debug` wins,
     * and the project's own first entry is the fallback.
     */
    function pickConfiguration(available, current) {
      if (available.includes(current)) return current
      if (available.includes('Debug')) return 'Debug'
      return available[0] ?? 'Debug'
    }

    function pickScheme(schemes, projectName) {
        if (schemes.length === 0) return ''
        return schemes.find((scheme) => scheme === projectName)
          ?? schemes.find((scheme) => !scheme.startsWith('Pods-'))
          ?? schemes[0]
      }

      /**
       * Search a directory for Xcode projects and settle on one.
       *
       * Naming a path cannot be the whole answer. A real checkout offers several
       * projects and most of the candidates are noise, so the search result —
       * not the typed path — is what decides: one hit is selected outright, and
       * several are offered as a choice instead of being guessed at.
       */
      async function doSearch(location) {
        if (!location) return
        state.busy = true
        state.error = ''
        emit()
        try {
          const result = await api('projects', { path: location })
          state.searchRoot = result.root
          state.candidates = result.candidates ?? []
          state.truncated = result.truncated === true
          if (state.candidates.length === 0) {
            state.project = null
            state.error = `No .xcworkspace or .xcodeproj under ${result.root}`
          } else if (state.candidates.length === 1) {
            await doDetect(state.candidates[0].location)
          } else {
            // More than one answer: the user picks — unless this workspace already
            // has a choice on record and it is still there, in which case coming
            // back to it is the whole point of remembering. Assuming one of
            // several unseen would silently build the wrong project, which is why
            // only an exact remembered match is adopted.
            //
            // The record is looked up by the directory that was searched, because
            // that is the directory the panel is opened with. It used to be written
            // only under the project's own directory (`detect` reports that as its
            // root), so for a project in a subdirectory the lookup never matched and
            // the picker came back every single time — see `doDetect`, which now
            // writes both.
            const recorded = readSelections()[storeKey(result.root)]?.location
            const known = state.candidates.find((candidate) => candidate.location === recorded)
            if (known !== undefined) await doDetect(known.location)
            else state.project = null
          }
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
        } finally {
          state.busy = false
          emit()
        }
      }

      /** Adopt one project: read its schemes, then its destinations. */
      async function doDetect(location) {
        if (!location) return
        state.busy = true
        state.error = ''
        emit()
        try {
          const info = await api('detect', { path: location })
          state.project = info
          state.path = info.location
          state.schemes = info.schemes ?? []
          // What this project was last set up with.
          const remembered = readSelections()[storeKey(info.root)] ?? {}
          // The whole description, so the next open of this workspace paints from
          // the store instead of waiting on xcodebuild again.
          remember(info.root, { location: info.location, info })
          // And under the directory the panel was pointed at, which is a different
          // key whenever the project sits in a subdirectory — `detect` answers with
          // the project's own directory as its root.
          //
          // Without this line a workspace holding several projects asked the user to
          // pick one on every single open: the choice was written under
          // `/ws/App` and looked up under `/ws`, so the record existed and was never
          // found. Writing both keys keeps the per-project facts (scheme,
          // configuration) where they were and gives the workspace the one thing it
          // is asked for when it opens — which project.
          if (state.searchRoot !== '' && storeKey(state.searchRoot) !== storeKey(info.root)) {
            remember(state.searchRoot, { location: info.location, info })
          }
          // And against the session workspace, whichever directory the project was
          // found under: the panel belongs to the workspace, so reopening THAT is what
          // has to bring the project back — including when it was typed in from
          // somewhere else entirely.
          if (state.workspace !== '' && storeKey(state.workspace) !== storeKey(state.searchRoot)) {
            remember(state.workspace, { location: info.location, info })
          }
          // The project's own list, in its own order. It is not always just
          // Debug and Release — a real project here also builds `Test-Release`.
          // An empty list means the listing could not be read, not that the
          // project has no configurations, so the conventional pair stands in
          // only as a last resort.
          const listed = Array.isArray(info.configurations)
            ? info.configurations.filter((name) => typeof name === 'string' && name !== '')
            : []
          state.configurations = listed.length > 0 ? listed : ['Debug', 'Release']
          state.configuration = pickConfiguration(state.configurations, remembered.configuration ?? state.configuration)
          const preferred = info.sweetpadDefaults?.scheme
          // Remembered first, then the project's own SweetPad defaults, then a
          // guess. A remembered scheme the project no longer offers is skipped
          // rather than carried over.
          state.scheme = (state.schemes.includes(remembered.scheme) ? remembered.scheme : '')
            || (preferred && state.schemes.includes(preferred) ? preferred : '')
            || pickScheme(state.schemes, info.name)
          state.destinations = []
          state.destination = ''
          emit()
          await doDestinations()
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
        } finally {
          state.busy = false
          emit()
        }
      }

      /**
       * Put a freshly read destination list on screen.
       *
       * One place, so the three paths that can produce a list — a refresh, a held refresh
       * released when the dropdown closes, and the cache — cannot drift apart. A selection
       * that is no longer in the list moves to the host's recommendation rather than
       * pointing at a phone that has been unplugged.
       *
       * @param {{list: object[], recommended: string, at: number}} fresh - the new list.
       * @param {string} root - the workspace root to remember the choice under.
       */
      function applyDestinations(fresh, root) {
        state.destinations = fresh.list
        state.destinationsAt = fresh.at
        state.destinationsStale = false
        state.destinationsNext = null
        if (!fresh.list.some((entry) => entry.destination === state.destination)) {
          state.destination = fresh.recommended || ''
        }
        remember(root, {
          scheme: state.scheme,
          destination: state.destination,
          configuration: state.configuration,
        })
      }

      /**
       * Show the destination list, then refresh it.
       *
       * Always both, and in this order. A test bench swaps phones and simulators
       * constantly, so the command has to run on every look or the list goes stale in a
       * way nobody can see; and it takes seconds, so waiting for it before drawing
       * anything is what made the control feel dead. The cached list is therefore painted
       * first — with its age on screen, because that is what tells a user whether the
       * phone they just unplugged is still in it — and replaced the moment the command
       * answers.
       */
      async function doDestinations() {
        if (!state.path || !state.scheme) return
        const root = state.project?.root ?? ''
        const remembered = readSelections()[storeKey(root)] ?? {}
        // The app bundle that was last built here, so the next read can attach to the app that is
        // RUNNING instead of asking for another build. Attaching needs only the device and the app
        // bundle (its name is the process name), and both survive a page reload now.
        state.attachAppPath = typeof remembered.appPath === 'string' ? remembered.appPath : ''
        state.attachBundleId = typeof remembered.bundleId === 'string' ? remembered.bundleId : ''
        state.lldb.attachProcess = typeof remembered.process === 'string' ? remembered.process : ''
        const cached = cachedDestinations(remembered, state.scheme)
        if (cached !== null) {
          state.destinations = cached.list
          state.destinationsAt = cached.at
          state.destinationsStale = true
          // What this workspace CHOSE outranks the recommendation this cache stored, because one
          // is explicit intent and the other was a guess made on some earlier day. Painting from
          // the cache used to put the guess in `state.destination`, which then travelled to the
          // host as `preferred` — so a return visit asked the host to prefer the guess, and the
          // remembered device never came back. Only a choice that is still in the list counts;
          // anything else falls through to the recommendation below, as before.
          const chosen = typeof remembered.destination === 'string' ? remembered.destination : ''
          if (chosen !== '' && cached.list.some((entry) => entry.destination === chosen)) {
            state.destination = chosen
          } else if (!cached.list.some((entry) => entry.destination === state.destination)) {
            state.destination = cached.recommended || cached.list[0]?.destination || ''
          }
        }
        state.destinationsRefreshing = true
        state.error = ''
        // Painted before the await, so the cached list is on screen while the command runs.
        emit()
        try {
          // The host picks the default — connected hardware before a simulator —
          // so this panel and the xcode_destinations tool cannot disagree. What
          // this workspace used last time is sent along and outranks both.
          const result = await api('destinations', {
            path: state.path,
            scheme: state.scheme,
            preferred: state.destination || remembered.destination || '',
          })
          const fresh = {
            list: result.destinations ?? [],
            recommended: result.recommended ?? '',
            at: Date.now(),
          }
          // The list itself is remembered, which is what lets the next look paint
          // something before the command answers.
          remember(root, {
            destinations: {
              scheme: state.scheme,
              list: fresh.list,
              recommended: fresh.recommended,
              at: fresh.at,
            },
          })
          if (state.destinationsHeld === true) {
            // The dropdown is open: keep the fresh list aside and swap it in when it
            // closes, so the options never change under the pointer.
            state.destinationsNext = fresh
          } else {
            applyDestinations(fresh, root)
          }
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
          // The cached list is what is still on screen, so it stays marked as cached: a
          // refresh that failed must not make it look live.
        }
        // A held list is still pending, so the panel keeps saying it is refreshing until
        // it has actually been applied.
        if (state.destinationsNext === null) state.destinationsRefreshing = false
        emit()
      }

      /**
       * Ask for the device list again.
       *
       * Every look at the list re-reads it, which is the point: a phone may have been
       * plugged in since the last look and nothing else on the panel would have changed to
       * say so. The only thing skipped is a second read while the first is still running —
       * those would overlap and the later answer would be no fresher than the one on its
       * way.
       */
      function refreshDestinations() {
        if (state.path === '' || state.scheme === '') return
        if (state.destinationsRefreshing === true) return
        void doDestinations()
      }

      /** Apply a refresh that was held back while the destination dropdown was open. */
      function releaseDestinations() {
        state.destinationsHeld = false
        const held = state.destinationsNext
        if (held === null) return
        applyDestinations(held, state.project?.root ?? '')
        state.destinationsRefreshing = false
        emit()
      }

      /**
       * Take over a run this panel did not start — in practice one the model began
       * with `xcode_run`. The log window restarts at line 0 (a `logNext` left from
       * the previous run would skip its head), and the selectors show what is
       * actually building, so the panel never displays one target while another runs.
       */
      function adoptRun(run) {
        state.runId = run.runId
        state.activeRunId = run.runId
        state.runOrigin = run.origin ?? 'panel'
        state.status = 'running'
        state.log = []
        state.logNext = 0
        state.searchLines = null
        state.searchKey = ''
        state.errors = []
        state.warningCount = 0
        state.artifact = null
        state.note = ''
        state.death = null
        state.exitCode = null
        state.durationMs = 0
        state.appReleased = false
        if (run.projectPath && run.projectPath === state.path) {
          if (run.scheme && state.schemes.includes(run.scheme)) state.scheme = run.scheme
          if (run.configuration && state.configurations.includes(run.configuration)) state.configuration = run.configuration
          if (run.destination && state.destinations.some((entry) => entry.destination === run.destination)) {
            state.destination = run.destination
          }
        }
      }

      async function doStart(action) {
        if (state.busy) return
        state.busy = true
        state.error = ''
        state.log = []
        state.logNext = 0
        state.searchLines = null
        state.searchKey = ''
        state.errors = []
        state.warningCount = 0
        state.artifact = null
        state.note = ''
        state.death = null
        state.exitCode = null
        state.appReleased = false
        state.status = 'starting'
        emit()
        try {
          const result = await api('start', {
            path: state.path,
            action,
            scheme: state.scheme,
            destination: state.destination,
            configuration: state.configuration,
          })
          state.runId = result.runId
          state.activeRunId = result.runId
          state.runOrigin = 'panel'
          state.status = 'running'
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
          state.status = 'idle'
        } finally {
          state.busy = false
          emit()
        }
      }

      async function doStop() {
        // Stopping ends the debugger too. A session left attached holds the device AND leaves the app
        // stopped, which is the state nobody asked for — and it is what makes the next attach fail
        // with "already being debugged". `dispose` detaches before it quits, so the app runs on.
        state.appReleased = true
        const hadSession = state.lldb.session !== null
        if (hadSession) {
          state.lldb.session = null
          state.lldb.busy = ''
          state.lldb.note = 'Stopped: the debugger was released and the app is running again.'
          try {
            await api('lldb', { op: 'dispose' })
          } catch {
            /* there may have been nothing left to end */
          }
        }
        if (state.activeRunId) {
          try {
            await api('stop', { runId: state.activeRunId })
          } catch {
            /* the run may have exited between the paint and the click */
          }
        }
        emit()
      }

      async function refreshState() {
        lastStateReadAt = Date.now()
        try {
          const result = await api('state', {})
          state.workspace = result.workspace ?? ''
          state.revision = result.revision ?? ''
          // Asked once per panel, not per tick: the report shells out to
          // `xcode-select` and `xcodebuild -version`, far too heavy for a
          // 2.5-second loop, and the answer only changes when the user installs
          // something. Reopening the panel is a fine way to ask again.
          if (!state.doctorAsked) {
            state.doctorAsked = true
            void api('doctor', {})
              .then((report) => { state.doctor = report; emit() })
              .catch(() => { /* an older host has no doctor route */ })
          }
          if (!state.activeRunId && result.activeRunId && result.activeRunId !== state.runId) {
            adoptRun(result.active ?? { runId: result.activeRunId })
          } else if (!state.activeRunId && result.activeRunId) {
            state.activeRunId = result.activeRunId
            state.status = 'running'
          }
          emit()
        } catch {
          /* the host may not be mounted yet, or the panel may be stale */
        }
      }

      // A tick still in flight must not be overlapped by the next one. `logNext`
      // advances only once a response lands, so a poll slower than the interval
      // lets a second request ask for the same range and append it a second time —
      // duplicate rows, duplicate React keys, and a log that grows twice as fast.
      let pollInFlight = false
      async function poll() {
        if (pollInFlight) return
        pollInFlight = true
        try {
          await pollOnce()
        } finally {
          pollInFlight = false
        }
      }

      async function pollOnce() {
        if (state.activeRunId) {
          try {
            const result = await api('poll', { runId: state.activeRunId, from: state.logNext })
            if (result.missing) {
              state.activeRunId = null
              state.status = 'unknown'
            } else {
              // The host dropped lines the browser never received: drop the local
              // window too, so line numbers stay gapless and the filter's count
              // keeps meaning something.
              if (result.firstAvailable > state.logNext && state.logNext > 0) state.log = []
              for (const line of result.lines ?? []) state.log.push(line)
              if (state.log.length > CLIENT_LINE_CAP) state.log.splice(0, state.log.length - CLIENT_LINE_CAP)
              state.logNext = result.next
              state.status = result.status
              state.exitCode = result.exitCode
              state.warningCount = result.warningCount ?? 0
              state.errors = result.errors ?? []
              state.durationMs = result.durationMs ?? 0
              state.artifact = result.artifact ?? null
              // Remembered so the NEXT read can attach to the app that is running, without
              // another build: the device, the app bundle and the process name are the whole
              // requirement for attaching.
              if (state.artifact !== null) {
                state.attachAppPath = state.artifact.appPath ?? ''
                state.attachBundleId = state.artifact.bundleId ?? ''
                // A build IS a choice: the app it just produced is the one to read, so the target
                // follows it without being asked, and a process picked from the Apps list gives way.
                // The name is the bundle's file name, which is what the process is called; the pid
                // is the freshest one there is, and the host re-finds it by name if the app restarts.
                const built = state.attachAppPath === ''
                  ? ''
                  : state.attachAppPath.split('/').pop().replace(/\.app$/, '')
                state.lldb.attachProcess = built
                state.lldb.attachPid = Number.isFinite(state.artifact.pid) ? state.artifact.pid : null
                state.lldb.processes = null
                remember(state.project?.root ?? '', {
                  destination: state.destination,
                  appPath: state.attachAppPath,
                  bundleId: state.attachBundleId,
                  process: state.lldb.attachProcess,
                })
                attachLaunchedApp()
              }
              state.note = result.note ?? ''
              state.death = result.death ?? null
              if (result.status !== 'running') {
                state.activeRunId = null
                void refreshState()
              }
            }
            emit()
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error)
            emit()
          }
        }

        // Committed text filter: ask the host, whose ring holds the whole run.
        if (state.filter !== '' && state.runId) {
          const pattern = state.regex ? state.filter : escapeRegExp(state.filter)
          const key = `${pattern}@${String(state.logNext)}@${String(state.clearedAt)}`
          if (key !== state.searchKey) {
            state.searchKey = key
            try {
              const result = await api('search', { runId: state.runId, grep: pattern, limit: 1500, since: state.clearedAt })
              if (!result.missing) {
                state.searchLines = result.lines ?? []
                state.searchTotal = result.totalLines ?? 0
                emit()
              }
            } catch {
              // An invalid regex, or a run that is gone: keep `searchKey` so this
              // does not retry twice a second, and fall back to the local window.
              state.searchLines = null
            }
          }
        }

        // Idle, the panel keeps asking whether a run has appeared, so a build the
        // model starts shows up here within a few seconds. The route only reads
        // memory; the doctor report, which shells out, is asked once per panel.
        if (!state.activeRunId && Date.now() - lastStateReadAt > 2500) await refreshState()

        // The debugger. Asked for whenever the drawer is open, and rarely when it is not:
        // a closed drawer still has to notice a session the model started, because that is
        // the one thing that opens it by itself.
        if (state.lldbOpen || Date.now() - lldbAskedAt > LLDB_IDLE_MS) await refreshLldb()
      }

      // -- the debugger's data ---------------------------------------------
      //
      // The drawer is a view of the host's session, so everything here is a question
      // asked of the `lldb` route. Two rules make it safe to live inside the build panel:
      // no failure is ever written to `state.error` (a dead debugger must not paint a red
      // row across a healthy build), and nothing here hangs — a `view` on a device takes
      // 10-25 s to attach, which the busy flag reports rather than freezing the drawer.

      /** How long a closed drawer waits between asking whether a session appeared. */
      const LLDB_IDLE_MS = 4000
      /** Lines of session transcript kept in the browser. */
      const LLDB_LINE_CAP = 4000
      /**
       * The height of one hierarchy row, and the indent of one level, in pixels.
       *
       * 28 and 14 are Lookin's own numbers, and the fixed height is why the tree can be drawn as a
       * window over its rows — only what is on screen is built, and the scroll position is
       * arithmetic rather than a measurement.
       */
      const LLDB_ROW_HEIGHT = 28
      const LLDB_ROW_INDENT = 14

      let lldbAskedAt = 0

      /**
       * The attribute read a selection wants but cannot start yet.
       *
       * `runLldb` refuses to begin while an operation is in flight, and picking a row is itself an
       * operation — so the read that the pane needs is queued here and drained when the selection's
       * own answer has landed. One deep on purpose: only the view that is picked now matters, and a
       * queue of addresses would be a queue of reads nobody is waiting for any more.
       */
      let lldbAttrsWanted = ''

      /**
       * Read the session's state, and whatever it has said since the last read.
       *
       * Cursor-based like the build log, and for the same reason: the host owns the whole
       * transcript and the panel holds a window of it, so a slow poll cannot duplicate
       * lines and a dropped window is noticed rather than rendered as a gap.
       */
      async function refreshLldb() {
        lldbAskedAt = Date.now()
        try {
          const result = await api('lldb', { op: 'state', from: state.lldb.next })
          const wasActive = state.lldb.active === true
          state.lldb.active = result.active === true
          state.lldb.session = result.session ?? null
          if (typeof result.firstAvailable === 'number' && result.firstAvailable > state.lldb.next && state.lldb.next > 0) {
            state.lldb.lines = []
          }
          for (const line of result.lines ?? []) state.lldb.lines.push(line)
          if (state.lldb.lines.length > LLDB_LINE_CAP) {
            state.lldb.lines.splice(0, state.lldb.lines.length - LLDB_LINE_CAP)
          }
          if (typeof result.next === 'number') state.lldb.next = result.next
          // A session the model starts opens the drawer by itself. The user asked for a
          // debugger they can watch, and one that appears without a word is a mystery —
          // especially since it leaves the app stopped.
          if (state.lldb.active && !wasActive && !state.lldbOpen) state.lldbOpen = true
          emit()
        } catch {
          // A host half without the route at all is not an error to report: the drawer
          // simply stays empty until the newer half is running.
        }
      }

      /**
       * Run one debugger operation, and fold what it said back into the drawer.
       *
       * @param {string} op - view, attach, interrupt, detach, dispose or command.
       * @param {object} body - the operation's own arguments.
       */
      /**
       * Stop the read that is in flight.
       *
       * A view read is a device attach driving a debugger, and it can take half a minute; aborting it
       * has to RELEASE that debugger rather than only hide the spinner, or the app is left stopped and
       * the device held by a session nobody is waiting for. The attempt counter is what makes the
       * answer that is already on its way harmless: it arrives, finds it is no longer the current
       * attempt, and is dropped instead of repainting the panel with a tree that was cancelled.
       */
      /** Ask the host about the background full export, and keep asking while it runs. */
      let lookinPoll = null
      async function pollLookinJob() {
        try {
          const answer = await api('lldb', { op: 'lookinJob' })
          state.lldb.lookinJob = answer?.job ?? null
        } catch {
          /* a missed poll is retried by the next one */
        }
        const job = state.lldb.lookinJob
        if (job === null || job.finished === true) {
          if (lookinPoll !== null) clearInterval(lookinPoll)
          lookinPoll = null
          // A finished export joins the history, so the list is current the next time it is opened.
          if (job !== null && job.finished === true) {
            if (job.stage === 'done' && typeof job.path === 'string' && job.path !== '') state.lldb.lookinPath = job.path
            void loadLookinHistory()
          }
        }
        emit()
      }

      function watchLookinJob() {
        if (lookinPoll !== null) return
        lookinPoll = setInterval(() => { void pollLookinJob() }, 700)
      }

      /**
       * The full export: rendered images for every view, made in the background.
       *
       * Not through `runLldb`, for the same reason the app log is not: that lock disables the whole
       * drawer, and a full export is minutes of work during which the drawer must stay usable —
       * including the button that cancels it.
       */
      async function startLookinFull() {
        state.lldb.lookinNote = ''
        try {
          const answer = await api('lldb', {
            op: 'lookinFull',
            destination: state.destination,
            appPath: state.attachAppPath ?? '',
            bundleId: state.attachBundleId ?? '',
            process: state.lldb.attachProcess ?? '',
            pid: Number.isFinite(state.lldb.attachPid) ? state.lldb.attachPid : null,
          })
          state.lldb.lookinJob = answer?.job ?? null
          if (typeof answer?.note === 'string' && answer.note !== '') state.lldb.lookinNote = answer.note
          watchLookinJob()
        } catch (error) {
          state.lldb.lookinNote = error instanceof Error ? error.message : String(error)
        }
        emit()
      }

      async function cancelLookinFull() {
        try {
          const answer = await api('lldb', { op: 'lookinCancel' })
          state.lldb.lookinJob = answer?.job ?? state.lldb.lookinJob
        } catch {
          /* the next poll says what happened */
        }
        watchLookinJob()
        emit()
      }

      async function loadLookinHistory() {
        try {
          const answer = await api('lldb', { op: 'lookinHistory' })
          state.lldb.lookinHistory = Array.isArray(answer?.entries) ? answer.entries : []
        } catch (error) {
          state.lldb.lookinNote = error instanceof Error ? error.message : String(error)
        }
        emit()
      }

      async function lookinRowAction(op, name) {
        state.lldb.lookinRowBusy = name
        state.lldb.lookinNote = ''
        emit()
        try {
          const answer = await api('lldb', { op, name })
          if (op === 'lookinDelete' && Array.isArray(answer?.entries)) state.lldb.lookinHistory = answer.entries
          if (answer?.ok !== true) state.lldb.lookinNote = typeof answer?.note === 'string' ? answer.note : 'that did not work'
          else if (op === 'lookinOpenFile' && typeof answer.note === 'string') state.lldb.lookinNote = answer.note
        } catch (error) {
          state.lldb.lookinNote = error instanceof Error ? error.message : String(error)
        } finally {
          state.lldb.lookinRowBusy = ''
          emit()
        }
      }

      async function abortLldb() {
        state.lldb.attempt = (state.lldb.attempt ?? 0) + 1
        state.lldb.busy = ''
        state.lldb.error = ''
        state.lldb.note = 'Read stopped. The debugger was released and the app is running again.'
        emit()
        try {
          await api('lldb', { op: 'dispose' })
        } catch {
          /* the session was going away regardless */
        }
      }

      /**
       * Read one window of the selected app's log.
       *
       * Deliberately NOT through `runLldb`. That one lock belongs to the debugger session, and the log
       * read held it: every 15 s the whole drawer was disabled — buttons that ignore a press for the
       * half-minute a CoreDevice copy can take — while doing something that never touches lldb. That is
       * the "the lldb environment feels intermittent" this fixes. The two are independent, so they get
       * independent locks and independent message areas, and a log read can no longer swallow a click
       * meant for the debugger.
       */
      async function fetchAppLog(name, bundleId) {
        if (state.appLogBusy === true || name === '') return
        state.appLogBusy = true
        emit()
        try {
          const result = await api('lldb', {
            op: 'logs',
            name,
            destination: state.destination,
            bundleId: bundleId ?? '',
          })
          // Into the LOG PANEL, which already speaks this format: its four level buttons ARE a device
          // log's four levels, and the host classifies every line into one of them.
          const incoming = Array.isArray(result.lines) ? result.lines : []
          let next = (state.log[state.log.length - 1]?.n ?? 0) + 1
          for (const line of incoming) {
            const text = typeof line === 'string' ? line : String(line?.t ?? '')
            if (text === '') continue
            const wanted = typeof line === 'string' ? 'plain' : String(line?.k ?? 'plain')
            // A kind the panel has no button for would be a line it can never show again, so an
            // unknown one becomes `plain`, which it can.
            state.log.push({ n: next, t: text, k: state.kinds[wanted] === undefined ? 'plain' : wanted })
            next += 1
          }
          if (state.log.length > CLIENT_LINE_CAP) state.log.splice(0, state.log.length - CLIENT_LINE_CAP)
          // An empty window and a missing reader are different problems, and only one of them is the
          // app being quiet: the host's note names which. It goes to the log panel's own error line,
          // never to the drawer's, which is about the debugger.
          if (typeof result.note === 'string' && result.note !== '') state.error = String(result.note)
          else if (result.ok === true) state.error = ''
        } catch (error) {
          state.error = `app log: ${error?.message ?? 'the read failed'}`
        } finally {
          state.appLogBusy = false
          emit()
        }
      }

      /**
       * The app a read is about, for every request that touches the debugger.
       *
       * `view` always sent this; the inspector's reads sent only an address, and the host then had to
       * guess the app from the workspace's runs. When that guess came up empty the host built an
       * unnamed device target, threw away the session the tree had just been read from, and answered
       * `the device  () is not one lldb can attach to right now` — on every attribute and layout read.
       * The host now reuses a live session for an unnamed request as well; this is the other half, and
       * it is what lets a read attach when nothing is attached yet.
       *
       * @returns the target fields, exactly as `view` sends them.
       */
      function lldbTargetBody() {
        return {
          destination: state.destination,
          appPath: state.attachAppPath ?? '',
          bundleId: state.attachBundleId ?? '',
          // A process picked from the Apps list wins over looking one up: it is the answer to
          // "which app", and it is a device's way of naming one.
          process: state.lldb.attachProcess ?? '',
          pid: Number.isFinite(state.lldb.attachPid) ? state.lldb.attachPid : null,
        }
      }

      async function runLldb(op, body) {
        if (state.lldb.busy !== '') return
        if (op === 'command' && typeof body?.command === 'string') {
          state.commandHistory = rememberInput(state.commandHistory, body.command.trim(), COMMAND_HISTORY)
        }
        // Every read carries the number of the attempt it belongs to: an aborted read's answer must
        // not land on top of the state that replaced it.
        const attempt = (state.lldb.attempt ?? 0) + 1
        state.lldb.attempt = attempt
        state.lldb.busy = op
        state.lldb.error = ''
        state.lldb.note = ''
        emit()
        try {
          const result = await api('lldb', { op, ...(body ?? {}) })
          // Stopped while this was on its way: the user asked for it to go away, and this answer is
          // the cancelled read's, so nothing about it may be painted.
          if (state.lldb.attempt !== attempt) return
          if (op === 'view' || op === 'attach') {
            state.lldb.viewFailed = result.ok !== true
            state.lldb.refused = result.ok !== true && result.refused === true
          }
          if (op === 'processes') {
            state.lldb.processes = Array.isArray(result.processes) ? result.processes : []
            state.lldb.note = typeof result.note === 'string' ? result.note : ''
            if (result.ok !== true && state.lldb.processes.length === 0) state.lldb.error = state.lldb.note
          }
          if (op === 'view' && result.ok === true) {
            state.lldb.tree = {
              target: result.target ?? null,
              views: result.views ?? 0,
              depth: result.depth ?? 0,
              classes: result.classes ?? [],
              shown: result.shown ?? 0,
              truncated: result.truncated === true,
              records: result.records ?? [],
            }
            // A fresh tree is something to look at: a folded tree section opens for it.
            state.lldb.treeShown = true
            state.lldb.filter = ''
            // New addresses are different objects: what was read for the old ones may be a view that
            // no longer exists, so nothing about the old tree is kept.
            state.lldb.attrs = {}
            state.lldb.layout = {}
            state.lldb.focusAddress = ''
            state.lldb.editNote = ''
          }
          if (op === 'view' && result.ok === true && result.details !== null && typeof result.details === 'object') {
            // The tree's own prefetch, straight into the caches the panes read: an address that
            // arrives here is answered by the panel from now on, which is what makes clicking around
            // a hierarchy free — and what keeps a click from reaching for the app at all.
            for (const [address, detail] of Object.entries(result.details)) {
              if (Array.isArray(detail?.groups)) {
                state.lldb.attrs[address] = {
                  ok: true,
                  address,
                  className: detail.className ?? '',
                  groups: detail.groups,
                  attributes: detail.attributes ?? 0,
                }
              }
              if (detail?.layout) {
                state.lldb.layout[address] = { ok: true, address, layout: detail.layout }
              }
            }
            state.lldb.detailsViews = Number.isFinite(result.detailsViews) ? result.detailsViews : 0
            state.lldb.detailsCapped = result.detailsCapped === true
          }
          // The host writes the .lookin file as it reads the tree, so the path arrives with
          // the dump; opening it later must not lose it if a poll happens in between.
          if (op === 'view') state.lldb.lookinPath = typeof result.lookinPath === 'string' ? result.lookinPath : ''
          if (op === 'lookin' && typeof result.path === 'string' && result.path !== '') state.lldb.lookinPath = result.path
          // Whether Lookin.app is installed on the machine the host runs on. The button that opens
          // the file in Lookin only appears when it is; when it is not, the same slot offers the
          // file in Finder rather than pretending.
          if (typeof result.lookinAvailable === 'boolean') state.lldb.lookinAvailable = result.lookinAvailable
          // A node answer belongs to the row that asked for it, and the solo image is the one a
          // person opened the pane to see — the control without its children drawn over it.
          if (op === 'node') {
            state.lldb.node = result
            state.lldb.selected = typeof result.address === 'string' ? result.address : ''
            state.lldb.shot = 'solo'
            // Opening a view opens its attributes: the pane is the point of picking a row, and
            // asking later instead of now would leave it blank for the length of a stop. This read
            // has to wait for the one that is running — see `lldbAttrsWanted`.
            if (state.lldb.selected !== '' && state.lldb.attrs[state.lldb.selected] === undefined) {
              lldbAttrsWanted = state.lldb.selected
            }
          }
          if (op === 'attributes') {
            const address = typeof result.address === 'string' ? result.address : ''
            if (address !== '') {
              state.lldb.attrs = { ...state.lldb.attrs, [address]: result }
            }
          }
          if (op === 'constraints') {
            const address = typeof result.address === 'string' ? result.address : ''
            if (address !== '') state.lldb.layout = { ...state.lldb.layout, [address]: result }
          }
          if (op === 'edit') {
            state.lldb.editBusy = ''
            const address = typeof result.address === 'string' ? result.address : ''
            if (result.ok === true && address !== '' && (result.groups ?? []).length > 0) {
              state.lldb.attrs = {
                ...state.lldb.attrs,
                [address]: { ...(state.lldb.attrs[address] ?? {}), ok: true, address, groups: result.groups, note: '' },
              }
            } else if (result.ok === true && address !== '') {
              // The write landed but the list did not come back: drop what is held and read it again
              // rather than showing an empty pane that looks like the object has no attributes.
              const { [address]: dropped, ...rest } = state.lldb.attrs
              state.lldb.attrs = rest
              void runLldb('attributes', { address, refresh: true, ...lldbTargetBody() })
            }
            // The app's own answer, next to what was asked for. A `frame` the app writes back in
            // `layoutSubviews` is the normal case for a constraint-driven view, and Lookin's own
            // words for it — "the modification seems to have no effect" — are exactly the diagnosis
            // worth showing, so the two are compared rather than assumed equal.
            if (result.ok === true && typeof result.value === 'string' && result.value !== '') {
              state.lldb.editNote = editTookEffect(body?.value, result.value)
                ? ''
                : `修改似乎没有生效：应用里的实际值是 ${result.value}`
            }
          }
          // The operation's own answer carries the session it acted on, so the head can say
          // what happened without waiting for the next state poll to agree with it — the
          // difference between a drawer that updates when a dump lands and one that looks
          // empty for half a second afterwards.
          // Kept only when nothing newer has been seen: the poll that ran while this operation was
          // in flight may already have read a later state line (the app resumed, or was killed), and
          // the operation's snapshot must not paint over it.
          if (result.session !== undefined && (result.session === null || (result.session.lineCount ?? 0) >= (state.lldb.session?.lineCount ?? 0))) {
            state.lldb.session = result.session ?? null
            state.lldb.active = result.session !== null && result.session !== undefined
          }
          if (typeof result.note === 'string' && result.note !== '') state.lldb.note = result.note
          if (result.ok !== true) {
            state.lldb.error = typeof result.note === 'string' && result.note !== ''
              ? result.note
              : 'the debugger refused'
          }
        } catch (error) {
          state.lldb.error = error instanceof Error ? error.message : String(error)
        } finally {
          state.lldb.busy = ''
          await refreshLldb()
          emit()
          // Drained after the answer is on screen and nothing is in flight: this is the one place a
          // read can be started that the operation itself asked for.
          const wanted = lldbAttrsWanted
          lldbAttrsWanted = ''
          if (wanted !== '' && op !== 'attributes') void runLldb('attributes', { address: wanted, ...lldbTargetBody() })
        }
      }

      /**
       * The records the drawer's filter keeps, ancestors included.
       *
       * Done here rather than asked of the host, deliberately: the panel is a separate
       * module graph (`window.__ModuleLoader__`, no relative imports, so the host's
       * parser is not reachable from it) and re-asking for every keystroke would be a
       * round trip to re-filter data the browser is already holding.
       *
       * @returns {Array<object>} the rows to draw.
       */
      function lldbRows() {
        const all = state.lldb.tree?.records ?? []
        // Focus mode, the way Lookin's double-click works: the picked view and everything under it,
        // and nothing else. The rows keep their printed depths, so the indentation is re-based by the
        // renderer — the focused view sits at the left edge and its children step in from there.
        const focus = state.lldb.focusAddress
        const records = focus === undefined || focus === '' ? all : (() => {
          const at = all.findIndex((record) => record.address === focus)
          if (at < 0) return all
          const kept = [all[at]]
          for (let index = at + 1; index < all.length && all[index].depth > all[at].depth; index += 1) kept.push(all[index])
          return kept
        })()
        const needle = state.lldb.filter.trim().toLowerCase()
        if (needle === '') {
          state.lldb.filterHits = 0
          return records
        }
        const keep = []
        const path = []
        let hits = 0
        records.forEach((record, index) => {
          // Keep the path to here and drop any deeper branch that came before: a match
          // without its ancestors is a class name floating in space.
          path.length = Math.min(path.length, record.depth)
          path[record.depth] = index
          const hay = `${record.className ?? ''} ${rowSubtitle(record)} ${record.address ?? ''}`.toLowerCase()
          if (!hay.includes(needle)) return
          hits += 1
          for (const kept of path) if (kept !== undefined) keep[kept] = true
        })
        state.lldb.filterHits = hits
        return records.filter((record, index) => keep[index] === true)
      }

      /**
       * A view, described for the AI so that it can tell exactly which one is meant.
       *
       * The address alone is exact but means nothing to a reader, and the class alone is ambiguous —
       * a screen has dozens of UILabels. So the description carries both, plus what makes it findable
       * in source: the path of classes from the window down (with each step's index among siblings of
       * the same class), what it shows, where it is, and its direct children. The address is what an
       * `xcode_lldb` command can use to reach the same object while this app is still running.
       *
       * @param {Array<object>} records - the whole tree, in dump order.
       * @param {number} index - the view's position in `records`.
       * @param {object|null} target - what the tree was read from (`process`, `bundleId`, …).
       * @returns {string} Markdown for the chat composer.
       */
      function viewChatContext(records, index, target) {
        const record = records[index]
        if (record === undefined) return ''
        // Ancestors, nearest last: walk back to each shallower depth.
        const chain = [index]
        for (let at = index - 1, depth = record.depth; at >= 0 && depth > 0; at -= 1) {
          if (records[at].depth < depth) {
            chain.unshift(at)
            depth = records[at].depth
          }
        }
        // `UILabel[2]`: the third UILabel directly under its parent — what makes a path unambiguous.
        const step = (at) => {
          const own = records[at]
          let parent = -1
          for (let back = at - 1; back >= 0; back -= 1) {
            if (records[back].depth < own.depth) { parent = back; break }
          }
          let nth = 0
          let same = 0
          for (let scan = parent + 1; scan < records.length && (parent < 0 || records[scan].depth > records[parent].depth); scan += 1) {
            if (records[scan].depth !== own.depth || records[scan].className !== own.className) continue
            if (scan < at) nth += 1
            same += 1
          }
          return same > 1 ? `${own.className}[${String(nth)}]` : own.className
        }
        const children = []
        for (let at = index + 1; at < records.length && records[at].depth > record.depth; at += 1) {
          if (records[at].depth === record.depth + 1) children.push(records[at])
        }
        const describe = (entry) => {
          const subtitle = rowSubtitle(entry)
          return `${entry.className} ${entry.address}${subtitle === '' ? '' : ` ${subtitle}`} frame=${formatFrame(entry.frame) || '?'}`
        }
        const attributes = Object.entries(record.attributes ?? {})
          .filter(([, value]) => typeof value === 'string' && value !== '' && value !== '(null)')
          .slice(0, 12)
          .map(([key, value]) => `${key}=${value.length > 80 ? `${value.slice(0, 80)}…` : value}`)
        const app = target === null || target === undefined
          ? ''
          : [target.process, target.bundleId].filter((part) => typeof part === 'string' && part !== '').join(' / ')
        const lines = [
          `[iOS view hierarchy] the view I mean${app === '' ? '' : ` in ${app}`}:`,
          `- view: ${record.className} ${record.address}`,
          `- path: ${chain.map(step).join(' > ')}`,
          `- frame (in parent): ${formatFrame(record.frame) || 'unknown'}`,
        ]
        if (typeof record.text === 'string' && record.text !== '') lines.push(`- text: "${record.text}"`)
        const flags = []
        if (record.hidden === true) flags.push('hidden')
        if (record.alpha !== null && record.alpha !== undefined && record.alpha < 1) flags.push(`alpha=${String(record.alpha)}`)
        if (flags.length > 0) lines.push(`- visibility: ${flags.join(', ')}`)
        if (attributes.length > 0) lines.push(`- attributes: ${attributes.join('; ')}`)
        if (chain.length > 1) lines.push(`- parent: ${describe(records[chain[chain.length - 2]])}`)
        if (children.length > 0) {
          lines.push(`- children (${String(children.length)}):`)
          for (const child of children.slice(0, 8)) lines.push(`  - ${describe(child)}`)
          if (children.length > 8) lines.push(`  - … ${String(children.length - 8)} more`)
        }
        lines.push(`- the address is live only while this app process runs; xcode_lldb can reach it, e.g. \`po (id)${record.address}\``)
        return lines.join('\n')
      }

      /**
       * The composer source that owns a view chip. The chip shows `UILabel 0x10a3f…`; what the model
       * receives is the full description, carried in the chip's `ref` itself so it survives undo,
       * copy and paste without a side table. Its trigger is one the composer never detects, so it
       * never adds rows to the `@` or `/` menus — it only serializes.
       */
      const VIEW_CHIP_SOURCE = {
        trigger: 'dsh-xcodebuild:view',
        name: 'dsh-xcodebuild-view',
        showGroupTitle: false,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      }
      let inputTriggers = null
      ctx.inject?.(['inputTriggers'], (scope) => {
        inputTriggers = scope.inputTriggers
        scope.effect(() => {
          const dispose = scope.inputTriggers.registerSource(VIEW_CHIP_SOURCE)
          return () => {
            inputTriggers = null
            dispose()
          }
        }, 'dsh-xcodebuild: view chip source')
      })

      /**
       * Put a view into this session's chat composer, after whatever is already being typed.
       *
       * As a chip when the composer can take one: it reads `ClassName 0xaddress`, and the full
       * description replaces it only when the message is sent. Otherwise as plain text, through the
       * conversation's input face, or the composer's contenteditable as the last resort. Never sends:
       * the user adds their question and sends it themselves.
       *
       * @param {string} text - the full description the model should receive.
       * @param {string} label - what the chip shows.
       * @returns {boolean} whether a composer took it.
       */
      function addToChat(text, label) {
        const conversation = ctx.get?.('conversation')
        const scope = sessionId === null ? undefined : ctx.get?.('sessions')?.scope?.(sessionId)
        if (conversation?.input !== undefined && scope !== undefined) {
          try {
            const input = conversation.input.for(scope)
            if (inputTriggers !== null && typeof input.insertReference === 'function') {
              // At the end of the draft, a space away from what is there.
              const before = String(input.projection?.detectText ?? input.snapshot?.draft ?? '')
              if (before !== '' && !/\s$/.test(before) && typeof input.insertText === 'function') {
                input.insertText(' ', { start: before.length, end: before.length, draftRev: input.snapshot.draftRev })
              }
              const at = String(input.projection?.detectText ?? input.snapshot?.draft ?? '').length
              const inserted = input.insertReference({
                source: VIEW_CHIP_SOURCE.name,
                ref: text,
                label,
                clipboardText: text,
              }, { start: at, end: at, draftRev: input.snapshot.draftRev })
              if (inserted) {
                try { input.focus?.() } catch { /* the chip is in; focus is a courtesy */ }
                return true
              }
            }
            const current = String(input.snapshot?.draft ?? '')
            input.setDraft(current.trim() === '' ? text : `${current.replace(/\s+$/, '')}\n\n${text}`)
            try { input.focus?.() } catch { /* the draft is in; focus is a courtesy */ }
            return true
          } catch {
            /* a scope torn down mid-call: the DOM path below still gets the text in */
          }
        }
        const editable = document.querySelector('[data-composer-input]')
        if (editable === null) return false
        editable.focus()
        const selection = document.getSelection?.()
        if (selection !== null && selection !== undefined) {
          const range = document.createRange()
          range.selectNodeContents(editable)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        const prefix = String(editable.textContent ?? '').trim() === '' ? '' : '\n\n'
        let ok = false
        try {
          ok = document.execCommand?.('insertText', false, `${prefix}${text}`) === true
        } catch {
          ok = false
        }
        if (!ok) {
          editable.textContent = `${String(editable.textContent ?? '')}${prefix}${text}`
          editable.dispatchEvent(new Event('input', { bubbles: true }))
        }
        return true
      }

      /**
       * What sits beside a view's class name, the way Lookin's subtitle does.
       *
       * Lookin's subtitle is the name of the ivar that points at the view — `_contentView`,
       * `_label` — which it learns from the server. Nothing here knows that for free, and asking
       * per row would be a stop per row, so the subtitle says the next most useful thing that IS
       * already in hand: the text a label is showing, the flags that make a view invisible, and
       * whatever single attribute the dump printed that distinguishes this view from its siblings.
       *
       * @param {object} record - one view record.
       * @returns {string} the subtitle, possibly empty.
       */
      function rowSubtitle(record) {
        if (typeof record.text === 'string' && record.text !== '') return `"${record.text}"`
        const attributes = record.attributes ?? {}
        // `label` and `userInteraction` are what a dump prints outside the semicolon list, and
        // for a container they are the only thing that tells two siblings apart.
        for (const key of ['label', 'image', 'title', 'name', 'identifier']) {
          const value = attributes[key]
          if (typeof value === 'string' && value !== '' && value !== '(null)') return String(value)
        }
        // A stack view's axis, distribution and alignment ARE its layout — they are usually the
        // reason a screen looks wrong — and the dump prints all three outside the semicolon list.
        const stack = ['axis', 'distribution', 'alignment']
          .filter((key) => typeof attributes[key] === 'string' && attributes[key] !== '')
          .map((key) => `${key}=${attributes[key]}`)
        if (stack.length > 0) return stack.join(' ')
        if (record.hidden === true) return 'hidden'
        if (record.alpha !== null && record.alpha !== undefined && record.alpha < 1) return `alpha ${String(record.alpha)}`
        if (typeof attributes.userInteraction === 'string' && attributes.userInteraction === 'NO') return 'no interaction'
        return ''
      }

      /**
       * Which glyph a row shows.
       *
       * Lookin picks a per-class PDF from a table and walks the class chain outermost-first, so a
       * `UIButton` beats a `UIControl` and a cell beats a reusable view. The families matter more
       * than the exact class: a row is scanned, not read, and "this is a label" is the whole
       * message. `baseClass` is the chain our own dump prints, so the walk is over text we already
       * have rather than another expression.
       *
       * @param {object} record - one view record.
       * @returns {string} a family name used as a CSS class and as the icon key.
       */
      function viewFamily(record) {
        const chain = `${record.className ?? ''} ${record.baseClass ?? ''}`
        const order = [
          ['UIWindow', 'window'], ['UINavigationBar', 'navbar'], ['UITabBar', 'tabbar'],
          ['UITextView', 'textview'], ['UIStackView', 'stack'], ['UITextField', 'field'],
          ['UITableView', 'table'], ['UICollectionViewCell', 'cell'], ['UICollectionView', 'collection'],
          ['UITableViewCell', 'cell'], ['_UITableViewCellSeparatorView', 'separator'],
          ['UITableViewCellContentView', 'cellcontent'], ['UITableViewHeaderFooterView', 'headerfooter'],
          ['UIScrollView', 'scroll'], ['UILabel', 'label'], ['UIButton', 'button'],
          ['UIImageView', 'image'], ['UIControl', 'control'], ['UIVisualEffectView', 'effect'],
          ['UISlider', 'slider'], ['UISwitch', 'switch'], ['UIProgressView', 'progress'],
        ]
        for (const [name, family] of order) {
          if (new RegExp(`(^|[\\s.])${name}([\\s.]|$)`).test(chain)) return family
        }
        return 'view'
      }

      /**
       * The 15-pixel glyph a row shows, as an inline SVG.
       *
       * Inline rather than an image asset: the panel is one JavaScript module with no files of its
       * own, and a sprite would be a route and a fetch. Shapes are drawn on a 15×15 grid to match
       * Lookin's icons, which are all 15×15 PDFs, and every path is stroked with `currentColor` so
       * the icon follows the row's colour — dimmed for a hidden branch, white when picked.
       *
       * @param {string} family - from `viewFamily`.
       * @param {string} key - React key.
       * @returns {object} the SVG element.
       */
      function viewIcon(family, key) {
        const paths = {
          window: ['M1.5 2.5h12v10h-12z', 'M1.5 5.5h12'],
          navbar: ['M1.5 2.5h12v10h-12z', 'M4.5 6.5h6'],
          tabbar: ['M1.5 2.5h12v10h-12z', 'M3 13.5v-3h2v3', 'M7 13.5v-3h2v3'],
          view: ['M1.5 2.5h12v10h-12z'],
          label: ['M2.5 3.5h10', 'M7.5 3.5v8'],
          button: ['M1.5 4.5h12v6h-12z', 'M4.5 7.5h6'],
          image: ['M1.5 2.5h12v10h-12z', 'M2 11l3-3 2 2 3-3 3 3'],
          table: ['M1.5 2.5h12v10h-12z', 'M1.5 6h12', 'M1.5 9.5h12'],
          cell: ['M1.5 2.5h12v10h-12z', 'M3.5 5.5h8', 'M3.5 8h5'],
          cellcontent: ['M3.5 4.5h8v6h-8z'],
          separator: ['M1.5 7.5h12'],
          headerfooter: ['M1.5 2.5h12v4h-12z', 'M1.5 9.5h12'],
          scroll: ['M2.5 2.5h10v10h-10z', 'M12.5 2.5v10', 'M4 6l1.5-1.5L7 6'],
          stack: ['M2.5 3.5h10v2h-10z', 'M2.5 6.5h10v2h-10z', 'M2.5 9.5h10v2h-10z'],
          textview: ['M2.5 2.5h10v10h-10z', 'M4.5 5.5h6', 'M4.5 8h6', 'M4.5 10.5h3'],
          field: ['M1.5 5.5h12v4h-12z', 'M4.5 7.5h4'],
          collection: ['M2.5 2.5h4v4h-4z', 'M8.5 2.5h4v4h-4z', 'M2.5 8.5h4v4h-4z', 'M8.5 8.5h4v4h-4z'],
          control: ['M7.5 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M7.5 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'],
          effect: ['M1.5 2.5h12v10h-12z', 'M4.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M10.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
          slider: ['M1.5 7.5h12', 'M5.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
          switch: ['M2.5 5.5h10v4h-10z', 'M9.5 7.5a1.5 1.5 0 1 0 0-0.01'],
          progress: ['M1.5 6.5h12v2h-12z', 'M1.5 6.5h6v2h-6z'],
          controller: ['M2.5 3.5h10v9h-10z', 'M5.5 3.5a2 2 0 1 1 4 0'],
          layer: ['M4.5 2.5h8v8h-8z', 'M2.5 4.5v8h8'],
        }
        const shape = paths[family] ?? paths.view
        return React.createElement('svg', {
          className: `xcb-lldb-icon xcb-lldb-icon-${family}`,
          key,
          viewBox: '0 0 15 15',
          width: 15,
          height: 15,
          'aria-hidden': 'true',
        }, shape.map((d, index) => React.createElement('path', { d, key: String(index) })))
      }

      /**
       * The path from a window down to one view, for the inspector's chain bar.
       *
       * Built from the flat tree rather than asked for: a dump is depth-first, so the ancestors of a
       * record are exactly the nearest preceding records with a smaller depth, and the host already
       * sent all of them. Following `superview` in the app would be one stop per level for something
       * the panel is already holding.
       *
       * @param {string} address - the view whose chain is wanted.
       * @returns {Array<{className: string, address: string}>} outermost first, the view last.
       */
      function viewChain(address) {
        const records = state.lldb.tree?.records ?? []
        const found = records.findIndex((record) => record.address === address)
        if (found < 0) return []
        const chain = [records[found]]
        let depth = records[found].depth
        for (let index = found - 1; index >= 0 && depth > 0; index -= 1) {
          if (records[index].depth < depth) {
            chain.unshift(records[index])
            depth = records[index].depth
          }
        }
        return chain.map((record) => ({ className: record.className, address: record.address }))
      }

      /** Split `"row 0"` / `{0, 0, 10, 20}` into the numbers or text an editor field wants. */
      function parseGeometry(text) {
        const inside = /^[{(](.*)[})]$/.exec(String(text ?? '').trim())
        if (inside === null) return null
        const parts = inside[1].split(',').map((part) => Number(part.trim()))
        return parts.every(Number.isFinite) ? parts : null
      }

      /**
       * Whether the value the app reports back is the value that was asked for.
       *
       * The comparison is loose on purpose. What goes out is a number, a boolean or a string from a
       * form; what comes back is how the object prints itself — `0.5` against `0.5`, a checked box
       * against `YES`, `hi` against `"hi"`, and `1, 2, 3, 4` against `{{1, 2}, {3, 4}}`. A strict
       * comparison would cry "no effect" at every one of those, and that is the one message here
       * that has to be trustworthy.
       *
       * @param {*} asked - what was sent.
       * @param {string} printed - what the app says the value is now.
       * @returns {boolean} true when the app looks like it kept the value.
       */
      function editTookEffect(asked, printed) {
        const got = String(printed).trim()
        if (Array.isArray(asked)) {
          const numbers = parseGeometry(got)
          if (numbers !== null) {
            return numbers.length === asked.length && numbers.every((number, at) => Math.abs(number - Number(asked[at])) < 0.001)
          }
        }
        const wanted = String(asked).trim()
        if (got === wanted) return true
        // A text attribute prints quoted: that is not a failure to take effect.
        const bare = (text) => text.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim()
        if (bare(got) === bare(wanted)) return true
        const a = Number(wanted)
        const b = Number(got)
        return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001
      }

      /** The hex an app-printed `UIColor` corresponds to, or '' for a colour it resolves later. */
      function colorHexOf(text) {
        const rgb = /red\s*=\s*([\d.]+)[;\s]*green\s*=\s*([\d.]+)[;\s]*blue\s*=\s*([\d.]+)/.exec(String(text))
        const parts = rgb === null
          ? (() => {
            const white = /white\s*=\s*([\d.]+)/.exec(String(text))
            return white === null ? null : [white[1], white[1], white[1]]
          })()
          : [rgb[1], rgb[2], rgb[3]]
        if (parts === null) return ''
        return `#${parts.map((part) => Math.max(0, Math.min(255, Math.round(Number(part) * 255))).toString(16).padStart(2, '0')).join('')}`
      }

      /** A number to two places: enough for a layout measurement, short enough for a badge. */
      function round2(value) {
        const number = Number(value)
        return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : String(value)
      }

      /** `{x, y, width, height}` as the compact `0,0 390x844` a tree row wants. */
      function formatFrame(frame) {
        if (frame === null || frame === undefined) return ''
        const round = (value) => Math.round(value * 10) / 10
        return `${round(frame.x)},${round(frame.y)} ${round(frame.width)}x${round(frame.height)}`
      }

      /** What the drawer's head says about the session: the same words lldb uses. */
      /**
       * The session's state as a light: the one thing a glance at the drawer should answer.
       *
       * The plugin probes LLDB for this on its own, and those probes used to print in the transcript —
       * a column of `process status` / `Process must be launched.` between the user's own commands.
       * They are silent now, and this light is where their answer shows.
       */
      function lldbLight(session, active) {
        if (active !== true || session === null) return { tone: 'off', label: 'No debugger session' }
        const state = String(session.state ?? 'idle')
        if (state === 'stopped') return { tone: 'green', label: 'Stopped — expressions and View Hierarchy can run' }
        if (state === 'running') return { tone: 'yellow', label: 'Running — Interrupt (or View Hierarchy) stops it to look inside' }
        if (state === 'attaching') return { tone: 'yellow blink', label: 'Attaching — waiting for the app to stop' }
        if (state === 'exited' || state === 'dead') {
          return { tone: 'red', label: `${state === 'dead' ? 'Debugger ended' : 'Process gone for the debugger'}${typeof session.detail === 'string' && session.detail !== '' ? ` — ${session.detail}` : ''}` }
        }
        return { tone: 'off', label: 'Idle — not attached' }
      }

      function lldbStateLine(session, active) {
        if (active !== true || session === null) return 'no session'
        const parts = [session.state ?? 'idle']
        if (typeof session.target === 'string' && session.target !== '') parts.push(session.target)
        if (typeof session.pid === 'number') parts.push(`pid ${String(session.pid)}`)
        if (session.attached !== null && session.attached !== undefined && session.attached.kind === 'device') {
          parts.push('device')
        }
        return parts.join(' · ')
      }

      /** Show the drawer, and put the caret in the command box. */
      function openLldb() {
        state.lldbOpen = true
        state.lldbFocus += 1
        void refreshLldb().then(() => { attachLaunchedApp() })
        emit()
      }

      /**
       * Mount the app the last Build & Run launched, the moment the drawer can use it.
       *
       * Opening the drawer is the request: waiting for View Hierarchy meant the attach — the slow
       * part, and the part that fails — only happened behind the first read, against a pid that
       * could be gone by then. The app keeps running once mounted; a read stops it when it asks.
       */
      function attachLaunchedApp() {
        if (state.lldbOpen !== true || state.lldb.busy !== '') return
        if (state.artifact === null || state.artifact === undefined || state.appReleased === true) return
        if (state.death !== null && state.death.fatal === true) return
        const session = state.lldb.session
        const held = state.lldb.active === true && session !== null && session.attached !== null && session.attached !== undefined
          && !['idle', 'starting', 'dead', 'exited'].includes(session.state)
        if (held) return
        // Once per launch: a mount that failed says why in the drawer, and is not retried in a loop.
        const key = `${state.runId ?? ''}:${state.attachAppPath ?? ''}`
        if (state.lldb.autoAttached === key) return
        state.lldb.autoAttached = key
        void runLldb('attach', {
          continue: true,
          destination: state.destination,
          appPath: state.attachAppPath ?? '',
          bundleId: state.attachBundleId ?? '',
          process: state.lldb.attachProcess ?? '',
          pid: Number.isFinite(state.lldb.attachPid) ? state.lldb.attachPid : null,
        })
      }

      /** Hide or show it. Hidden, the session keeps running — only its view is gone. */
      /**
       * Close the debugger drawer, and let the debugger go with it.
       *
       * A session left attached holds the device and leaves the app stopped — the state that makes the
       * next attach answer `already being debugged` — and a closed panel is not using it. `dispose`
       * detaches before it quits, so the app keeps running, and it is idempotent on the host, so a
       * session this panel never knew about (one the model opened) is released too.
       */
      function closeLldb() {
        state.lldbOpen = false
        const had = state.lldb.session !== null || state.lldb.busy !== ''
        state.lldb.session = null
        state.lldb.busy = ''
        state.lldb.tree = null
        state.lldb.viewFailed = false
        emit()
        if (!had) return
        void api('lldb', { op: 'dispose' }).catch(() => {
          /* the session may already be gone */
        })
      }

      function toggleLldb() {
        if (state.lldbOpen) {
          closeLldb()
          emit()
          return
        }
        openLldb()
      }

      // -- views -----------------------------------------------------------

      /**
       * The debugger drawer.
       *
       * One session, shared with the model on purpose: the user watches what the model
       * asks the app, and can take over the prompt at any point. `View Hierarchy` is the
       * button that matters — it attaches to the app this project last ran, stops it, and
       * draws its view tree, which is the question a screenshot cannot answer.
       */
      const STAGE_TEXT = {
        attaching: 'Attaching to the app',
        reading: 'Reading the view tree',
        rendering: 'Rendering views',
        copying: 'Copying images off the device',
        writing: 'Writing the Lookin file',
        opening: 'Opening in Lookin',
        done: 'Done',
        failed: 'Failed',
        cancelled: 'Cancelled',
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`
      }

      function formatWhen(iso) {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return ''
        const pad = (value) => String(value).padStart(2, '0')
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      }

      /** The popup over the drawer: the quick-or-full choice with its progress, or the history. */
      function lookinPopupView() {
        const which = state.lldb.lookinPopup
        if (which !== 'lookin' && which !== 'history') return null
        const close = () => { state.lldb.lookinPopup = ''; emit() }
        const job = state.lldb.lookinJob
        const running = job !== null && job.finished !== true
        const head = (title) => React.createElement('div', { className: 'xcb-lldb-apps-head', key: 'head' }, [
          React.createElement('span', { key: 'title' }, title),
          React.createElement('button', { className: 'xcb-btn tiny', key: 'close', onClick: close }, 'Close'),
        ])
        const note = state.lldb.lookinNote === ''
          ? null
          : React.createElement('div', { className: 'xcb-lldb-apps-note', key: 'note' }, state.lldb.lookinNote)
        let body = []
        if (which === 'lookin') {
          const busy = state.lldb.busy
          const quick = React.createElement('button', {
            className: 'xcb-lookin-option xcb-lookin-quick',
            key: 'quick',
            disabled: busy !== '',
            onClick: () => {
              state.lldb.lookinPopup = ''
              emit()
              // The quick file is written by every read; without one yet, reading is the first step.
              if (state.lldb.tree === null || state.lldb.lookinPath === '') {
                void runLldb('view', {
                  continue: true,
                  destination: state.destination,
                  appPath: state.attachAppPath ?? '',
                  bundleId: state.attachBundleId ?? '',
                  process: state.lldb.attachProcess ?? '',
                  pid: Number.isFinite(state.lldb.attachPid) ? state.lldb.attachPid : null,
                }).then(() => {
                  if (state.lldb.lookinPath !== '') void runLldb('lookin', { open: true })
                })
                return
              }
              void runLldb('lookin', { open: true })
            },
          }, [
            React.createElement('b', { key: 't' }, 'Quick — structure only'),
            React.createElement('span', { key: 'd' }, 'The tree as read, without images. Seconds.'),
          ])
          const full = React.createElement('button', {
            className: 'xcb-lookin-option xcb-lookin-full',
            key: 'full',
            disabled: running,
            onClick: () => { void startLookinFull() },
          }, [
            React.createElement('b', { key: 't' }, 'Full — with every view rendered'),
            React.createElement('span', { key: 'd' }, 'Renders each view in short batches in the background, then opens it in Lookin. Can be cancelled.'),
          ])
          body = [React.createElement('div', { className: 'xcb-lookin-choice', key: 'choice' }, [quick, full])]
          if (job !== null) {
            const percent = Number.isFinite(job.percent) ? job.percent : 0
            const counted = job.stage === 'rendering' && job.total > 0 ? `${String(job.done)}/${String(job.total)}` : ''
            body.push(React.createElement('div', { className: 'xcb-lookin-progress', key: 'progress' }, [
              React.createElement('div', { className: 'xcb-lookin-bar', key: 'bar' },
                React.createElement('div', { className: 'xcb-lookin-fill', style: { width: `${String(percent)}%` } })),
              React.createElement('div', { className: 'xcb-lookin-stage', key: 'stage' }, [
                React.createElement('span', { key: 's' }, `${STAGE_TEXT[job.stage] ?? job.stage}${counted === '' ? '' : ` · ${counted}`}`),
                React.createElement('span', { key: 'p' }, `${String(percent)}%`),
              ]),
              job.note !== '' ? React.createElement('div', { className: 'xcb-lldb-apps-note', key: 'n' }, job.note) : null,
              running
                ? React.createElement('button', {
                    className: 'xcb-btn tiny xcb-lookin-cancel',
                    key: 'cancel',
                    disabled: job.cancelled === true,
                    onClick: () => { void cancelLookinFull() },
                  }, job.cancelled === true ? 'Cancelling...' : 'Cancel')
                : null,
            ]))
          }
          body.push(note)
          return popupShell([head('Open in Lookin'), ...body], close)
        }
        const entries = Array.isArray(state.lldb.lookinHistory) ? state.lldb.lookinHistory : []
        body = entries.length === 0
          ? [React.createElement('div', { className: 'xcb-lldb-apps-note', key: 'empty' }, 'No view tree has been kept yet. The newest three are kept.')]
          : entries.map((entry) => React.createElement('div', { className: 'xcb-lookin-row', key: entry.name, title: entry.name }, [
              React.createElement('span', { className: `xcb-lookin-kind ${entry.kind}`, key: 'k' }, entry.kind === 'full' ? 'Full' : 'Quick'),
              React.createElement('span', { className: 'xcb-lookin-row-main', key: 'm' }, [
                React.createElement('b', { key: 'a' }, entry.app === '' ? entry.name : entry.app),
                React.createElement('span', { key: 'i' }, [
                  formatWhen(entry.created),
                  `${String(entry.views)} views`,
                  entry.kind === 'full' ? `${String(entry.images)} images` : '',
                  formatBytes(entry.bytes),
                ].filter((part) => part !== '').join(' · ')),
              ]),
              React.createElement('button', {
                className: 'xcb-btn tiny xcb-lookin-open',
                key: 'o',
                disabled: state.lldb.lookinRowBusy !== '',
                onClick: () => { void lookinRowAction('lookinOpenFile', entry.name) },
              }, state.lldb.lookinRowBusy === entry.name ? '...' : 'Open'),
              React.createElement('button', {
                className: 'xcb-btn tiny xcb-lookin-delete',
                key: 'd',
                disabled: state.lldb.lookinRowBusy !== '',
                onClick: () => { void lookinRowAction('lookinDelete', entry.name) },
              }, 'Delete'),
            ]))
        return popupShell([head(`View tree history (${String(entries.length)})`), ...body, note], close)
      }

      function popupShell(children, close) {
        return React.createElement('div', {
          className: 'xcb-lldb-apps-popup xcb-lookin-popup',
          key: 'lookin-popup',
          onClick: (event) => { if (event.target === event.currentTarget) close() },
        }, React.createElement('div', { className: 'xcb-lldb-apps-card' }, children))
      }

      /**
       * The right-click menu both logs share: Select All, Copy, and Clear.
       *
       * The browser's own menu cannot take an extra entry, so the panel draws one. It is a FIXED layer
       * at the pointer, above everything: positioned inside a log it was clipped by that log's
       * overflow and the panel's whenever the log was short. Near the window's edge it opens toward
       * the room there is, like a native menu. It closes on a choice, a click elsewhere, Esc, or the
       * window losing focus.
       */
      function useLogMenu() {
        const [at, setAt] = React.useState(null)
        React.useEffect(() => {
          if (at === null) return undefined
          const close = () => setAt(null)
          const onKey = (event) => { if (event.key === 'Escape') close() }
          // Deferred one tick, so the right-click that opened the menu does not also close it.
          const timer = setTimeout(() => {
            document.addEventListener('mousedown', close)
            document.addEventListener('keydown', onKey)
            window.addEventListener('blur', close)
          }, 0)
          return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', close)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('blur', close)
          }
        }, [at])
        const open = (event) => {
          event.preventDefault()
          const width = 170
          const height = 110
          const viewW = window.innerWidth || 1024
          const viewH = window.innerHeight || 768
          const x = event.clientX + width > viewW ? Math.max(4, event.clientX - width) : event.clientX
          const y = event.clientY + height > viewH ? Math.max(4, event.clientY - height) : event.clientY
          setAt({ x, y })
        }
        /**
         * @param {{className: string, box: {current: Element|null}, lines: Array<{t: string}>, onClear: Function}} options
         */
        const render = (options) => {
          if (at === null) return null
          const lines = Array.isArray(options.lines) ? options.lines : []
          const selectAll = () => {
            const element = options.box.current
            const selection = window.getSelection?.()
            if (element === null || selection === null || selection === undefined) return
            const range = document.createRange()
            range.selectNodeContents(element)
            selection.removeAllRanges()
            selection.addRange(range)
          }
          const copy = async () => {
            // The selection when there is one, which is what Copy means everywhere; the whole log
            // otherwise, which is what a right-click on an unselected log most often wants.
            const picked = String(window.getSelection?.()?.toString() ?? '')
            const text = picked !== '' ? picked : lines.map((line) => line.t).join('\n')
            try {
              await navigator.clipboard.writeText(text)
            } catch {
              document.execCommand?.('copy')
            }
          }
          const items = [
            ['Select All', '⌘A', selectAll, false],
            ['Copy', '⌘C', () => { void copy() }, lines.length === 0],
            null,
            ['Clear', '', options.onClear, lines.length === 0],
          ]
          return React.createElement('div', {
            className: `xcb-ctxmenu ${options.className}`,
            key: 'menu',
            role: 'menu',
            style: { left: `${String(at.x)}px`, top: `${String(at.y)}px` },
            // Inside the menu a mousedown is a choice, not the click-away that closes it.
            onMouseDown: (event) => { event.stopPropagation() },
          }, items.map((item, index) => item === null
            ? React.createElement('div', { className: 'xcb-ctxmenu-sep', key: `sep${String(index)}` })
            : React.createElement('button', {
                className: `xcb-ctxmenu-item${item[0] === 'Clear' ? ' danger' : ''}`,
                key: item[0],
                type: 'button',
                role: 'menuitem',
                disabled: item[3],
                onClick: () => { setAt(null); item[2]() },
              }, [
                React.createElement('span', { key: 'l' }, item[0]),
                item[1] === '' ? null : React.createElement('span', { className: 'xcb-ctxmenu-key', key: 'k' }, item[1]),
              ])))
        }
        return { open, render }
      }

      /**
       * What a transcript line is, so it can be coloured like the build log's levels.
       *
       * The transcript is LLDB's own words, not a classified log, so this reads its shapes: the
       * echoed `(lldb) …` command is what the reader typed or the panel sent, `error:` lines are
       * LLDB refusing, and `Process N stopped / resuming / exited` is the app changing state — the
       * three things a person scans a console for.
       */
      function lldbLineKind(text) {
        const line = String(text ?? '').trimStart()
        if (line.startsWith('(lldb)')) return 'cmd'
        if (/^error:|^\s*error:|exited with status|Could not find process|not a valid command/i.test(line)) return 'error'
        if (/^warning:/i.test(line)) return 'warning'
        if (/^Process \d+ (stopped|resuming|exited|launched)|^Process \d+ is (running|stopped)|^Target \d+:/.test(line)) return 'state'
        return 'out'
      }

      function LldbDrawer(props) {
        useStore()
        const session = state.lldb.session
        const active = state.lldb.active === true
        const busy = state.lldb.busy
        const stopped = session !== null && session.state === 'stopped'
        const running = session !== null && (session.state === 'running' || session.state === 'attaching')
        const tree = state.lldb.tree
        const apps = Array.isArray(state.lldb.processes) ? state.lldb.processes : []
        // Mounted: the debugger holds an app. Everything that reads the app needs one, so those
        // buttons exist only while it does, and Apps — the way to get one — only while it does not.
        // A detach (`idle`), an app that exited, or a debugger that died all hand the choice back.
        const attached = active && session !== null && session.attached !== null && session.attached !== undefined
          && !['idle', 'starting', 'dead', 'exited'].includes(session.state)
        // A Build & Run mounts its app as well: the app it launched is the one to read, so nothing
        // is left to pick until it is let go (Stop, Detach) or it dies.
        const launched = state.artifact !== null && state.artifact !== undefined
          && state.appReleased !== true && !(state.death !== null && state.death.fatal === true)
        const mounted = attached || launched
        const box = React.useRef(null)
        // The console hugs its own bottom: a terminal that does not follow its tail makes the reader
        // scroll to find out what just happened, which is the opposite of watching it.
        const logBox = React.useRef(null)
        const [draft, setDraft] = React.useState('')

        // Only a press of the user's own moves the caret here: a session the model starts
        // opens the drawer, but it must not take focus out of what the user is typing.
        React.useEffect(() => {
          if (props?.focus > 0 && box.current !== null) box.current.focus()
        }, [props?.focus])

        // The transcript follows its tail the way the build log does: new output carries the view
        // down while the reader is at the bottom, and a reader who scrolls up to read something is
        // left there — a console that yanks you back to the end on every line cannot be read.
        const lldbStick = React.useRef(true)
        const [lldbFollow, setLldbFollow] = React.useState(true)
        const lldbAnchor = React.useRef(0)
        const lldbNewest = state.lldb.lines[state.lldb.lines.length - 1]?.n ?? 0
        // The tree is drawn as a window over its rows rather than all of them. A real app's
        // hierarchy is thousands of views, and a panel that renders every row of it costs a frame
        // per keystroke in the filter — so the scroll position is local state here, and only the
        // rows around it are built. Local on purpose: emitting on every scroll event would
        // re-render the whole panel, which is exactly the jank this avoids.
        const treeBox = React.useRef(null)
        const treeHeight = React.useRef(320)
        const [treeScroll, setTreeScroll] = React.useState(0)
        // The preview canvas owns its own wheel and drag handlers. React attaches `wheel` at the root
        // as a passive listener, so a `preventDefault` in an `onWheel` prop is ignored and the pane
        // scrolls while the image zooms — this is the one place the handler has to be added by hand.
        const previewBox = React.useRef(null)
        React.useEffect(() => {
          const element = previewBox.current
          if (element === null) return undefined
          const image = element.querySelector('img')
          const zoom = () => (typeof state.lldb.zoom === 'number' ? state.lldb.zoom : 1)
          const pan = () => state.lldb.pan ?? { x: 0, y: 0 }
          const apply = (at) => {
            // Translate outside the scale: a pan is in screen pixels at any zoom, so the image
            // follows the pointer one for one instead of eight times as fast at 8×.
            if (image !== null) image.style.transform = `translate(${String(at.x)}px, ${String(at.y)}px) scale(${String(zoom())})`
          }
          const onWheel = (event) => {
            event.preventDefault()
            state.lldb.zoom = Math.max(0.2, Math.min(8, zoom() * (event.deltaY < 0 ? 1.1 : 0.9)))
            apply(pan())
            emit()
          }
          // Dragging pans, and does it by writing the transform directly: a re-render per mouse move
          // would repaint the whole panel sixty times for one gesture. Only the end of the drag is
          // committed to state.
          let drag = null
          const onDown = (event) => {
            if (event.button !== 0) return
            drag = { x: event.clientX, y: event.clientY, from: { ...pan() }, at: { ...pan() } }
            element.classList.add('dragging')
            element.setPointerCapture?.(event.pointerId)
          }
          const onMove = (event) => {
            if (drag === null) return
            drag.at = { x: drag.from.x + (event.clientX - drag.x), y: drag.from.y + (event.clientY - drag.y) }
            apply(drag.at)
          }
          const onUp = () => {
            if (drag === null) return
            state.lldb.pan = drag.at
            drag = null
            element.classList.remove('dragging')
            emit()
          }
          element.addEventListener('wheel', onWheel, { passive: false })
          element.addEventListener('pointerdown', onDown)
          element.addEventListener('pointermove', onMove)
          element.addEventListener('pointerup', onUp)
          element.addEventListener('pointercancel', onUp)
          return () => {
            element.removeEventListener('wheel', onWheel)
            element.removeEventListener('pointerdown', onDown)
            element.removeEventListener('pointermove', onMove)
            element.removeEventListener('pointerup', onUp)
            element.removeEventListener('pointercancel', onUp)
          }
        }, [state.lldb.selected, state.lldb.inspector])
        const lldbMenu = useLogMenu()
        // The tree's own right-click menu: one row's actions, at the pointer.
        const [rowMenu, setRowMenu] = React.useState(null)
        React.useEffect(() => {
          if (rowMenu === null) return undefined
          const close = () => setRowMenu(null)
          const onKey = (event) => { if (event.key === 'Escape') close() }
          const timer = setTimeout(() => {
            document.addEventListener('mousedown', close)
            document.addEventListener('keydown', onKey)
            window.addEventListener('blur', close)
          }, 0)
          return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', close)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('blur', close)
          }
        }, [rowMenu])
        const clearLldbLog = () => {
          // The panel's lines only: the cursor (`state.lldb.next`) stays where it is, so the host
          // keeps sending what comes AFTER the clear and never the lines that were dropped.
          state.lldb.lines = []
          lldbStick.current = true
          lldbAnchor.current = 0
          setLldbFollow(true)
          emit()
        }
        React.useEffect(() => {
          const element = logBox.current
          if (element === null || !lldbStick.current) return
          element.scrollTop = element.scrollHeight
        }, [state.lldb.lines.length, state.lldb.treeShown])

        // While the log is on screen, keep asking. Each read is a bounded window, so "live" is the
        // panel asking again — not a reader left running on the device, which would outlive the
        // panel and hold the phone.
        React.useEffect(() => {
          const name = state.lldb.attachProcess ?? ''
          if (name === '' || state.lldbOpen !== true) return undefined
          // 15 s, not 5: the fallback reads the app's own log file over CoreDevice, and one of those
          // takes tens of seconds — asking every 5 would keep the tunnel busy for no new lines. The
          // read itself refuses to start while one is running, so a slow device cannot pile them up.
          const timer = setInterval(() => {
            void fetchAppLog(name, state.attachBundleId)
          }, 15000)
          return () => clearInterval(timer)
        }, [state.lldb.attachProcess, state.lldbOpen])

        // The picked view, as lldb can name it: its class and address make an expression that works in
        // ObjC and from Swift frames alike, so a command needs no more than a choice of what to do.
        const pickedView = (() => {
          const address = state.lldb.selected
          if (typeof address !== 'string' || !/^0x[0-9a-f]+$/i.test(address)) return null
          const record = (state.lldb.tree?.records ?? []).find((entry) => entry.address === address)
          const className = typeof record?.className === 'string' && /^[A-Za-z_][\w.]*$/.test(record.className) ? record.className : 'UIView'
          // A Swift class (`Module.Type`) is cast through its ObjC face; UIView has every method the
          // quick commands use.
          const objcClass = className.includes('.') ? 'UIView' : className
          return { address, className, ref: `((${objcClass} *)${address})` }
        })()
        // What can be done with a view in one click. Each is an ordinary lldb command, shown in the
        // transcript as typed, so the user learns the command by using the button.
        const quickCommands = pickedView === null ? [] : [
          { label: 'po', title: 'Print the view', command: `po ${pickedView.ref}` },
          { label: 'frame', title: 'Its frame', command: `p (CGRect)[${pickedView.ref} frame]` },
          { label: 'superview', title: 'Its superview', command: `po [${pickedView.ref} superview]` },
          { label: 'subviews', title: 'Its subviews', command: `po [${pickedView.ref} subviews]` },
          { label: 'controller', title: 'The view controller that owns it', command: `po [${pickedView.ref} _viewControllerForAncestor]` },
          { label: 'tree', title: 'Its subtree, as UIKit describes it', command: `po [${pickedView.ref} recursiveDescription]` },
          { label: 'hide', title: 'Toggle hidden, and redraw', command: `e (void)[${pickedView.ref} setHidden:![${pickedView.ref} isHidden]]; (void)[CATransaction flush]` },
          { label: 'flash', title: 'Show where it is: a red border for a moment', command: `e (void)[[${pickedView.ref} layer] setBorderWidth:2]; (void)[[${pickedView.ref} layer] setBorderColor:(CGColorRef)[[UIColor redColor] CGColor]]; (void)[CATransaction flush]` },
        ]
        // Where ↑/↓ has walked to in the command history; null while the box holds what was typed.
        const commandRecall = React.useRef(null)
        const recallCommand = (delta) => {
          const step = stepRecall(state.commandHistory, commandRecall.current, draft, delta)
          commandRecall.current = step.recall
          setDraft(step.value)
        }
        const send = () => {
          commandRecall.current = null
          // `$v` stands for the picked view, so `po [$v alpha]` needs no address typed.
          const typed = draft.trim()
          if (typed === '') return
          const command = pickedView === null ? typed : typed.replace(/\$v\b/g, pickedView.ref)
          setDraft('')
          void runLldb('command', { command })
        }

        const button = (label, onClick, options) => React.createElement('button', {
          className: `xcb-btn${options?.primary === true ? ' primary' : ''}${options?.danger === true ? ' danger' : ''}`
            + `${typeof options?.className === 'string' ? ` ${options.className}` : ''}`,
          disabled: options?.disabled === true,
          title: options?.title,
          key: label,
          onClick,
        }, label)
        // The tree and the log share one page, tree above. This toggles the tree section; the log
        // below it is always there, so a command's answer never needs a tab switch to be seen.
        const treeToggle = React.createElement('button', {
          className: `xcb-lldb-tab${state.lldb.treeShown !== false ? ' on' : ''}`,
          key: 'tree',
          title: state.lldb.treeShown !== false ? 'Hide the view tree' : 'Show the view tree',
          onClick: () => { state.lldb.treeShown = state.lldb.treeShown === false; emit() },
        }, 'Tree')

        const head = React.createElement('div', { className: 'xcb-lldb-head', key: 'head' }, [
          React.createElement('span', { className: 'xcb-lldb-title', key: 'title' }, 'LLDB'),
          React.createElement('span', {
            className: `xcb-lldb-light ${lldbLight(session, active).tone}`,
            key: 'light',
            title: lldbLight(session, active).label,
            role: 'status',
            'aria-label': lldbLight(session, active).label,
          }),
          React.createElement('span', {
            className: `xcb-lldb-state${running ? ' running' : stopped ? ' stopped' : ''}`,
            key: 'state',
            title: lldbLight(session, active).label,
          }, lldbStateLine(session, active)),
          React.createElement('span', { className: 'xcb-spacer', key: 'spacer' }),
          treeToggle,
          // Which app is it? The device knows every process it runs, so the user can point at the
          // one to read instead of building something first — attaching needs a pid, nothing more.
          mounted ? null : button(busy === 'processes' ? 'Listing...' : busy === 'attach' ? 'Attaching...' : 'Apps', () => {
            // The list answers "which app", so it gets a panel of its own: a phone runs a few hundred
            // processes, and picking one out of a row of buttons is not a choice anybody can make.
            state.lldb.appsOpen = true
            emit()
            void runLldb('processes', { destination: state.destination })
          }, {
            className: 'xcb-lldb-apps',
            disabled: busy !== '',
            title: 'List the apps running on the device and attach to the one you pick — no build needed',
          }),
          state.lldb.appsOpen === true
            ? React.createElement('div', {
                className: 'xcb-lldb-apps-popup',
                key: 'apps-popup',
                // The backdrop closes it: a panel this large has to be dismissable without hunting
                // for a button, and a click that lands on the panel itself must not close it.
                onClick: (event) => {
                  if (event.target === event.currentTarget) {
                    state.lldb.appsOpen = false
                    emit()
                  }
                },
              }, React.createElement('div', { className: 'xcb-lldb-apps-card' }, [
                React.createElement('div', { className: 'xcb-lldb-apps-head', key: 'head' }, [
                  React.createElement('span', { key: 'title' }, apps.length === 0
                    ? 'Running apps'
                    : `Running apps (${apps.length})`),
                  React.createElement('button', {
                    className: 'xcb-btn tiny',
                    key: 'close',
                    onClick: () => { state.lldb.appsOpen = false; emit() },
                  }, 'Close'),
                ]),
                busy === 'processes' ? React.createElement('div', { className: 'xcb-lldb-apps-note', key: 'busy' }, 'Reading the device...') : null,
                busy !== 'processes' && apps.length === 0 ? React.createElement('div', { className: 'xcb-lldb-apps-note', key: 'empty' }, state.lldb.note === '' ? 'No app is running on this device.' : state.lldb.note) : null,
                apps.map((entry) => React.createElement('button', {
                  className: `xcb-lldb-apps-row${state.lldb.attachPid === entry.pid ? ' on' : ''}`,
                  key: `app-${entry.pid}`,
                  title: entry.path,
                  onClick: () => {
                    state.lldb.attachPid = entry.pid
                    state.lldb.attachProcess = entry.name
                    remember(state.project?.root ?? '', { process: entry.name })
                    state.lldb.appsOpen = false
                    // Picking an app mounts it: the debugger attaches and lets it run on, and the
                    // buttons that read it appear once the session says it holds the app.
                    void runLldb('attach', {
                      continue: true,
                      destination: state.destination,
                      bundleId: state.attachBundleId ?? '',
                      process: entry.name,
                      pid: entry.pid,
                    })
                    // The log comes with the app: choosing it is the whole instruction, and the
                    // question that follows "which app is it?" is "what is it saying?". It lands in
                    // the log panel, so nothing here switches the debugger drawer anywhere.
                    void fetchAppLog(entry.name, state.attachBundleId)
                    emit()
                  },
                }, [
                  React.createElement('span', { className: 'xcb-lldb-apps-name', key: 'name' }, entry.name),
                  React.createElement('span', { className: 'xcb-lldb-apps-pid', key: 'pid' }, String(entry.pid)),
                ])),
              ]))
            : null,
          // Offered whether or not anything is mounted. This press is what ATTACHES — with no
          // session this is the only way to ask for a tree from the panel itself, and hiding it
          // while the empty tree said "press View Hierarchy" left the instruction pointing at a
          // button that was not on screen (measured on the live panel: head was Tree/Apps/History).
          // A press that finds nothing to attach to is answered with the host's own note, which is
          // a better outcome than a drawer that cannot ask.
          button(busy === 'view' ? 'Reading... (click to stop)' : 'View Hierarchy', () => {
            // A second press stops the read. It is the same button, because that is where the hand
            // already is: 30 seconds of a read that cannot be called off is the thing being fixed.
            if (busy === 'view') {
              void abortLldb()
              return
            }
            void runLldb('view', {
            // The app that is running, not a build: attaching needs the device and the process
            // name, both of which the panel already knows. Without this the host fell back to the
            // last run and a running app could only be read by building again.
            continue: true,
            // Every view's own account, read in the same stop as the tree: the panes are then drawn
            // from what the panel already holds instead of stopping the app again per click.
            details: true,
            ...lldbTargetBody(),
          }) }, {
            primary: true,
            // Disabled while ANOTHER action runs, but never while this one does: the click that stops
            // it has to reach the button.
            disabled: busy !== '' && busy !== 'view',
            title: busy === 'view'
              ? 'Click again to stop reading and release the debugger'
              : 'Attach to the app that is running, stop it, and read its view tree',
          }),
          // The export is written as the tree is read, so this opens a file that exists. Before a
          // read there is nothing to open, which is why the button is absent rather than inert.
          //
          // Lookin.app is asked about rather than assumed: the file format is Lookin's, but the
          // app is a separate install, and a button labelled "Lookin" that quietly opened Finder
          // would be a lie. Without the app the same slot offers to show the file itself.
          // One button for both exports. The tree alone is quick and is already written by every read;
          // the views' own images take minutes, so that is a choice made in the popup, not a cost
          // every read pays.
          //
          // Lookin.app is asked about rather than assumed: once a read has said it is not installed,
          // the same slot is called Reveal, because both exports then end in Finder, not in Lookin.
          !mounted ? null : button(state.lldb.lookinAvailable === false ? 'Reveal' : 'Lookin', () => {
            state.lldb.lookinPopup = 'lookin'
            state.lldb.lookinNote = ''
            emit()
            void pollLookinJob()
          }, {
            className: 'xcb-lldb-lookin',
            // Not while attaching (the blinking yellow light): both exports read the tree, which needs
            // the app stopped, and the attach in flight is the very thing that has not delivered that
            // stop yet. Clicking then only queued a second attach behind the first. Nor while another
            // drawer operation holds the debugger — the same rule View Hierarchy follows.
            disabled: (session !== null && session.state === 'attaching') || busy !== '',
            title: session !== null && session.state === 'attaching'
              ? 'Waiting for the attach to finish — Lookin needs the app stopped first'
              : busy !== ''
                ? 'The debugger is busy with another operation'
                : state.lldb.lookinAvailable === false
                  ? 'Lookin.app is not installed: make the .lookin file (quick or full) and show it in Finder'
                  : 'Open the view tree in Lookin: quick (structure only) or full (with every view rendered)',
          }),
          button('History', () => {
            state.lldb.lookinPopup = 'history'
            state.lldb.lookinNote = ''
            emit()
            void loadLookinHistory()
          }, {
            className: 'xcb-lldb-history',
            title: 'The view trees read before: open or delete them',
          }),
          // While a full export runs, the drawer says so without the popup having to stay open.
          state.lldb.lookinJob !== null && state.lldb.lookinJob.finished !== true
            ? React.createElement('span', {
                className: 'xcb-lookin-job',
                key: 'job',
                title: 'Full export in progress — open Lookin to watch or cancel it',
              }, [
                React.createElement('span', { className: 'xcb-lookin-mini', key: 'bar' },
                  React.createElement('span', { className: 'xcb-lookin-fill', style: { display: 'block', width: `${String(state.lldb.lookinJob.percent ?? 0)}%` } })),
                React.createElement('span', { key: 'pct' }, `${String(state.lldb.lookinJob.percent ?? 0)}%`),
              ])
            : null,
          lookinPopupView(),
          // Maximise: the drawer is a strip at the bottom of the panel — 52% of it — and a
          // hierarchy beside an attribute list beside a console does not fit in a strip. This is
          // the same drawer given the whole panel, not a second window: everything in it keeps
          // working, and the panel keeps one place where the debugger lives.
          button(state.lldb.maximized === true ? '⤡' : '⤢', () => {
            state.lldb.maximized = state.lldb.maximized !== true
            emit()
          }, {
            className: 'xcb-lldb-max',
            title: state.lldb.maximized === true ? 'Give the panel back to the build log' : 'Fill the panel with the debugger',
          }),
          // Offered only after a dump has failed, because that is when it is the answer:
          // an app the run's own console session is holding cannot be inspected by a second
          // debugger, and taking it over means relaunching it under this one.
          // Offered only after a dump has failed for a reason taking the app over can fix. An app
          // with an anti-debugging guard refuses the debugger that launches it too, so the button
          // would be a dead end dressed as the answer.
          state.lldb.viewFailed === true && state.lldb.refused !== true && busy === '' ? button('Take over', () => { void runLldb('view', {
            mode: 'launch',
            continue: true,
            destination: state.destination,
            appPath: state.attachAppPath ?? '',
            bundleId: state.attachBundleId ?? '',
            // A picked process wins over looking one up: it is the answer to "which app".
            process: state.lldb.attachProcess ?? '',
            pid: Number.isFinite(state.lldb.attachPid) ? state.lldb.attachPid : null,
          }) }, {
            title: 'Relaunch this app under the debugger and read its view tree (the running copy is replaced)',
          }) : null,
          // The pair a debugger needs. A dump stops the app and leaves it stopped, so
          // without Continue the only way to let it go again would be to detach.
          stopped ? button('Continue', () => { void runLldb('continue', {}) }, {
            disabled: busy !== '',
            title: 'Let the app carry on running, with the debugger still attached',
          }) : null,
          running ? button('Interrupt', () => { void runLldb('interrupt', {}) }, {
            disabled: busy !== '',
            title: 'Stop the running process so it can be inspected',
          }) : null,
          active ? button('Detach', () => { state.appReleased = true; void runLldb('detach', {}) }, {
            disabled: busy !== '',
            title: 'Let the app go and carry on running',
          }) : null,
          button('✕', () => { closeLldb(); emit() }, { title: 'Hide the debugger (⌘L)' }),
        ])

        const rows = lldbRows()
        const needle = state.lldb.filter.trim().toLowerCase()
        // A row that the filter did not match is kept only to hold its match in place, and is
        // dimmed so the eye goes to the hits. Lookin fades those context rows for the same reason.
        const isHit = (record) => needle !== '' && `${record.className ?? ''} ${rowSubtitle(record)} ${record.address ?? ''}`.toLowerCase().includes(needle)

        // A window over the rows, not all of them: `padding` above and below keeps the scroll
        // height honest, and the rows inside it are absolutely placed so a scrolled tree never
        // rebuilds from the top.
        const visibleFrom = Math.max(0, Math.floor(treeScroll / LLDB_ROW_HEIGHT) - 6)
        const visibleTo = Math.min(rows.length, Math.ceil((treeScroll + treeHeight.current) / LLDB_ROW_HEIGHT) + 6)

        const treeBody = tree === null
          ? React.createElement('div', { className: 'xcb-lldb-note' },
              'No view tree yet — View Hierarchy attaches to the app this project last ran and reads it; '
                + 'Apps picks one that is running now, and Build & Run launches one.')
          : React.createElement('div', {
              className: 'xcb-lldb-tree',
              key: 'tree',
              ref: treeBox,
              onScroll: (event) => {
                const element = event.currentTarget
                treeHeight.current = element.clientHeight
                // Local state, deliberately: the drawer's own rows are the only thing that changes,
                // and re-rendering the whole panel on every scroll event is the jank this avoids.
                setTreeScroll(element.scrollTop)
              },
            }, [
              React.createElement('div', {
                key: 'pad',
                style: { height: `${String(rows.length * LLDB_ROW_HEIGHT)}px`, position: 'relative' },
              }, rows.slice(visibleFrom, visibleTo).map((record, offset) => {
                const index = visibleFrom + offset
                const picked = state.lldb.selected !== '' && state.lldb.selected === record.address
                const childCount = (() => {
                  const next = rows[index + 1]
                  return next !== undefined && next.depth > record.depth ? next.depth - record.depth : 0
                })()
                const children = [
                  // The triangle is drawn for a view that has children, and it is a glyph rather
                  // than a button: our tree arrives fully expanded, so there is nothing to open.
                  React.createElement('span', {
                    className: `xcb-lldb-tw${childCount > 0 ? '' : ' empty'}`,
                    key: 'tw',
                  }, childCount > 0 ? '▾' : ''),
                  viewIcon(viewFamily(record), 'i'),
                  React.createElement('span', { className: 'xcb-lldb-class', key: 'c' }, record.className),
                ]
                const subtitle = rowSubtitle(record)
                if (subtitle !== '' && !/^hidden$/.test(subtitle)) {
                  children.push(React.createElement('span', { className: 'xcb-lldb-sub', key: 's' }, subtitle))
                }
                children.push(React.createElement('span', { className: 'xcb-lldb-grow', key: 'g' }))
                if (record.hidden === true) {
                  children.push(React.createElement('span', { className: 'xcb-lldb-badge', key: 'h', title: 'hidden = YES' }, 'hidden'))
                } else if (record.alpha !== null && record.alpha !== undefined && record.alpha < 1) {
                  children.push(React.createElement('span', { className: 'xcb-lldb-badge', key: 'a', title: `alpha = ${String(record.alpha)}` }, `α${String(record.alpha)}`))
                }
                children.push(React.createElement('span', { className: 'xcb-lldb-frame', key: 'f' }, formatFrame(record.frame)))
                return React.createElement('div', {
                  className: `xcb-lldb-row${record.hidden === true || (record.alpha !== null && record.alpha !== undefined && record.alpha < 1) ? ' invisible' : ''}${picked ? ' picked' : ''}${needle === '' ? '' : (isHit(record) ? ' hit' : ' context')}`,
                  key: `${String(index)}-${record.address}`,
                  style: {
                    top: `${String(index * LLDB_ROW_HEIGHT)}px`,
                    paddingLeft: `${String(13 + (record.depth - (rows[0]?.depth ?? 0)) * 14)}px`,
                    height: `${String(LLDB_ROW_HEIGHT)}px`,
                  },
                  // The panel can only know a view it has asked about, and asking costs one round
                  // trip per click — so a row is a question, and the answer lands beside the tree.
                  // A second click on the picked row lets go of it: the details close and the command bar
                  // stops aiming at that view.
                  onClick: () => {
                    if (picked) {
                      state.lldb.selected = ''
                      state.lldb.node = null
                      state.lldb.layout = {}
                      state.lldb.editNote = ''
                      emit()
                      return
                    }
                    state.lldb.editNote = ''
                    void runLldb('node', { address: record.address })
                  },
                  // Right-click picks the row too, the way a native list does, and offers its actions.
                  onContextMenu: (event) => {
                    event.preventDefault()
                    const width = 170
                    const height = 110
                    const viewW = window.innerWidth || 1024
                    const viewH = window.innerHeight || 768
                    setRowMenu({
                      x: event.clientX + width > viewW ? Math.max(4, event.clientX - width) : event.clientX,
                      y: event.clientY + height > viewH ? Math.max(4, event.clientY - height) : event.clientY,
                      address: record.address,
                    })
                    if (!picked) {
                      state.lldb.editNote = ''
                      void runLldb('node', { address: record.address })
                    }
                  },
                  onDoubleClick: () => {
                    // Double-click focuses: the picked view becomes the whole tree, which is how
                    // Lookin's focus mode works and the only way to read a deep subtree in a panel
                    // this size. A second double-click on it comes back.
                    state.lldb.focusAddress = state.lldb.focusAddress === record.address ? '' : record.address
                    emit()
                  },
                  title: picked ? 'Click again to deselect · double-click to focus' : `${record.className} ${record.address}\ndouble-click to focus this subtree`,
                }, children)
              })),
              rows.length === 0
                ? React.createElement('div', { className: 'xcb-lldb-empty', key: 'none' }, '无搜索结果')
                : null,
              rowMenu === null ? null : React.createElement('div', {
                className: 'xcb-ctxmenu xcb-lldb-rowmenu',
                key: 'rowmenu',
                role: 'menu',
                style: { left: `${String(rowMenu.x)}px`, top: `${String(rowMenu.y)}px` },
                onMouseDown: (event) => { event.stopPropagation() },
              }, [
                // Lookin's menu leads with Focus: this view and its subtree become the whole tree. On
                // the view already focused, the same place offers the way back.
                React.createElement('button', {
                  className: 'xcb-ctxmenu-item',
                  key: 'focus',
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    const leaving = state.lldb.focusAddress === rowMenu.address
                    state.lldb.focusAddress = leaving ? '' : rowMenu.address
                    // Focus and search together are two filters on one list; Lookin leaves search
                    // when it focuses, and so does this.
                    if (!leaving) state.lldb.filter = ''
                    setRowMenu(null)
                    emit()
                  },
                }, React.createElement('span', null, state.lldb.focusAddress === rowMenu.address ? '退出聚焦' : '聚焦')),
                React.createElement('div', { className: 'xcb-ctxmenu-sep', key: 'sep-focus' }),
                React.createElement('button', {
                  className: 'xcb-ctxmenu-item',
                  key: 'chat',
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    const all = state.lldb.tree?.records ?? []
                    const at = all.findIndex((entry) => entry.address === rowMenu.address)
                    setRowMenu(null)
                    if (at < 0) return
                    const added = addToChat(viewChatContext(all, at, state.lldb.tree?.target ?? null), `${all[at].className} ${all[at].address}`)
                    state.lldb.note = added ? `Added ${all[at].className} ${all[at].address} to the chat` : ''
                    state.lldb.error = added ? '' : 'No chat composer to add to — open a session first'
                    emit()
                  },
                }, React.createElement('span', null, '添到聊天')),
                React.createElement('button', {
                  className: 'xcb-ctxmenu-item',
                  key: 'copy',
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    const all = state.lldb.tree?.records ?? []
                    const at = all.findIndex((entry) => entry.address === rowMenu.address)
                    setRowMenu(null)
                    if (at < 0) return
                    void navigator.clipboard?.writeText(viewChatContext(all, at, state.lldb.tree?.target ?? null)).catch(() => {})
                  },
                }, React.createElement('span', null, '复制描述')),
              ]),
            ])

        const treeHead = React.createElement('div', { className: 'xcb-lldb-stats', key: 'stats' }, [
          React.createElement('span', { key: 'count' },
            tree === null
              ? ''
              : `${String(tree.views)} views · ${String(tree.depth)} levels${tree.truncated ? ` · showing ${String(tree.shown)}` : ''}`),
          // What the tree read brought with it. It is the answer to "why is this pane instant", and
          // when the bounds stopped the pass early it is also why a view still has to be asked for.
          state.lldb.detailsViews === 0
            ? null
            : React.createElement('span', { key: 'cached', className: 'xcb-lldb-dim', title: state.lldb.detailsCapped
                ? 'Attributes and layout were read for as many views as the bounds allowed; the rest are read when opened'
                : 'Attributes and layout for every view were read with the tree' },
              `已缓存 ${String(state.lldb.detailsViews)} 个视图${state.lldb.detailsCapped ? '（部分）' : ''}`),
          React.createElement('span', { className: 'xcb-spacer', key: 'spacer' }),
          state.lldb.focusAddress === '' ? null : React.createElement('button', {
            className: 'xcb-btn xcb-lldb-quick',
            key: 'unfocus',
            title: 'Leave focus mode and show the whole hierarchy again',
            onClick: () => { state.lldb.focusAddress = ''; emit() },
          }, '退出聚焦'),
        ])

        // The filter lives at the bottom of the tree, as it does in Lookin: it filters the list
        // above it, and a bar at the foot of a list reads as belonging to that list.
        const filterBar = React.createElement('div', { className: 'xcb-lldb-filterbar', key: 'filter' }, [
          React.createElement('span', { className: 'xcb-lldb-magnifier', key: 'm' }, '⌕'),
          React.createElement('input', {
            key: 'input',
            className: 'xcb-lldb-filterinput',
            value: state.lldb.filter,
            placeholder: '搜索 类名 / 文字 / 地址',
            spellCheck: false,
            onChange: (event) => { state.lldb.filter = event.target.value; setTreeScroll(0); if (treeBox.current !== null) treeBox.current.scrollTop = 0; emit() },
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                state.lldb.filter = ''
                emit()
              }
            },
          }),
          needle === ''
            ? null
            : React.createElement('span', {
                className: `xcb-lldb-hitcount${state.lldb.filterHits === 0 ? ' none' : ''}`,
                key: 'count',
                title: `${String(state.lldb.filterHits)} matching views; their ancestors are kept so each match has its place`,
              }, `${String(state.lldb.filterHits)} 处`),
        ])

        // -- the inspector ----------------------------------------------------

        const pickedRecord = state.lldb.selected === ''
          ? null
          : rows.find((record) => record.address === state.lldb.selected) ?? null
        const chain = state.lldb.selected === '' ? [] : viewChain(state.lldb.selected)
        const chainBar = chain.length === 0 ? null : React.createElement('div', { className: 'xcb-lldb-chain', key: 'chain' },
          chain.flatMap((link, index) => {
            const parts = []
            if (index > 0) parts.push(React.createElement('span', { className: 'xcb-lldb-chain-sep', key: `s${String(index)}` }, '›'))
            parts.push(React.createElement('button', {
              className: `xcb-lldb-chain-link${link.address === state.lldb.selected ? ' on' : ''}`,
              key: link.address,
              title: `${link.className} ${link.address}`,
              onClick: () => {
                if (link.address === state.lldb.selected) return
                state.lldb.editNote = ''
                void runLldb('node', { address: link.address })
              },
            }, link.className))
            return parts
          }))

        const tab = (name, label, title) => React.createElement('button', {
          className: `xcb-lldb-tab${state.lldb.inspector === name ? ' on' : ''}`,
          key: name,
          title,
          // The layout report is not read until it is asked for: it is a stop of its own, and most
          // visits to a view are about its attributes.
          onClick: () => {
            state.lldb.inspector = name
            // The tree read already brought every layout with it, so this asks only for what the
            // bounds left out — a click never stops an app to ask for something already in hand.
            if (name === 'layout' && state.lldb.selected !== '' && state.lldb.layout[state.lldb.selected] === undefined && busy !== 'constraints') {
              void runLldb('constraints', { address: state.lldb.selected, ...lldbTargetBody() })
            }
            emit()
          },
        }, label)

        const inspectorTabs = React.createElement('div', { className: 'xcb-lldb-tabs', key: 'tabs' }, [
          tab('attrs', '属性', 'Everything the app says about this object, grouped by the class that declares it'),
          tab('layout', '布局', 'Auto Layout: ambiguity, intrinsic size, and the constraints that place this view'),
          tab('preview', '预览', 'The rendered image of this view, with zoom and pan'),
          React.createElement('span', { className: 'xcb-spacer', key: 'spacer' }),
          pickedRecord === null ? null : React.createElement('span', { className: 'xcb-lldb-dim', key: 'addr' }, pickedRecord.address),
        ])

        const attrs = state.lldb.selected === '' ? undefined : state.lldb.attrs[state.lldb.selected]
        const attrsBusy = state.lldb.busy === 'attributes'

        /**
         * One attribute row: the name, its type, and a value the user can change when the plugin
         * has decided that attribute is safe to change.
         *
         * The editor is chosen by the declared type, which is why the row carries one: a `BOOL` gets
         * a switch, a `double` a number, a `CGRect` four numbers, a `UIColor` a colour well. An
         * attribute whose type the plugin does not know is shown and not offered — a debugger that
         * lets someone type arbitrary text into an unknown ivar's slot is a debugger that crashes
         * apps.
         */
        const attrRow = (row, groupName, index) => {
          // The printed value and the editor are two different things, and the host sends them as
          // two: `value` is what the app prints (`{{0, 0}, {200, 20}}`, `"row 0"`, `nil`) and `edit`
          // is what may be written back (kind, parsed value, and the KVC key). Showing the parsed
          // one would put `0,0,200,20` on screen where the app said something else.
          const editor = row.edit ?? { kind: 'none', value: null }
          const id = `${state.lldb.selected}:${row.name}`
          const cell = []
          const commit = (value) => {
            state.lldb.editBusy = id
            state.lldb.editNote = ''
            emit()
            void runLldb('edit', {
              address: state.lldb.selected,
              key: editor.key ?? row.name,
              kind: editor.kind,
              value,
              ...lldbTargetBody(),
            })
          }
          if (editor.kind === 'bool') {
            cell.push(React.createElement('input', {
              type: 'checkbox',
              className: 'xcb-lldb-check',
              key: 'v',
              checked: editor.value === true,
              title: row.value,
              onChange: (event) => { commit(event.target.checked) },
            }))
            cell.push(React.createElement('span', { className: 'xcb-lldb-val', key: 't' }, row.value))
          } else if (editor.kind === 'number') {
            cell.push(React.createElement('input', {
              type: 'number',
              step: 'any',
              className: 'xcb-lldb-num',
              key: 'v',
              defaultValue: String(editor.value),
              title: row.value,
              onKeyDown: (event) => { if (event.key === 'Enter') commit(Number(event.target.value)) },
              onBlur: (event) => {
                if (Number(event.target.value) !== Number(editor.value)) commit(Number(event.target.value))
              },
            }))
          } else if (editor.kind === 'text') {
            // An input that commits on blur as well as on Enter: a debugger's text field is usually
            // filled and then clicked away from, and losing the edit to a missing Enter is the kind
            // of thing that makes a tool feel broken.
            cell.push(React.createElement('input', {
              type: 'text',
              className: 'xcb-lldb-textinput',
              key: 'v',
              defaultValue: String(editor.value ?? ''),
              title: row.value,
              onKeyDown: (event) => { if (event.key === 'Enter') commit(event.target.value) },
              onBlur: (event) => { if (event.target.value !== String(editor.value ?? '')) commit(event.target.value) },
            }))
          } else if (editor.kind === 'color') {
            const hex = typeof editor.value === 'string' && editor.value !== '' ? editor.value.slice(0, 7) : ''
            cell.push(React.createElement('input', {
              type: 'color',
              className: 'xcb-lldb-color',
              key: 'c',
              value: hex === '' ? '#ffffff' : hex,
              title: hex === ''
                ? 'This colour is resolved by the system, so its value is not known here — picking one sets an explicit colour'
                : `${hex} — click to change it`,
              onChange: (event) => { commit(event.target.value) },
            }))
            cell.push(React.createElement('span', { className: 'xcb-lldb-val', key: 'v' }, row.value))
          } else if (['rect', 'point', 'size', 'insets'].includes(editor.kind)) {
            const numbers = Array.isArray(editor.value) ? editor.value : null
            const labels = editor.kind === 'rect' ? ['x', 'y', 'w', 'h']
              : editor.kind === 'insets' ? ['t', 'l', 'b', 'r']
                : editor.kind === 'point' ? ['x', 'y'] : ['w', 'h']
            if (numbers === null) {
              cell.push(React.createElement('span', { className: 'xcb-lldb-val', key: 'v', title: row.value }, row.value))
            } else {
              cell.push(React.createElement('span', { className: 'xcb-lldb-geom', key: 'g' },
                numbers.map((number, at) => React.createElement('label', { key: labels[at], title: row.value }, [
                  React.createElement('span', { key: 'l' }, labels[at]),
                  React.createElement('input', {
                    type: 'number',
                    step: 'any',
                    key: 'i',
                    defaultValue: String(number),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const next = [...numbers]
                      next[at] = Number(event.target.value)
                      commit(next)
                    },
                  }),
                ]))))
            }
          } else {
            cell.push(React.createElement('span', {
              className: 'xcb-lldb-val',
              key: 'v',
              // The whole value on hover: an ivar holding a layer or a dictionary is longer than any
              // row, and the row is where the eye already is.
              title: row.value,
            }, row.value))
          }
          if (state.lldb.editBusy === id) cell.push(React.createElement('span', { className: 'xcb-lldb-dim', key: 'b' }, '…'))
          return React.createElement('div', {
            className: `xcb-lldb-attr${editor.kind === 'none' ? '' : ' editable'}`,
            key: `${groupName}-${row.name}-${String(index)}`,
            style: { paddingLeft: `${String(8 + row.depth * 14)}px` },
            title: `${row.name} (${row.type})`,
          }, [
            React.createElement('span', { className: 'xcb-lldb-attr-name', key: 'n' }, row.name),
            React.createElement('span', { className: 'xcb-lldb-attr-type', key: 't' }, row.type),
            React.createElement('span', { className: 'xcb-lldb-attr-val', key: 'v' }, cell),
          ])
        }

        const attrsPane = state.lldb.selected === ''
          ? React.createElement('div', { className: 'xcb-lldb-note' }, 'Pick a view in the tree to see everything the app says about it.')
          : attrsBusy && attrs === undefined
            ? React.createElement('div', { className: 'xcb-lldb-note' }, 'Reading the attributes — the app is held for about a fifth of a second.')
            : attrs === undefined || attrs.ok !== true
              ? React.createElement('div', { className: 'xcb-lldb-note' }, attrs?.note ?? 'no attributes read for this view')
              : React.createElement('div', { className: 'xcb-lldb-attrs' }, [
                  React.createElement('div', { className: 'xcb-lldb-attr-sum', key: 'sum' }, [
                    React.createElement('span', { key: 'c' }, attrs.className),
                    React.createElement('span', { className: 'xcb-lldb-dim', key: 'n' }, `${String(attrs.attributes ?? 0)} attributes · ${String(attrs.groups?.length ?? 0)} classes`),
                    React.createElement('span', { className: 'xcb-spacer', key: 's' }),
                    React.createElement('button', {
                      className: 'xcb-btn xcb-lldb-quick',
                      key: 'r',
                      title: 'Read the attributes again — the app may have changed them since',
                      disabled: busy !== '',
                      onClick: () => {
                        void runLldb('attributes', { address: state.lldb.selected, refresh: true, ...lldbTargetBody() })
                      },
                    }, '刷新'),
                  ]),
                  state.lldb.editNote === '' ? null : React.createElement('div', { className: 'xcb-lldb-editnote', key: 'note' }, state.lldb.editNote),
                  ...(attrs.groups ?? []).map((group) => {
                    const collapsed = (state.lldb.attrCollapsed ?? {})[group.name] === true
                    return React.createElement('div', { className: 'xcb-lldb-attrgroup', key: group.name }, [
                      React.createElement('div', {
                        className: 'xcb-lldb-attrgroup-head',
                        key: 'h',
                        onClick: () => {
                          state.lldb.attrCollapsed = { ...(state.lldb.attrCollapsed ?? {}), [group.name]: !collapsed }
                          emit()
                        },
                        title: collapsed ? 'Expand this class' : 'Collapse this class',
                      }, [
                        React.createElement('span', { className: 'xcb-lldb-tw', key: 'tw' }, collapsed ? '▸' : '▾'),
                        React.createElement('span', { key: 'n' }, group.name),
                        React.createElement('span', { className: 'xcb-lldb-dim', key: 'c' }, String(group.rows.length)),
                      ]),
                      collapsed ? null : React.createElement('div', { className: 'xcb-lldb-attrgroup-body', key: 'b' },
                        group.rows.map((row, index) => attrRow(row, group.name, index))),
                    ])
                  }),
                ])

        const layout = state.lldb.layout[state.lldb.selected] ?? null
        const layoutPane = state.lldb.selected === ''
          ? React.createElement('div', { className: 'xcb-lldb-note' }, 'Pick a view to see how it is laid out.')
          : layout === null && busy === 'constraints'
            ? React.createElement('div', { className: 'xcb-lldb-note' }, 'Reading the layout…')
            : layout === null || layout.ok !== true
              ? React.createElement('div', { className: 'xcb-lldb-note' }, layout?.note ?? 'no layout read yet')
              : (() => {
                  const report = layout.layout ?? {}
                  const badge = (label, value, tone) => React.createElement('div', { className: `xcb-lldb-badge-box${tone === undefined ? '' : ` ${tone}`}`, key: label }, [
                    React.createElement('span', { className: 'xcb-lldb-badge-label', key: 'l' }, label),
                    React.createElement('span', { className: 'xcb-lldb-badge-value', key: 'v' }, value),
                  ])
                  // A constraint names the two views it relates by printing them, so the address in
                  // its text is the way to reach the other one: when that view is in the tree the
                  // name becomes a jump, which is how a person follows "why is this here".
                  const constraintRow = (text, index) => {
                    const addresses = [...new Set(String(text).match(/0x[0-9a-f]+/g) ?? [])]
                    const known = addresses.filter((address) => rows.some((record) => record.address === address))
                    return React.createElement('div', { className: 'xcb-lldb-constraint', key: String(index), title: text }, [
                      React.createElement('span', { key: 't' }, text),
                      ...known.map((address) => React.createElement('button', {
                        className: 'xcb-lldb-jump',
                        key: address,
                        title: `Select ${address} in the tree`,
                        onClick: () => { void runLldb('node', { address }) },
                      }, address)),
                    ])
                  }
                  return React.createElement('div', { className: 'xcb-lldb-layout' }, [
                    React.createElement('div', { className: 'xcb-lldb-badges', key: 'badges' }, [
                      badge('Auto Layout', report.masked === true ? 'translatesAutoresizingMask' : 'on', report.masked === true ? 'warn' : 'ok'),
                      badge('Ambiguous', report.ambiguous === true ? 'YES' : 'no', report.ambiguous === true ? 'bad' : 'ok'),
                      // A view with no intrinsic size at all reports -1 for both, which is the
                      // runtime's way of saying "none" — printing `-1 × -1` would read as a size.
                      badge('Intrinsic', report.intrinsic === undefined || report.intrinsic.width < 0 || report.intrinsic.height < 0
                        ? 'none'
                        : `${round2(report.intrinsic.width)} × ${round2(report.intrinsic.height)}`),
                      badge('Hugging', (report.hugging ?? []).join(' / ')),
                      badge('Resistance', (report.resistance ?? []).join(' / ')),
                    ]),
                    React.createElement('div', { className: 'xcb-lldb-sec-title', key: 'own' }, `This view's own constraints (${String((report.own ?? []).length)})`),
                    (report.own ?? []).length === 0
                      ? React.createElement('div', { className: 'xcb-lldb-note', key: 'none' }, 'none')
                      : React.createElement('div', { key: 'list' }, (report.own ?? []).map(constraintRow)),
                    React.createElement('div', { className: 'xcb-lldb-sec-title', key: 'ref' }, `On ancestors, and they mention this view (${String((report.referencing ?? []).length)})`),
                    (report.referencing ?? []).length === 0
                      ? React.createElement('div', { className: 'xcb-lldb-note', key: 'none' }, 'none — this view is placed by its own constraints or by its frame')
                      : React.createElement('div', { key: 'list' }, (report.referencing ?? []).map(constraintRow)),
                    report.ambiguous === true
                      ? React.createElement('div', { className: 'xcb-lldb-note', key: 'amb' },
                          'The engine says this layout is ambiguous: something is under-constrained, and the frame on screen is one of several answers.')
                      : null,
                  ])
                })()

        const node = state.lldb.node
        const previewPane = state.lldb.selected === ''
          ? React.createElement('div', { className: 'xcb-lldb-note' }, 'Pick a view to see its image.')
          : node === null || node.ok !== true
            ? React.createElement('div', { className: 'xcb-lldb-note' }, node?.note ?? 'no image read for this view')
            : (() => {
                const images = node.image ?? {}
                const shot = state.lldb.shot === 'group' ? 'group' : 'solo'
                const shown = images[shot] ?? images.solo ?? images.group ?? ''
                const zoom = state.lldb.zoom ?? 1
                const toggle = (kind, label) => React.createElement('button', {
                  className: `xcb-btn xcb-lldb-shot-${kind}${shot === kind ? ' primary' : ''}`,
                  key: kind,
                  onClick: () => { state.lldb.shot = kind; emit() },
                  title: kind === 'solo' ? 'This control alone, without its subviews' : 'This control with everything inside it',
                }, label)
                return React.createElement('div', { className: 'xcb-lldb-preview' }, [
                  React.createElement('div', { className: 'xcb-lldb-preview-bar', key: 'bar' }, [
                    images.solo === undefined ? null : toggle('solo', 'Solo'),
                    images.group === undefined ? null : toggle('group', 'Group'),
                    React.createElement('span', { className: 'xcb-spacer', key: 's' }),
                    React.createElement('button', {
                      className: 'xcb-btn xcb-lldb-quick',
                      key: 'out',
                      title: 'Zoom out',
                      onClick: () => { state.lldb.zoom = Math.max(0.2, zoom / 1.25); emit() },
                    }, '−'),
                    React.createElement('span', { className: 'xcb-lldb-dim', key: 'z' }, `${String(Math.round(zoom * 100))}%`),
                    React.createElement('button', {
                      className: 'xcb-btn xcb-lldb-quick',
                      key: 'in',
                      title: 'Zoom in',
                      onClick: () => { state.lldb.zoom = Math.min(8, zoom * 1.25); emit() },
                    }, '+'),
                    React.createElement('button', {
                      className: 'xcb-btn xcb-lldb-quick',
                      key: 'fit',
                      title: 'Fit the image to the pane',
                      onClick: () => { state.lldb.zoom = 1; state.lldb.pan = { x: 0, y: 0 }; emit() },
                    }, '适配'),
                  ]),
                  shown === ''
                    ? React.createElement('div', { className: 'xcb-lldb-note', key: 'none' },
                        node.note === undefined || node.note === '' ? 'no image for this view' : node.note)
                    : React.createElement('div', {
                        className: 'xcb-lldb-preview-canvas',
                        key: 'canvas',
                        ref: previewBox,
                        title: '滚轮缩放，拖动平移',
                      },
                        React.createElement('img', {
                          src: shown,
                          alt: `${node.className} ${shot}`,
                          style: {
                            transform: `translate(${String(state.lldb.pan?.x ?? 0)}px, ${String(state.lldb.pan?.y ?? 0)}px) scale(${String(zoom)})`,
                          },
                        })),
                  node.color !== undefined && (node.color.css !== '' || node.color.name !== '')
                    ? React.createElement('div', { className: 'xcb-lldb-detail-row', key: 'color' }, [
                        React.createElement('span', { className: 'xcb-lldb-label', key: 'l' }, '背景'),
                        React.createElement('span', { key: 'v' }, [
                          node.color.css === ''
                            ? null
                            : React.createElement('span', { className: 'xcb-lldb-swatch', key: 's', style: { background: node.color.css } }),
                          React.createElement('span', { key: 'n' }, node.color.css === '' ? node.color.name : node.color.css),
                        ]),
                      ])
                    : null,
                  React.createElement('div', { className: 'xcb-lldb-detail-rows', key: 'rows' },
                    (node.rows ?? []).map((row, index) => React.createElement('div', {
                      className: 'xcb-lldb-detail-row',
                      key: String(index),
                    }, [
                      React.createElement('span', { className: 'xcb-lldb-label', key: 'l' }, row.label),
                      React.createElement('span', { key: 'v' }, row.value),
                    ]))),
                ])
              })()

        const inspector = React.createElement('div', { className: 'xcb-lldb-insp', key: 'insp' }, [
          pickedRecord === null
            ? React.createElement('div', { className: 'xcb-lldb-insp-head', key: 'head' }, [
                React.createElement('span', { className: 'xcb-lldb-dim', key: 'n' }, '未选中任何视图 · No view picked'),
              ])
            : React.createElement('div', { className: 'xcb-lldb-insp-head', key: 'head' }, [
                viewIcon(viewFamily(pickedRecord), 'i'),
                React.createElement('span', { className: 'xcb-lldb-class', key: 'c' }, pickedRecord.className),
                React.createElement('span', { className: 'xcb-lldb-dim', key: 'f' }, formatFrame(pickedRecord.frame)),
                React.createElement('span', { className: 'xcb-spacer', key: 's' }),
                React.createElement('button', {
                  className: 'xcb-btn xcb-lldb-quick',
                  key: 'cmd',
                  title: 'Put this view in the command bar as $v',
                  onClick: () => { state.lldbFocus += 1; emit() },
                }, '$v'),
              ]),
          chainBar,
          inspectorTabs,
          React.createElement('div', { className: 'xcb-lldb-insp-body', key: 'body' },
            state.lldb.inspector === 'layout' ? layoutPane : state.lldb.inspector === 'preview' ? previewPane : attrsPane),
        ])

        const workspace = React.createElement('div', { className: 'xcb-lldb-workspace', key: 'workspace' }, [
          React.createElement('div', { className: 'xcb-lldb-treecol', key: 'treecol' }, [treeHead, treeBody, filterBar]),
          inspector,
        ])

        const lldbUnseen = lldbFollow ? 0 : Math.max(0, lldbNewest - lldbAnchor.current)
        const logBody = React.createElement('div', { className: 'xcb-lldb-logwrap' }, [
          React.createElement('div', {
            className: 'xcb-lldb-log',
            ref: logBox,
            key: 'log',
            onContextMenu: lldbMenu.open,
            onScroll: (event) => {
              const element = event.currentTarget
              // Same rule as the build log: only the very bottom re-arms following, so parking a
              // line above the end to read it does not snap the view away.
              const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2
              if (lldbStick.current && !atBottom) lldbAnchor.current = lldbNewest
              lldbStick.current = atBottom
              setLldbFollow((current) => (current === atBottom ? current : atBottom))
            },
          }, state.lldb.lines.length === 0
            ? React.createElement('div', { className: 'xcb-lldb-note' },
                active ? 'Nothing said yet.' : 'No session yet — Build & Run, then View Hierarchy.')
            : state.lldb.lines.map((line) => React.createElement('div', {
                className: `xcb-line xcb-lldb-line xcb-lldb-k-${lldbLineKind(line.t)}`,
                key: String(line.n),
              },
                React.createElement('span', { className: 'xcb-num' }, String(line.n)),
                React.createElement('span', { className: 'xcb-txt' }, line.t)))),
          lldbFollow || state.lldb.lines.length === 0 ? null : React.createElement('button', {
            className: 'xcb-jump xcb-lldb-jump',
            key: 'jump',
            type: 'button',
            title: 'Show the newest output and follow it from here',
            onClick: () => {
              lldbStick.current = true
              setLldbFollow(true)
              const element = logBox.current
              if (element !== null) element.scrollTop = element.scrollHeight
            },
          }, lldbUnseen > 0 ? `↓ ${String(lldbUnseen)} new` : '↓ Latest'),
          lldbMenu.render({
            className: 'xcb-lldb-ctxmenu',
            box: logBox,
            lines: state.lldb.lines,
            onClear: clearLldbLog,
          }),
        ])

        const notice = state.lldb.error !== ''
          ? React.createElement('div', { className: 'xcb-lldb-error', key: 'notice' }, state.lldb.error)
          : state.lldb.note !== ''
            ? React.createElement('div', { className: 'xcb-lldb-note', key: 'notice' }, state.lldb.note)
            : null

        // The picked view rides above the prompt: what it is, how to let go of it, and what to do with it.
        const target = pickedView === null ? null : React.createElement('div', { className: 'xcb-lldb-target', key: 'target' }, [
          React.createElement('span', { className: 'xcb-lldb-chip', key: 'chip', title: `${pickedView.className} ${pickedView.address} — $v in a command` }, [
            React.createElement('span', { key: 'c' }, pickedView.className),
            React.createElement('span', { className: 'xcb-lldb-chip-addr', key: 'a' }, pickedView.address),
            React.createElement('button', {
              className: 'xcb-lldb-chip-x',
              key: 'x',
              title: 'Deselect',
              onClick: () => { state.lldb.selected = ''; state.lldb.node = null; emit() },
            }, '×'),
          ]),
          ...quickCommands.map((entry) => React.createElement('button', {
            className: 'xcb-btn xcb-lldb-quick',
            key: entry.label,
            title: `${entry.title}\n${entry.command}`,
            disabled: busy !== '',
            onClick: () => { void runLldb('command', { command: entry.command }) },
          }, entry.label)),
        ])
        const command = React.createElement('div', { className: 'xcb-lldb-cmdrow', key: 'cmd' }, [
          React.createElement('span', { className: 'xcb-lldb-prompt', key: 'prompt' }, '(lldb)'),
          React.createElement('input', {
            key: 'cmd',
            ref: box,
            className: 'xcb-input xcb-lldb-cmd',
            value: draft,
            placeholder: pickedView !== null
              ? `a command for ${pickedView.className} — $v is the view, e.g. po [$v alpha]`
              : (active ? 'po self.view' : 'an lldb command (attaches to the last run)'),
            spellCheck: false,
            // Typing leaves the walk: ↑ next time starts again from the newest command.
            onChange: (event) => { commandRecall.current = null; setDraft(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter') send()
              else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault?.()
                recallCommand(event.key === 'ArrowUp' ? -1 : 1)
              }
            },
          }),
          button('Run', send, { disabled: busy !== '' || draft.trim() === '' }),
        ])

        // Head, then what it is showing, then the prompt: the same order as a terminal
        // window, and the drawer sits at the bottom of the panel below the log.
        const parts = [
          head,
          notice,
          // One page, two stacked sections: the workspace (tree beside inspector, folding away with
          // the Tree button) over the log. The debugger keeps one place in the panel, and the whole
          // place is the workspace when it is maximised.
          React.createElement('div', { className: 'xcb-lldb-body', key: 'body' }, [
            state.lldb.treeShown === false ? null : React.createElement('div', { className: 'xcb-lldb-treesec', key: 'tree' }, workspace),
            React.createElement('div', { className: 'xcb-lldb-logsec', key: 'log' }, logBody),
          ]),
          target,
          command,
        ].filter((node) => node !== null)
        return React.createElement('div', { className: `xcb-lldb${state.lldb.maximized === true ? ' max' : ''}` }, parts)
      }

      function LogView() {
        useStore()
        const ref = React.useRef(null)
        // Whether new output should carry the view down with it. True means the
        // user wants to watch the tail.
        const stick = React.useRef(true)
        // The same fact as `stick`, but observable: the button's presence depends
        // on it, and a ref change renders nothing. It is flipped only when the view
        // crosses the threshold, never on every scroll event — otherwise each flick
        // of the wheel would repaint every rendered row.
        const [follow, setFollow] = React.useState(true)
        // The newest line that was on screen when the reader left the tail, so the
        // button can say how much has arrived since.
        const anchor = React.useRef(0)
        const findInput = React.useRef(null)
        const runMenu = useLogMenu()
        // ⌘F is a request to type, so the caret goes there — and a second ⌘F selects what
        // is already in the box, which is what makes it a "find something else" key.
        React.useEffect(() => {
          if (!state.findOpen) return
          const input = findInput.current
          if (input === null) return
          input.focus()
          input.select?.()
        }, [state.findOpen, state.findFocus])
        // A clear is a fresh start, so it also re-arms following the tail.
        React.useEffect(() => {
          stick.current = true
          anchor.current = 0
          setFollow(true)
        }, [state.clearedAt])
        // Closing the find bar re-arms it too. The render window goes back to the tail
        // when the search does, so a view left parked where the hits were would be
        // reading lines that are no longer there — and the search was the reason to be
        // parked in the first place. Opening it changes nothing: the reader keeps their
        // place until they ask to go somewhere.
        const findWasOpen = React.useRef(false)
        React.useEffect(() => {
          if (findWasOpen.current && !state.findOpen) {
            stick.current = true
            anchor.current = 0
            setFollow(true)
          }
          findWasOpen.current = state.findOpen
        }, [state.findOpen])
        React.useEffect(() => {
          const element = ref.current
          if (element === null || !stick.current) return
          // The browser clamps this to `scrollHeight - clientHeight`, so the
          // scroll event it queues reads back as "still at the bottom" and does
          // not switch following off by itself.
          element.scrollTop = element.scrollHeight
        })
        const lines = visibleLines()
        const needle = state.search
        // A hit is a LINE, not an occurrence: "how many logs match" is the question, and
        // the up/down buttons walk lines. Occurrences inside a line are all marked.
        const hits = needle === ''
          ? []
          : lines.map((line, index) => ({ index, line })).filter(({ line }) => hitRanges(line.t, needle).length > 0)
        const hitIndex = hits.length === 0 ? 0 : Math.min(Math.max(state.searchIndex, 0), hits.length - 1)
        const newest = lines[lines.length - 1]?.n ?? 0
        // Moving to a hit is the one thing that scrolls the view on purpose. It is keyed
        // on the jump counter rather than the hit index so that TYPING does not drag the
        // log around: the count and the marks update under the caret, and the view moves
        // only when the user presses Enter, ↑ or ↓.
        React.useEffect(() => {
          if (state.searchJump === 0) return
          const element = ref.current
          const row = element === null ? null : element.querySelector('.xcb-line-current')
          if (element === null || row === null) return
          // Parked, like a reader who scrolled away by hand: following the tail would
          // pull the view back to the newest output on the next line that arrives. The
          // anchor moves too, so "N new" counts from the hit the reader is reading.
          stick.current = false
          anchor.current = newest
          setFollow(false)
          element.scrollTop = Math.max(0, row.offsetTop - element.clientHeight / 2)
        }, [state.searchJump, hitIndex, needle])
        // The hooks are all above this point on purpose: an early return before one of
        // them would change the hook order between renders.
        if (lines.length === 0) {
          const text = state.log.length > 0
            ? 'No lines match the current filter.'
            : (state.status === 'running' ? 'Starting xcodebuild…' : 'No build output yet — pick a scheme and press Build.')
          return React.createElement('div', { className: 'xcb-empty' }, text)
        }

        // Which slice of the log is in the DOM. Without a search it is the tail, which is
        // what a watching user wants. A search moves it: the current hit must be one of the
        // rendered rows, or "jump to the next hit" would silently do nothing once the hits
        // are further back than the render cap.
        const start = hits.length === 0
          ? Math.max(0, lines.length - RENDER_CAP)
          : Math.max(0, Math.min(hits[hitIndex].index - Math.floor(RENDER_CAP / 2), Math.max(0, lines.length - RENDER_CAP)))
        const rows = start > 0 || lines.length > RENDER_CAP ? lines.slice(start, start + RENDER_CAP) : lines
        const above = start
        const below = Math.max(0, lines.length - (start + rows.length))
        const currentRowNumber = hits.length === 0 ? null : hits[hitIndex].line.n

        const children = []
        if (above > 0) {
          // The advice is the filter's, so it is only offered when the filter is what
          // could change: with a search running the window is centred on the current hit,
          // and telling the user to narrow the filter would be advice about another box.
          children.push(React.createElement('div', { className: 'xcb-note-row', key: 'above' },
            `${String(above)} earlier matching lines not rendered`
            + (needle === '' ? ' — narrow the filter to see them' : '')))
        }
        for (const line of rows) {
          // Every occurrence in the current line is marked, and the current line's marks
          // are the ones that stand out: the count says which hit you are on, and this is
          // what says which line that is.
          const isCurrent = currentRowNumber !== null && line.n === currentRowNumber
          const ranges = hitRanges(line.t, needle)
          let body = line.t
          if (ranges.length > 0) {
            body = []
            let at = 0
            ranges.forEach((range, index) => {
              if (range.start > at) body.push(line.t.slice(at, range.start))
              body.push(React.createElement('mark', {
                className: `xcb-hit${isCurrent ? ' now' : ''}`,
                key: `h${String(index)}`,
              }, line.t.slice(range.start, range.end)))
              at = range.end
            })
            if (at < line.t.length) body.push(line.t.slice(at))
          }
          children.push(React.createElement('div', {
            className: `xcb-line xcb-k-${line.k}${isCurrent ? ' xcb-line-current' : ''}`,
            key: line.n,
          },
            React.createElement('span', { className: 'xcb-num' }, String(line.n)),
            React.createElement('span', { className: 'xcb-txt' }, body)))
        }
        if (below > 0) {
          children.push(React.createElement('div', { className: 'xcb-note-row', key: 'below' },
            `${String(below)} later matching lines not rendered`))
        }
        // What has arrived since the reader parked. Cheap, and the difference
        // between knowing whether it is worth clicking and guessing.
        const unseen = follow ? 0 : Math.max(0, newest - anchor.current)

        return React.createElement('div', { className: 'xcb-logwrap' },
          state.findOpen ? React.createElement('div', { className: 'xcb-row xcb-find', key: 'find' },
            React.createElement('input', {
              className: 'xcb-input find',
              ref: findInput,
              value: needle,
              placeholder: 'Search this log',
              spellCheck: false,
              title: 'Search the lines on screen — nothing is hidden. Enter or the ↓ button for the next hit, Shift+Enter or the ↑ button for the previous one, ↑/↓ alone walk your earlier searches, Esc closes.',
              onChange: (event) => { setSearch(event.target.value) },
              onBlur: (event) => {
                if (isFindBox(event?.relatedTarget)) return
                // Losing focus is the moment to judge the box, and the only one. An empty
                // box is a row of the panel with nothing in it and goes away — but judging
                // it on the keystroke instead would take the bar away from someone who is
                // mid-edit, deleting a character to retype it.
                if (state.search === '') closeFind()
                else rememberSearch()
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  rememberSearch()
                  stepSearch(event.shiftKey ? -1 : 1, hits.length)
                  event.preventDefault()
                } else if (event.key === 'ArrowUp' && event.shiftKey !== true) {
                  recallInput('search', -1)
                  event.preventDefault()
                } else if (event.key === 'ArrowDown' && event.shiftKey !== true) {
                  recallInput('search', 1)
                  event.preventDefault()
                } else if (event.key === 'Escape') {
                  // One Esc is the whole way out now that an empty box closes itself.
                  closeFind()
                }
              },
            }),
            React.createElement('button', {
              className: 'xcb-btn tiny find-nav',
              disabled: hits.length === 0,
              title: 'Previous hit',
              onClick: () => { stepSearch(-1, hits.length) },
            }, '↑'),
            React.createElement('button', {
              className: 'xcb-btn tiny find-nav',
              disabled: hits.length === 0,
              title: 'Next hit',
              onClick: () => { stepSearch(1, hits.length) },
            }, '↓'),
            needle === ''
              ? null
              : React.createElement('span', {
                  className: `xcb-findcount${hits.length === 0 ? ' none' : ''}`,
                  key: 'count',
                }, hits.length === 0 ? 'no hits' : `${String(hitIndex + 1)} / ${String(hits.length)}`))
            : null,
          React.createElement('div', {
            className: 'xcb-log',
            ref,
            onContextMenu: runMenu.open,
            onScroll: (event) => {
              const element = event.currentTarget
              // Reaching the bottom — and letting go there — is a request to keep
              // following, so this re-arms as well as disarms. The threshold is
              // tight on purpose: with slack, parking a line or two above the end
              // while reading would silently re-arm and yank the view away.
              const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2
              // Only note the anchor on the way out, so the count is measured from
              // where the reader actually stopped reading.
              if (stick.current && !atBottom) anchor.current = newest
              stick.current = atBottom
              setFollow((current) => (current === atBottom ? current : atBottom))
            },
          }, children),
          // Parked above the tail, the panel offers the way back in one click:
          // dragging a scrollbar to the end to resume watching is the thing this
          // saves. Semi-transparent because it sits on top of the output.
          follow ? null : React.createElement('button', {
            className: 'xcb-jump',
            key: 'jump',
            type: 'button',
            title: 'Show the newest output and follow it from here',
            onClick: () => {
              stick.current = true
              setFollow(true)
              const element = ref.current
              if (element !== null) element.scrollTop = element.scrollHeight
            },
          }, unseen > 0 ? `↓ ${String(unseen)} new` : '↓ Latest'),
          // The same menu as the debugger's transcript. Clear is the toolbar's Clear: it drops the
          // lines AND moves the baseline, so neither the next poll nor a filter brings them back.
          runMenu.render({ className: 'xcb-log-ctxmenu', box: ref, lines, onClear: clearLog }),
        )
      }

      /**
       * The panel body, rendered in two seats.
       *
       * As a better-sidebar tab the host supplies the tab strip, the title and
       * the close button; as the floating overlay it supplies none of those, so
       * the panel draws its own head row. `docked` is the only difference.
       */
      function Panel(props) {
        useStore()
        const docked = props?.docked === true
        const [draft, setDraft] = React.useState(state.path || state.workspace)
        // `⌘F` opens the log search.
        //
        // Bound to the document rather than to the panel element, because the log itself
        // is not focusable: after clicking a line, the event has no panel ancestor to
        // bubble through. It is safe because this component is mounted exactly while the
        // panel is on screen — a closed panel leaves the browser's own find alone.
        React.useEffect(() => {
          const onKeyDown = (event) => {
            const key = String(event.key).toLowerCase()
            if (key !== 'f' && key !== 'l') return
            // `ctrlKey` as well: the same binding on a keyboard without Command, and it
            // costs nothing here — this panel has no other use for it.
            if (event.metaKey !== true && event.ctrlKey !== true) return
            if (event.altKey === true) return
            event.preventDefault()
            // `⌘L` is the debugger next to `⌘F` for the log, which is where a browser
            // keeps its location bar and where Xcode keeps its debug area.
            if (key === 'l') toggleLldb()
            else openFind()
          }
          document.addEventListener('keydown', onKeyDown)
          return () => { document.removeEventListener('keydown', onKeyDown) }
        }, [])
        React.useEffect(() => { setDraft(state.path) }, [state.path])
        // Seed the field from the session workspace the host reports, then search it
        // once without being asked.
        //
        // Opening the panel used to land on a path with nothing behind it: the
        // project only appeared after clicking into the field and back out, or
        // pressing the search button. The workspace is already known, so searching
        // it is not a decision to hand to the user. When this workspace was seen
        // before, its project facts come straight out of the store and paint at
        // once, and the host is asked in the background so a project edited on disk
        // still corrects itself.
        React.useEffect(() => {
          const workspace = state.workspace
          if (workspace === '') return
          setDraft((current) => (current === '' ? workspace : current))
          if (state.autoSearched === workspace) return
          state.autoSearched = workspace
          if (adoptCached(workspace)) {
            void doDetect(state.path).then(() => {
              // A stored location can go stale — the project moved or was renamed.
              // Fall back to a real search rather than leaving an error and an
              // empty panel where a project used to be.
              if (state.error !== '') void doSearch(workspace)
            })
            return
          }
          void doSearch(workspace)
        }, [state.workspace])

        const running = state.status === 'running' || state.status === 'starting'
        const canRun = !state.busy && state.path !== '' && state.scheme !== '' && !running
        const act = (action) => () => { void doStart(action) }

        const option = (value, label) => React.createElement('option', { key: value, value }, label)
        // What the destination list is worth at this moment. A bench swaps hardware
        // constantly, so a list is only trustworthy together with when it was read: the
        // age is shown while it is cached, and it disappears the moment the refresh
        // answers. An empty string renders nothing.
        const destinationNote = (() => {
          if (!state.path) return ''
          if (state.destinationsRefreshing || state.destinationsNext !== null) {
            return state.destinationsStale
              ? `cached ${formatDuration(Math.max(0, Date.now() - state.destinationsAt))} ago · refreshing…`
              : 'reading devices…'
          }
          if (state.destinationsStale) {
            return `cached ${formatDuration(Math.max(0, Date.now() - state.destinationsAt))} ago · not refreshed`
          }
          return ''
        })()
        const schemeOptions = state.schemes.map((scheme) => option(scheme, scheme))
        const destinationOptions = state.destinations.map((entry) => option(
          entry.destination,
          `${entry.kind === 'simulator' ? '◻ ' : entry.kind === 'device' ? '▣ ' : '⌘ '}${entry.name}`
            + `${entry.os ? ` · ${entry.os}` : ''}${entry.placeholder ? ' (generic)' : ''}`
            // A device every source reports as unreachable is still listed — that is
            // how a paired-but-unplugged phone is found — so it has to say so rather
            // than look like a target that will fail on Build.
            + `${entry.available === false ? ' (not connected)' : ''}`,
        ))
        const configurationOptions = state.configurations.map((value) => option(value, value))

        // An app that died is not a run that is still working. The session can outlive the
        // app it launched — ios-deploy lingers over the crash dump, devicectl finishes
        // reading the console — and showing the session's `running` while the phone holds
        // no such process is exactly how a crashed launch used to look healthy. So the
        // verdict the console gave outranks the status here, while the run is still
        // attached and streaming.
        const died = state.death !== null && state.death.fatal === true
        const status = [
          React.createElement('span', { className: `xcb-dot ${died ? 'failed' : state.status}`, key: 'dot' }),
          React.createElement('span', { key: 'status' },
            died ? 'app died' : (running ? 'running' : state.status)),
        ]
        if (state.runOrigin === 'agent') status.push(React.createElement('span', { key: 'origin', title: 'Started by the model with xcode_run' }, 'by agent'))
        if (state.exitCode !== null && !running) status.push(React.createElement('span', { key: 'exit' }, `exit ${String(state.exitCode)}`))
        if (state.durationMs > 0) status.push(React.createElement('span', { key: 'time' }, formatDuration(state.durationMs)))
        if (state.warningCount > 0) status.push(React.createElement('span', { key: 'warn' }, `${String(state.warningCount)} warnings`))
        if (state.errors.length > 0) status.push(React.createElement('span', { key: 'errors' }, `${String(state.errors.length)} errors`))
        if (state.artifact) {
          // On the classic channel the run's second witness is a file the app wrote
          // as it started, and it is worth showing: a `launched` line with a log
          // name behind it is a launch somebody can go and read, while one without
          // is a launch only the exit code vouches for.
          const appLog = typeof state.artifact.appLog === 'string' ? state.artifact.appLog : null
          status.push(React.createElement(
            'span',
            { key: 'artifact' },
            appLog === null ? `launched ${state.artifact.bundleId}` : `launched ${state.artifact.bundleId} · ${appLog}`,
          ))
          // An attached launch is a live session, not a finished step: the run stays
          // `running` for as long as the debugger is attached, so the panel has to say
          // what that running means and how to end it.
          if (state.artifact.attached === true) {
            status.push(React.createElement('span', {
              key: 'attached',
              title: state.artifact.consoleLog === undefined
                ? 'The debugger is attached to the app'
                : `Debugger attached; its console is ${String(state.artifact.consoleLog)}`,
            }, 'attached — Stop ends the session'))
          }
        }
        // The note is where the reason lives, and a faint grey sentence is not enough for
        // the one line that says the app is gone: it is red, and it is the loudest text in
        // a row of quiet facts.
        if (state.note) {
          status.push(React.createElement('span', {
            key: 'note',
            className: died ? 'xcb-note died' : 'xcb-note',
          }, state.note))
        }
        // The drawer's own handle. It lives in the status row because that is where the
        // panel already says what is going on, and a debugger holding the app stopped is
        // something that is going on.
        status.push(React.createElement('button', {
          key: 'lldb',
          className: `xcb-btn xcb-lldb-toggle${state.lldbOpen ? ' on' : ''}${state.lldb.active ? ' live' : ''}`,
          title: state.lldb.active
            ? `LLDB: ${state.lldb.session?.state ?? 'idle'} (⌘L)`
            : 'LLDB: inspect the running app (⌘L)',
          onClick: () => toggleLldb(),
        }, [
          state.lldb.active
            ? React.createElement('span', { className: 'xcb-lldb-dot', key: 'dot' })
            : null,
          React.createElement('span', { key: 'label' }, 'LLDB'),
        ].filter((node) => node !== null)))

        // Which revision of the host half this page is actually talking to. It is
        // the only way to tell a stale process from a broken fix without reading
        // timestamps out of the harness log.
        if (state.revision !== '') {
          status.push(React.createElement('span', {
            key: 'revision',
            className: 'xcb-rev',
            title: 'Revision of the plugin host half this panel is talking to',
          }, `rev ${state.revision}`))
        }

        // What this machine is missing, said before it costs the user a build.
        // The plugin is meant to be handed to somebody else, and half of what it
        // needs for device work is not part of macOS or Xcode.
        const missingTools = state.doctor === null
          ? []
          : state.doctor.tools.filter((tool) => !tool.ready)
        const doctorRow = missingTools.length === 0 ? null : React.createElement('div', {
          className: `xcb-doctor${state.doctor.missingRequired.length > 0 ? ' required' : ''}`,
          key: 'doctor',
        },
        React.createElement('span', null, state.doctor.missingRequired.length > 0
          ? 'this machine is missing:'
          : 'optional, for iOS 16 and earlier devices:'),
        React.createElement('span', { className: 'xcb-doctor-tools' },
          missingTools.map((tool) => tool.command).join(', ')),
        // Each tool's own install command, deduplicated. Spelling them out beats
        // naming one package, because ideviceinstaller and ios-deploy are NOT part
        // of libimobiledevice.
        React.createElement('code', null,
          [...new Set(missingTools.map((tool) => tool.install))].join(' ; ')))

        const pending = state.filterDraft.trim() !== state.filter
        const filtering = state.filter !== ''
        const shown = visibleLines().length
        const scanned = filtering && state.searchLines !== null ? state.searchTotal : state.log.length

        const filterBar = React.createElement('div', { className: 'xcb-row', key: 'filter' },
          React.createElement('input', {
            className: `xcb-input filter${pending ? ' pending' : ''}`,
            value: state.filterDraft,
            spellCheck: false,
            placeholder: 'Filter log…',
            title: 'Type a filter, then press Enter or click anywhere to apply it. Esc clears it. ⌘F searches the log.',
            onChange: (event) => {
              // Draft only: the committed filter (and the host query) waits for blur.
              state.filterDraft = event.target.value
              // Typing is the user's own text again, so the ↑/↓ walk starts over.
              state.filterRecall = null
              emit()
            },
            onBlur: commitFilter,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                commitFilter()
                event.currentTarget.blur()
              } else if (event.key === 'ArrowUp') {
                // ↑/↓ walk the filters used before, the way a shell walks its history.
                recallInput('filter', -1)
                event.preventDefault()
              } else if (event.key === 'ArrowDown') {
                recallInput('filter', 1)
                event.preventDefault()
              } else if (event.key === 'Escape') {
                clearFilter()
              }
            },
          }),
          React.createElement('button', {
            className: `xcb-btn tiny${state.regex ? ' on' : ''}`,
            title: 'Treat the filter as a regular expression (searched across the whole run on the host)',
            onClick: () => {
              state.regex = !state.regex
              state.searchLines = null
              state.searchKey = ''
              emit()
            },
          }, '.*'),
          // One button per level, from the table: a level that is not drawn here is a
          // kind nothing can show.
          ...LEVELS.map((level) => React.createElement('button', {
            key: `level-${level.id}`,
            'data-level': level.id,
            className: `xcb-btn tiny${levelOn(level) ? ` on${level.tone}` : ''}`,
            title: level.title,
            onClick: () => { toggleLevel(level) },
          }, level.label)),
          React.createElement('button', {
            className: 'xcb-btn tiny',
            title: "Show only the diagnostics — errors and warnings, with the compiler's notes that explain them",
            onClick: () => {
              state.kinds = freshKinds()
              for (const kind of OTHER_KINDS) state.kinds[kind] = false
              emit()
            },
          }, 'Problems'),
          React.createElement('button', { className: 'xcb-btn tiny', title: 'Clear the output log', onClick: clearLog }, 'Clear'),
          pending
            ? React.createElement('span', { className: 'xcb-hint' }, '↵ or click away to apply')
            : null,
          React.createElement('span', { className: 'xcb-count' },
            filtering
              ? `${String(shown)} match${shown === 1 ? '' : 'es'} / ${String(scanned)} lines`
              : `${String(state.log.length)} lines`))

        const picking = state.project === null && state.candidates.length > 0

        // The dock draws the title and its own close button in the tab strip;
        // repeating them here would give one panel two close buttons.
        const head = docked
          ? null
          : React.createElement('div', { className: 'xcb-head', key: 'head' },
              // The floating seat has no chip to carry the mark, so the panel draws it
              // itself: the same drawing, at the head row's scale.
              React.createElement(Mark, { size: 16, className: 'chip' }),
              React.createElement('span', { className: 'xcb-title' }, TAB_TITLE),
              React.createElement('span', { className: 'xcb-sub' }, state.project?.kind ?? ''),
              React.createElement('span', { className: 'xcb-spacer' }),
              React.createElement('button', {
                className: 'xcb-btn',
                title: 'Close panel',
                onClick: () => { state.open = false; emit() },
              }, '✕'))

        // More than one project under the directory: the user picks. React skips
        // a null child, so this slot costs nothing when there is nothing to ask.
        const picker = picking
          ? React.createElement('div', { className: 'xcb-picker', key: 'picker' },
              React.createElement('div', { className: 'xcb-picker-head' },
                `${String(state.candidates.length)} projects found — pick one`),
              state.candidates.map((candidate) => React.createElement('button', {
                key: candidate.location,
                className: 'xcb-candidate',
                title: candidate.location,
                onClick: () => { void doDetect(candidate.location) },
              },
                React.createElement('span', { className: 'xcb-candidate-name' }, candidate.name),
                React.createElement('span', { className: `xcb-candidate-kind ${candidate.kind}` }, candidate.kind),
                React.createElement('span', { className: 'xcb-candidate-path' }, candidate.relative))),
              state.truncated
                ? React.createElement('div', { className: 'xcb-picker-note' }, 'More projects exist; search a narrower directory.')
                : null)
          : null

        // Maximised, the debugger takes the whole panel: the build rows, the status and the log are
        // not squeezed above it but left out, and come back with ⤡. Only the floating seat's own head
        // stays, because it carries the panel's close button.
        if (state.lldbOpen && state.lldb.maximized === true) {
          return React.createElement('div', { className: `xcb-panel${docked ? ' docked' : ''}` }, [
            head,
            React.createElement(LldbDrawer, { key: 'lldb', focus: state.lldbFocus }),
          ])
        }

        const children = [
          head,
          React.createElement('div', { className: 'xcb-row', key: 'path' },
            React.createElement('input', {
              className: 'xcb-input path',
              value: draft,
              spellCheck: false,
              placeholder: 'a directory, or one .xcworkspace / .xcodeproj',
              title: 'Search this directory for Xcode projects',
              onChange: (event) => { setDraft(event.target.value) },
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  void doSearch(draft)
                  event.currentTarget.blur()
                }
              },
              // Committed on blur, like the filter field: naming a directory is
              // a decision, and searching on each keystroke would walk the tree
              // dozens of times for one answer.
              onBlur: () => {
                if (draft !== '' && draft !== state.path && draft !== state.searchRoot) void doSearch(draft)
              },
            }),
            React.createElement('button', {
              className: 'xcb-btn',
              disabled: state.busy || draft === '',
              title: 'Search this directory for Xcode projects',
              onClick: () => { void doSearch(draft) },
            }, 'Search'),
            state.project === null
              ? null
              : React.createElement('button', {
                  className: 'xcb-btn',
                  title: 'Choose a different project',
                  onClick: () => { state.project = null; emit() },
                }, 'Change')),
          picker,
          React.createElement('div', { className: 'xcb-row', key: 'target' },
            React.createElement('select', {
              className: 'xcb-select scheme',
              value: state.scheme,
              disabled: schemeOptions.length === 0,
              onChange: (event) => {
                state.scheme = event.target.value
                state.destination = ''
                // A list read for the scheme just left is not this scheme's list. Blur has
                // already released anything held, so this only makes that unreachable.
                state.destinationsHeld = false
                state.destinationsNext = null
                emit()
                void doDestinations()
              },
            }, schemeOptions.length > 0 ? schemeOptions : option('', 'no schemes')),
            React.createElement('select', {
              className: 'xcb-select dest',
              value: state.destination,
              disabled: destinationOptions.length === 0,
              // Opening the list is a request to look at the hardware, and a bench changes
              // it between looks: the command runs now, and its answer is held until the
              // dropdown shuts (see `destinationsHeld`), so the options cannot move under
              // the pointer that is choosing one of them.
              onMouseDown: () => {
                state.destinationsHeld = true
                refreshDestinations()
              },
              onBlur: () => { releaseDestinations() },
              onChange: (event) => {
                state.destination = event.target.value
                remember(state.project?.root ?? '', { destination: state.destination })
                emit()
                releaseDestinations()
              },
            }, destinationOptions.length > 0 ? destinationOptions : option('', 'no destinations')),
            // An explicit way to re-read the list, for when a phone was plugged in and
            // nothing else on the panel has changed.
            React.createElement('button', {
              className: 'xcb-btn tiny',
              key: 'redest',
              title: 'Re-read the device list from xcodebuild',
              disabled: state.path === '' || state.scheme === '',
              onClick: () => { refreshDestinations() },
            }, '⟳'),
            destinationNote === '' ? null : React.createElement('span', {
              className: `xcb-destnote${state.destinationsStale ? ' stale' : ''}`,
              key: 'destnote',
            }, destinationNote),
            React.createElement('select', {
              className: 'xcb-select',
              value: state.configuration,
              onChange: (event) => {
                state.configuration = event.target.value
                remember(state.project?.root ?? '', { configuration: state.configuration })
                emit()
              },
            }, configurationOptions)),
          React.createElement('div', { className: 'xcb-row', key: 'actions' },
            React.createElement('button', { className: 'xcb-btn primary', disabled: !canRun, onClick: act('build') }, 'Build'),
            // Says what it does: `run` is a build followed by an install and a
            // launch, and a button reading only "Run" hides the build entirely.
            React.createElement('button', {
              className: 'xcb-btn', disabled: !canRun, onClick: act('run'),
              title: 'Build, then install and launch on the destination',
            }, 'Build & Run'),
            React.createElement('button', { className: 'xcb-btn', disabled: !canRun, onClick: act('test') }, 'Test'),
            React.createElement('button', { className: 'xcb-btn', disabled: !canRun, onClick: act('clean') }, 'Clean'),
            React.createElement('button', { className: 'xcb-btn', disabled: !canRun, onClick: act('archive') }, 'Archive'),
            React.createElement('button', { className: 'xcb-btn danger', disabled: !running, onClick: () => { void doStop() } }, 'Stop')),
          React.createElement('div', { className: 'xcb-status', key: 'status' }, status),
          doctorRow,
          filterBar,
        ]
        if (state.error !== '') children.push(React.createElement('div', { className: 'xcb-err', key: 'error' }, state.error))
        children.push(React.createElement(LogView, { key: 'log' }))
        // The drawer is the last child, so it sits at the bottom edge of the panel and
        // takes its own height from the log above it.
        if (state.lldbOpen) {
          children.push(React.createElement(LldbDrawer, { key: 'lldb', focus: state.lldbFocus }))
        }
        return React.createElement('div', { className: `xcb-panel${docked ? ' docked' : ''}` }, children)
      }


      /**
       * The plugin's mark: four tapered blades leaving a pin of dark at the crossing.
       *
       * One drawing for every seat the plugin has — the header button, the icon
       * better-sidebar draws in its tab strip, and both the Guide capsule and the tab
       * chip of the shell's own right sidebar — so it is recognisable by the same mark
       * wherever it is docked. The sizes differ per seat; the drawing does not.
       *
       * @param {object} props - `size` in px, and an optional extra `className`.
       */
      function Mark({ size = 20, className }) {
        // A gradient is referenced by id, and several seats are on screen at once, so
        // each drawing declares its own rather than relying on `url(#…)` resolving to
        // whichever identical definition the document happens to hold first. The colon
        // React's ids carry is legal in an id but not worth trusting inside `url()`.
        const gradient = `xcb-emblem-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
        return React.createElement('svg', {
          className: className === undefined ? 'xcb-mark' : `xcb-mark ${className}`,
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
        },
          React.createElement('defs', null,
            React.createElement('linearGradient', {
              id: gradient,
              x1: '0', y1: '0', x2: '1', y2: '1',
            },
              React.createElement('stop', { offset: '0', stopColor: '#a8c4ff' }),
              React.createElement('stop', { offset: '.55', stopColor: '#5b8cff' }),
              React.createElement('stop', { offset: '1', stopColor: '#2f56d8' }))),
          React.createElement('path', {
            d: 'M12.52 13.53L17.55 20.8L20.8 17.55L13.53 12.52Z M13.53 11.48L20.8 6.45L17.55 3.2L12.52 10.47Z M10.47 12.52L3.2 17.55L6.45 20.8L11.48 13.53Z M11.48 10.47L6.45 3.2L3.2 6.45L10.47 11.48Z',
            fill: `url(#${gradient})`,
            stroke: 'rgba(168,196,255,.45)',
            strokeWidth: .35,
          }))
      }

      /**
       * The mark in the shape better-sidebar asks for it: `icon(size)`, called as a
       * plain function with the px the tab strip draws it at.
       *
       * The shell's own sidebar asks the other way — `entry.icon` is drawn as a
       * component receiving `{size, className}` — which is what `Mark` itself already
       * is. One drawing, two adapters, because the two registries disagree about which
       * side of `createElement` the size is passed on.
       *
       * @param {number} size - the px the tab strip draws the mark at.
       * @returns {object} the mark element.
       */
      const markIcon = (size) => React.createElement(Mark, { size })

      function Toggle(props) {
        useStore()
        const session = typeof props?.sessionId === 'string' ? props.sessionId : null
        // The header seat is the fallback that names the session, and it is the
        // one seat mounted in every shell.
        //
        // Adoption used to be gated on this seat also *displaying* the panel
        // (`dock === null`), so that a component rendering nothing could not steer
        // the shared state. With a sidebar installed that gate closed for good,
        // which left the sidebar tab's session as the only way to name one — and
        // an unscoped dock tab supplies none. The panel then sent every read
        // unnamed and the host, asked to guess, answered with its own launch
        // directory. The arbitration in `adoptSession` keeps a seated source
        // authoritative while letting this seat fill the gap.
        React.useEffect(() => { adoptSession(session, 'header') }, [session])
        // Nothing to show once a sidebar is in charge: it registers the tab and
        // offers it in its own list — better-sidebar in its tab strip, the shell's
        // right sidebar in its Guide and its add-tab menu — so a second permanent
        // button beside the session title would only be clutter. It survives
        // solely for a shell with no sidebar to add the tab from.
        if (sidebarOwnsPanel()) return null
        // Everything below is the shell with no sidebar to add the tab from.
        return React.createElement('button', {
          className: `xcb-trigger${state.open ? ' on' : ''}`,
          type: 'button',
          title: 'XcBuild panel',
          'aria-label': 'XcBuild panel',
          'aria-pressed': state.open ? 'true' : 'false',
          onClick: () => {
            state.open = !state.open
            emit()
          },
        },
          // An emblem rather than a label. This seat is one control in a row of
          // header controls, where a word beside a status dot reads as clutter; and
          // a small thin X reads as "close", so this one is drawn instead: the same
          // mark the sidebars show, at header size. The name survives in the tooltip
          // and the accessible label, which is where it is needed.
          React.createElement(Mark, { size: 20 }),
          // The status rides the tile's corner rather than sitting beside the
          // mark: inline, a bare dot next to a glyph is the stray bullet the
          // word used to give a home to. Its ring is the tile's own colour, so
          // it reads as part of the badge on any header background.
          React.createElement('span', {
            className: `xcb-dot sm ${state.death !== null && state.death.fatal === true ? 'failed' : state.status}`,
          }))
      }

      /**
       * The dock tab.
       *
       * better-sidebar hands each tab its `scope`, which carries the session the
       * tab was opened in — the same fact the header button gets as `sessionId`.
       * A tab opened without a scope has none, which is why this seat is
       * authoritative when it speaks and the header seat covers it when it does
       * not.
       */
      function DockTab(props) {
        useStore()
        const session = typeof props?.scope?.sessionId === 'string' ? props.scope.sessionId : null
        React.useEffect(() => { adoptSession(session, 'dock') }, [session])
        return React.createElement(Panel, { docked: true })
      }

      /**
       * The official right sidebar's tab.
       *
       * That sidebar's tab bodies are session-scoped, so `sessionId` arrives as a
       * prop — the same fact the dock tab gets from its `scope`, which is why the
       * two seats rank alike in `adoptSession`. Rendered docked: the shell's tab
       * chip draws the title and the close button, exactly as better-sidebar's
       * strip does, so the panel draws no head row of its own.
       */
      function RightBarTab(props) {
        useStore()
        const session = typeof props?.sessionId === 'string' ? props.sessionId : null
        React.useEffect(() => { adoptSession(session, 'rightbar') }, [session])
        return React.createElement(Panel, { docked: true })
      }

      /**
       * The chip the shell's tab strip draws for our tab: the mark, then the name.
       *
       * The name is the one the plugin registered — a tab's title comes from the type's
       * own `title()` — so the seat needs no reader for it. (The shipped Files chip reads
       * `useTabInfo()` instead, which throws for an uncommitted tab; this chip also has
       * to render outside the shell, in this plugin's tests.)
       */
      function RightBarTitle() {
        return React.createElement(React.Fragment, null,
          React.createElement(Mark, { size: 16, className: 'chip' }),
          TAB_TITLE)
      }

      /** True while a sidebar — either one — is showing the panel. */
      function sidebarOwnsPanel() {
        return dock !== null || rightBarSeat !== null
      }

      /** Give the official right sidebar's seat back, if this plugin is holding one. */
      function dropRightBarSeat() {
        if (rightBarSeat === null) return
        const dispose = rightBarSeat
        rightBarSeat = null
        dispose()
      }

      /**
       * Take the official right sidebar's seat: the tab type, the Guide capsule that
       * offers it, and the body that type dispatches to.
       *
       * One disposer covers all of it on purpose. Half a seat is a broken one: a type
       * with no body is a tab the Guide offers and nothing can draw, and a body with no
       * type is a renderer no tab can reach.
       */
      function takeRightBarSeat() {
        const registry = rightBar
        if (registry === null || rightBarSeat !== null) return
        const disposeType = registry.register({
          id: TAB_ID,
          kind: RIGHT_TAB_KIND,
          // The band a plugin contributes in. It only decides anything when two
          // registrations claim one `kind`, and ours is our own.
          priority: 'extension',
          title: () => TAB_TITLE,
          // The Guide is where a shell with no better-sidebar discovers this: the
          // shell's own Files tab is listed there the same way, capsule and all.
          guide: [{
            order: 40,
            title: () => TAB_TITLE,
            description: () => TAB_DESCRIPTION,
            // Drawn as a component here, unlike the dock's `icon(size)`: `Mark` takes
            // `{size, className}` as props.
            icon: Mark,
          }],
        })
        const disposeBody = ctx.slots.inject(RIGHT_TAB_SLOT, () => ctx.slots.register(
          { name: RIGHT_TAB_SLOT, key: TAB_ID },
          RightBarTab,
        ))
        // The chip is the other half of being in that sidebar: without it the tab is a
        // word, and the mark the user recognises the plugin by is missing where they are
        // most likely to look for it.
        const disposeTitle = ctx.slots.inject(RIGHT_TAB_TITLE_SLOT, () => ctx.slots.register(
          { name: RIGHT_TAB_TITLE_SLOT, key: TAB_ID },
          RightBarTitle,
        ))
        rightBarSeat = () => {
          disposeTitle()
          disposeBody()
          disposeType()
        }
      }

      /**
       * Put the panel in whichever sidebar the shell has.
       *
       * The two services arrive in an order this plugin does not control — each
       * `ctx.inject` callback fires when its own service appears, whenever that is —
       * so neither callback can decide alone. This reads both and makes the shell
       * match: better-sidebar when it is there, the official right sidebar when it is
       * not, and the header button plus the floating overlay when neither is.
       */
      function syncSeats() {
        // better-sidebar in charge: the official seat, if it was taken, goes back.
        if (dock !== null) {
          if (rightBarSeat !== null) {
            dropRightBarSeat()
            emit()
          }
          return
        }
        takeRightBarSeat()
      }

      function Overlay() {
        useStore()
        // Deliberately NOT refreshed here. This entry is mounted without a session
        // of its own, and the header seat — mounted for every session, and the
        // one seat that always knows which one that is — owns the first read; the
        // interval above keeps it current on its own. (The host no longer guesses
        // when asked unnamed: it answers with an empty workspace, not its own
        // directory, so a stray read here could not point the panel at the
        // harness's launch root anyway.)
        return state.open ? React.createElement(Panel, { docked: false }) : null
      }

      // Polling lives here, not in a component.
      //
      // It used to be an effect on the overlay entry, which made the log's
      // freshness depend on whether the shell happened to mount that slot. It is
      // a data concern: a build's lines must keep arriving whatever surface is
      // on screen, and whether the docked panel, the overlay, or neither is
      // mounted must not decide whether the log moves.
      ctx.effect(() => {
        const timer = setInterval(() => { void poll() }, POLL_MS)
        return () => { clearInterval(timer) }
      }, 'dsh-xcodebuild: poll')

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
        { name: OVERLAY_SLOT, id: 'dsh-xcodebuild-panel', order: 60 },
        Overlay,
      ))
      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register(
        { name: HEADER_SLOT, id: 'dsh-xcodebuild-toggle', order: 5 },
        Toggle,
      ))

      // better-sidebar, when the shell has it, owns the panel: it renders the
      // component itself, gives it a tab strip and a close button, and lets the
      // user move it between the right sidebar and the bottom workbench. The
      // overlay above stays registered as the surface for a shell without it,
      // and renders nothing while the dock is in charge.
      //
      // Declared through `ctx.inject` rather than `exports.inject` on purpose: a
      // hard dependency would park this plugin until a service that may never
      // exist appears, which is the opposite of a fallback.
      // The official right sidebar is the fallback for a shell that has it and no
      // docking plugin: the panel becomes a tab type there, beside the shell's own
      // Files tab. Soft dependency for the same reason as the dock below — a shell
      // with neither sidebar must still load this plugin and keep the header button.
      ctx.inject(['sidebarRightTabs'], (scope) => {
        rightBar = scope.sidebarRightTabs
        // The leash: the seat is taken by hand (it comes and goes with the other
        // service), so losing this service — or unloading — has to give it back
        // from here, and stop claiming a registry that is gone.
        scope.effect(() => () => {
          rightBar = null
          dropRightBarSeat()
        }, 'dsh-xcodebuild: right-sidebar seat')
        syncSeats()
        emit()
      })

      ctx.inject(['betterSidebar'], (scope) => {
        dock = scope.betterSidebar
        scope.effect(() => dock.registerTab({
          id: TAB_ID,
          title: TAB_TITLE,
          description: TAB_DESCRIPTION,
          // The same mark as the header button and the shell's own sidebar: a tab strip
          // draws the icon it is given, and without one this tab is words only.
          icon: markIcon,
          single: true,
          order: 40,
          component: (props) => React.createElement(DockTab, { scope: props?.scope }),
        }), 'dsh-xcodebuild: better-sidebar tab')
        // The header button mirrors the tab, so it re-renders when the dock's
        // layout changes — and the dock is the only one who knows about that.
        scope.effect(() => dock.subscribeState(() => { emit() }), 'dsh-xcodebuild: dock state')
        // The dock is in charge now, so the official seat — if that service arrived
        // first and took one — goes back.
        syncSeats()
        emit()
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
