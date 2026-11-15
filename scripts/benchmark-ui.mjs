import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),data=path.join(root,'artifacts/scale/profile');
const executablePath=process.env.MATERIAL_FINDER_EXECUTABLE;
const application=await electron.launch({executablePath,args:executablePath?[]:[root],env:{...process.env,MATERIAL_FINDER_DATA:data,MATERIAL_FINDER_IMPORT:''}});
try{
 const page=await application.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('textbox',{name:'搜索资料',exact:true}).waitFor();
 const deadline=Date.now()+120000;
 for(;;){const s=await page.evaluate(()=>window.materialFinder.getState());if(s.stats.units===10000&&s.progress.phase==='idle')break;if(Date.now()>deadline)throw new Error('Scale profile not fully indexed');await page.waitForTimeout(300);}
 const box=page.getByRole('textbox',{name:'搜索资料',exact:true});
 const results=[];
 for(let i=-6;i<120;i++){
  const at=(i+6)%6;
  const q=['保密协议解除条件','资料','采购 审批','历史记录','找不到的内容编号',`页面编号 ${200000+Math.max(0,i)}`][at];
  await page.evaluate(()=>performance.clearMeasures('material-finder:search-to-render'));
  await box.fill(q);
  await page.waitForFunction(q=>performance.getEntriesByName('material-finder:search-to-render').some(e=>e.detail.query===q),q);
  const measure=await page.evaluate(()=>{const e=performance.getEntriesByName('material-finder:search-to-render').at(-1);return {query:e.detail.query,elapsedMs:e.duration};});
  if(i>=0)results.push(measure);
 }
 const sorted=results.map(x=>x.elapsedMs).sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1];
 const metrics=await application.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,name:m.name,memory:m.memory,cpu:m.cpu})));
 const report={platform:process.platform,packaged:!!executablePath,queryCount:results.length,p50Ms:sorted[59],p95Ms:p95,maxMs:sorted.at(-1),gateMs:500,passed:p95<=500,measurement:'Renderer IPC submission to committed result DOM at next animation frame; excludes 180ms input debounce and PDF render.',results,metrics,rendererErrors:errors};
 await mkdir('artifacts/scale',{recursive:true});await writeFile('artifacts/scale/ui-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({queryCount:results.length,p95Ms:p95,maxMs:sorted.at(-1),passed:report.passed}));
 assert.deepEqual(errors,[]);assert.ok(report.passed,`P95 ${p95} exceeds 500ms`);
}finally{await application.close();}
