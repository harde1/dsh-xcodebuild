// The silent failure this prevents: `device select` accepts an identifier lldb does not know, selects
// nothing, and the attach that follows waits forever.
import { connectedDevices, describeConnectedDevices, parseDeviceList, resolveDeviceId } from '../lib/lldb-devices.js'

let passed = 0, failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(c, label, detail) { if (c) { passed++; console.log(`  ok   ${label}`) } else { failed++; console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`) } }
const eq = (a, b, label) => check(a === b, label, JSON.stringify(a))

// Verbatim from this machine, including the lines that are not devices.
const real = `(lldb) device list
Name                Identifier                            State         Configuration
------------------  ------------------------------------  ------------  -----------------
chuck的iPhone       B7485956-FD06-57E9-ACFD-D6D1E41EF111  connected     iOS 26.6.2 23G90
iPhone app to work  AEDB651E-30D9-5E3F-A930-015355F22C1A  disconnected  iOS 18.3.1 22D72
iPhone (2)          2044E690-2C8C-54C4-B565-4D010094A4AD  unavailable   iOS 26.4.2 23E261
(lldb) quit`

section('the table is read out of lldb\'s own output')
const devices = parseDeviceList(real)
eq(devices.length, 3, 'three devices')
eq(devices[0].name, 'chuck的iPhone', 'a name with non-ASCII characters survives')
eq(devices[0].identifier, 'B7485956-FD06-57E9-ACFD-D6D1E41EF111', 'the CoreDevice identifier')
eq(devices[0].state, 'connected', 'the state')
eq(devices[0].configuration, 'iOS 26.6.2 23G90', 'the configuration keeps its inner space')
eq(parseDeviceList('').length, 0, 'no output, no devices')
eq(parseDeviceList('Name  Identifier  State\n').length, 0, 'the header is not a device')
eq(parseDeviceList('----  ----  ----\n').length, 0, 'the rule is not a device')
eq(parseDeviceList('(lldb) quit').length, 0, 'the prompt is not a device')

section('only connected devices can be attached to')
eq(connectedDevices(devices).length, 1, 'one is connected')
eq(connectedDevices(devices)[0].name, 'chuck的iPhone', 'and it is the one that is plugged in')

section('the hardware UDID is translated to the identifier lldb wants')
eq(resolveDeviceId(devices, { id: '00008110-000078242EBB801E', name: 'chuck的iPhone' }),
  'B7485956-FD06-57E9-ACFD-D6D1E41EF111',
  'the UDID from -showdestinations is not what lldb knows, but the name resolves it')
eq(resolveDeviceId(devices, { id: 'B7485956-FD06-57E9-ACFD-D6D1E41EF111', name: 'chuck的iPhone' }),
  'B7485956-FD06-57E9-ACFD-D6D1E41EF111', 'an identifier lldb already knows is kept')
eq(resolveDeviceId(devices, { id: '', name: 'chuck的iPhone' }), 'B7485956-FD06-57E9-ACFD-D6D1E41EF111',
  'a name alone is enough')
eq(resolveDeviceId(devices, { id: '00008110-000078242EBB801E', name: '' }), '',
  'an unknown identifier with no name to fall back on resolves to nothing')
eq(resolveDeviceId(devices, { id: 'AEDB651E-30D9-5E3F-A930-015355F22C1A', name: 'iPhone app to work' }), '',
  'a device lldb knows but cannot reach is not a target')
eq(resolveDeviceId(devices, { id: '', name: 'not my phone' }), '', 'a name nobody has resolves to nothing')
eq(resolveDeviceId([], { id: 'B7485956-FD06-57E9-ACFD-D6D1E41EF111', name: 'x' }), '',
  'with nothing connected, nothing resolves')

section('and what is available is said plainly')
eq(describeConnectedDevices(devices).includes('chuck的iPhone'), true, 'the connected device is named')
eq(describeConnectedDevices(devices).includes('B7485956'), true, 'with the identifier to use')
eq(describeConnectedDevices([]), 'lldb lists no connected device at all', 'and an empty list says so')

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
console.log('lldb devices OK')
