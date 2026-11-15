import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import chokidar from 'chokidar';
import { ProcessClient } from './process-client';
import { LatestTask } from '../core/latest-task';
import { directoryBytes } from '../core/cache';
import type { AppState, DocumentListQuery, FileKind, IndexProgress, Library, PreviewData, SearchQuery, SearchResponse, SourceDocument, StoredUnit } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const customData = process.env.MATERIAL_FINDER_DATA;
app.setName('资料快搜');
app.setPath('userData', customData ? path.resolve(customData) : path.join(app.getPath('appData'), process.windowsStore ? '资料快搜 Store' : '资料快搜'));
protocol.registerSchemesAsPrivileged([{ scheme: 'material', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let window: BrowserWindow | null = null;
let watcher: ReturnType<typeof chokidar.watch> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
let lastProgress: IndexProgress = { phase: 'idle' };
let quitting = false, ready = false, notifying = false, notificationPending = false;
let libraryGeneration = 0;
let writerStarting: Promise<void> | undefined, readerStarting: Promise<void> | undefined;
const dataDir = app.getPath('userData'), cacheDir = path.join(dataDir, 'cache'), dbPath = path.join(dataDir, 'library.sqlite');
const writer = new ProcessClient(path.join(here, 'index-worker.js'), '资料快搜 · 文档索引', message => {
  if (message.type === 'state') { lastProgress = (message.state as AppState).progress; void notify(); }
}, code => { if (!quitting) { lastProgress = { phase: 'idle', message: `索引进程已退出（${code}），已完成内容已保存。点击刷新继续。` }; void notify(); } });
const reader = new ProcessClient(path.join(here, 'query-worker.js'), '资料快搜 · 资料查询', () => {}, code => {
  if (!quitting && window) window.webContents.send('library:error', `查询进程已退出（${code}），请重新搜索或刷新。`);
});
async function ensureWriter() {
  if (writerStarting) return writerStarting;
  if (writer.process) return;
  writerStarting = (async () => {
    writer.start();
    try { await writer.request('init', { dbPath, cacheDir, ocrDataDir: app.isPackaged ? path.join(process.resourcesPath, 'ocr') : path.resolve(here, '../../resources/ocr') }); }
    catch (e) { writer.kill(); throw e; }
  })();
  try { await writerStarting; } finally { writerStarting = undefined; }
}
async function ensureReader() {
  if (readerStarting) return readerStarting;
  if (reader.process) return;
  readerStarting = (async () => { reader.start(); try { await reader.request('init', { dbPath }); } catch(e) { reader.kill(); throw e; } })();
  try { await readerStarting; } finally { readerStarting = undefined; }
}
async function query<T = any>(command: string, payload?: unknown): Promise<T> { await ensureReader(); return reader.request<T>(command, payload); }
async function command(name: string, payload?: unknown) { await ensureWriter(); return writer.request(name, payload); }
async function state(): Promise<AppState> { return query('state', lastProgress); }
async function notify() {
  if (!ready || quitting || !reader.process) return;
  notificationPending = true;
  if (notifying) return;
  notifying = true;
  try {
    while(notificationPending && reader.process && !quitting) {
      notificationPending = false;
      const next = await reader.request<AppState>('state', lastProgress);
      if (window && !window.isDestroyed()) window.webContents.send('library:changed', next);
    }
  } catch { /* Next explicit user request restarts the reader. */ }
  finally { notifying = false; }
}
function within(root: string, target: string) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function integer(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('无效的资料编号。'); return Number(value); }
function pageNumber(value: unknown, fallback: number, maximum: number) { return value === undefined ? fallback : typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback; }
async function watchLibrary() {
  await watcher?.close(); watcher = null;
  const library = await query<Library | null>('library');
  if (!library || !await stat(library.rootPath).then(s => s.isDirectory()).catch(() => false)) return;
  watcher = chokidar.watch(library.rootPath, { ignoreInitial: true, followSymlinks: false,
    ignored: file => within(dataDir, path.resolve(file)) || /(^|[/\\])(?:\.|~\$)/.test(file),
    awaitWriteFinish: { stabilityThreshold: 1600, pollInterval: 250 } });
  watcher.on('all', () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => {
    // Background events never restart a crashed worker. Recovery is user-triggered.
    if (writer.process) void writer.request('refresh').catch(() => {});
  }, 1000); });
  watcher.on('error', () => { lastProgress = { ...lastProgress, message: '目录监听暂时不可用，可点击刷新。' }; void notify(); });
}
async function sourcePath(id: number) {
  const doc = await query<SourceDocument | undefined>('document', id);
  const library = await query<Library | null>('library');
  if (!doc || !library) throw new Error('这份资料已从索引移除，请刷新搜索结果。');
  const actual = await realpath(doc.path).catch(() => { throw new Error('原文件已移动或删除，请检查资料文件夹或刷新索引。'); });
  if (!within(await realpath(library.rootPath), actual)) throw new Error('文件已移出资料文件夹，请重新导入。');
  return actual;
}
async function configureProtocol() {
  protocol.handle('material', async req => {
    try {
      const url = new URL(req.url), id = integer(Number(url.pathname.slice(1)));
      const generation = libraryGeneration;
      let target: string;
      if (url.hostname === 'source') {
        const doc = await query<SourceDocument | undefined>('document', id);
        if (!doc || url.searchParams.get('v') !== doc.hash) return new Response('资料已更新，请重新搜索。', { status: 409 });
        const cached = path.join(cacheDir, 'sources', doc.hash + path.extname(doc.name).toLowerCase());
        if (await stat(cached).then(s => s.isFile()).catch(() => false)) target = cached;
        else { target = await sourcePath(id); const info = await stat(target); if (info.size !== doc.size || info.mtimeMs !== doc.mtime) return new Response('资料已更新，正在重新读取。', { status: 409 }); }
      } else if (url.hostname === 'image') {
        const item = await query<{unit: StoredUnit; document?: SourceDocument} | undefined>('image', id);
        if (!item?.unit.imagePath || !item.document) return new Response('Image unavailable', { status: 404 });
        target = item.unit.locator.type === 'image' ? await sourcePath(item.document.id) : await realpath(item.unit.imagePath);
        if (!within(await realpath(cacheDir), target) && target !== await sourcePath(item.document.id)) return new Response('Forbidden', { status: 403 });
      } else return new Response('Not found', { status: 404 });
      if (generation !== libraryGeneration) return new Response('资料库已切换。', { status: 409 });
      const response = await net.fetch(pathToFileURL(target).href, { headers: req.headers });
      const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); headers.set('Cache-Control', 'no-cache');
      return new Response(response.body, { status: response.status, headers });
    } catch (e) { return new Response(e instanceof Error ? e.message : 'File unavailable', { status: 404 }); }
  });
}
async function preview(documentId: number, unitId: number, text: string): Promise<PreviewData> {
  const generation = libraryGeneration;
  const p = await query('preview', { documentId: integer(documentId), unitId: integer(unitId), query: typeof text === 'string' ? text.slice(0, 2000) : '' });
  if (generation !== libraryGeneration) throw new Error('资料库已切换，请重新搜索。');
  const { document: doc, unit, before, after, rects, highlights } = p as {document:SourceDocument;unit:StoredUnit;before:StoredUnit[];after:StoredUnit[];rects:any;highlights:any};
  return { document: doc, unit, rects, highlights, sourceUrl: `material://source/${doc.id}?v=${doc.hash}`,
    imageUrl: doc.kind === 'image' ? `material://source/${doc.id}?v=${doc.hash}` : unit.imagePath ? `material://image/${unit.id}` : undefined,
    neighbors: [...before.map(u=>({...u,side:'before' as const})),...after.map(u=>({...u,side:'after' as const}))].map(u => ({ side:u.side, id:u.id, locator:u.locator, text:u.text, imageUrl:u.imagePath ? `material://image/${u.id}` : undefined })),
    previousUnitId: before.at(-1)?.id, nextUnitId: after[0]?.id };
}
const searches = new LatestTask<{query: SearchQuery; generation:number}, SearchResponse>(async job => {
  if(job.generation !== libraryGeneration)throw new Error('SEARCH_SUPERSEDED');
  const result = await query<SearchResponse>('search',job.query);
  if(job.generation !== libraryGeneration)throw new Error('SEARCH_SUPERSEDED');
  return result;
});
function registerHandlers() {
  const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle(name,(event,...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效请求。');
    return callback(...args);
  });
  handle('library:state', state);
  handle('library:choose', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择资料文件夹', properties: ['openDirectory'], buttonLabel: '建立搜索索引' });
    if (result.canceled || !result.filePaths[0]) return null;
    const next = await realpath(result.filePaths[0]);
    const current = await query<Library | null>('library');
    if (current && path.resolve(current.rootPath) !== next) {
      const choice = await dialog.showMessageBox(window!, { type:'warning', buttons:['取消','替换索引'], defaultId:0,cancelId:0,
        message:'替换当前资料库索引？',detail:'切换后会为新文件夹建立索引，原来的索引将被移除。不会删除或修改任何原文件。' });
      if(choice.response!==1)return null;
    }
    libraryGeneration++; await command('folder', next); await watchLibrary(); return state();
  });
  handle('index:refresh', async () => { await command('refresh'); await ensureReader(); await watchLibrary(); await notify(); });
  for(const name of ['pause','resume'])handle(`index:${name}`,()=>command(name));
  handle('index:retry',(id?:number)=>command('retry',id===undefined?undefined:integer(id)));
  handle('library:list',(q:DocumentListQuery={})=>{
    if(!q || (q.status!==undefined && !['queued','indexing','ready','error'].includes(q.status)))throw new Error('无效的文件筛选条件。');
    return query('list',{text:typeof q.text==='string'?q.text.slice(0,2000):'',status:q.status,offset:pageNumber(q.offset,0,1000000),limit:Math.max(1,pageNumber(q.limit,100,100))});
  });
  handle('library:search',(q:SearchQuery)=>{
    if(!q||typeof q.text!=='string'||q.text.length>2000)throw new Error('搜索内容过长，请缩短文字片段。');
    if(q.kind!==undefined&&!(['pdf','image','word'] as FileKind[]).includes(q.kind))throw new Error('无效文件类型。');
    return searches.submit({generation:libraryGeneration,query:{text:q.text,kind:q.kind,folder:typeof q.folder==='string'?q.folder:undefined,offset:pageNumber(q.offset,0,100000),limit:Math.max(1,pageNumber(q.limit,30,100))}});
  });
  handle('library:preview',preview);
  handle('source:copy',async (docId:number,unitId:number,text:string)=>{
    const p=await preview(docId,unitId,text);
    const at=p.highlights[0]?.start??0, start=Math.max(0,at-60);
    const excerpt=p.unit.text.slice(start,start+500);
    const loc=p.unit.locator;
    const label=loc.type==='pdf'?`第 ${loc.page} 页`:loc.type==='word'?`${loc.section} · 第 ${loc.paragraph} 段${loc.imageIndex?` · 图片 ${loc.imageIndex}`:''}`:'图片';
    clipboard.writeText(`${excerpt}\n\n出处：${p.document.relativePath}\n位置：${label}`);
  });
  handle('app:storage',async()=>({version:app.getVersion(),dataPath:dataDir,indexBytes:await Promise.all(['','-wal','-shm'].map(s=>stat(dbPath+s).then(x=>x.size).catch(()=>0))).then(xs=>xs.reduce((a,b)=>a+b,0)),cacheBytes:await directoryBytes(cacheDir)}));
  handle('source:open',async(id:number)=>{const error=await shell.openPath(await sourcePath(integer(id)));if(error)throw new Error(error);});
  handle('source:reveal',async(id:number)=>shell.showItemInFolder(await sourcePath(integer(id))));
}
function createWindow() {
  window=new BrowserWindow({width:1440,height:940,minWidth:800,minHeight:600,title:'资料快搜',backgroundColor:'#f6f7f9',show:false,
    webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window.once('ready-to-show',()=>window?.show());window.on('closed',()=>{window=null;});
  window.loadFile(path.join(here,'../renderer/index.html'));
}
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();else{
  app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.focus();});
  app.whenReady().then(async()=>{
    await mkdir(cacheDir,{recursive:true});await ensureWriter();await ensureReader();
    await configureProtocol();registerHandlers();
    if(process.env.MATERIAL_FINDER_IMPORT)await command('folder',process.env.MATERIAL_FINDER_IMPORT);
    await watchLibrary();ready=true;createWindow();
  }).catch(e=>{dialog.showErrorBox('资料快搜启动失败',String(e));writer.kill();reader.kill();app.exit(1);});
  app.on('activate',()=>{if(!window&&ready)createWindow();});app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();quitting=true;clearTimeout(changeTimer);void watcher?.close();
    const timeout=setTimeout(()=>{writer.kill();reader.kill();app.exit(0);},4000);
    Promise.allSettled([writer.request('close'),reader.request('close')]).finally(()=>{clearTimeout(timeout);writer.kill();reader.kill();app.exit(0);});
  });
}
