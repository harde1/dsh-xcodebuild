/**
 * The command that installs an app on an iOS 16 or earlier device.
 *
 * `ideviceinstaller` changed its command line out from under this plugin, and the old
 * spelling is not a deprecated alias. Up to 1.1.x the operation WAS the flag
 * (`ideviceinstaller.c` 1.1.1, `print_usage`: `-i, --install ARCHIVE`); 1.2.0 turned the
 * app operations into COMMANDS and dropped the short options — Homebrew's
 * `ideviceinstaller 1.2.0_1` answers `--help` with:
 *
 * ```console
 * COMMANDS:
 *   list                List installed apps. …
 *   install PATH        Install app from package file specified by PATH.
 *   uninstall BUNDLEID  Uninstall app specified by BUNDLEID.
 *   upgrade PATH        Upgrade app from package file specified by PATH.
 * ```
 *
 * Handed the 1.1.x spelling, 1.2.0 does not fall back to it: `-i` is not in its short
 * options any more, so getopt rejects the line before it looks at the device or at the
 * path, and prints its usage. That usage is what a run then reported as the install's
 * own failure — the device was never touched:
 *
 * ```console
 * $ ideviceinstaller -u d6c2… -i …/蜜语-Dev.app
 * ideviceinstaller: invalid option -- i
 * Usage: ideviceinstaller OPTIONS
 * ```
 *
 * So the shape is read off the tool's own `--help`, which is the CLI contract itself
 * rather than a version number to keep a table of, and only the two shapes are built
 * here. The help is also the only thing that separates them: 1.1.1 prints the same
 * `Usage: ideviceinstaller OPTIONS` first line, so the COMMANDS section — which 1.2.0
 * uniquely has — is what the test keys on.
 *
 * **Why `-u` stays in front of the command.** Both shapes accept it there, which is what
 * lets one argv template build either: 1.2.0 parses `-u` as a global option before the
 * command word (measured — `-u <udid> install <path>` reaches the path check and answers
 * `ERROR: stat: …: No such file or directory`), and 1.1.x has no command word at all.
 *
 * **What this module deliberately does NOT do.** It does not guess from the tool's
 * version string, and it does not decide the shape once for the process. A path is read
 * once by the caller and the answer cached there; the caller also has
 * `installerRejectedCommandLine` as the runtime proof, so a shape this text heuristic
 * did not anticipate still costs one rejected command line rather than a failed run.
 *
 * @module dsh-xcodebuild/legacy-install
 */

/** 1.2.0's install command, as its help prints it: `install PATH` (or a placeholder). */
const SUBCOMMAND_INSTALL = /^[^\S\n]*install[^\S\n]+(?:<[^>\n]+>|PATH|path)\b/m

/** 1.1.x's install flag: `-i, --install ARCHIVE` (the long spelling alone also counts). */
const FLAG_INSTALL = /(?:^|\s)-i,[^\S\n]*--install\b|--install[^\S\n]+(?:<[^>\n]+>|ARCHIVE|archive|app)/m

/**
 * Which command line this `ideviceinstaller` speaks.
 *
 * @param {string} helpText - the tool's own `--help` output, stdout and stderr together.
 * @returns {'commands'|'flags'|null} the shape, or null when the text says neither —
 *   in which case the caller keeps the historical `-i` argv and lets the tool's own
 *   rejection correct it.
 */
export function installerDialect(helpText) {
  const text = String(helpText ?? '')
  if (SUBCOMMAND_INSTALL.test(text)) return 'commands'
  if (FLAG_INSTALL.test(text)) return 'flags'
  return null
}

/**
 * The argv that installs `appPath` on `udid`.
 *
 * Anything other than the measured `commands` shape is built as the flag form, so a
 * machine whose help could not be parsed behaves exactly as this plugin did before
 * 1.2.0 existed.
 *
 * @param {string} installer - path to `ideviceinstaller`.
 * @param {string} udid - device id.
 * @param {string} appPath - the .app (or .ipa/.ipcc) to install.
 * @param {'commands'|'flags'|null} dialect - what `installerDialect` answered.
 * @returns {string[]} argv.
 */
export function legacyInstallArgv(installer, udid, appPath, dialect) {
  const device = ['-u', String(udid)]
  return dialect === 'commands'
    ? [installer, ...device, 'install', String(appPath)]
    : [installer, ...device, '-i', String(appPath)]
}

/**
 * Did the tool reject the command LINE rather than fail at the work?
 *
 * This is the difference the retry rests on. Both shapes answer a command line they do
 * not understand with their usage text and a non-zero exit — 1.2.0 adds
 * `ideviceinstaller: invalid option -- i` from getopt, while 1.1.x given a command word
 * prints `ERROR: No mode/command was supplied.` and the same usage — and in both cases
 * nothing was uploaded, nothing was installed, and no device was even asked. A real
 * install failure never prints the usage; it prints the device's or AFC's own error.
 *
 * @param {string} output - the command's stdout and stderr together.
 * @returns {boolean} true when the command line itself was refused.
 */
export function installerRejectedCommandLine(output) {
  const text = String(output ?? '')
  if (/invalid option/i.test(text)) return true
  return /Usage:\s*ideviceinstaller\b/i.test(text)
}
