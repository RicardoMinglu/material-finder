import type { Locator } from '../shared/types';
import { Fragment } from 'react';

export function locationLabel(locator: Locator): string {
  if (locator.type === 'pdf') return `第 ${locator.page} 页`;
  if (locator.type === 'image') return '图片文字';
  if (locator.imageIndex !== undefined) return `内嵌图片 ${locator.imageIndex}`;
  return `${locator.section || '正文'} · 段落 ${locator.paragraph}`;
}
export function readableError(message: string): string {
  if (/Invalid PDF structure|InvalidPDFException|bad xref/i.test(message)) return 'PDF 文件损坏或格式不正确，请用原软件检查后重试。';
  if (/password|encrypted|加密|密码/i.test(message)) return '文件有密码保护，请先解除保护，再重新处理。';
  if (/ENOENT|no such file|not found/i.test(message)) return '找不到原文件，可能已移动或删除，请刷新资料夹。';
  if (/EACCES|EPERM|permission denied/i.test(message)) return '无法读取这个文件，请检查文件夹的访问权限。';
  return message;
}
export function Highlight({ text, ranges }: { text: string; ranges: Array<{ start: number; end: number }> }) {
  let cursor = 0;
  const parts: React.ReactNode[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, range.start, 0);
    const end = Math.min(text.length, range.end);
    if (end <= start) continue;
    if (start > cursor) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, start)}</Fragment>);
    parts.push(<mark key={`h${start}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}
