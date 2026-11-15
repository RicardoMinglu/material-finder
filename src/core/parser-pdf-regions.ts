import type { Rect, TextSpan } from '../shared/types.ts';

type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
function matrix(value: any): Matrix | null {
  if (!value || value.length !== 6) return null;
  const numbers = Array.from(value) as number[];
  return numbers.every(Number.isFinite) ? numbers as Matrix : null;
}
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** null means the operator geometry is uncertain, and requires full-page OCR. */
export function pdfImageRegions(
  list: { fnArray: ArrayLike<number>; argsArray: any[] }, ops: Record<string, number>,
  viewport: { transform: ArrayLike<number>; width: number; height: number }, padding = 3,
): Rect[] | null {
  const view = matrix(viewport.transform);
  if (!view || viewport.width <= 0 || viewport.height <= 0) return null;
  const names = new Map(Object.entries(ops).map(([name, value]) => [value, name]));
  const simpleImages = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintSolidColorImageMask']);
  const stack: Array<{ type: 'save' | 'form'; transform: Matrix }> = [];
  let transform = identity();
  const regions: Rect[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const name = names.get(list.fnArray[i]) ?? '';
    const args = list.argsArray[i];
    if (name === 'save') stack.push({ type: 'save', transform });
    else if (name === 'restore' || name === 'paintFormXObjectEnd') {
      const previous = stack.pop();
      if (!previous || previous.type !== (name === 'restore' ? 'save' : 'form')) return null;
      transform = previous.transform;
    } else if (name === 'transform') {
      const next = matrix(args); if (!next) return null;
      transform = multiply(transform, next);
    } else if (name === 'paintFormXObjectBegin') {
      stack.push({ type: 'form', transform });
      if (args?.[0]) {
        const next = matrix(args[0]); if (!next) return null;
        transform = multiply(transform, next);
      }
    } else if (name === 'beginGroup' || name === 'beginAnnotation') return null;
    else if (/^paint.*Image/.test(name)) {
      if (!simpleImages.has(name)) return null;
      const placed = multiply(view, transform);
      const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
        [placed[0] * x + placed[2] * y + placed[4], placed[1] * x + placed[3] * y + placed[5]]);
      const left = Math.max(0, Math.min(...points.map(p => p[0])) - padding);
      const top = Math.max(0, Math.min(...points.map(p => p[1])) - padding);
      const right = Math.min(viewport.width, Math.max(...points.map(p => p[0])) + padding);
      const bottom = Math.min(viewport.height, Math.max(...points.map(p => p[1])) + padding);
      if (right <= left || bottom <= top) continue; // Entirely outside the visible page.
      regions.push({ x: left / viewport.width, y: top / viewport.height,
        width: (right - left) / viewport.width, height: (bottom - top) / viewport.height });
    }
  }
  if (stack.length) return null;
  // Merge overlapping or nearby image placements, preserving every image area.
  const gapX = 6 / viewport.width, gapY = 6 / viewport.height;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length;) {
      const a = regions[i], b = regions[j];
      if (a.x <= b.x + b.width + gapX && a.x + a.width + gapX >= b.x &&
          a.y <= b.y + b.height + gapY && a.y + a.height + gapY >= b.y) {
        const right = Math.max(a.x + a.width, b.x + b.width), bottom = Math.max(a.y + a.height, b.y + b.height);
        a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y); a.width = right - a.x; a.height = bottom - a.y;
        regions.splice(j, 1); i = -1; break;
      } else j++;
    }
  }
  // Full-page OCR is cheaper than many crops or a near-page-sized union.
  if (regions.length > 12 || regions.reduce((area, rect) => area + rect.width * rect.height, 0) > 0.75) return null;
  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function translateCropSpans(spans: TextSpan[], crop: Rect): TextSpan[] {
  return spans.map(span => ({ ...span, rect: {
    x: crop.x + span.rect.x * crop.width, y: crop.y + span.rect.y * crop.height,
    width: span.rect.width * crop.width, height: span.rect.height * crop.height,
  } }));
}
