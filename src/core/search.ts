import type { Rect, StoredUnit, TextSpan } from '../shared/types.js';

export interface Highlight { start: number; end: number }
export interface NormalizedText { text: string; starts: number[]; ends: number[] }
export interface PreparedQuery { terms: string[]; phrase: string }
export interface TextMatch {
  exact: boolean; proximity: number; focus: number; highlights: Highlight[];
}
export interface TextRank { exact: boolean; proximity: number }
interface TermOccurrence { start: number; end: number; term: number }

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Every normalized UTF-16 code unit retains its original UTF-16 source range. */
export function normalizeText(value: string): NormalizedText {
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  for (const { segment, index } of graphemes.segment(value)) {
    const normalized = segment.normalize('NFKC').toLowerCase().replace(/[\s\p{Cc}\p{Cf}]/gu, '');
    text += normalized;
    for (let i = 0; i < normalized.length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  return { text, starts, ends };
}

export function prepareQuery(query: string): PreparedQuery {
  return {
    phrase: normalizeText(query).text,
    terms: [...new Set(query.split(/\s+/u).map(value => normalizeText(value).text).filter(Boolean))],
  };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function quoteFts(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function occurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const found: number[] = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const position = text.indexOf(needle, from);
    if (position === -1) break;
    found.push(position);
    from = position + 1;
  }
  return found;
}

export function mergeHighlights(highlights: Highlight[]): Highlight[] {
  const merged: Highlight[] = [];
  for (const item of [...highlights].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

function closestWindow(events: TermOccurrence[], termCount: number): { proximity: number; focus: number } {
  const counts = new Map<number, number>();
  const maxima: number[] = [];
  let head = 0, covered = 0, left = 0, shortest = Infinity, focus = events[0]!.start;
  // Monotone deque: each interval enters/leaves once, including overlapping terms.
  for (let right = 0; right < events.length; right++) {
    const event = events[right]!;
    while (maxima.length > head && events[maxima.at(-1)!]!.end <= event.end) maxima.pop();
    maxima.push(right);
    if (!(counts.get(event.term) ?? 0)) covered++;
    counts.set(event.term, (counts.get(event.term) ?? 0) + 1);
    while (covered === termCount) {
      const width = events[maxima[head]!]!.end - events[left]!.start;
      if (width < shortest) { shortest = width; focus = events[left]!.start; }
      const removed = events[left++]!;
      counts.set(removed.term, counts.get(removed.term)! - 1);
      if (!counts.get(removed.term)) covered--;
      while (head < maxima.length && maxima[head]! < left) head++;
    }
  }
  return { proximity: shortest, focus };
}

function termEvents(text: string, query: PreparedQuery): TermOccurrence[] {
  return query.terms.flatMap((value, term) => occurrences(text, value).map(start => ({
    start, end: start + value.length, term,
  }))).sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Candidate ranking needs no source-offset arrays, spans or highlight allocations. */
export function rankText(text: string, query: PreparedQuery): TextRank | null {
  if (!query.terms.length || !query.terms.every(term => text.includes(term))) return null;
  if (text.includes(query.phrase)) return { exact: true, proximity: query.phrase.length };
  if (query.terms.length === 1) return { exact: false, proximity: query.terms[0]!.length };
  return { exact: false, proximity: closestWindow(termEvents(text, query), query.terms.length).proximity };
}

/** Literal AND search, followed by exact phrase and shortest covering-window ranking. */
export function matchText(normalized: NormalizedText, query: PreparedQuery): TextMatch | null {
  const rank = rankText(normalized.text, query);
  if (!rank) return null;
  const phrasePositions = occurrences(normalized.text, query.phrase);
  const events = termEvents(normalized.text, query);
  const focus = phrasePositions.length ? phrasePositions[0]! : closestWindow(events, query.terms.length).focus;
  const ranges = events.map(event => ({
    start: normalized.starts[event.start]!,
    end: normalized.ends[event.end - 1]!,
  }));
  if (phrasePositions.length) {
    ranges.push(...phrasePositions.map(start => ({
      start: normalized.starts[start]!, end: normalized.ends[start + query.phrase.length - 1]!,
    })));
  }
  return {
    ...rank,
    focus: normalized.starts[focus] ?? 0,
    highlights: mergeHighlights(ranges),
  };
}

export function snippetFor(text: string, match: TextMatch, length = 240): {
  snippet: string; highlights: Highlight[];
} {
  let start = Math.max(0, match.focus - 65);
  let end = Math.min(text.length, Math.max(start + length, match.focus + 100));
  // Do not truncate between the halves of a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end++;
  const prefix = start ? '…' : '';
  return {
    snippet: prefix + text.slice(start, end) + (end < text.length ? '…' : ''),
    highlights: match.highlights.filter(range => range.end > start && range.start < end).map(range => ({
      start: Math.max(range.start, start) - start + prefix.length,
      end: Math.min(range.end, end) - start + prefix.length,
    })),
  };
}

export function rectsFor(spans: TextSpan[], highlights: Highlight[]): Rect[] {
  const seen = new Set<string>();
  const rects: Rect[] = [];
  for (const span of spans) {
    if (!highlights.some(range => span.start < range.end && span.end > range.start)) continue;
    if (![span.rect.x, span.rect.y, span.rect.width, span.rect.height].every(Number.isFinite)) continue;
    const x = Math.max(0, Math.min(1, span.rect.x));
    const y = Math.max(0, Math.min(1, span.rect.y));
    const width = Math.max(0, Math.min(1 - x, span.rect.width));
    const height = Math.max(0, Math.min(1 - y, span.rect.height));
    if (!width || !height) continue;
    const rect = { x, y, width, height }, key = JSON.stringify(rect);
    if (!seen.has(key)) { seen.add(key); rects.push(rect); }
  }
  return rects;
}

export function matchUnit(unit: StoredUnit, query: string): { rects: Rect[]; highlights: Highlight[] } {
  const match = matchText(normalizeText(unit.text), prepareQuery(query));
  return match ? { rects: rectsFor(unit.spans, match.highlights), highlights: match.highlights } :
    { rects: [], highlights: [] };
}
