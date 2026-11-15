import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { project } from '../build/store-config.mjs';

// Reuse the existing product artwork; do not let builder fall back to samples.
export const storeAssets = {
  'StoreLogo.png': [50, 50],
  'Square44x44Logo.png': [44, 44],
  'Square150x150Logo.png': [150, 150],
  'Wide310x150Logo.png': [310, 150],
};
export async function generateStoreAssets() {
  const directory = path.join(project, 'resources/store/appx');
  await mkdir(directory, { recursive: true });
  const icon = await loadImage(path.join(project, 'resources/icon.png'));
  for (const [name, [width, height]] of Object.entries(storeAssets)) {
    const canvas = createCanvas(width, height), context = canvas.getContext('2d');
    const size = Math.min(width, height);
    context.drawImage(icon, (width - size) / 2, (height - size) / 2, size, size);
    await writeFile(path.join(directory, name), await canvas.encode('png'));
  }
}
