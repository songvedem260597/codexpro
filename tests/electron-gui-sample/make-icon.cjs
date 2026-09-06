const fs = require('node:fs');
const path = require('node:path');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const SS = 3;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rgba(hex, a = 255) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

function renderIcon(size) {
  const W = size * SS, H = size * SS;
  const p = new Uint8ClampedArray(W * H * 4);
  const S = (v) => v * W;

  function blend(x, y, c) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H || c[3] <= 0) return;
    const i = (y * W + x) * 4;
    const sa = c[3] / 255;
    const da = p[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    p[i] = Math.round((c[0] * sa + p[i] * da * (1 - sa)) / oa);
    p[i + 1] = Math.round((c[1] * sa + p[i + 1] * da * (1 - sa)) / oa);
    p[i + 2] = Math.round((c[2] * sa + p[i + 2] * da * (1 - sa)) / oa);
    p[i + 3] = Math.round(oa * 255);
  }

  function circle(cx, cy, r, c) {
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    const rr = r * r;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= rr) blend(x, y, c);
    }
  }

  function roundRect(x, y, w, h, r, c) {
    const x0 = Math.floor(x), x1 = Math.ceil(x + w);
    const y0 = Math.floor(y), y1 = Math.ceil(y + h);
    const rr = r * r;
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const qx = px + 0.5 < x + r ? x + r : (px + 0.5 > x + w - r ? x + w - r : px + 0.5);
      const qy = py + 0.5 < y + r ? y + r : (py + 0.5 > y + h - r ? y + h - r : py + 0.5);
      const dx = px + 0.5 - qx, dy = py + 0.5 - qy;
      if (dx * dx + dy * dy <= rr) blend(px, py, c);
    }
  }

  function line(x1, y1, x2, y2, width, c) {
    const r = width / 2;
    const minX = Math.floor(Math.min(x1, x2) - r), maxX = Math.ceil(Math.max(x1, x2) + r);
    const minY = Math.floor(Math.min(y1, y2) - r), maxY = Math.ceil(Math.max(y1, y2) + r);
    const vx = x2 - x1, vy = y2 - y1, l2 = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const wx = x + 0.5 - x1, wy = y + 0.5 - y1;
      const t = clamp((wx * vx + wy * vy) / l2, 0, 1);
      const dx = x + 0.5 - (x1 + t * vx), dy = y + 0.5 - (y1 + t * vy);
      if (dx * dx + dy * dy <= r * r) blend(x, y, c);
    }
  }

  function triangle(ax, ay, bx, by, cx, cy, c) {
    const minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy)), maxY = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const w2 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const w3 = 1 - w1 - w2;
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) blend(x, y, c);
    }
  }

  const blue = rgba('#1677ff');
  const cyan = rgba('#42e8ff');
  const navy = rgba('#071a35');
  const panel = rgba('#0b2344');
  const muted = rgba('#4d78b8');
  const white = rgba('#f7fbff');
  const green = rgba('#1fd17a');
  const red = rgba('#ff4068');
  const yellow = rgba('#ffc928');

  roundRect(S(.065), S(.085), S(.87), S(.69), S(.075), rgba('#0b63ff', 26));
  roundRect(S(.075), S(.095), S(.85), S(.67), S(.07), rgba('#1479ff', 45));

  roundRect(S(.085), S(.105), S(.83), S(.64), S(.055), rgba('#0b67ee'));
  roundRect(S(.102), S(.123), S(.796), S(.602), S(.045), rgba('#36cfff'));
  roundRect(S(.112), S(.133), S(.776), S(.582), S(.038), rgba('#0a2b57'));
  roundRect(S(.119), S(.140), S(.762), S(.568), S(.034), navy);

  roundRect(S(.455), S(.74), S(.09), S(.12), S(.025), rgba('#0d59d3'));
  roundRect(S(.42), S(.835), S(.16), S(.05), S(.025), blue);
  roundRect(S(.36), S(.875), S(.28), S(.04), S(.02), rgba('#2385ff'));

  const pipe = rgba('#39dfff');
  line(S(.255), S(.305), S(.255), S(.615), S(.022), pipe);
  line(S(.255), S(.405), S(.36), S(.405), S(.022), pipe);
  line(S(.255), S(.505), S(.36), S(.505), S(.022), rgba('#388cff'));
  line(S(.255), S(.615), S(.36), S(.615), S(.022), rgba('#3be2ff'));

  circle(S(.255), S(.265), S(.095), rgba('#1a7cff', 42));
  circle(S(.255), S(.265), S(.078), cyan);
  circle(S(.255), S(.265), S(.066), blue);
  triangle(S(.235), S(.228), S(.235), S(.302), S(.297), S(.265), white);
  circle(S(.255), S(.405), S(.037), cyan);
  circle(S(.255), S(.405), S(.025), blue);
  circle(S(.255), S(.615), S(.035), cyan);
  circle(S(.255), S(.615), S(.023), blue);

  function statusNode(cx, cy, fill, symbol) {
    circle(S(cx), S(cy), S(.06), [...fill.slice(0, 3), 48]);
    circle(S(cx), S(cy), S(.052), fill);
    circle(S(cx), S(cy), S(.041), [...fill.slice(0, 3), 225]);
    if (symbol === 'check') {
      line(S(cx - .022), S(cy), S(cx - .006), S(cy + .018), S(.012), white);
      line(S(cx - .006), S(cy + .018), S(cx + .027), S(cy - .020), S(.012), white);
    } else if (symbol === 'x') {
      line(S(cx - .020), S(cy - .020), S(cx + .020), S(cy + .020), S(.012), white);
      line(S(cx + .020), S(cy - .020), S(cx - .020), S(cy + .020), S(.012), white);
    } else {
      line(S(cx), S(cy - .021), S(cx), S(cy + .008), S(.010), white);
      circle(S(cx), S(cy + .026), S(.006), white);
    }
  }
  statusNode(.405, .405, green, 'check');
  statusNode(.405, .505, red, 'x');
  statusNode(.405, .615, yellow, '!');

  const rowX = .525, rowW = .29, rowH = .085;
  const ys = [.235, .36, .485, .61];
  const dots = [green, red, yellow, green];
  for (let i = 0; i < ys.length; i++) {
    roundRect(S(rowX), S(ys[i]), S(rowW), S(rowH), S(.025), panel);
    roundRect(S(rowX + .012), S(ys[i] + .008), S(rowW - .024), S(rowH - .016), S(.020), rgba('#0e315e'));
    circle(S(rowX + .038), S(ys[i] + rowH / 2), S(.017), dots[i]);
    roundRect(S(rowX + .075), S(ys[i] + .025), S(.095), S(.015), S(.007), muted);
    roundRect(S(rowX + .075), S(ys[i] + .05), S(.068), S(.013), S(.006), rgba('#355f9b'));
    roundRect(S(rowX + .218), S(ys[i] + .032), S(.045), S(.022), S(.011), rgba('#2d72d8'));
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = (((y * SS + sy) * W) + (x * SS + sx)) * 4;
      r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3];
    }
    const n = SS * SS;
    const o = (y * size + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
  return out;
}

function dibFor(size, rgbaPixels) {
  const maskRow = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  const maskBytes = maskRow * size;
  const buf = Buffer.alloc(40 + pixelBytes + maskBytes);
  let o = 0;
  buf.writeUInt32LE(40, o); o += 4;
  buf.writeInt32LE(size, o); o += 4;
  buf.writeInt32LE(size * 2, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(32, o); o += 2;
  buf.writeUInt32LE(0, o); o += 4;
  buf.writeUInt32LE(pixelBytes, o); o += 4;
  buf.writeInt32LE(0, o); o += 4;
  buf.writeInt32LE(0, o); o += 4;
  buf.writeUInt32LE(0, o); o += 4;
  buf.writeUInt32LE(0, o); o += 4;

  for (let y = size - 1; y >= 0; y--) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    buf[o++] = rgbaPixels[i + 2];
    buf[o++] = rgbaPixels[i + 1];
    buf[o++] = rgbaPixels[i];
    buf[o++] = rgbaPixels[i + 3];
  }

  const maskStart = 40 + pixelBytes;
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row;
    for (let x = 0; x < size; x++) {
      const alpha = rgbaPixels[(y * size + x) * 4 + 3];
      if (alpha === 0) {
        const byte = maskStart + row * maskRow + (x >> 3);
        buf[byte] |= 1 << (7 - (x & 7));
      }
    }
  }
  return buf;
}

const images = sizes.map((size) => ({ size, data: dibFor(size, renderIcon(size)) }));
const headerSize = 6 + images.length * 16;
let dataOffset = headerSize;
const ico = Buffer.alloc(headerSize + images.reduce((sum, i) => sum + i.data.length, 0));
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(images.length, 4);
let entry = 6;
for (const image of images) {
  ico[entry] = image.size === 256 ? 0 : image.size;
  ico[entry + 1] = image.size === 256 ? 0 : image.size;
  ico[entry + 2] = 0;
  ico[entry + 3] = 0;
  ico.writeUInt16LE(1, entry + 4);
  ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(image.data.length, entry + 8);
  ico.writeUInt32LE(dataOffset, entry + 12);
  image.data.copy(ico, dataOffset);
  dataOffset += image.data.length;
  entry += 16;
}

const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log(`ICON_BUILD path=${outPath} sizes=${sizes.join(',')}`);
