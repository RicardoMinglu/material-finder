import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState, FileKind, PreviewData, SearchHit, SearchResponse, DocumentList, StorageInfo } from '../shared/types';
import { BrandMark, Icon, type IconName } from './Icons';
import { Highlight, locationLabel, readableError } from './format';
import Preview from './Preview';

const emptyState: AppState = { library: null, stats: { total: 0, ready: 0, queued: 0, indexing: 0, errors: 0, units: 0, ocrPending: 0, skipped: 0 }, progress: { phase: 'idle' }, folders: [], counts: {pdf:0,image:0,word:0}, revision: '' };
const emptyResults: SearchResponse = { hits: [], total: 0, elapsedMs: 0 };
const fileKinds: Array<{ key: FileKind | ''; label: string; icon: IconName }> = [
  { key: '', label: '全部资料', icon: 'grid' }, { key: 'pdf', label: 'PDF 文档', icon: 'file' }, { key: 'image', label: '图片', icon: 'image' }, { key: 'word', label: 'Word 文档', icon: 'word' },
];
const kindLabel: Record<FileKind, string> = { pdf: 'PDF', image: '图片', word: 'WORD' };
const statusLabel = { queued: '等待处理', indexing: '处理中', ready: '已完成', error: '需处理' };

function ResultCard({ hit, selected, onClick }: { hit: SearchHit; selected: boolean; onClick: () => void }) {
  return <button className={`result-card ${selected ? 'selected' : ''}`} onClick={onClick} aria-pressed={selected}>
    <div className="result-topline"><span className={`file-tag ${hit.kind}`}>{kindLabel[hit.kind]}</span><span className="result-location">{locationLabel(hit.locator)}</span>{hit.exact && <span className="exact-tag">完整匹配</span>}</div>
    <h3>{hit.name}</h3><p className="result-snippet"><Highlight text={hit.snippet} ranges={hit.highlights}/></p>
    <div className="result-bottom"><span className="result-path" title={hit.relativePath}><Icon name="folder" size={12}/>{hit.relativePath.includes('/') || hit.relativePath.includes('\\') ? hit.relativePath.replace(/[/\\][^/\\]+$/, '') : '资料文件夹'}</span>{hit.sourceCount > 1 && <span className="duplicate-count">{hit.sourceCount} 个来源</span>}{hit.ocrPending && <span className="pending-tag">识别中</span>}<Icon name="chevronRight" size={14}/></div>
  </button>;
}

function WelcomeArt() {
  return <div className="welcome-art" aria-hidden="true"><div className="art-paper back"><span/><span/><span/></div><div className="art-paper front"><div className="art-file-badge">PDF</div><span/><span/><span className="art-highlight"/><span/><span/></div><div className="art-search"><Icon name="search" size={30}/></div><div className="art-spark spark-one"/><div className="art-spark spark-two"/></div>;
}

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [booting, setBooting] = useState(true);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<FileKind | ''>('');
  const [folder, setFolder] = useState('');
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<SearchResponse>(emptyResults);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<{ documentId: number; unitId: number } | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [filePage, setFilePage] = useState(0);
  const [documents, setDocuments] = useState<DocumentList>({files:[],total:0,revision:''});
  const [filesLoading, setFilesLoading] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const searchTiming = useRef<{version:number;start:number;query:string;offset:number}|null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchVersion = useRef(0);
  const previewVersion = useRef(0);
  const settledSearchKey = useRef<string | null>(null);
  const loadedPreviewKey = useRef<string | null>(null);
  const previewSnapshot = useRef<PreviewData | null>(null);
  const libraryPath = state.library?.rootPath;
  const sourceRevision = state.revision;
  const selectedSourceHash = state.revision;
  const isPaused = state.progress.phase === 'paused';
  const isWorking = ['scanning', 'extracting', 'ocr'].includes(state.progress.phase);

  const act = useCallback(async (name: string, callback: () => Promise<unknown>) => {
    setBusy(name); setError('');
    try { await callback(); } catch (e) { setError(e instanceof Error ? e.message : '操作没有完成，请重试。'); }
    finally { setBusy(''); }
  }, []);
  const chooseFolder = useCallback(() => act('choose', async () => {
    const next = await window.materialFinder.chooseFolder();
    if (next) { setState(next); setQuery(''); setSelected(null); setPreview(null); setKind(''); setFolder(''); setOffset(0); }
  }), [act]);
  useEffect(() => {
    if (!window.materialFinder) { setError('请通过「资料快搜」桌面应用打开此界面。'); setBooting(false); return; }
    let live = true;
    const offError = window.materialFinder.onError(message => { if(live) setError(message); });
    const off = window.materialFinder.onState(next => { if (live) setState(next); });
    void window.materialFinder.getState().then(next => { if (live) setState(next); }).catch(e => { if (live) setError(String(e)); }).finally(() => { if (live) setBooting(false); });
    return () => { live = false; off(); offError(); };
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (drawer) { if (event.key === 'Escape') setDrawer(false); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void chooseFolder(); }
      if (event.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chooseFolder, drawer]);
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>('.management-drawer');
    if (!panel) return;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    panel.addEventListener('keydown', trap);
    return () => { panel.removeEventListener('keydown', trap); previous?.focus(); };
  }, [drawer]);
  useEffect(() => {
    const version = ++searchVersion.current;
    const searchKey = JSON.stringify([query, kind, folder, offset, libraryPath]);
    if (!query.trim() || !libraryPath) { settledSearchKey.current = null; setResults(emptyResults); setSearching(false); setSelected(null); return; }
    if (settledSearchKey.current !== searchKey) setSearching(true);
    const timer = setTimeout(() => {
      searchTiming.current={version,start:performance.now(),query,offset};
      void window.materialFinder.search({ text: query, kind: kind || undefined, folder: folder || undefined, offset, limit: 30 }).then(next => {
        if (version !== searchVersion.current) return;
        const inputChanged = settledSearchKey.current !== searchKey;
        settledSearchKey.current = searchKey;
        setResults(next); setSearching(false);
        setSelected(previous => {
          if (previous && !inputChanged) {
            return previous;
          }
          if (previous && inputChanged && next.hits.some(h => h.documentId === previous.documentId && h.unitId === previous.unitId)) return previous;
          return next.hits[0] ? { documentId: next.hits[0].documentId, unitId: next.hits[0].unitId } : null;
        });
      }).catch(e => { if (version === searchVersion.current) { setError(e instanceof Error ? e.message : '搜索没有完成，请重试。'); setSearching(false); } });
    }, 180);
    return () => clearTimeout(timer);
  }, [query, kind, folder, offset, libraryPath, sourceRevision, state.stats.units, state.stats.ready, state.stats.ocrPending]);
  useLayoutEffect(() => {
    const timing=searchTiming.current;
    if(!timing || timing.version!==searchVersion.current || searching)return;
    const frame=requestAnimationFrame(()=>{
      performance.clearMeasures('material-finder:search-to-render');
      performance.measure('material-finder:search-to-render',{start:timing.start,end:performance.now(),detail:{query:timing.query,offset:timing.offset}});
    });
    return()=>cancelAnimationFrame(frame);
  },[results,searching]);
  useEffect(() => {
    const version = ++previewVersion.current;
    if (!selected) { loadedPreviewKey.current = null; previewSnapshot.current = null; setPreview(null); setPreviewLoading(false); setPreviewError(''); return; }
    const previewKey = JSON.stringify([selected.documentId, selected.unitId, query]);
    // OCR finishes across the library frequently. Keep the current page mounted
    // while refreshing its highlights; only a new location/query blocks preview.
    if (loadedPreviewKey.current !== previewKey) setPreviewLoading(true);
    setPreviewError('');
    void window.materialFinder.preview(selected.documentId, selected.unitId, query).then(data => {
      if (version !== previewVersion.current) return;
      loadedPreviewKey.current = previewKey;
      previewSnapshot.current = data;
      setPreview(data); setPreviewLoading(false);
    }).catch(e => {
      if (version !== previewVersion.current) return;
      const message = e instanceof Error ? e.message : '原文打开失败';
      if (/内容已更新|已从索引移除/.test(message)) {
        loadedPreviewKey.current = null; previewSnapshot.current = null;
        setSelected(null); setPreview(null);
      }
      setPreviewError(message); setPreviewLoading(false);
    });
  }, [selected, query, selectedSourceHash, state.stats.ocrPending, state.stats.ready]);
  useEffect(() => {
    if (folder && !state.folders.includes(folder)) { setFolder(''); setOffset(0); }
  }, [folder, state.folders]);

  const counts = state.counts;
  const displayedFiles = documents.files;
  useEffect(() => { setFilePage(0); }, [fileQuery, onlyErrors, libraryPath]);
  useEffect(() => {
    if (!drawer) return;
    let live = true;
    setFilesLoading(true);
    const timer = setTimeout(() => {
      void window.materialFinder.listDocuments({text:fileQuery,status:onlyErrors?'error':undefined,offset:filePage,limit:100}).then(result => {
        if (!live) return;
        if (filePage && filePage >= result.total) { setFilePage(Math.max(0, Math.floor((result.total-1)/100)*100)); return; }
        setDocuments(result);setFilesLoading(false);
      }).catch(e => { if(live){setError(String(e));setFilesLoading(false);} });
    }, 150);
    return () => { live=false;clearTimeout(timer); };
  },[drawer,fileQuery,onlyErrors,filePage,libraryPath,state.revision]);
  useEffect(() => {
    if (!drawer) return;
    let live=true;
    void window.materialFinder.storageInfo().then(info=>{if(live)setStorage(info);}).catch(e=>{if(live)setError(String(e));});
    return()=>{live=false;};
  },[drawer]);
  useEffect(() => { if(!copyNotice)return;const timer=setTimeout(()=>setCopyNotice(''),2500);return()=>clearTimeout(timer); },[copyNotice]);
  const copyCitation=()=>selected&&void act('copy',async()=>{await window.materialFinder.copyCitation(selected.documentId,selected.unitId,query);setCopyNotice('已复制片段及出处');});
  const progressLabel = isPaused ? '已暂停处理' : state.progress.phase === 'scanning' ? '正在检查资料' : state.progress.phase === 'ocr' ? '正在识别图片文字' : state.progress.phase === 'extracting' ? '正在读取文档文字' : state.stats.errors ? '部分资料需要处理' : state.stats.total ? '资料已准备好' : '等待添加资料';
  const progressPercent = state.stats.total ? Math.min(100, Math.round((state.stats.ready + state.stats.errors) / state.stats.total * 100)) : 0;

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><BrandMark/><div><h1>资料快搜</h1><span>让每份资料，都有迹可循</span></div></div><div className="header-actions"><span className="privacy-badge"><Icon name="shield" size={14}/><span>本地搜索 · 离线可用</span></span><button className="secondary-button" disabled={!!busy || booting} onClick={() => void chooseFolder()}><Icon name="folder" size={16}/>{state.library ? '更换资料夹' : '选择资料夹'}</button><button className="icon-button" title="资料管理" aria-label="资料管理" onClick={() => setDrawer(true)}><Icon name="settings" size={19}/></button></div></header>
    {error && <div className="error-banner" role="alert"><Icon name="warning" size={16}/><span>{error}</span><button className="icon-button small" aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" size={15}/></button></div>}
    <div className="app-body"><aside className="sidebar">
      <div className="library-heading"><span className="eyebrow">我的资料库</span><span className="count-circle">{state.stats.total}</span></div>
      <div className="library-card" title={state.library?.rootPath}><div className="folder-icon"><Icon name="folder" size={20}/></div><div><strong>{state.library?.name || '还没有资料夹'}</strong><span>{state.library ? '自动包含所有子文件夹' : '添加资料，开始搜索'}</span></div></div>
      {state.library?.missing && <div className="missing-library"><Icon name="warning" size={15}/><span>找不到原资料夹，请重新选择位置。</span></div>}
      <nav className="type-navigation" aria-label="文件类型">{fileKinds.map(item => <button key={item.key} className={`type-item ${kind === item.key ? 'active' : ''}`} onClick={() => { setKind(item.key); setOffset(0); }}><Icon name={item.icon} size={18}/><span>{item.label}</span><span className="type-count">{item.key ? counts[item.key] : state.stats.total}</span></button>)}</nav>
      <div className="folder-filter"><label className="eyebrow" htmlFor="folder-filter">查找范围</label><select id="folder-filter" value={folder} onChange={event => { setFolder(event.target.value); setOffset(0); }} disabled={!state.library}><option value="">所有文件夹</option>{state.folders.map(path => <option key={path} value={path}>{path}</option>)}</select></div>
      <div className="sidebar-spacer"/>
      <div className={`index-card ${isWorking ? 'working' : ''}`}><div className="index-title"><span className={`status-dot ${isWorking ? 'pulsing' : ''} ${state.stats.errors ? 'has-errors' : ''}`}/><strong>{progressLabel}</strong>{isWorking || isPaused ? <button className="icon-button small" title={isPaused ? '继续处理' : '暂停处理'} aria-label={isPaused ? '继续处理' : '暂停处理'} disabled={!!busy} onClick={() => void act('toggle', () => isPaused ? window.materialFinder.resume() : window.materialFinder.pause())}><Icon name={isPaused ? 'play' : 'pause'} size={13}/></button> : <button className="icon-button small" title="刷新资料" aria-label="刷新资料" disabled={!state.library || !!busy} onClick={() => void act('refresh', () => window.materialFinder.refresh())}><Icon name="refresh" size={13}/></button>}</div>
        {state.stats.total > 0 && <><div className="progress-track"><div style={{ width: `${progressPercent}%` }}/></div><div className="index-counts"><span>已处理 {state.stats.ready + state.stats.errors} / {state.stats.total}</span><span>{progressPercent}%</span></div></>}
        <p title={state.progress.message || state.progress.currentFile}>{state.progress.message || (state.progress.currentFile ? state.progress.currentFile.split(/[/\\]/).pop() : state.stats.units ? `${state.stats.units.toLocaleString()} 页 / 段内容可搜索` : '首次识别完成后，即可快速查找')}</p>
        {state.stats.ocrPending > 0 && <span className="ocr-pending-count">还有 {state.stats.ocrPending} 处图片文字待识别</span>}
        <button className="index-detail-button" onClick={() => setDrawer(true)}>查看处理详情<Icon name="chevronRight" size={13}/></button>
      </div><div className="sidebar-foot"><Icon name="shield" size={13}/><span>你的资料，只保存在你的电脑</span></div>
    </aside>
    <main className="workspace"><section className="search-area"><div className="search-heading"><h2>{query.trim() ? '查找资料' : '想找哪份资料？'}</h2><span>关键词、文字片段，都可以</span></div><form className={`search-box ${searching ? 'searching' : ''}`} onSubmit={e => { e.preventDefault(); searchRef.current?.blur(); }}><Icon name="search" size={21}/><input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} placeholder="输入文字片段或关键词，多个关键词用空格分隔" aria-label="搜索资料" disabled={!state.library || booting} spellCheck={false}/>{query ? <button type="button" className="icon-button small" aria-label="清空搜索" title="清空搜索" onClick={() => { setQuery(''); setOffset(0); searchRef.current?.focus(); }}><Icon name="close" size={15}/></button> : <kbd>⌘ / Ctrl F</kbd>}{searching && <span className="spinner"/>}<button type="submit" className="search-submit" disabled={!state.library || !query.trim()}>搜索<Icon name="arrow" size={15}/></button></form><div className="search-meta"><span>{state.library ? `已读取 ${state.stats.units.toLocaleString()} 页 / 段内容${isWorking ? '，其余资料正在后台处理' : ''}` : '支持 PDF、图片、Word，自动识别图片中的文字'}</span><span><Icon name="check" size={12}/>原文定位</span></div></section>
    {booting ? <div className="workspace-loading"><span className="spinner"/>正在打开资料库…</div> : !state.library ? <section className="welcome-screen"><WelcomeArt/><span className="welcome-kicker">把资料整理成一个可搜索的书架</span><h2>不用再一份一份翻了。</h2><p>选择你的资料文件夹，让文字成为线索。<br/>找到内容，再一键回到原文。</p><button className="primary-button" disabled={!!busy} onClick={() => void chooseFolder()}><Icon name="folder" size={18}/>{busy === 'choose' ? '正在打开…' : '选择资料文件夹'}<Icon name="arrow" size={17}/></button><div className="welcome-formats"><span className="file-tag pdf">PDF</span><span className="file-tag image">PNG / JPG</span><span className="file-tag word">DOC / DOCX</span></div><div className="welcome-explainer"><span><b>01</b>选择资料夹</span><i/><span><b>02</b>自动读取与识别</span><i/><span><b>03</b>输入文字查找</span></div></section> : <div className="search-workspace"><section className="results-panel" aria-label="搜索结果"><div className="results-heading"><h3>{query.trim() ? '搜索结果' : '开始查找'}{query.trim() && <span>{results.total}</span>}</h3><span>{query.trim() ? searching ? '搜索中…' : `${(results.elapsedMs / 1000).toFixed(2)} 秒` : '输入文字即可搜索'}</span></div>
      {!query.trim() ? <div className="results-empty"><div className="empty-icon"><Icon name="search" size={29}/></div><h3>记得几个字，就能找一找</h3><p>输入资料中有辨识度的一句话，<br/>或者用空格隔开几个关键词。</p><div className="search-tip"><Icon name="scan" size={18}/><span>扫描件和图片会自动识别。<br/>已读取的资料，现在就能搜索。</span></div></div> : !results.hits.length ? <div className="results-empty"><div className="empty-icon"><Icon name={searching ? 'search' : 'file'} size={28}/></div><h3>{searching ? '正在查找…' : '暂时没有找到匹配内容'}</h3><p>{searching ? '稍等一下，结果马上就好。' : '试试更短的文字，或减少关键词。'}{!searching && (kind || folder) ? <><br/>也可以清除筛选，搜索全部资料。</> : null}</p>{!searching && (kind || folder) && <button className="text-button" onClick={() => { setKind(''); setFolder(''); setOffset(0); }}>清除筛选<Icon name="arrow" size={14}/></button>}{!searching && state.stats.ocrPending > 0 && <div className="search-tip"><Icon name="scan" size={17}/><span>还有 {state.stats.ocrPending} 处图片文字正在等待识别，完成后结果会自动更新。</span></div>}</div> : <div className="result-list">{results.hits.map(hit => <ResultCard key={`${hit.documentId}-${hit.unitId}`} hit={hit} selected={selected?.documentId === hit.documentId && selected.unitId === hit.unitId} onClick={() => setSelected({ documentId: hit.documentId, unitId: hit.unitId })}/>)}</div>}
      {results.total > 30 && <div className="pagination"><button className="icon-button small" aria-label="上一组结果" disabled={!offset || searching} onClick={() => setOffset(Math.max(0, offset - 30))}><Icon name="chevronLeft" size={15}/></button><span>{offset + 1}–{Math.min(offset + 30, results.total)} / {results.total}</span><button className="icon-button small" aria-label="下一组结果" disabled={offset + 30 >= results.total || searching} onClick={() => setOffset(offset + 30)}><Icon name="chevronRight" size={15}/></button></div>}
    </section><Preview copyNotice={copyNotice} onCopy={copyCitation} data={preview} loading={previewLoading} error={previewError} onNavigate={unitId => selected && setSelected({ documentId: selected.documentId, unitId })} onOpen={() => selected && void act('open', () => window.materialFinder.openSource(selected.documentId))} onReveal={() => selected && void act('reveal', () => window.materialFinder.revealSource(selected.documentId))}/></div>}
    </main></div>
    {drawer && <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDrawer(false); }}><section className="management-drawer" role="dialog" aria-modal="true" aria-labelledby="management-title"><div className="drawer-header"><div><span className="eyebrow">资料库</span><h2 id="management-title">资料管理</h2></div><button className="icon-button" aria-label="关闭资料管理" onClick={() => setDrawer(false)}><Icon name="close" size={19}/></button></div><div className="drawer-body"><div className="drawer-library"><Icon name="folder" size={23}/><div><strong>{state.library?.name || '尚未选择资料夹'}</strong><p>{state.library?.rootPath || '添加一个文件夹，自动读取其中的 PDF、图片和 Word。'}</p></div></div><div className="drawer-stats"><div><strong>{state.stats.total}</strong><span>可处理文件</span></div><div><strong>{state.stats.ready}</strong><span>已完成</span></div><div><strong>{state.stats.ocrPending}</strong><span>待识别位置</span></div><div className={state.stats.errors ? 'error-stat' : ''}><strong>{state.stats.errors}</strong><span>需处理</span></div></div><div className="drawer-actions"><button className="secondary-button" disabled={!state.library || !!busy} onClick={() => void act('refresh', () => window.materialFinder.refresh())}><Icon name="refresh" size={15}/>刷新资料</button><button className="secondary-button" disabled={!state.library || !!busy || (!isWorking && !isPaused)} onClick={() => void act('toggle', () => isPaused ? window.materialFinder.resume() : window.materialFinder.pause())}><Icon name={isPaused ? 'play' : 'pause'} size={14}/>{isPaused ? '继续处理' : '暂停处理'}</button>{state.stats.errors > 0 && <button className="secondary-button" disabled={!!busy} onClick={() => void act('retry', () => window.materialFinder.retry())}>重试失败文件</button>}</div><div className="drawer-progress"><span className={`status-dot ${isWorking ? 'pulsing' : ''}`}/><span>{progressLabel}{state.progress.currentUnit ? ` · ${state.progress.currentUnit}` : ''}</span>{state.progress.fraction !== undefined && isWorking && <span className="current-fraction">{Math.round(state.progress.fraction * 100)}%</span>}</div>{state.progress.message && <div className="operation-message" role="status">{state.progress.message}</div>}<div className="drawer-notice"><Icon name="shield" size={17}/><div><strong>资料只在本机处理</strong><p>图片识别需要一些时间，完成的内容可以立即搜索。退出后会保留进度。</p><p>Word 按文字段落和内嵌图片定位；旧版 .doc 内的图片暂不识别。视频不纳入搜索{state.stats.skipped ? `（已跳过 ${state.stats.skipped} 个不支持的文件）` : ''}。</p></div></div><div className="files-toolbar"><label className="file-search"><Icon name="search" size={15}/><input placeholder="筛选文件名" aria-label="筛选文件名" value={fileQuery} onChange={e => setFileQuery(e.target.value)}/></label><label className="error-filter"><input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)}/>只看失败</label></div><div className="managed-files" aria-busy={filesLoading}>{displayedFiles.length ? displayedFiles.map(file => <div className={`managed-file ${file.status}`} key={file.id}><div className={`managed-file-icon ${file.kind}`}><Icon name={file.kind === 'pdf' ? 'file' : file.kind} size={19}/></div><div className="managed-file-content"><strong title={file.relativePath}>{file.name}</strong><p title={file.relativePath}>{file.relativePath}</p>{file.error && <div className="file-error" title={file.error}>{readableError(file.error)}</div>}</div><div className="managed-file-status"><span>{statusLabel[file.status]}</span>{file.status === 'error' && <button className="text-button" disabled={!!busy} onClick={() => void act(`retry-${file.id}`, () => window.materialFinder.retry(file.id))}>重试</button>}</div></div>) : <div className="managed-files-empty">{onlyErrors ? '没有失败的文件' : state.library ? '没有符合筛选的文件' : '选择资料夹后，文件会显示在这里'}</div>}</div></div><div className="file-pagination"><button className="secondary-button" disabled={filePage===0||filesLoading} onClick={()=>setFilePage(Math.max(0,filePage-100))}>上一页</button><span>{documents.total ? `${filePage+1}–${Math.min(filePage+100,documents.total)} / ${documents.total}` : '0 个文件'}{filesLoading?' · 读取中…':''}</span><button className="secondary-button" disabled={filePage+100>=documents.total||filesLoading} onClick={()=>setFilePage(filePage+100)}>下一页</button></div>{storage&&<div className="storage-info"><strong>本机存储</strong><p>索引 {(storage.indexBytes/1048576).toFixed(1)} MB · 内容缓存 {(storage.cacheBytes/1048576).toFixed(1)} MB</p><p title={storage.dataPath}>{storage.dataPath}</p><p>缓存保存文件快照以保证原文一致，失去引用的缓存会自动清理。</p></div>}<div className="drawer-footer"><span>资料快搜 · {storage?.version||'1.1.0-rc.1'}</span><button className="text-button" disabled={!!busy} onClick={() => void chooseFolder()}>选择其他资料夹<Icon name="folder" size={14}/></button></div></section></div>}
  </div>;
}
