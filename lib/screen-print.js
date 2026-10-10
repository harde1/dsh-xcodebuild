/**
 * A screen's fingerprint, for deciding whether a view tree read earlier still describes the app.
 *
 * Reading the tree stops the app; looking at its screen does not. So a capture is shrunk to a grid
 * of 16×32 cells, each its average brightness, and two grids are compared cell by cell: the share
 * of cells that kept their brightness is how much of the screen is the same. Over the threshold the
 * old tree is reused; under it the tree is marked stale and read again only when asked.
 *
 * Deliberately coarse. A false "changed" costs one read, which is what would have happened without
 * this; a false "same" is the risk, and it is bounded by the share the threshold allows. Nothing here
 * proves an address is still alive — a same-looking screen can hold different objects.
 *
 * The top and bottom rows are dropped before comparing: the status bar's clock and battery and the
 * home indicator change on their own and say nothing about the app.
 */

export const PRINT_COLUMNS = 16
export const PRINT_ROWS = 32
/** A cell whose brightness moved by more than this (of 255) counts as changed. */
export const CELL_TOLERANCE = 12
/** At or above this share of unchanged cells, a cached tree is reused. */
export const SAME_SCREEN = 0.6

/**
 * Brightness grid from an uncompressed 24- or 32-bit BMP, as `sips -s format bmp` writes it.
 *
 * @param {Buffer} bytes - the BMP file.
 * @returns {{width: number, height: number, cells: number[]} | null} row-major brightness 0–255,
 *   top row first; null when the file is not a BMP this can read.
 */
export function parseBmpBrightness(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54 || bytes.toString('latin1', 0, 2) !== 'BM') return null
  const offset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const bits = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  if (width <= 0 || rawHeight === 0 || (bits !== 24 && bits !== 32) || (compression !== 0 && compression !== 3)) return null
  const height = Math.abs(rawHeight)
  // A positive height is stored bottom row first; `sips` writes a negative one, top row first.
  const topDown = rawHeight < 0
  const step = bits / 8
  const stride = Math.ceil((width * step) / 4) * 4
  if (offset + stride * height > bytes.length) return null
  const cells = new Array(width * height)
  for (let row = 0; row < height; row += 1) {
    const at = offset + (topDown ? row : height - 1 - row) * stride
    for (let column = 0; column < width; column += 1) {
      const pixel = at + column * step
      // BGR order; Rec. 601 luma, the usual weighting for "how bright does this look".
      const blue = bytes[pixel]
      const green = bytes[pixel + 1]
      const red = bytes[pixel + 2]
      cells[row * width + column] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue)
    }
  }
  return { width, height, cells }
}

/**
 * How much of two screens is the same, from their grids.
 *
 * @param {{width: number, height: number, cells: number[]}} before
 * @param {{width: number, height: number, cells: number[]}} after
 * @param {{tolerance?: number, skipTop?: number, skipBottom?: number}} [options]
 * @returns {{similarity: number, changed: number, compared: number, rows: number[]} | null} the share
 *   of unchanged cells, how many changed out of how many compared, and which grid rows changed (so a
 *   caller can say where); null when the two grids are not the same shape (a rotation, another device).
 */
export function compareScreens(before, after, options = {}) {
  if (before === null || after === null || before === undefined || after === undefined) return null
  if (before.width !== after.width || before.height !== after.height) return null
  const tolerance = options.tolerance ?? CELL_TOLERANCE
  const skipTop = options.skipTop ?? 1
  const skipBottom = options.skipBottom ?? 1
  let changed = 0
  let compared = 0
  const rows = new Set()
  for (let row = skipTop; row < before.height - skipBottom; row += 1) {
    for (let column = 0; column < before.width; column += 1) {
      const index = row * before.width + column
      compared += 1
      if (Math.abs(before.cells[index] - after.cells[index]) > tolerance) {
        changed += 1
        rows.add(row)
      }
    }
  }
  if (compared === 0) return null
  return { similarity: (compared - changed) / compared, changed, compared, rows: [...rows].sort((a, b) => a - b) }
}

/**
 * The verdict a caller acts on.
 *
 * @param {ReturnType<typeof compareScreens>} comparison
 * @param {number} [threshold]
 * @returns {'same' | 'changed' | 'unknown'}
 */
export function screenVerdict(comparison, threshold = SAME_SCREEN) {
  if (comparison === null || comparison === undefined) return 'unknown'
  return comparison.similarity >= threshold ? 'same' : 'changed'
}
