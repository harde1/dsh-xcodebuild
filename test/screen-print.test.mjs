// A screen's fingerprint decides whether a view tree read earlier can be shown again without stopping
// the app. These are the rules it has to keep: read the BMP `sips` writes, ignore the status bar and
// home indicator, and call a screen the same only when most of it is.
import { readFileSync } from 'node:fs'
import { CELL_TOLERANCE, SAME_SCREEN, compareScreens, parseBmpBrightness, screenVerdict } from '../lib/screen-print.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n# ${name}`)
function check(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n  actual:   ${detail}`}`)
  }
}
const eq = (actual, expected, label) => check(actual === expected, label, JSON.stringify(actual))

/** A 24-bit BMP, bottom row first (positive height) unless `topDown`, filled by `paint(x, y)`. */
function bmp(width, height, paint, topDown = false) {
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = Buffer.alloc(54 + stride * height)
  bytes.write('BM', 0, 'latin1')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(topDown ? -height : height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = paint(x, y)
      bytes[row + x * 3] = blue
      bytes[row + x * 3 + 1] = green
      bytes[row + x * 3 + 2] = red
    }
  }
  return bytes
}

section('reads the BMP sips writes from a real simulator capture')
{
  const grid = parseBmpBrightness(readFileSync(new URL('./fixtures/screen-16x32.bmp', import.meta.url)))
  check(grid !== null, 'the fixture parses')
  eq(grid?.width, 16, '16 columns')
  eq(grid?.height, 32, '32 rows')
  eq(grid?.cells.length, 512, 'one brightness per cell')
  check(grid !== null && grid.cells.every((value) => value >= 0 && value <= 255), 'each a brightness 0–255')
  eq(compareScreens(grid, grid)?.similarity, 1, 'and a screen is entirely the same as itself')
}

section('row order: bottom-up and top-down files read the same picture')
{
  const paint = (x, y) => (y === 0 ? [255, 255, 255] : [0, 0, 0])
  const up = parseBmpBrightness(bmp(4, 6, paint))
  const down = parseBmpBrightness(bmp(4, 6, paint, true))
  eq(up?.cells[0], 255, 'a bottom-up file puts its top row first')
  eq(down?.cells[0], 255, 'and so does a top-down one')
  eq(up?.cells[4], 0, 'with the rows below it after')
}

section('not a BMP this can read')
eq(parseBmpBrightness(Buffer.from('not an image')), null, 'arbitrary bytes are refused')
eq(parseBmpBrightness(Buffer.alloc(60)), null, 'and a file without the BM magic')

section('comparing: the status bar and home indicator do not count')
{
  const base = parseBmpBrightness(bmp(16, 32, () => [200, 200, 200]))
  const clock = parseBmpBrightness(bmp(16, 32, (x, y) => (y === 0 || y === 31 ? [10, 10, 10] : [200, 200, 200])))
  eq(compareScreens(base, clock)?.similarity, 1, 'a changed top and bottom row leave the screen the same')
  eq(compareScreens(base, clock)?.compared, 16 * 30, 'and only the rows between are compared')
}

section('comparing: small shifts in brightness are noise, a real change is not')
{
  const base = parseBmpBrightness(bmp(16, 32, () => [120, 120, 120]))
  const nudged = parseBmpBrightness(bmp(16, 32, () => [120 + CELL_TOLERANCE - 2, 120 + CELL_TOLERANCE - 2, 120 + CELL_TOLERANCE - 2]))
  eq(compareScreens(base, nudged)?.changed, 0, 'a shift inside the tolerance is not a change')
  // The top half of the app area goes dark: a sheet, a new page, a keyboard from above.
  const covered = parseBmpBrightness(bmp(16, 32, (x, y) => (y >= 1 && y < 16 ? [0, 0, 0] : [120, 120, 120])))
  const half = compareScreens(base, covered)
  eq(half?.changed, 16 * 15, 'every cell that went dark is counted')
  check(half !== null && Math.abs(half.similarity - 0.5) < 1e-9, 'so half the app area is the same', half?.similarity)
  eq(screenVerdict(half), 'changed', 'which is under the threshold: the tree is stale')
  eq(JSON.stringify(half?.rows.slice(0, 3)), '[1,2,3]', 'and it says which rows changed')
}

section('the verdict')
{
  const base = parseBmpBrightness(bmp(16, 32, () => [120, 120, 120]))
  // A third of the app area changes: a list scrolled a little, a badge, a toast.
  const some = parseBmpBrightness(bmp(16, 32, (x, y) => (y >= 1 && y < 11 ? [255, 255, 255] : [120, 120, 120])))
  const result = compareScreens(base, some)
  check(result !== null && result.similarity >= SAME_SCREEN, `a screen ${String(Math.round((result?.similarity ?? 0) * 100))}% the same is over ${String(SAME_SCREEN * 100)}%`)
  eq(screenVerdict(result), 'same', 'and is reused')
  eq(screenVerdict(null), 'unknown', 'no comparison is no verdict')
  const rotated = parseBmpBrightness(bmp(32, 16, () => [120, 120, 120]))
  eq(compareScreens(base, rotated), null, 'a grid of another shape (a rotation) is not compared')
}

console.log(`\n${String(passed)}/${String(passed + failed)} checks passed`)
if (failed > 0) process.exit(1)
