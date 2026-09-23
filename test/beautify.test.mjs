// Beautifying with `xcbeautify`: the flags, the pipeline, and what it does to the lines.
//
// The interesting half of this is not the flags but the VOCABULARY. Measured against
// xcbeautify 2.28.0, it rewrites diagnostics and drops the words it formatted into:
//
//     /p/App.swift:12:9: error: cannot find 'Foo' in scope  ->  [x] /p/App.swift:12:9: cannot find 'Foo' in scope
//     /p/App.swift:4:2: warning: unused variable 'x'        ->  [!]  /p/App.swift:4:2: unused variable 'x'
//     ** BUILD SUCCEEDED **                                 ->  Build Succeeded
//
// and, without `--preserve-unbeautified`, it swallows the task lines outright. So this
// file runs the real binary where it is installed: the fixtures below are its actual
// output, and the last section asserts that the panel's classifier still reads those
// lines as errors, warnings and tasks.
//
// Run: node test/beautify.test.mjs

import { spawn } from 'node:child_process'
import { classify } from '../lib/classify.js'
import {
  BEAUTIFY_FLAGS,
  beautifyDisabled,
  beautifyPipelineLine,
  stripAnsi,
  supportedBeautifyFlags,
} from '../lib/beautify.js'
import { beautifyTool, formatterAcceptsFlags, resolveTool, spawnStreaming } from '../lib/index.js'

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
}
function eq(actual, expected, label) {
  check(actual === expected, label, `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}
function equal(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
  )
}

console.log('== only the flags this xcbeautify knows ==')
equal(supportedBeautifyFlags('USAGE: xcbeautify [--quiet] [--preserve-unbeautified]'), ['--preserve-unbeautified'],
  'a flag the help lists is passed')
equal(supportedBeautifyFlags('USAGE: xcbeautify [--quiet]'), [], 'a flag it does not list is not')
equal(supportedBeautifyFlags(BEAUTIFY_FLAGS.join(' ')), BEAUTIFY_FLAGS,
  'all three, in order, when all three are known')
equal(supportedBeautifyFlags(''), [], 'no help text, no flags: an unreadable answer must not become a wrong argv')
equal(supportedBeautifyFlags(undefined), [], 'and neither must a missing one')
// An older xcbeautify exits with a usage error on an unknown flag, which would mean no
// build at all, so the filter is the thing standing between the user and a broken build.
equal(supportedBeautifyFlags('USAGE: xcbeautify [--quiet] [--disable-colored-output]'),
  ['--disable-colored-output'], 'a version without --preserve-unbeautified still gets the flags it has')

console.log('== the escape hatch ==')
check(beautifyDisabled('1') && beautifyDisabled('true') && beautifyDisabled('YES') && beautifyDisabled('on'),
  'a true-ish value turns beautifying off')
check(!beautifyDisabled('') && !beautifyDisabled(undefined) && !beautifyDisabled('0')
  && !beautifyDisabled('false') && !beautifyDisabled('off'), 'anything else leaves it on')
check(!beautifyDisabled('  '), 'and so does whitespace, since that is an unset variable with padding')

console.log('== the command line the panel prints ==')
eq(beautifyPipelineLine(['xcodebuild', '-scheme', 'App', 'build'], '/opt/homebrew/bin/xcbeautify', ['--preserve-unbeautified']),
  'xcodebuild -scheme App build | /opt/homebrew/bin/xcbeautify --preserve-unbeautified',
  'the pipeline is shown as the pipeline it is')
eq(beautifyPipelineLine(['xcodebuild'], '/x/xcbeautify', []), 'xcodebuild | /x/xcbeautify',
  'and with no flags when there are none')

console.log('== colour codes never reach the panel ==')
eq(stripAnsi('\u001B[31m[x] /p/App.swift:1:1: boom\u001B[0m'), '[x] /p/App.swift:1:1: boom',
  'an SGR pair is removed, leaving the text inside')
eq(stripAnsi('\u001B[1m\u001B[31merror:\u001B[0m nope'), 'error: nope',
  'including when it wrapped the word the classifier looks for')
eq(stripAnsi('plain text'), 'plain text', 'plain text is untouched')
eq(stripAnsi('trailing \u001B[K'), 'trailing ', 'an erase-in-line is removed')
eq(stripAnsi(undefined), '', 'and a missing line is empty, not the string "undefined"')

// --- the pipeline, through the real formatter -------------------------------
//
// `spawnStreaming` is what the plugin runs a build with, so this drives it exactly as
// `runBuild` does: a producer whose output is piped, and the lines that arrive.

const xcbeautify = resolveTool('xcbeautify')
console.log(`\n== the pipeline ==${xcbeautify === null ? ' (xcbeautify not installed: formatter cases skipped)' : ` (${xcbeautify})`}`)

/** A producer that prints the given lines to stdout with the given exit code. */
function producerArgv(lines, exitCode = 0) {
  const script = `${lines.map((line) => `console.log(${JSON.stringify(line)})`).join(';')};process.exit(${exitCode})`
  return [process.execPath, '-e', script]
}

/** A formatter that is not xcbeautify: uppercases its stdin and exits with `exitCode`. */
function upperFormatter(exitCode = 0) {
  return [process.execPath, '-e', `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(d.toUpperCase());process.exit(${exitCode})})`]
}

section1('a formatter sees the producer\'s stdout and its own lines are what arrive')
{
  const seen = []
  const result = await spawnStreaming(producerArgv(['first line', 'second line']), process.cwd(),
    (line) => seen.push(line), { formatter: upperFormatter() })
  equal(seen, ['FIRST LINE', 'SECOND LINE'], 'the formatter\'s output is what reaches the panel')
  eq(result.exitCode, 0, 'and the exit code is the producer\'s')
}

section1('the exit code is the build\'s, not the formatter\'s')
{
  const seen = []
  const result = await spawnStreaming(producerArgv(['compiling'], 65), process.cwd(),
    (line) => seen.push(line), { formatter: upperFormatter(99) })
  eq(result.exitCode, 65, 'a failing build is a failing build however the formatter exited')
  equal(seen, ['COMPILING'], 'and its output still arrived')
}

section1('a formatter that dies does not take the build with it')
{
  // What is guaranteed when a formatter dies mid-build: the build keeps running, the run
  // still reports the BUILD's exit code, the panel is told the formatting stopped, and
  // everything the build prints from then on is shown raw. What is NOT recoverable is
  // whatever was already piped into the dead process — which is why `beautifyTool` runs
  // the formatter through its exact argv before any build relies on it, and why the
  // preflight below is the real protection rather than this fallback.
  const script = "console.log('early one');setTimeout(()=>{console.log('late two');process.exit(0)},400)"
  const seen = []
  const result = await spawnStreaming([process.execPath, '-e', script], process.cwd(),
    (line) => seen.push(line), { formatter: [process.execPath, '-e', 'process.exit(3)'] })
  check(seen.some((line) => line.includes('showing xcodebuild\'s own output')),
    `the panel is told why it is seeing raw output (${JSON.stringify(seen)})`)
  check(seen.some((line) => line.includes('late two')),
    `output printed after the death arrives (${JSON.stringify(seen)})`)
  eq(result.exitCode, 0, 'and the run reports the build\'s exit code, not the formatter\'s')
}

section1('the formatter is run through its own flags before a build depends on it')
{
  // This is the check that keeps a log formatter from being able to fail a build.
  check(await formatterAcceptsFlags(process.execPath, ['-e', 'process.exit(0)']),
    'a command that exits 0 is accepted')
  check(!await formatterAcceptsFlags(process.execPath, ['-e', 'process.exit(4)']),
    'a command that exits non-zero is not')
  check(!await formatterAcceptsFlags(process.execPath, ['--definitely-not-a-node-flag']),
    'a command that rejects its argv is not')
  check(!await formatterAcceptsFlags('/definitely/not/a/formatter', []), 'a command that is not there is not')
  if (xcbeautify !== null) {
    check(await formatterAcceptsFlags(xcbeautify, BEAUTIFY_FLAGS),
      'and the real xcbeautify accepts exactly the flags this plugin passes it')
  }
}

section1("a formatter's output is streamed, not saved up for the end")
{
  // Measured on xcbeautify: with stdout on a pipe rather than a terminal its own output
  // is BLOCK buffered, so the whole build log arrived at the moment the build ended —
  // no progress and no errors while they mattered. `NSUnbufferedIO` is what fixes it,
  // and this is the check that it is still being passed.
  const script = "let i=0;const t=setInterval(()=>{i+=1;console.log('line '+i);if(i===3){clearInterval(t);setTimeout(()=>process.exit(0),50)}},150)"
  const seen = []
  const started = Date.now()
  await spawnStreaming([process.execPath, '-e', script], process.cwd(), (line) => seen.push(line), {
    formatter: [process.execPath, '-e', "process.stdin.on('data',c=>process.stdout.write(c))"],
  })
  check(seen.length >= 3, `every line arrived (${JSON.stringify(seen)})`)
  check(Date.now() - started < 3000, 'and the run did not stall waiting for output')
}

section1('a formatter that cannot be started is reported, not fatal')
{
  const seen = []
  const result = await spawnStreaming(producerArgv(['still here'], 0), process.cwd(),
    (line) => seen.push(line), { formatter: ['/definitely/not/a/formatter'] })
  check(seen.some((line) => line.includes('still here')), `the output arrives (${JSON.stringify(seen)})`)
  eq(result.exitCode, 0, 'the build succeeded')
}

section1('stderr is passed through, not merged into the formatter')
{
  // xcodebuild writes `xcodebuild: error: …` to stderr; merging it into the formatter's
  // stdin with stdout risks splitting a line across two pipes.
  const seen = []
  const script = "console.log('out');console.error('err: boom');process.exit(0)"
  await spawnStreaming([process.execPath, '-e', script], process.cwd(), (line) => seen.push(line),
    { formatter: upperFormatter() })
  equal(seen.sort(), ['OUT', 'err: boom'], 'stdout went through the formatter, stderr did not')
}

if (xcbeautify !== null) {
  section1('the real xcbeautify, on shape-for-shape input')
  {
    // The exact shapes from the classifier's specification, run through the real binary.
    const raw = [
      'SwiftDriverJobDiscovery normal arm64 Compiling AppDelegate.swift (in target \'Demo\' from project \'Demo\')',
      'CompileSwift normal arm64 /Users/mac/P/AppDelegate.swift',
      '/Users/mac/P/AppDelegate.swift:12:9: error: cannot find \'Foo\' in scope',
      '** BUILD FAILED **',
    ]
    const seen = []
    const result = await spawnStreaming(producerArgv(raw, 65), process.cwd(), (line) => seen.push(line),
      { formatter: [xcbeautify, '--preserve-unbeautified', '--disable-colored-output', '--disable-logging'] })
    const kinds = seen.map((line) => `${classify(line)}:${line}`)
    eq(result.exitCode, 65, 'the build\'s failure is what the run reports')
    check(seen.some((line) => /^\[x\] /.test(line)),
      `the error was beautified into xcbeautify's marker (${JSON.stringify(kinds)})`)
    check(!seen.some((line) => line.includes('\u001B')), 'and no escape sequence came with it')
    check(seen.some((line) => line.includes('CompileSwift normal arm64')),
      `--preserve-unbeautified kept the task line (${JSON.stringify(kinds)})`)
    check(seen.some((line) => classify(line) === 'error'),
      'the panel still reads an error out of the beautified log')
    check(seen.some((line) => classify(line) === 'task'),
      'and still reads a task line out of it')
    check(seen.every((line) => !line.startsWith('-----')), 'the version banner is not in the log')

    // Streaming through the real binary: three lines printed over ~600ms must be visible
    // while the producer is still running, not in one burst at the end.
    const live = []
    const marks = []
    const liveScript = "let i=0;const t=setInterval(()=>{i+=1;console.log('/p/App.swift:'+i+':1: error: problem '+i);if(i===3){clearInterval(t);setTimeout(()=>process.exit(0),50)}},200)"
    const liveStart = Date.now()
    await spawnStreaming([process.execPath, '-e', liveScript], process.cwd(), (line) => {
      if (line.includes('problem')) marks.push(Date.now() - liveStart)
      live.push(line)
    }, { formatter: [xcbeautify, '--preserve-unbeautified', '--disable-colored-output', '--disable-logging'] })
    eq(live.filter((line) => line.includes('problem')).length, 3, 'all three diagnostics came through xcbeautify')
    check(marks.length >= 2 && marks[0] < 800,
      `the first line arrived while the build was still running, not at the end (${JSON.stringify(marks)})`)

    const banner = []
    await spawnStreaming(producerArgv(['** BUILD SUCCEEDED **']), process.cwd(), (line) => banner.push(line),
      { formatter: [xcbeautify, '--disable-logging', '--disable-colored-output'] })
    check(banner.some((line) => classify(line) === 'success'),
      `the succeeded banner is still read as success (${JSON.stringify(banner)})`)

    const warn = []
    await spawnStreaming(producerArgv(['/Users/mac/P/Other.swift:4:2: warning: unused variable \'x\'']), process.cwd(),
      (line) => warn.push(line), { formatter: [xcbeautify, '--disable-logging', '--disable-colored-output'] })
    check(warn.some((line) => classify(line) === 'warning'),
      `a warning is still read as a warning, marked [!] by xcbeautify (${JSON.stringify(warn)})`)
  }
}

section1('the machine decides, and nothing has to be configured')
{
  // The policy the user asked for: if xcbeautify is installed, the log is beautified —
  // and if it is not, nothing breaks and nothing needs setting up.
  process.env.DSH_XCODEBUILD_NO_BEAUTIFY = '1'
  eq(await beautifyTool(), null, 'the escape hatch leaves the formatter unused even when it is installed')
  delete process.env.DSH_XCODEBUILD_NO_BEAUTIFY

  const tool = await beautifyTool()
  if (xcbeautify === null) {
    eq(tool, null, 'with no xcbeautify installed nothing is used, and the build is unaffected')
  } else {
    eq(tool?.path, xcbeautify, 'the installed xcbeautify is the one that gets used')
    check(BEAUTIFY_FLAGS.every((flag) => tool.flags.includes(flag)),
      `with the flags this version accepts (${JSON.stringify(tool.flags)})`)
    check(/\d+\.\d+/.test(tool.version), `and the version it reports is kept (${JSON.stringify(tool.version)})`)
    check(await beautifyTool() === tool, 'and it is probed once, not once per build')
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`\n${checks}/${checks} checks passed`)
console.log('beautify OK')

function section1(title) {
  console.log(`\n== ${title} ==`)
}
