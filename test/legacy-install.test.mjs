// How this plugin installs onto an iOS 16 or earlier device.
//
// The failure this file exists for, reported from a real run against an iPhone with
// Homebrew's `ideviceinstaller 1.2.0_1`:
//
//   $ ideviceinstaller -u d6c2… -i …/蜜语-Dev.app
//   ideviceinstaller: invalid option -- i
//   Usage: ideviceinstaller OPTIONS
//
// A correct build, a correct app path, and a run reported as a failed install — because
// 1.2.0 moved installing from the flag `-i` to the command `install <app>` and does not
// alias the old spelling. The help text below is the contract each version prints, and
// the argv is built from it rather than from a spelling that happened to be right.
//
// The two help texts are not invented. The 1.2.0 one is this machine's own
// `ideviceinstaller --help`; the 1.1.x one is `print_usage` from
// libimobiledevice/ideviceinstaller 1.1.1 (`src/ideviceinstaller.c`), whose OPTIONS
// section is what the old `-i, --install ARCHIVE` came from.
//
// Run: node test/legacy-install.test.mjs

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installerDialect, installerRejectedCommandLine, legacyInstallArgv } from '../lib/legacy-install.js'
import { resolveTool } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `actual: ${JSON.stringify(actual)} expected: ${JSON.stringify(expected)}`,
  )
}

// --- the two help texts, as the tools print them ---------------------------

/** Homebrew `ideviceinstaller 1.2.0_1 --help`, captured on this machine. */
const HELP_1_2_0 = `Usage: ideviceinstaller OPTIONS

Manage apps on iOS devices.

COMMANDS:
  list                List installed apps. Options:
        --user          List user apps only (this is the default)
        --system        List system apps only
        --all           List all types of apps
        --xml           Print output as XML Property List
        -a, --attribute ATTR  Specify attribute to return - see man page
            (can be passed multiple times)
        -b, --bundle-identifier BUNDLEID  Only query given bundle identifier
            (can be passed multiple times)
  install PATH        Install app from package file specified by PATH.
                      PATH can also be a .ipcc file for carrier bundles.
        -s, --sinf PATH  Pass an external SINF file
        -m, --metadata PATH  Pass an external iTunesMetadata file
  uninstall BUNDLEID  Uninstall app specified by BUNDLEID.
  upgrade PATH        Upgrade app from package file specified by PATH.

LEGACY COMMANDS (non-functional with iOS 7 or later):
  archive BUNDLEID    Archive app specified by BUNDLEID. Options:
        --uninstall     Uninstall the package after making an archive
        --app-only      Archive application data only
        --docs-only     Archive documents (user data) only
        --copy=PATH     Copy the app archive to directory PATH when done
        --remove        Only valid when copy=PATH is used: remove after copy
  restore BUNDLEID    Restore archived app specified by BUNDLEID
  list-archives       List archived apps. Options:
        --xml           Print output as XML Property List
  remove-archive BUNDLEID    Remove app archive specified by BUNDLEID

OPTIONS:
  -u, --udid UDID     Target specific device by UDID
  -n, --network       Connect to network device
  -w, --notify-wait   Wait for app installed/uninstalled notification
                      before reporting success of operation
  -h, --help          Print usage information
  -d, --debug         Enable communication debugging
  -v, --version       Print version information

Homepage:    <https://libimobiledevice.org>
Bug Reports: <https://github.com/libimobiledevice/ideviceinstaller/issues>
`

/** `ideviceinstaller` 1.1.1 `print_usage`, where installing was still a flag. */
const HELP_1_1_1 = `Usage: ideviceinstaller OPTIONS

Manage apps on iOS devices.

OPTIONS:
  -u, --udid UDID\tTarget specific device by UDID.
  -n, --network\t\tConnect to network device.
  -l, --list-apps\tList apps, possible options:
       -o list_user\t- list user apps only (this is the default)
       -o list_system\t- list system apps only
       -o list_all\t- list all types of apps
       -o xml\t\t- print full output as xml plist
  -i, --install ARCHIVE\tInstall app from package file specified by ARCHIVE.
                       \tARCHIVE can also be a .ipcc file for carrier bundles.
  -U, --uninstall APPID\tUninstall app specified by APPID.
  -g, --upgrade ARCHIVE\tUpgrade app from package file specified by ARCHIVE.
  -L, --list-archives\tList archived applications, possible options:
       -o xml\t\t- print full output as xml plist
  -a, --archive APPID\tArchive app specified by APPID, possible options:
       -o uninstall\t- uninstall the package after making an archive
       -o app_only\t- archive application data only
       -o docs_only\t- archive documents (user data) only
       -o copy=PATH\t- copy the app archive to directory PATH when done
       -o remove\t- only valid when copy=PATH is used: remove after copy
  -r, --restore APPID\tRestore archived app specified by APPID
  -R, --remove-archive APPID  Remove app archive specified by APPID
  -o, --options\t\tPass additional options to the specified command.
  -w, --notify-wait\t\tWait for app installed/uninstalled notification
                    \t\tto before reporting success of operation
  -h, --help\t\tprints usage information
  -d, --debug\t\tenable communication debugging
  -v, --version\t\tprint version information

Homepage:    <https://libimobiledevice.org>
Bug Reports: <https://github.com/libimobiledevice/ideviceinstaller/issues>
`

// --- what each version's help says the shape is ----------------------------

console.log('== reading the shape off the help ==')
eq(installerDialect(HELP_1_2_0), 'commands', '1.2.0 installs with the `install` command')
eq(installerDialect(HELP_1_1_1), 'flags', '1.1.x installs with `-i`')
// The first line is identical in both, so this is exactly the trap: a reader keying on
// `Usage: ideviceinstaller OPTIONS` cannot tell them apart.
check(HELP_1_2_0.split('\n')[0] === HELP_1_1_1.split('\n')[0],
  'both versions print the same first line, which is why the OPTIONS/COMMANDS body decides')
check(HELP_1_1_1.includes('-i, --install ARCHIVE'), 'the 1.1.x text really is the flag form')
check(!HELP_1_2_0.includes('--install'), '1.2.0 has dropped the long install flag entirely')

eq(installerDialect(''), null, 'an empty help is not a verdict')
eq(installerDialect(undefined), null, 'a missing help is not a verdict')
eq(installerDialect('Usage: idevice_id [OPTIONS]'), null, 'another tool\'s help is not a verdict')
eq(installerDialect('ideviceinstaller: command not found'), null, 'a shell error is not a verdict')

// --- the argv each shape needs ---------------------------------------------

console.log('\n== the argv ==')
const APPPATH = '/Users/mac/Library/Developer/Xcode/DerivedData/Enshi-…/蜜语-Dev.app'
eq(
  legacyInstallArgv('/opt/homebrew/bin/ideviceinstaller', 'd6c2c9dd', APPPATH, 'commands'),
  ['/opt/homebrew/bin/ideviceinstaller', '-u', 'd6c2c9dd', 'install', APPPATH],
  '1.2.0 gets `-u <udid> install <app>` and the app path is passed through untouched',
)
eq(
  legacyInstallArgv('/opt/homebrew/bin/ideviceinstaller', 'd6c2c9dd', APPPATH, 'flags'),
  ['/opt/homebrew/bin/ideviceinstaller', '-u', 'd6c2c9dd', '-i', APPPATH],
  '1.1.x keeps `-u <udid> -i <app>`',
)
// `-u` in front of the command word is what lets one template build either shape; it was
// measured against 1.2.0 (`-u <udid> install <path>` reaches the path check).
eq(
  legacyInstallArgv('ideviceinstaller', 'U', 'A', 'commands').slice(1, 3),
  legacyInstallArgv('ideviceinstaller', 'U', 'A', 'flags').slice(1, 3),
  'both shapes carry -u <udid> in the same place',
)
eq(
  legacyInstallArgv('ideviceinstaller', 'U', 'A', null),
  legacyInstallArgv('ideviceinstaller', 'U', 'A', 'flags'),
  'an unreadable help falls back to the historical flag form',
)

// --- being told the command line itself was refused -------------------------

console.log('\n== what a refusal looks like ==')
// Measured on this machine: 1.2.0 given `-i`, exit 2, both streams together.
const REFUSED_1_2_0 = 'ideviceinstaller: invalid option -- i\nUsage: ideviceinstaller OPTIONS\n'
check(installerRejectedCommandLine(REFUSED_1_2_0),
  '1.2.0\'s `invalid option -- i` is a refused command line')
// What 1.1.x prints when handed a command word it does not know: no mode, then usage.
const REFUSED_1_1_1 = 'ERROR: No mode/command was supplied.\nUsage: ideviceinstaller OPTIONS\n'
check(installerRejectedCommandLine(REFUSED_1_1_1),
  '1.1.x\'s "No mode/command was supplied" plus usage is a refused command line')

// And what is NOT a refusal: the tool understood the line and went on to do the work.
// These are the outputs a retry must never be triggered by.
check(!installerRejectedCommandLine('No device found with udid 0000dshprobe0000.\n'),
  'a missing device is not a refused command line')
check(!installerRejectedCommandLine('ERROR: stat: /tmp/nope.app: No such file or directory\n'),
  'a missing app is not a refused command line')
check(!installerRejectedCommandLine(
  'Installing \'com.example.app\'\nERROR: Install failed. Got error "ApplicationVerificationFailed" with code 0xE8008015.\n'),
'a signing failure is not a refused command line')
check(!installerRejectedCommandLine(''),
  'silence is not a refused command line')

// --- the source builds no literal install argv any more ---------------------

console.log('\n== the source ==')
check(SOURCE.includes('legacyInstallArgv(installer, udid, appPath, dialect)'),
  'the legacy install site builds its argv from the helper')
check(!SOURCE.includes("[installer, '-u', udid, '-i', appPath]"),
  'and the hardcoded `-i` argv that broke 1.2.0 is gone from the source')
check(!/'-u',\s*udid,\s*'-i'/.test(SOURCE),
  'no other place in the source spells an install as a bare flag either')

// --- the tool actually installed here --------------------------------------
//
// The texts above are fixtures, so the one thing they cannot prove is that the argv built
// for the tool ON THIS MACHINE is accepted by it. Both halves are asked without touching
// a device or installing anything: `--help` for the shape, and the built argv with a
// device that does not exist and a path that does not exist — which fails at the first
// thing it looks at, and must not fail as an unparsed command line.

function run(argv, timeoutMs = 20000) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveRun({ exitCode: -1, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ exitCode: -1, stdout, stderr: stderr + String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

const installer = resolveTool('ideviceinstaller')
if (installer === null) {
  console.log('\n== the installed tool ==\n  ideviceinstaller is not installed here; the fixtures above are the whole check')
} else {
  console.log(`\n== the installed tool (${installer}) ==`)
  const help = await run([installer, '--help'])
  const dialect = installerDialect(help.stdout + help.stderr)
  check(dialect !== null, 'this machine\'s ideviceinstaller prints a help this module understands',
    (help.stdout + help.stderr).slice(0, 200))
  const argv = legacyInstallArgv(installer, 'dsh-xcodebuild-probe-no-such-device', '/dsh-xcodebuild-probe/no-such.app', dialect)
  const probe = await run(argv)
  const output = probe.stdout + probe.stderr
  check(!installerRejectedCommandLine(output),
    `the argv built for this ${dialect} tool is not refused as a command line`,
    output.slice(0, 200))
  check(/No device found|stat:|No such file/i.test(output),
    'and it fails on the probe\'s missing device or path instead, which means the line parsed', output.slice(0, 200))
  console.log(`  ${dialect}: ${argv.slice(argv.indexOf('-u'), argv.indexOf('-u') + 3).join(' ')} …  → ${output.split('\n')[0]}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
console.log('legacy-install OK')
