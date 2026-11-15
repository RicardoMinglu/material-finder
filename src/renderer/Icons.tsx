import type { CSSProperties } from 'react';

export type IconName = 'search' | 'folder' | 'file' | 'image' | 'word' | 'grid' | 'refresh' | 'pause' | 'play' | 'check' | 'close' | 'arrow' | 'chevronLeft' | 'chevronRight' | 'external' | 'settings' | 'shield' | 'warning' | 'plus' | 'minus' | 'scan';
const paths: Record<IconName, React.ReactNode> = {
  search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>,
  file: <><path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.3"/><path d="m3 17 5-5 4 4 3-3 6 6"/></>,
  word: <><path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 11l1.5 6 2.5-4 2.5 4 1.5-6"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9M3 3v6h6M4 13a8 8 0 0 0 14 5l3-3M21 21v-6h-6"/></>,
  pause: <><path d="M8 5v14M16 5v14"/></>,
  play: <path d="m8 4 12 8-12 8Z"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  chevronLeft: <path d="m15 5-7 7 7 7"/>,
  chevronRight: <path d="m9 5 7 7-7 7"/>,
  external: <><path d="M14 3h7v7M21 3 10 14M10 5H4v15h15v-6"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/></>,
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
  warning: <><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  minus: <path d="M5 12h14"/>,
  scan: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M4 12h16"/></>,
};
export function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name]}</svg>;
}
export function BrandMark({ size = 34 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#27615E"/><path d="M11 10h13l5 5v15H11V10Z" fill="#F4FAF6"/><path d="M24 10v6h5" fill="#B8D8CD"/><path d="M15 17h5M15 21h4" stroke="#66958B" strokeWidth="1.5" strokeLinecap="round"/><circle cx="23" cy="25" r="5.5" fill="#D9EEE7" stroke="#27615E" strokeWidth="2"/><path d="m27 29 4 4" stroke="#EFCB7A" strokeWidth="3" strokeLinecap="round"/></svg>;
}
