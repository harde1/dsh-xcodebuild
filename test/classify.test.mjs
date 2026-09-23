// Tests for the xcodebuild log classifier.
//
// The classifier is not cosmetic. One kind per line drives three visible things:
// the panel's colouring, the Errors/Warnings/Info filter groups, and the
// `errors` / `warningCount` summary that a tool result reports to the model. A
// rule that quietly stops matching would make a failed build look clean, which
// is the single most expensive way this plugin could be wrong — so the cases
// below are written against real xcodebuild output, not invented strings.
//
// Run: node test/classify.test.mjs

import { KINDS, classify } from '../lib/classify.js'

let failures = 0
let checks = 0

/**
 * Assert one line's kind.
 * @param {string} line - raw output line.
 * @param {string} expected - expected kind.
 */
function expectKind(line, expected) {
  checks += 1
  const actual = classify(line)
  // Every case below also pins the vocabulary itself: a kind the classifier can produce
  // but `KINDS` does not list is a kind the panel has no toggle for.
  if (!KINDS.includes(actual)) {
    failures += 1
    console.error(`FAIL classify(${JSON.stringify(line)}) returned ${JSON.stringify(actual)}, which is not in KINDS`)
    return
  }
  if (actual !== expected) {
    failures += 1
    console.error(`FAIL classify(${JSON.stringify(line)})\n  actual:   ${actual}\n  expected: ${expected}`)
  }
}

// --- build banners win outright ------------------------------------------
expectKind('** BUILD SUCCEEDED **', 'success')
expectKind('** BUILD FAILED **', 'error')
expectKind('** TEST FAILED **', 'error')
expectKind('** ARCHIVE SUCCEEDED **', 'success')
expectKind('** CLEAN SUCCEEDED **', 'success')

// --- a failed build must never be summarised as anything else ------------
expectKind('The following build commands failed:', 'error')
expectKind('Command PhaseScriptExecution failed with a nonzero exit code', 'error')

// --- compiler diagnostics -------------------------------------------------
expectKind(
  '/Users/mac/Project/Gemoy/Gemoy/Controller/GMPhoneLoginController.swift:34:26: warning: unrecognized platform name \'iOS14\'',
  'warning',
)
expectKind(
  '/Users/mac/Project/Gemoy/Gemoy/AppDelegate.swift:12:9: error: cannot find \'Foo\' in scope',
  'error',
)
expectKind('<unknown>:0: error: fatal error: module \'X\' not found', 'error')
expectKind('    note: candidate has non-matching type', 'note')

// A line carrying both an error and a warning is an error: ordering matters.
expectKind('foo.swift:1:1: error: bad; foo.swift:2:2: warning: also bad', 'error')

// `note:` anchored at line start only — mid-sentence prose is not a note.
expectKind('See the note: this is prose inside a script', 'plain')
expectKind('/path/file.swift:3:1: note: attached to a diagnostic', 'note')

// --- progress verbs -------------------------------------------------------
expectKind('CompileSwift normal arm64 /Users/mac/Project/Gemoy/AppDelegate.swift', 'task')
expectKind('    CompileC /path/to/Thing.o /path/to/Thing.m normal arm64 objective-c', 'task')
expectKind('Ld /Users/mac/Library/Developer/Xcode/DerivedData/Gemoy.app/Gemoy normal', 'task')
expectKind('CodeSign /Users/mac/Library/Developer/Xcode/DerivedData/Gemoy.app', 'task')
expectKind('PhaseScriptExecution [CP] Check Pods Manifest.lock /path/script.sh', 'task')

// A compiler message that merely mentions a filename is not progress.
expectKind('SomeTool output: CompileSwift failed to start', 'plain')

// --- tests ----------------------------------------------------------------
expectKind('Test Case \'-[GemoyTests testExample]\' passed (0.001 seconds).', 'test')
expectKind('Test Suite \'GemoyTests\' started at 2026-01-01', 'test')
expectKind('Testing started on \'iPhone 17 Pro\'', 'test')

// --- sections and the command echo ---------------------------------------
expectKind('$ xcodebuild -workspace Gemoy.xcworkspace -scheme Gemoy build', 'section')
expectKind('=== CLEAN TARGET Gemoy OF PROJECT Gemoy ===', 'section')
expectKind('--- xcodebuild: WARNING: Using the first of multiple matching destinations', 'section')

// --- what xcbeautify leaves behind ---------------------------------------
//
// Measured against xcbeautify 2.28.0, which is what the panel's log is piped through
// when the machine has it: it eats the words `error:` and `warning:` and rewrites the
// banner. A classifier that could not read these would leave a beautified log with
// nothing marked at all — worse than an ugly one.
expectKind("[x] /p/App.swift:12:9: cannot find 'Foo' in scope", 'error')
expectKind("[!]  /p/App.swift:4:2: unused variable 'x'", 'warning')
expectKind("[x] /p/Other.swift:1:1: use of unresolved identifier 'Bar'", 'error')
expectKind('Build Succeeded', 'success')
expectKind('Clean Succeeded', 'success')
expectKind('Archive Succeeded', 'success')
expectKind('Test Succeeded', 'success')
// The marker is anchored to the start of the line and is not just a bracket: a beautified
// log still contains raw lines, and xcodebuild prints bracketed text of its own. Both of
// these are neither an error nor a warning, which is the point.
expectKind('[1/12] Compiling App.swift', 'plain')
expectKind('    [!] note: this is not a marker, it is indented text', 'plain')

// --- plain ----------------------------------------------------------------
expectKind('', 'plain')
expectKind('note the missing colon', 'plain')
expectKind('Total build time: 45.2s', 'plain')

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('classifier OK')
