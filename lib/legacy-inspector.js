/**
 * The LLDB inspector on an iOS 16 and earlier device.
 *
 * CoreDevice (`devicectl`) is the only channel the inspector's device routes go through, and
 * CoreDevice knows iOS 17 and later only. Against an iPhone X on iOS 16.7.12 every one of
 * those routes answers:
 *
 * ```console
 * $ xcrun devicectl device info apps --device d6c2c9dd2da8def539603fe180c1e6c59b277f58
 * ERROR: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000 (0x3E8))
 * ```
 *
 * — about a phone that is plugged in, paired, and answering on the classic channel at that
 * very moment. `devicectl` cannot resolve it by NAME either, so no spelling makes it work.
 * That error blames the phone, so no route which cannot work on this generation is allowed to
 * let it through; `legacyChannelNotice` is what they say instead.
 *
 * # Where the classic attach stands
 *
 * The recipe below is built and tested but NOT yet wired to a route, because every way of
 * getting a port for it was measured on the iPhone X and none of them works with the tooling
 * installed here. Recorded so the next attempt does not repeat them:
 *
 * - **`connect://<udid>` is gone.** `process connect connect://d6c2c9dd…` is refused with
 *   `error: invalid host:port specification`. A current lldb no longer speaks lockdown itself,
 *   so it needs a host:port, which means something must forward one.
 * - **`idevicedebugserverproxy` asks for a service that no longer starts.** It requests
 *   `com.apple.debugserver`, which answers `InvalidService` on this generation. The library
 *   installed here (`libimobiledevice` 1.3.0) does not know
 *   `com.apple.debugserver.DVTSecureSocketProxy` — which is the service `ios-deploy` falls back
 *   to, and the reason `ios-deploy` succeeds on the same device at the same moment. Its bundled
 *   lldb script does `platform select remote-ios` then connects to a forwarded
 *   `connect://127.0.0.1:<port>`.
 * - **`ios-deploy --nolldb` exposes no port**, and its own session cannot be borrowed: it echoes
 *   the forwarded port only in interactive mode, and in that mode it does not forward stdin to
 *   lldb, so it cannot be driven as a command channel either.
 *
 * So what is missing is a lockdownd client that can start the DVT service and forward a local
 * port to it — a newer `libimobiledevice`, or `pymobiledevice3`. `classicAttachCommands` is what
 * to hand that port once it exists, and `deviceSupportSymbolsPath` is where to point `--sysroot`.
 *
 * @module dsh-xcodebuild/legacy-inspector
 */

/** The lldb platform that reaches pre-CoreDevice hardware. */
export const CLASSIC_PLATFORM = 'remote-ios'

/**
 * What a route says when CoreDevice is the wrong channel for this phone.
 *
 * Says the three things that make it actionable: which phone and which iOS, why CoreDevice
 * cannot help, and what does work. Never restates the raw `CoreDeviceError error 1000`, which
 * blames the phone.
 *
 * @param {{name?: string, id?: string, version?: string, what?: string}} spec - the device and
 *   the operation as a subject: `what: 'Listing the running apps'`.
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
 * The SDK root lldb must be pointed at for one device — `--sysroot`, the `/Symbols` included.
 *
 * The suffix is the whole point of this function. `platform select remote-ios` on its own picks
 * an SDK root by itself, and it picked the WRONG device's on the machine this was measured on:
 * the platform came up with `iPhone13,2 18.3.1` while an iPhone X on 16.7.12 was the device
 * being debugged. Loading another device's dyld shared cache is a silent way to read wrong
 * symbols, and it is the bare DeviceSupport directory (which `ios-deploy` passes WITH `/Symbols`
 * and this does not) that invites it. Xcode names the directory exactly as below, which is what
 * makes it derivable rather than something to search for.
 *
 * @param {{root?: string, productType?: string, productVersion?: string, buildVersion?: string}} spec -
 *   the `iOS DeviceSupport` directory, and `ideviceinfo`'s ProductType, ProductVersion and BuildVersion.
 * @returns {string} the path for `--sysroot`, or '' when any part is missing.
 */
export function deviceSupportSymbolsPath({ root = '', productType = '', productVersion = '', buildVersion = '' } = {}) {
  const base = String(root ?? '').replace(/\/+$/, '')
  const type = String(productType ?? '').trim()
  const version = String(productVersion ?? '').trim()
  const build = String(buildVersion ?? '').trim()
  if (base === '' || type === '' || version === '' || build === '') return ''
  return `${base}/${type} ${version} (${build})/Symbols`
}

/**
 * The argv that raises a debugserver on the device and forwards a local port to it.
 *
 * `idevicedebugserverproxy` owns the whole classic sequence — it starts the device's debugserver
 * over lockdown when a client connects and relays the GDB remote protocol to `127.0.0.1:<port>`.
 * That forwarding is NOT optional on a current Xcode: lldb refuses `connect://<udid>` outright,
 * so a host:port is the only thing that can be handed to `process connect`.
 *
 * Only the SERVICE NAME it asks for is the problem, and that lives in libimobiledevice, not in
 * this argv: as of 1.3.0 it asks for `com.apple.debugserver`, which answers `InvalidService` on
 * this generation. Verify the service it starts before trusting a successful run of this.
 *
 * @param {{proxy: string, udid: string, port: number}} spec - the resolved proxy tool, the
 *   hardware udid, and the local port to listen on.
 * @returns {string[]} argv for `idevicedebugserverproxy`.
 */
export function debugserverProxyArgv({ proxy, udid, port }) {
  return [proxy, '-u', udid, String(port)]
}

/**
 * The lldb commands that attach to an app on a pre-CoreDevice device.
 *
 * Order matters and mirrors the script ios-deploy embeds: the platform is selected with this
 * device's own sysroot, the app bundle is made the target so its symbols exist, and only then is
 * the tunnel connected. `process connect` leaves lldb sitting at a debugserver with nothing
 * loaded, so the attach is what actually names the process.
 *
 * @param {{appPath?: string, port: number, process?: string, symbolsPath?: string}} spec - the
 *   local app bundle, the forwarded port, the process name, and the device's SDK root
 *   (`deviceSupportSymbolsPath`).
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
