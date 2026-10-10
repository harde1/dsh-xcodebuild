/**
 * The LLDB inspector on an iOS 16 and earlier device.
 *
 * CoreDevice (`devicectl`) is the only thing the inspector's device routes go through,
 * and CoreDevice knows iOS 17 and later only. Against an iPhone X on iOS 16.7.12 every
 * one of those routes answers:
 *
 * ```console
 * $ xcrun devicectl device info apps --device d6c2c9dd2da8def539603fe180c1e6c59b277f58
 * ERROR: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000 (0x3E8))
 * ```
 *
 * — about a phone that is plugged in, paired, and answering on the classic channel at
 * that very moment. `devicectl` cannot even resolve it by NAME, so there is no spelling
 * that makes it work. The error names the phone as missing, which is the opposite of the
 * truth, and a route that cannot work on this generation must never let it through.
 *
 * Two halves of the answer live here. `legacyChannelNotice` is what to say instead of
 * that error. `classicAttachCommands` is what the classic debug session actually is.
 *
 * **The recipe is not invented here.** `ios-deploy` embeds the command script it drives
 * lldb with, and it is the only thing measured to debug this generation from a current
 * Xcode:
 *
 * ```text
 * platform select remote-'{platform}' --sysroot '{symbols_path}'
 * target create "{disk_app}"
 * script fruitstrap_connect_url="connect://127.0.0.1:{device_port}"
 * ```
 *
 * The device is named on this channel by its HARDWARE UDID and by nothing else — which
 * is the one name the destination already carries, and the one name `device select`
 * refuses. That is why the classic channel is reachable at all when the CoreDevice one
 * is not, and why the two names never had to be translated to use it.
 *
 * @module dsh-xcodebuild/legacy-inspector
 */

/** The lldb platform that reaches pre-CoreDevice hardware. */
export const CLASSIC_PLATFORM = 'remote-ios'

/**
 * What a route says when CoreDevice is the wrong channel for this phone.
 *
 * Says the three things that make it actionable: which phone and which iOS, why
 * CoreDevice cannot help, and what does work. Never restates the raw
 * `CoreDeviceError error 1000`, which blames the phone.
 *
 * @param {{name?: string, id?: string, version?: string, what?: string}} spec - the device
 *   and the operation, as a subject: `what: 'Listing the running apps'`.
 * @returns {string} one paragraph, ending with what to do.
 */
export function legacyChannelNotice({ name = '', id = '', version = '', what = 'This' } = {}) {
  const phone = String(name ?? '').trim() === ''
    ? (String(id ?? '').trim() === '' ? 'this device' : String(id).trim())
    : `${name} (${id})`
  const ios = String(version ?? '').trim() === ''
    ? 'an iOS 16 or earlier device'
    : `an iOS ${String(version).trim()} device`
  return `${what} needs CoreDevice, and ${phone} is ${ios}: CoreDevice reaches iOS 17 and later only, `
    + 'so every `devicectl` route reports it as a device that was not found. The classic USB/lockdown '
    + 'channel does reach this phone — building, running and the device log all use it — so debug this '
    + 'generation from Xcode, or use a device on iOS 17 or later.'
}

/**
 * The SDK root lldb must be pointed at for one device.
 *
 * `platform select remote-ios` on its own picks an SDK root by itself, and it picked the
 * WRONG device's on the machine this was measured on: the platform came up with
 * `iPhone13,2 18.3.1` while an iPhone X on 16.7.12 was the device being debugged. Loading
 * another device's dyld shared cache is a silent way to read wrong symbols, so the root
 * for this device's own model, version and build is named explicitly — `--sysroot`.
 *
 * Xcode names the directory exactly this way, which is what makes it derivable rather
 * than something to search for.
 *
 * @param {{productType?: string, productVersion?: string, buildVersion?: string}} spec -
 *   `ideviceinfo`'s ProductType, ProductVersion and BuildVersion.
 * @returns {string} the directory name, or '' when any part is missing.
 */
export function deviceSupportDirName({ productType = '', productVersion = '', buildVersion = '' } = {}) {
  const type = String(productType ?? '').trim()
  const version = String(productVersion ?? '').trim()
  const build = String(buildVersion ?? '').trim()
  if (type === '' || version === '' || build === '') return ''
  return `${type} ${version} (${build})`
}

/**
 * The argv that raises a debugserver on the device and forwards a local port to it.
 *
 * `idevicedebugserverproxy` owns the whole classic sequence — it starts
 * `com.apple.debugserver` over lockdown when a client connects and relays the GDB remote
 * protocol to `127.0.0.1:<port>`. That forwarding is NOT optional on a current Xcode:
 * lldb no longer speaks lockdown itself, and `connect://<udid>` is refused outright with
 *
 * ```text
 * error: invalid host:port specification: 'd6c2c9dd...'
 * ```
 *
 * so a host:port is the only thing that can be handed to `process connect`.
 *
 * @param {{proxy: string, udid: string, port: number}} spec - the resolved proxy tool,
 *   the hardware udid, and the local port to listen on.
 * @returns {string[]} argv for `idevicedebugserverproxy`.
 */
export function debugserverProxyArgv({ proxy, udid, port }) {
  return [proxy, '-u', udid, String(port)]
}

/**
 * The lldb commands that attach to an app on a pre-CoreDevice device.
 *
 * Order matters and mirrors the script ios-deploy embeds: the platform is selected with
 * this device's own sysroot, the app bundle is made the target so its symbols exist, and
 * only then is the tunnel connected. `process connect` leaves lldb sitting at a debugserver
 * with nothing loaded, so the attach is what actually names the process.
 *
 * @param {{appPath?: string, port: number, process?: string, symbolsPath?: string}} spec -
 *   the local app bundle, the forwarded port, the process name, and the device's SDK root.
 * @returns {string[]} lldb commands, in order.
 */
export function classicAttachCommands({ appPath = '', port, process = '', symbolsPath = '' } = {}) {
  const commands = [
    symbolsPath === ''
      ? `platform select ${CLASSIC_PLATFORM}`
      : `platform select ${CLASSIC_PLATFORM} --sysroot "${symbolsPath}"`,
  ]
  if (String(appPath).trim() !== '') commands.push(`target create "${appPath}"`)
  commands.push(`process connect connect://127.0.0.1:${String(port)}`)
  const name = String(process ?? '').trim()
  if (name !== '') commands.push(`process attach --name "${name}"`)
  return commands
}
