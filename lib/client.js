/**
 * dsh-xcodebuild — browser half.
 *
 * Two additive contributions, both into existing slots, so nothing in the shell
 * is replaced: a small "XcBuild" toggle in the session header, and the build panel
 * itself as an overlay entry.
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

    const ALL_KINDS = ['error', 'warning', 'success', 'task', 'test', 'note', 'section', 'plain']
    const OTHER_KINDS = ['success', 'task', 'test', 'note', 'section', 'plain']

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
      '.xcb-row{display:flex;gap:6px;align-items:center;padding:7px 10px;flex-wrap:wrap;border-bottom:1px solid #2b2e34}',
      '.xcb-input,.xcb-select{appearance:none;background:#16181c;border:1px solid #3a3e46;color:#dfe1e5;border-radius:6px;padding:4px 7px;font:inherit;min-width:0}',
      '.xcb-input:focus,.xcb-select:focus{outline:1px solid #2f6feb}',
      '.xcb-input.path{flex:1;min-width:170px}',
      '.xcb-input.filter{flex:1;min-width:130px}',
      '.xcb-input.pending{border-color:#e0a33a}',
      '.xcb-select.scheme{max-width:190px}.xcb-select.dest{max-width:250px}',
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
      '.xcb-logwrap{position:relative;flex:1;min-height:0;display:flex}',
      '.xcb-log{flex:1;overflow:auto;margin:0;padding:7px 0;background:#131518;',
      'font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.xcb-line{display:flex;gap:9px;padding:0 10px}',
      '.xcb-num{flex:0 0 46px;text-align:right;color:#4a4f57;user-select:none}',
      '.xcb-txt{flex:1;white-space:pre-wrap;word-break:break-word;min-width:0}',
      '.xcb-k-error .xcb-txt{color:#ff6b5e}',
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
      '.xcb-trigger{display:inline-flex;align-items:center;gap:6px;appearance:none;border:1px solid transparent;',
      'background:transparent;color:inherit;border-radius:6px;padding:4px 8px;font:inherit;cursor:pointer}',
      '.xcb-trigger:hover{background:rgba(127,127,127,.16)}',
      '.xcb-trigger.on{background:rgba(47,111,235,.18);border-color:rgba(47,111,235,.5)}',
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
       * Adopt the session the panel was mounted for, and re-read state for it.
       *
       * A slot hands its session down as a prop, and the panel renders once per
       * session, so the first render with an id is the moment the workspace
       * becomes knowable.
       */
      function adoptSession(id) {
        const next = typeof id === 'string' && id !== '' ? id : ''
        if (next !== sessionId) {
          sessionId = next
          state = storeFor(next)
          // Repaint before the host answers, so the previous workspace's project
          // and log never linger under the new session's name.
          emit()
        }
        // Always read, even with no session to name: the host then answers with
        // its own directory, which is still better than a blank panel.
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
        const cached = readSelections()[root]
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
        // Left empty on purpose: the live list arrives from the refresh that
        // follows, so a destination that disappeared never lingers.
        state.destinations = []
        state.destination = ''
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
        runId: null,
        activeRunId: null,
        log: [],
        logNext: 0,
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
        if (typeof root !== 'string' || root === '') return
        try {
          const all = readSelections()
          const current = all[root] !== null && typeof all[root] === 'object' ? all[root] : {}
          all[root] = { ...current, ...patch }
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

      function groupOn(group) {
        if (group === 'error') return state.kinds.error
        if (group === 'warning') return state.kinds.warning
        return OTHER_KINDS.some((kind) => state.kinds[kind])
      }

      function toggleGroup(group) {
        const on = !groupOn(group)
        if (group === 'error') state.kinds.error = on
        else if (group === 'warning') state.kinds.warning = on
        else for (const kind of OTHER_KINDS) state.kinds[kind] = on
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
            const recorded = readSelections()[result.root]?.location
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
          const remembered = readSelections()[info.root] ?? {}
          // The whole description, so the next open of this workspace paints from
          // the store instead of waiting on xcodebuild again.
          remember(info.root, { location: info.location, info })
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

      async function doDestinations() {
        if (!state.path || !state.scheme) return
        const root = state.project?.root ?? ''
        try {
          const remembered = readSelections()[root] ?? {}
          // The host picks the default — connected hardware before a simulator —
          // so this panel and the xcode_destinations tool cannot disagree. What
          // this workspace used last time is sent along and outranks both.
          const result = await api('destinations', {
            path: state.path,
            scheme: state.scheme,
            preferred: state.destination || remembered.destination || '',
          })
          const list = result.destinations ?? []
          state.destinations = list
          if (!list.some((entry) => entry.destination === state.destination)) {
            state.destination = result.recommended ?? ''
          }
          remember(root, {
            scheme: state.scheme,
            destination: state.destination,
            configuration: state.configuration,
          })
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
        }
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
        // A clear is a fresh start, so it also re-arms following the tail.
        React.useEffect(() => {
          stick.current = true
          anchor.current = 0
          setFollow(true)
        }, [state.clearedAt])
        React.useEffect(() => {
          const element = ref.current
          if (element === null || !stick.current) return
          // The browser clamps this to `scrollHeight - clientHeight`, so the
          // scroll event it queues reads back as "still at the bottom" and does
          // not switch following off by itself.
          element.scrollTop = element.scrollHeight
        })
        const lines = visibleLines()
        if (lines.length === 0) {
          const text = state.log.length > 0
            ? 'No lines match the current filter.'
            : (state.status === 'running' ? 'Starting xcodebuild…' : 'No build output yet — pick a scheme and press Build.')
          return React.createElement('div', { className: 'xcb-empty' }, text)
        }
        const hidden = Math.max(0, lines.length - RENDER_CAP)
        const rows = hidden > 0 ? lines.slice(lines.length - RENDER_CAP) : lines
        const children = []
        if (hidden > 0) {
          children.push(React.createElement('div', { className: 'xcb-note-row', key: 'cap' },
            `${String(hidden)} earlier matching lines not rendered — narrow the filter to see them`))
        }
        for (const line of rows) {
          children.push(React.createElement('div', { className: `xcb-line xcb-k-${line.k}`, key: line.n },
            React.createElement('span', { className: 'xcb-num' }, String(line.n)),
            React.createElement('span', { className: 'xcb-txt' }, line.t)))
        }
        const newest = lines[lines.length - 1]?.n ?? 0
        // What has arrived since the reader parked. Cheap, and the difference
        // between knowing whether it is worth clicking and guessing.
        const unseen = follow ? 0 : Math.max(0, newest - anchor.current)

        return React.createElement('div', { className: 'xcb-logwrap' },
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
        if (state.artifact) status.push(React.createElement('span', { key: 'artifact' }, `launched ${state.artifact.bundleId}`))
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
            title: 'Type a filter, then press Enter or click anywhere to apply it. Esc clears it.',
            onChange: (event) => {
              // Draft only: the committed filter (and the host query) waits for blur.
              state.filterDraft = event.target.value
              emit()
            },
            onBlur: commitFilter,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                commitFilter()
                event.currentTarget.blur()
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
          React.createElement('button', {
            className: `xcb-btn tiny${groupOn('error') ? ' on err' : ''}`,
            title: 'Show errors',
            onClick: () => { toggleGroup('error') },
          }, 'Errors'),
          React.createElement('button', {
            className: `xcb-btn tiny${groupOn('warning') ? ' on warn' : ''}`,
            title: 'Show warnings',
            onClick: () => { toggleGroup('warning') },
          }, 'Warnings'),
          React.createElement('button', {
            className: `xcb-btn tiny${groupOn('other') ? ' on' : ''}`,
            title: 'Show build, task and info lines',
            onClick: () => { toggleGroup('other') },
          }, 'Info'),
          React.createElement('button', {
            className: 'xcb-btn tiny',
            title: 'Show only errors and warnings',
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
              React.createElement('span', { className: 'xcb-title' }, 'XcBuild'),
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
                emit()
                void doDestinations()
              },
            }, schemeOptions.length > 0 ? schemeOptions : option('', 'no schemes')),
            React.createElement('select', {
              className: 'xcb-select dest',
              value: state.destination,
              disabled: destinationOptions.length === 0,
              onChange: (event) => {
                state.destination = event.target.value
                remember(state.project?.root ?? '', { destination: state.destination })
                emit()
              },
            }, destinationOptions.length > 0 ? destinationOptions : option('', 'no destinations')),
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


      function Toggle(props) {
        useStore()
        const session = typeof props?.sessionId === 'string' ? props.sessionId : null
        // Only the seat that actually displays the panel may adopt a session. A
        // component that renders nothing must not steer the shared state out
        // from under the surface the user is looking at.
        const owns = dock === null
        React.useEffect(() => { if (owns) adoptSession(session) }, [owns, session])
        // Nothing to show once better-sidebar is in charge: it registers the tab
        // and offers it in its own list, so a second permanent button beside the
        // session title would only be clutter. It survives solely for a shell
        // with no sidebar to add the tab from.
        if (dock !== null) return null
        // Everything below is the shell with no sidebar to add the tab from.
        return React.createElement('button', {
          className: `xcb-trigger${state.open ? ' on' : ''}`,
          title: 'XcBuild panel',
          onClick: () => {
            state.open = !state.open
            emit()
          },
        },
          React.createElement('span', { className: `xcb-dot sm ${state.status}` }),
          React.createElement('span', null, 'XcBuild'))
      }

      /**
       * The dock tab.
       *
       * better-sidebar hands each tab its `scope`, which carries the session the
       * tab was opened in — the same fact the header button gets as `sessionId`.
       */
      function DockTab(props) {
        useStore()
        const session = typeof props?.scope?.sessionId === 'string' ? props.scope.sessionId : null
        React.useEffect(() => { adoptSession(session) }, [session])
        return React.createElement(Panel, { docked: true })
      }

      function Overlay() {
        useStore()
        // Deliberately NOT refreshed here. This entry is mounted without a
        // session, so a read from here would ask the host to guess the workspace
        // and get its own directory back. The header button — which is always
        // mounted and always knows its session — owns the first read; the
        // interval above keeps it current on its own.
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
      ctx.inject(['betterSidebar'], (scope) => {
        dock = scope.betterSidebar
        scope.effect(() => dock.registerTab({
          id: TAB_ID,
          title: 'XcBuild',
          description: 'Build, run and test a project with a live, filterable log',
          single: true,
          order: 40,
          component: (props) => React.createElement(DockTab, { scope: props?.scope }),
        }), 'dsh-xcodebuild: better-sidebar tab')
        // The header button mirrors the tab, so it re-renders when the dock's
        // layout changes — and the dock is the only one who knows about that.
        scope.effect(() => dock.subscribeState(() => { emit() }), 'dsh-xcodebuild: dock state')
        emit()
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
