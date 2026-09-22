/**
 * xcodebuild output classification.
 *
 * Every log line gets exactly one kind as it is captured. That kind drives three
 * things at once: the panel's colouring, the severity toggles (Errors /
 * Warnings / Info), and the `errors`/`warningCount` summary a tool result
 * carries. Those are load-bearing, so the rules live here — a dependency-free
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
export function classify(text) {
  const line = String(text)
  if (/\*\* (BUILD|TEST|ARCHIVE|CLEAN) FAILED \*\*/.test(line)) return 'error'
  if (/\*\* (BUILD|TEST|ARCHIVE|CLEAN) SUCCEEDED \*\*/.test(line)) return 'success'
  if (/\berror:|fatal error:|The following build commands failed|Command .* failed with a nonzero exit code/.test(line)) return 'error'
  if (/\bwarning:/.test(line)) return 'warning'
  if (/^\s*note:/.test(line) || /:\d+(?::\d+)?: note:/.test(line)) return 'note'
  if (TASK_VERBS.test(line)) return 'task'
  if (/^\s*(Test Case|Test Suite|Testing started|Test session)/.test(line)) return 'test'
  if (/^(=== |--- |\$ )/.test(line)) return 'section'
  return 'plain'
}
