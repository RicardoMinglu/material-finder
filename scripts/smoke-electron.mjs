import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, rm, copyFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const root = process.cwd();
GlobalFonts.registerFromPath(path.join(root, 'resources/fonts/NotoSansCJKsc-Regular.otf'), 'FixtureCJK');
const executablePath = process.env.MATERIAL_FINDER_EXECUTABLE;
const testData = path.join(root, executablePath ? 'artifacts/ui-smoke-packaged' : 'artifacts/ui-smoke');
const fixtureDir = path.join(root, 'artifacts/ui-fixtures');
const shots = path.join(root, executablePath ? 'output/playwright/packaged' : 'output/playwright');
const hasCorpus = false;
const fixtureMode = 'generated';
const pdfQuery = 'Responsibility';
const pdfFirstPageQuery = 'Responsibility';
function nativePdfFixture() {
  const content = 'BT /F1 18 Tf 36 720 Td (Responsibility for local document search 4827) Tj ET\n';
  const secondContent = 'BT /F1 18 Tf 36 720 Td (Following page about local material sources and answers.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(secondContent)} >>\nstream\n${secondContent}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
function unicodeRtf(text) {
  return [...text].map(char => { const value = char.charCodeAt(0); return `\\u${value > 32767 ? value - 65536 : value}?`; }).join('');
}
await rm(testData, { recursive: true, force: true });
await rm(fixtureDir, { recursive: true, force: true });
await mkdir(fixtureDir, { recursive: true });
await mkdir(shots, { recursive: true });
await writeFile(path.join(fixtureDir, '责任感知识点.pdf'), nativePdfFixture());
await writeFile(path.join(fixtureDir, '职业锚的自我评价.doc'), `{\\rtf1\\ansi\\ansicpg936\\uc1 \\'d6\\'b0\\'d2\\'b5\\par ${unicodeRtf('职业发展与本地资料查询')}\\par Offline search works.}`);
const application = await electron.launch({ executablePath, args: [...(executablePath ? [] : [root]), ...(process.env.MATERIAL_FINDER_NETWORK_BLOCKED==='1'?['--no-sandbox']:[])], cwd: root, env: { ...process.env, MATERIAL_FINDER_DATA: testData, MATERIAL_FINDER_IMPORT: '' }, timeout: 60000 });
const errors = [];
const externalRequests = [];
const processLogs = [];
application.process().stderr?.on('data', data => processLogs.push(data.toString()));
async function waitForState(page, predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    // waitForFunction treats an async predicate's Promise as truthy in this
    // Playwright version, so explicitly await the IPC result outside the page.
    state = await page.evaluate(() => window.materialFinder.getState());
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({ stats: state?.stats, progress: state?.progress })}`);
}
try {
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.getByRole('heading', { name: '不用再一份一份翻了。' }).waitFor();
  await page.screenshot({ path: path.join(shots, 'empty.png') });
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixtureDir);
  await page.getByRole('button', { name: '选择资料文件夹', exact: true }).click();
  await waitForState(page, state => state.stats.total === 2 && state.stats.ready === 2 && state.stats.ocrPending === 0 && state.progress.phase === 'idle', 'the two initial documents to finish indexing');
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill(pdfQuery);
  const pdfResult = page.locator('.result-card').filter({ has: page.getByRole('heading', { name: '责任感知识点.pdf', exact: true }) }).first();
  await pdfResult.waitFor();
  await pdfResult.click();
  await page.waitForFunction(() => { const canvas = document.querySelector('.pdf-sheet canvas'); return canvas && canvas.width > 100 && !document.querySelector('.pdf-sheet.is-loading') && document.querySelectorAll('.match-rect').length > 0; }, null, { timeout: 30000 });
  await page.screenshot({ path: path.join(shots, 'search.png') });
  const canvasStats = await page.locator('.pdf-sheet canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  assert.ok(canvasStats.width > 100);
  assert.ok(await page.locator('.match-rect').count() > 0);
  await page.getByTitle('查看提取文字').click();
  assert.ok(await page.locator('.main-text mark').count() > 0);
  await page.getByRole('button', { name: /Word 文档/ }).click();
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill('职业');
  await page.locator('.result-card').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.main-text')?.textContent?.includes('职业'));
  await page.screenshot({ path: path.join(shots, 'word.png') });
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill('这句测试文字肯定不存在xyz007');
  await page.getByRole('heading', { name: '暂时没有找到匹配内容' }).waitFor();
  await page.getByRole('button', { name: '资料管理', exact: true }).click();
  await page.getByRole('dialog', { name: '资料管理' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.managed-file').length === 2);
  assert.equal(await page.locator('.managed-file').count(), 2);
  await page.getByRole('checkbox', { name: '只看失败' }).check();
  await page.getByText('没有失败的文件', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭资料管理' }).click();

  // Reading an adjacent page must survive unrelated OCR completions. Keep a
  // handle to the actual canvas to detect even a brief unmount/reload.
  await page.getByRole('button', { name: /PDF 文档/ }).click();
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill(pdfFirstPageQuery);
  await pdfResult.waitFor();
  await pdfResult.click();
  await page.waitForFunction(() => document.querySelector('.pdf-sheet canvas') && !document.querySelector('.pdf-sheet.is-loading'));
  await page.getByRole('button', { name: '下一页或下一段', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.location-pill')?.textContent === '第 2 页' && !document.querySelector('.pdf-sheet.is-loading'));
  const readingCanvas = await page.locator('.pdf-sheet canvas').elementHandle();

  const canvas = createCanvas(1600, 3200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1600, 3200); ctx.fillStyle = '#111'; ctx.font = '40px FixtureCJK';
  for (let i = 0; i < 40; i++) ctx.fillText(`Offline document search line ${i + 1}`, 60, 80 + i * 70);
  await writeFile(path.join(fixtureDir, 'offline-image.png'), canvas.toBuffer('image/png'));
  await writeFile(path.join(fixtureDir, '损坏文档.pdf'), 'this is not a valid PDF');
  await page.evaluate(() => window.materialFinder.refresh());
  await waitForState(page, state => state.stats.total === 4, 'the new image and invalid PDF to be discovered');
  await page.evaluate(() => window.materialFinder.pause());
  await waitForState(page, state => state.progress.phase === 'paused', 'the indexing queue to pause', 30000);
  await page.getByRole('button', { name: '资料管理', exact: true }).click();
  await page.getByRole('button', { name: '继续处理', exact: true }).last().click();
  await waitForState(page, state => state.stats.ready === 3 && state.stats.errors === 1 && state.stats.ocrPending === 0 && state.progress.phase === 'idle', 'background OCR to fully finish', 120000);
  await page.waitForTimeout(350); // Allow the 180 ms background-search debounce to settle.
  assert.equal(await page.locator('.location-pill').textContent(), '第 2 页', 'Background indexing must preserve an adjacent page outside search results');
  assert.equal(await readingCanvas.evaluate(canvas => canvas.isConnected), true, 'Background OCR must not unmount the current PDF canvas');
  await page.getByRole('checkbox', { name: '只看失败' }).check();
  await page.locator('.managed-file.error').waitFor();
  await page.screenshot({ path: path.join(shots, 'files.png') });
  await page.getByRole('button', { name: '关闭资料管理' }).click();
  await page.locator('.type-navigation').getByRole('button', { name: /图片/ }).click();
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill('Offline');
  await page.locator('.result-card').first().waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('.image-sheet img'); return image && image.complete && image.naturalWidth > 0 && document.querySelectorAll('.match-rect').length > 0; });
  await page.screenshot({ path: path.join(shots, 'image.png') });
  await page.getByRole('button', { name: /PDF 文档/ }).click();
  await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill(pdfQuery);
  await page.locator('.result-card').filter({ has: page.getByRole('heading', { name: '责任感知识点.pdf', exact: true }) }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.search-box.searching') && document.querySelector('.pdf-sheet canvas'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.waitForFunction(() => window.innerWidth <= 1050);
  await page.waitForFunction(() => !document.querySelector('.pdf-sheet.is-loading'));
  await page.screenshot({ path: path.join(shots, 'compact.png') });
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(overflow.content <= overflow.viewport + 1, `Horizontal overflow: ${JSON.stringify(overflow)}`);
  assert.deepEqual(externalRequests, [], 'Offline UI must not make external HTTP requests');
  assert.deepEqual(errors, [], 'Renderer page errors');
  await page.getByRole('button', {name:'复制片段及出处',exact:true}).click();
  await page.getByText('已复制片段及出处',{exact:true}).waitFor();
  const citation=await application.evaluate(({clipboard})=>clipboard.readText());
  assert.ok(citation.includes('Responsibility') && citation.includes('责任感知识点.pdf') && citation.includes('第 1 页'));
  assert.ok(!citation.includes(fixtureDir),'Citation must not expose absolute library paths');
  const originalRoot=(await page.evaluate(()=>window.materialFinder.getState())).library.rootPath;
  const alternate=path.join(root,'artifacts/alternate-library');await mkdir(alternate,{recursive:true});
  await application.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});},alternate);
  assert.equal(await page.evaluate(()=>window.materialFinder.chooseFolder()),null);
  assert.equal((await page.evaluate(()=>window.materialFinder.getState())).library.rootPath,originalRoot);
  // Kill each utility process only in this isolated test application.
  for(const service of ['资料快搜 · 资料查询','资料快搜 · 文档索引']) {
    const metrics=await application.evaluate(({app})=>app.getAppMetrics().map(m=>({pid:m.pid,name:m.name,serviceName:m.serviceName,type:m.type})));
    const processInfo=metrics.find(m=>m.name===service||m.serviceName===service);
    assert.ok(processInfo,`Missing utility process ${service}: ${JSON.stringify(metrics)}`);
    await application.evaluate((_electron,pid)=>process.kill(pid,'SIGKILL'),processInfo.pid);
    await page.waitForTimeout(300);
    if(service.endsWith('资料查询'))assert.ok((await page.evaluate(q=>window.materialFinder.search({text:q}),pdfQuery)).total>0);
    else {await page.evaluate(()=>window.materialFinder.refresh());await waitForState(page,s=>s.progress.phase==='idle'&&s.stats.ready===3,'index worker recovery');}
  }
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,600));
  await page.waitForTimeout(200);
  const small=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(small.scroll<=small.w+1,`800px overflow: ${JSON.stringify(small)}`);
  await page.screenshot({path:path.join(shots,'minimum.png')});
  await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await page.evaluate(()=>window.materialFinder.chooseFolder());
  await waitForState(page,s=>s.library.rootPath===alternate&&s.stats.total===0&&s.progress.phase==='idle','confirmed root replacement');
  await access(path.join(fixtureDir,'责任感知识点.pdf'));
  const report = { ok: true, timestamp: new Date().toISOString(), platform: process.platform, packaged: !!executablePath, fixtureMode, stateWaits: 'awaited IPC polling', copyCitation:true, rootSwitchCancelAndConfirm:true, utilityCrashRecovery:true, networkBlocked:process.env.MATERIAL_FINDER_NETWORK_BLOCKED==='1', preservedPreviewDuringOcr: true, screenshots: shots, canvasStats, externalRequests, rendererErrors: errors, state: await page.evaluate(() => window.materialFinder.getState()) };
  await writeFile(path.join(shots, 'smoke-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(processLogs.slice(-10).join('\n'));
  const windows = application.windows();
  if (windows[0]) await windows[0].screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  throw error;
} finally { await application.close(); }
