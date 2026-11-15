import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PreviewData, Rect } from '../shared/types';
import { Icon } from './Icons';
import { Highlight, locationLabel } from './format';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function Rectangles({ rects }: { rects: Rect[] }) {
  return <div className="match-overlay" aria-hidden="true">{rects.map((r, i) => <span key={i} className="match-rect" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }} />)}</div>;
}

function PdfPage({ sourceUrl, pageNumber, rects, zoom }: { sourceUrl: string; pageNumber: number; rects: Rect[]; zoom: number }) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [availableWidth, setAvailableWidth] = useState(500);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(Math.max(160, entry.contentRect.width - 48)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    const abort = new AbortController();
    setPdf(null); setError(''); setLoading(true);
    void (async () => {
      const response = await fetch(sourceUrl, { signal: abort.signal });
      if (!response.ok) throw new Error('原文件无法读取，请检查资料文件夹是否仍可访问。');
      const data = await response.arrayBuffer();
      if (disposed) return;
      task = pdfjs.getDocument({
        data,
        cMapUrl: new URL('./pdfjs/cmaps/', document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('./pdfjs/standard_fonts/', document.baseURI).href,
        wasmUrl: new URL('./pdfjs/wasm/', document.baseURI).href,
      });
      const loaded = await task.promise;
      if (disposed) { await loaded.loadingTask.destroy(); return; }
      setPdf(loaded);
    })().catch((e: unknown) => { if (!disposed) { setError(e instanceof Error ? e.message : 'PDF 打开失败'); setLoading(false); } });
    return () => { disposed = true; abort.abort(); void task?.destroy(); };
  }, [sourceUrl]);
  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    let rendering: RenderTask | undefined;
    setLoading(true); setError('');
    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (disposed || !canvas.current) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (availableWidth / natural.width) * zoom });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const el = canvas.current;
      el.width = Math.ceil(viewport.width * pixelRatio);
      el.height = Math.ceil(viewport.height * pixelRatio);
      setDimensions({ width: viewport.width, height: viewport.height });
      rendering = page.render({ canvas: el, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await rendering.promise;
      if (!disposed) setLoading(false);
    })().catch((e: unknown) => { if (!disposed) { setError(e instanceof Error ? e.message : '页面显示失败'); setLoading(false); } });
    return () => { disposed = true; rendering?.cancel(); };
  }, [pdf, pageNumber, availableWidth, zoom]);
  return <div className="document-scroll" ref={container}>
    {error && <div className="preview-error"><Icon name="warning"/><p>{error}</p></div>}
    {loading && !error && <div className="preview-loading"><span className="spinner"/>正在打开原文…</div>}
    <div className={`pdf-sheet ${loading ? 'is-loading' : ''}`} style={{ width: dimensions.width || '90%', height: dimensions.height || undefined }}>
      <canvas ref={canvas} style={{ width: dimensions.width || '100%', height: dimensions.height || undefined }}/>
      {!loading && <Rectangles rects={rects}/>}
    </div>
  </div>;
}

function ImagePage({ url, rects, zoom, label }: { url: string; rects: Rect[]; zoom: number; label: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const firstMatchY = rects[0]?.y;
  useEffect(() => { setLoaded(false); setError(false); }, [url]);
  useEffect(() => {
    if (!loaded || !scroll.current || firstMatchY === undefined) return;
    const image = scroll.current.querySelector('img');
    if (!image) return;
    scroll.current.scrollTop = Math.max(0, firstMatchY * image.clientHeight - 100);
  }, [loaded, url, firstMatchY, zoom]);
  return <div className="document-scroll image-scroll" ref={scroll}>
    {!loaded && !error && <div className="preview-loading"><span className="spinner"/>正在打开图片…</div>}
    {error ? <div className="preview-error"><Icon name="warning"/><p>图片无法显示，请尝试打开原文件。</p></div> : <div className="image-sheet" style={{ width: `${zoom * 100}%` }}>
      <img src={url} alt={label} onLoad={() => setLoaded(true)} onError={() => setError(true)} />
      {loaded && <Rectangles rects={rects}/>}
    </div>}
  </div>;
}

export default function Preview({ data, loading, error, onNavigate, onOpen, onReveal, onCopy, copyNotice }: {
  onCopy: () => void; copyNotice: string;
  data: PreviewData | null; loading: boolean; error: string;
  onNavigate: (unitId: number) => void; onOpen: () => void; onReveal: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [showText, setShowText] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const textAnchorKey = data ? JSON.stringify([data.document.id, data.unit.id, data.highlights[0]?.start]) : '';
  useEffect(() => { setZoom(1); setShowText(false); }, [data?.document.id]);
  useEffect(() => {
    if (data && (showText || (data.unit.locator.type === 'word' && !data.imageUrl))) {
      textRef.current?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [textAnchorKey, showText]);
  if (!data && !loading && !error) return <section className="preview-panel preview-placeholder"><div className="preview-empty-art"><Icon name="file" size={42}/><span><Icon name="search" size={23}/></span></div><h3>原文，就在旁边</h3><p>点击一条搜索结果<br/>查看原文内容与上下文</p><span className="soft-label"><span className="yellow-dot"/>命中文字会高亮显示</span></section>;
  const isImage = data && (data.unit.locator.type === 'image' || !!data.imageUrl);
  const isText = !!data && (showText || (data.unit.locator.type === 'word' && !data.imageUrl));
  return <section className="preview-panel" aria-label="原文预览">
    <header className="preview-heading"><div><span className="eyebrow">原文预览</span><h2 title={data?.document.name}>{data?.document.name || '正在读取…'}</h2></div><button className="icon-button" title="在文件夹中显示" aria-label="在文件夹中显示" disabled={!data} onClick={onReveal}><Icon name="folder"/></button></header>
    <div className="preview-toolbar"><span className="location-pill">{data && locationLabel(data.unit.locator)}</span><div className="preview-tools">
      <button className="icon-button small" title="上一页或上一段" aria-label="上一页或上一段" disabled={!data?.previousUnitId || loading} onClick={() => data?.previousUnitId && onNavigate(data.previousUnitId)}><Icon name="chevronLeft" size={15}/></button>
      <button className="icon-button small" title="下一页或下一段" aria-label="下一页或下一段" disabled={!data?.nextUnitId || loading} onClick={() => data?.nextUnitId && onNavigate(data.nextUnitId)}><Icon name="chevronRight" size={15}/></button>
      <span className="tool-divider"/>
      {!isText && <><button className="icon-button small" title="缩小" aria-label="缩小" disabled={zoom <= .5} onClick={() => setZoom(z => Math.max(.5, z - .25))}><Icon name="minus" size={15}/></button><button className="zoom-label" title="恢复适合宽度" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="icon-button small" title="放大" aria-label="放大" disabled={zoom >= 3} onClick={() => setZoom(z => Math.min(3, z + .25))}><Icon name="plus" size={15}/></button></>}
      <button className={`text-toggle ${showText ? 'active' : ''}`} onClick={() => setShowText(v => !v)} disabled={!data} title="查看提取文字">文字</button>
    </div></div>
    {error ? <div className="preview-error"><Icon name="warning"/><p>{error}</p></div> : loading ? <div className="preview-loading"><span className="spinner"/>正在定位…</div> : data && <>
      {isText ? <div className="text-preview" ref={textRef}><span className="text-context-label">提取文字 · {locationLabel(data.unit.locator)}</span>{data.neighbors.filter(n => n.side === 'before').slice(-1).map(n => <p className="neighbor-text" key={n.id}>{n.text}</p>)}<p className="main-text"><Highlight text={data.unit.text || '这一处尚未识别出文字。'} ranges={data.highlights}/></p>{data.neighbors.filter(n => n.side === 'after').slice(0, 1).map(n => <p className="neighbor-text" key={n.id}>{n.text}</p>)}</div> : isImage ? <ImagePage url={data.imageUrl || data.sourceUrl} rects={data.rects} zoom={zoom} label={data.document.name}/> : <PdfPage sourceUrl={data.sourceUrl} pageNumber={data.unit.locator.type === 'pdf' ? data.unit.locator.page : 1} rects={data.rects} zoom={zoom}/>}
      {data.unit.needsOcr && <div className="ocr-note"><Icon name="scan" size={14}/>图片文字还在识别中，完成后会补充搜索结果</div>}
      {data.unit.ocrError && <div className="ocr-note error-note"><Icon name="warning" size={14}/>本页识别未完成，可在资料管理中重试</div>}
    </>}
    <footer className="preview-footer"><span role="status">{copyNotice || '高亮为匹配位置'}</span><button className="text-button" disabled={!data||loading} onClick={onCopy}>复制片段及出处</button><button className="text-button" disabled={!data} onClick={onOpen}>打开原文件<Icon name="external" size={14}/></button></footer>
  </section>;
}
