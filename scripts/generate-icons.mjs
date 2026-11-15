import { createCanvas } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const directory = 'resources/icon.iconset';
await mkdir(directory, { recursive: true });
async function render(size) {
  const canvas = createCanvas(size, size), c = canvas.getContext('2d');
  c.scale(size / 1024, size / 1024);
  const gradient = c.createLinearGradient(0, 0, 950, 1024);
  gradient.addColorStop(0, '#1c4363'); gradient.addColorStop(1, '#102a43');
  c.fillStyle = gradient; c.beginPath(); c.roundRect(25, 25, 974, 974, 218); c.fill();
  c.save(); c.shadowColor = '#05172570'; c.shadowBlur = 35; c.shadowOffsetY = 24;
  c.fillStyle = '#f8fafc'; c.beginPath(); c.roundRect(252, 185, 430, 600, 54); c.fill(); c.restore();
  c.fillStyle = '#d3e3ec';
  for (const [y, width] of [[307, 242], [388, 242], [469, 175]]) { c.beginPath(); c.roundRect(330, y, width, 22, 11); c.fill(); }
  c.strokeStyle = '#57dbbc'; c.lineWidth = 52; c.lineCap = 'round';
  c.beginPath(); c.arc(635, 608, 145, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(740, 715); c.lineTo(844, 819); c.stroke();
  return canvas.encode('png');
}
await writeFile('resources/icon.png', await render(1024));
for (const size of [16, 32, 128, 256, 512]) {
  await writeFile(`${directory}/icon_${size}x${size}.png`, await render(size));
  await writeFile(`${directory}/icon_${size}x${size}@2x.png`, await render(size * 2));
}
if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', directory, '-o', 'resources/icon.icns']);
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(render));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const at = 6 + i * 16;
  header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[i].length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
}
await writeFile('resources/icon.ico', Buffer.concat([header, ...pngs]));
console.log('Application icons generated.');
