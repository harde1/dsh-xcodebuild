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
      '.xcb-empty{padding:28px 16px;text-align:center;color:#6b7280}',
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

      /**
       * Add a value to one box's history, newest last.
       *
       * Empty is not a value to remember — it is the absence of one, and an entry for it
       * would make ↑ walk onto a blank line. Repeating the newest entry is not remembered
       * either: pressing Enter twice on the same filter should not need two ↑ to pass it.
       */
      function rememberInput(history, value) {
        const text = String(value ?? '')
        if (text === '') return history
        if (history[history.length - 1] === text) return history
        return history.concat([text]).slice(-INPUT_HISTORY)
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
        const cached = cachedDestinations(remembered, state.scheme)
        if (cached !== null) {
          state.destinations = cached.list
          state.destinationsAt = cached.at
          state.destinationsStale = true
          if (!cached.list.some((entry) => entry.destination === state.destination)) {
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
        state.exitCode = null
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
        if (!state.activeRunId) return
        try {
          await api('stop', { runId: state.activeRunId })
        } catch {
          /* the run may have exited between the paint and the click */
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
          if (!state.activeRunId && result.activeRunId) {
            state.activeRunId = result.activeRunId
            state.runId = result.activeRunId
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
              state.note = result.note ?? ''
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

        if (!state.activeRunId && Date.now() - lastStateReadAt > 2500) await refreshState()
      }

      // -- views -----------------------------------------------------------

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
            if (event.key !== 'f' && event.key !== 'F') return
            // `ctrlKey` as well: the same binding on a keyboard without Command, and it
            // costs nothing here — this panel has no other use for it.
            if (event.metaKey !== true && event.ctrlKey !== true) return
            if (event.altKey === true) return
            event.preventDefault()
            openFind()
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
            + `${entry.os ? ` · ${entry.os}` : ''}${entry.placeholder ? ' (generic)' : ''}`,
        ))
        const configurationOptions = state.configurations.map((value) => option(value, value))

        const status = [
          React.createElement('span', { className: `xcb-dot ${state.status}`, key: 'dot' }),
          React.createElement('span', { key: 'status' }, running ? 'running' : state.status),
        ]
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
        if (state.note) status.push(React.createElement('span', { key: 'note' }, state.note))
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
          React.createElement('span', { className: `xcb-dot sm ${state.status}` }))
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
