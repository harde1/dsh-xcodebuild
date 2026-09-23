// Beautifying `xcodebuild` output with `xcbeautify`, when the machine has it.
//
// The plugin does not ship a formatter and does not require one: `xcbeautify` is used
// when it is installed, and the raw output is shown when it is not. That makes it
// optional in a stronger sense than the device tools — the build works either way, and
// only the reading of it changes.
//
// What lives here is the part that can be pinned by a test: which flags a given
// xcbeautify understands, how the pipeline is described to the user, and the two small
// defences (an escape hatch, and stripping colour codes if they ever arrive).
//
// Everything below was measured against xcbeautify 2.28.0 rather than read off a
// manual, because the flags are not the interesting part — what it does to the lines
// is. See `classify.js` for that half: xcbeautify REWRITES diagnostics, dropping the
// `error:` and `warning:` words it formats into (`…: error: msg` becomes
// `[x] …: msg`), so a classifier that only knows xcodebuild's own vocabulary would
// report a beautified build as having no errors at all.
//
// This module is plain JS with no imports so its exact source can also be embedded in
// the dynamic Cordis host half, where import/require are unavailable.

/**
 * Flags tried in order, each used only when the installed xcbeautify lists it.
 *
 * `--preserve-unbeautified` is the one that must not be dropped: measured, without it
 * xcbeautify SWALLOWS the task lines it recognises (`CompileSwift …` disappears), which
 * would leave the panel's task colouring and its Info filter with nothing to show.
 * `--disable-colored-output` keeps ANSI out of the panel, which colours lines itself,
 * and `--disable-logging` drops the version banner it otherwise prints on startup.
 */
export const BEAUTIFY_FLAGS = ['--preserve-unbeautified', '--disable-colored-output', '--disable-logging']

/**
 * Which of the wanted flags this xcbeautify actually accepts.
 *
 * An older xcbeautify that does not know a flag exits with a usage error instead of
 * building, so the flags are filtered by what `--help` lists rather than assumed.
 *
 * @param {string} helpText - the output of `xcbeautify --help`.
 * @returns {string[]} the supported subset, in the order above.
 */
export function supportedBeautifyFlags(helpText) {
  const text = String(helpText ?? '')
  if (text.trim() === '') return []
  return BEAUTIFY_FLAGS.filter((flag) => text.includes(flag))
}

/**
 * Whether the user has asked for raw output.
 *
 * Installing xcbeautify turns beautifying on, and uninstalling it turns it off — but
 * neither is a way to say "not this time, I want xcodebuild's own text". Setting
 * `DSH_XCODEBUILD_NO_BEAUTIFY` to a true-ish value is.
 *
 * @param {string|undefined} value - the environment variable's value.
 * @returns {boolean} true when beautifying must not be used.
 */
export function beautifyDisabled(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false' && text !== 'no' && text !== 'off'
}

/**
 * Remove ANSI escape sequences from a line.
 *
 * `--disable-colored-output` is passed, but it is a flag of the installed version, and
 * an escape sequence reaching the panel would be both unreadable and — because it sits
 * between `[x]` and the message, or inside the word `error:` — enough to defeat
 * classification. Belt and braces, applied at the one place lines enter the run.
 *
 * @param {string} text - a line, possibly containing escape sequences.
 * @returns {string} the line without them.
 */
export function stripAnsi(text) {
  // CSI/OSC/other escape families, each ended by its final byte. Written out rather
  // than imported, and deliberately not the shortest possible pattern, because this is
  // the kind of regex that is wrong in ways nobody notices until a log looks broken.
  return String(text ?? '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

/**
 * How the piped command is shown in the panel.
 *
 * The panel prints the command it ran, and this one really is a pipeline: showing only
 * `xcodebuild …` would misdescribe what the lines below came from.
 *
 * @param {string[]} argv - the xcodebuild argv.
 * @param {string} tool - the resolved path of the formatter.
 * @param {string[]} flags - the flags being passed.
 * @returns {string} one line naming the whole pipeline.
 */
export function beautifyPipelineLine(argv, tool, flags) {
  const left = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '')
  const right = [String(tool ?? ''), ...(Array.isArray(flags) ? flags : [])].join(' ')
  return `${left} | ${right}`
}
