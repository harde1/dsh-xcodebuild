/**
 * xcodebuild output classification.
 *
 * Every log line gets exactly one kind as it is captured. That kind drives three
 * things at once: the panel's colouring, the severity toggles (one per kind,
 * listed in `LEVELS` in `lib/client.js`), and the `errors`/`warningCount`
 * summary a tool result carries. Those are load-bearing, so the rules live here — a dependency-free
 * module with a test — rather than inline in the plugin body where the only way
 * to check them would be to run a real build.
 *
 * The order of the checks is the specification, not an accident:
 *
 * 1. The `** BUILD FAILED **` / `** BUILD SUCCEEDED **` banners win outright.
 *    A failed build must never be summarised as anything but an error, and the
 *    success banner is the one line a user scans for.
 * 2. Then the compiler's own diagnostics: `error:` before `warning:`, because a
 *    line such as `error: ... warning: ...` (clang does emit these) is an error.
 * 3. `note:` is matched either at the start of a line or after a
 *    `file:line[:col]: ` diagnostic prefix. The prefix form is the one that
 *    actually occurs — clang and Swift emit `<path>:<line>:<col>: note: …` — so
 *    anchoring to the line start alone matches nothing in practice. Requiring
 *    the numeric prefix (rather than matching `note:` anywhere) is what keeps
 *    prose that happens to contain the word out of the bucket.
 * 4. Task lines are xcodebuild's own progress verbs (`CompileSwift`, `Ld`, …).
 *    They are matched at line start after optional whitespace so that a
 *    compiler message quoting a filename is not swallowed as progress.
 *
 * 5. `xcbeautify` output is a second vocabulary, and it is not a superset of the
 *    first. Measured with 2.28.0, it REWRITES what it formats and drops the words
 *    it formatted into:
 *        /p/App.swift:12:9: error: cannot find 'Foo' in scope   ->  [x] /p/App.swift:12:9: cannot find 'Foo' in scope
 *        /p/App.swift:4:2: warning: unused variable 'x'         ->  [!]  /p/App.swift:4:2: unused variable 'x'
 *        ** BUILD SUCCEEDED **                                  ->  Build Succeeded
 *    A classifier that only knew xcodebuild's text would call every one of those
 *    `plain`, so a beautified failing build would be shown with no errors in it and
 *    the Warnings filter would have nothing to filter. The markers are therefore
 *    part of the specification, not a special case bolted on later.
 *
 * @module dsh-xcodebuild/classify
 */

/** xcodebuild's progress verbs, matched at the start of a line. */
const TASK_VERBS = new RegExp(
  '^\\s*('
  + 'Compile|CompileSwift|CompileC|CompileAssetCatalog|Ld |Linking|SwiftDriver|SwiftCompile|'
  + 'CodeSign|CopySwiftLibs|ProcessInfoPlistFile|WriteAuxiliaryFile|Touch |MkDir|CpResource|'
  + 'PhaseScriptExecution|EmitSwiftModule|GenerateDSYMFile|SwiftMergeGeneratedHeaders|'
  + 'ExtractAppIntentsMetadata'
  + ')',
)

/**
 * Classify one line of xcodebuild output.
 * @param {string} text - a single raw output line, without its trailing newline.
 * @returns {'error'|'warning'|'note'|'task'|'test'|'success'|'section'|'plain'} the line's kind.
 */
/**
 * Every kind a line can have, in one place.
 *
 * The panel draws one severity toggle per kind, so this list is also the panel's minimal
 * contract: a kind added to `classify` with no level to show it would be a line the user
 * cannot get back on screen once it is off. The client's level table is checked against
 * this, and `test/classify.test.mjs` checks that no case below returns anything else.
 */
/**
 * Every kind a line can carry.
 *
 * `classify` produces all of them except the last two: `verbose` and `info` are declared by
 * the device itself (`lib/syslog.js`), and they are listed here because the panel's level
 * buttons are drawn from this vocabulary and a kind missing from it would have no button.
 */
export const KINDS = ['error', 'warning', 'note', 'success', 'task', 'test', 'section', 'plain', 'verbose', 'info']

export function classify(text) {
  const line = String(text)
  if (/\*\* (BUILD|TEST|ARCHIVE|CLEAN) FAILED \*\*/.test(line)) return 'error'
  // xcbeautify formats the failed banner through unchanged and the succeeded one into
  // this sentence, so both spellings have to be here.
  if (/\*\* (BUILD|TEST|ARCHIVE|CLEAN) SUCCEEDED \*\*/.test(line)
    || /^\s*(Build|Test|Clean|Archive) Succeeded\s*$/.test(line)) return 'success'
  // The beautified forms of the two diagnostics, before their raw spellings: `[x]` and
  // `[!]` are what is left of `error:` and `warning:` once xcbeautify has eaten them.
  if (/^\[x\]\s/.test(line)) return 'error'
  if (/^\[!\]\s/.test(line)) return 'warning'
  if (/\berror:|fatal error:|The following build commands failed|Command .* failed with a nonzero exit code/.test(line)) return 'error'
  if (/\bwarning:/.test(line)) return 'warning'
  if (/^\s*note:/.test(line) || /:\d+(?::\d+)?: note:/.test(line)) return 'note'
  if (TASK_VERBS.test(line)) return 'task'
  if (/^\s*(Test Case|Test Suite|Testing started|Test session)/.test(line)) return 'test'
  if (/^(=== |--- |\$ )/.test(line)) return 'section'
  return 'plain'
}
