// How each view looks, for the canvas. The fixture is the real output of `viewStyleExpression` on
// HIDProbe (iPhone 17 simulator, iOS 26): its status lights are labels on dynamic system colours,
// which `recursiveDescription` prints only by name — here they come back resolved.
//
// Run: node test/view-style.test.mjs
import { readFileSync } from 'node:fs'
import {
  IMAGE_BATCH, hexAddress, imageKey, imageQueue, looseImageKey, parseViewImages, parseViewStyles, viewImagesExpression, viewStyleExpression,
} from '../lib/view-style.js'

let failures = 0
let checks = 0
function check(cond, label, detail) {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

const styles = parseViewStyles(readFileSync(new URL('./fixtures/view-styles.txt', import.meta.url), 'utf8'))
const green = styles[hexAddress('4374744480')]
check(green !== undefined, 'a decimal address comes back as the 0x address the tree uses', JSON.stringify(Object.keys(styles).slice(0, 3)))
check(green?.bg === 'rgba(52, 199, 89, 1)', 'systemGreenColor arrives as the colour itself', green?.bg)
check(green?.radius === 8 && green?.clips === true, 'with its corner radius, clipped', JSON.stringify(green))
check(green?.fg === 'rgba(255, 255, 255, 1)' && green?.fontSize === 13 && green?.bold === true && green?.align === 'center',
  'and its text style: white, 13 pt, bold, centred', JSON.stringify(green))
check(green?.content === true, 'a label draws content of its own, so its pixels are worth fetching')
const field = styles[hexAddress('4405177440')]
check(field?.borderWidth > 0 && field?.border === 'rgba(0, 0, 0, 0.2)', 'a hairline border keeps its width and colour', JSON.stringify(field))
const plain = styles[hexAddress('4374740960')]
check(plain !== undefined && plain.bg === undefined && plain.radius === undefined, 'a plain container has nothing to draw', JSON.stringify(plain))
check(parseViewStyles('garbage\nS notanumber bg=1').constructor === Object && Object.keys(parseViewStyles('garbage')).length === 0, 'other output is ignored')
check(parseViewStyles('S 16 bg=0,0,0,0')['0x10'].bg === undefined, 'a clear background is no background')

const records = [
  { address: hexAddress('4374740960'), frame: { width: 10, height: 10 } },
  { address: hexAddress('4374744480'), frame: { width: 120, height: 44 } },
  { address: '0xaa', frame: { width: 20, height: 20 } },
  { address: '0xbb', frame: { width: 0, height: 20 } },
]
const queued = imageQueue(records, { ...styles, '0xaa': { content: true, image: true }, '0xbb': { content: true } })
check(queued[0] === '0xaa' && queued[1] === hexAddress('4374744480') && queued.length === 2,
  'image views first, then other content; empty and zero-sized views are never rendered', JSON.stringify(queued))

// The cache key. A layer's contents object is NOT a key: measured, it survives a label's text and
// colour changing. An image view is keyed on its UIImage, a text view on its text and text style.
const keyed = parseViewStyles('S 16 ct=1 img=1 im=4660 tc=0,0,1,1\nS 32 ct=1 fg=0,0,0,1 fs=17\nS 48 ct=1')
check(keyed['0x10'].imageObject === '4660' && keyed['0x10'].tint === 'rgba(0, 0, 255, 1)', 'an image view reports its image object and tint', JSON.stringify(keyed['0x10']))
const icon = { className: 'UIImageView', frame: { width: 24, height: 24 } }
check(imageKey(icon, keyed['0x10']) !== '' && imageKey({ ...icon }, { ...keyed['0x10'] }) === imageKey(icon, keyed['0x10']),
  'the same image, tint, class and size give the same key — an icon every cell shares is fetched once')
check(imageKey(icon, { ...keyed['0x10'], imageObject: '4661' }) !== imageKey(icon, keyed['0x10']), 'another image is another key')
check(imageKey(icon, { ...keyed['0x10'], tint: 'rgba(255, 0, 0, 1)' }) !== imageKey(icon, keyed['0x10']), 'so is another tint')
check(imageKey({ ...icon, frame: { width: 48, height: 24 } }, keyed['0x10']) !== imageKey(icon, keyed['0x10']), 'and another size')
const label = { className: 'UILabel', text: '清空', frame: { width: 30, height: 18 } }
check(imageKey(label, keyed['0x20']) !== '' && imageKey({ ...label, text: '重连' }, keyed['0x20']) !== imageKey(label, keyed['0x20']),
  'a label is keyed on its text: new text is a new picture')
check(imageKey(label, { ...keyed['0x20'], fg: 'rgba(255, 0, 0, 1)' }) !== imageKey(label, keyed['0x20']), 'and on its colour')
check(imageKey({ className: 'Custom.Drawing', frame: { width: 50, height: 50 } }, keyed['0x30']) === '',
  'a view that draws itself has nothing to key on, so it is fetched every time')
check(viewStyleExpression().includes('im=') && !viewStyleExpression().includes('ck='), 'the style read reports the image object, not the layer contents')

// The loose key is the view itself: it survives a changed text (that is the point — a first look draws
// at once), and it is only ever used within one process.
check(looseImageKey({ ...label, address: '0xABC' }) === looseImageKey({ ...label, text: '重连', address: '0xabc' }) && looseImageKey({ ...label, address: '0xabc' }) !== '',
  'the loose key names the view, not what it draws')
check(looseImageKey({ ...label, address: '0xabc' }) !== looseImageKey({ ...label, address: '0xabc', frame: { width: 31, height: 18 } }), 'though a resized view is another one')
check(looseImageKey({ className: 'UILabel' }) === '', 'no address, no loose key')

const expression = viewImagesExpression(['0x10', 'not an address', '0xABC'])
check(expression.startsWith('po ({') && !expression.includes('\n'), 'one line behind po')
// On the classic channel (iOS 16 through the debugserver forwarder) `@import UIKit` fails with
// "Header search couldn't locate module 'UIKit'" and takes the whole expression with it (measured on
// the iPhone X), so neither expression may need a header: no import, no UIKit/CG type or typedef.
for (const [name, source] of [['style', viewStyleExpression()], ['images', expression]]) {
  check(!source.includes('@import'), `the ${name} read imports nothing`)
  const typed = /\b(UIView|UIColor|UIFont|CALayer|CGFloat|NSInteger|BOOL|size_t|CGContextRef|CGImageRef|NSString|NSArray|YES|NO|nil|NSNotFound)\b/.exec(source.replace(/@"[^"]*"/g, "@\"\""))
  check(typed === null, `and names no type or macro a header would declare (${name})`, typed?.[0])
}
check(expression.includes('{ 0x10, 0xABC }') && !expression.includes('not an address'), 'only real addresses reach the expression')
// `context` clashes with a symbol in some apps' images: `Multiple internal symbols found for 'context'`
// (measured on HIDProbe). Every local in the render is prefixed.
check(!/\bcontext\b/.test(expression) && !/\bspace\b/.test(expression), 'no local is named after a symbol an app may export')
check(!/\bcontext\b/.test(viewStyleExpression()), 'nor in the style read')
// `scale` is the same trap, and the one that reached a user: `Multiple external symbols found for
// 'scale'` on the iPhone X (iOS 16, classic channel), from the image render's `double scale` — the
// name view-shots.js had already retired for exactly this reason. Checked as a USE, not only as a
// declaration: `scale:` as a selector label and ` scale]` as a message are fine, anything else is not.
for (const [name, source] of [['style', viewStyleExpression()], ['images', expression]]) {
  const bare = /.{0,30}(?<! )\bscale\b(?![:\]]).{0,30}|.{0,30} scale\b(?![:\]]).{0,30}/.exec(source)
  check(bare === null, `no bare 'scale' in the ${name} read`, bare?.[0])
}
// And no declared local takes a name an image was MEASURED to export: `scale` (iPhone X), `context`
// and `space` (HIDProbe).
const COLLIDING = ['scale', 'context', 'space']
for (const [name, source] of [['style', viewStyleExpression()], ['images', expression]]) {
  const declared = [...source.matchAll(/\b(?:double|int|unsigned long long|unsigned long|long|id|void \*|signed char)\s+\*?([A-Za-z_]\w*)\s*(?:=|;|\[)/g)].map((m) => m[1])
  const clash = declared.filter((local) => COLLIDING.includes(local))
  check(clash.length === 0, `no declared local in the ${name} read is a name images export`, clash.join(', '))
}
check(IMAGE_BATCH > 0 && IMAGE_BATCH <= 20, 'a batch is a short stop', String(IMAGE_BATCH))
// A CGBitmapContext's origin is bottom-left and `renderInContext:` draws UIKit's top-down layer tree
// into it as is, so without a flip every picture comes back upside down (measured on 蜜语-Dev: the
// window came off the device with its tab bar on top and its text inverted).
check(expression.includes('CGContextTranslateCTM)(xcbContext, 0, (double)pixelHeight)') && expression.includes('xcbImageScale, 0 - xcbImageScale'),
  'the context is flipped to UIKit\'s top-down origin')

const images = parseViewImages(`I 16 iVBORw0KGgo=\nnoise\nI x abc`)
check(images['0x10'] === 'data:image/png;base64,iVBORw0KGgo=' && Object.keys(images).length === 1, 'an image line becomes a data URL', JSON.stringify(images))

console.log(`${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exit(1)
console.log('view-style OK')
