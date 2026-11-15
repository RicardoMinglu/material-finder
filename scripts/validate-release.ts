import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Indexer } from '../src/core/indexer';
import { directoryBytes } from '../src/core/cache';
const mode=process.argv[2]??'quality';
const base=path.resolve(`artifacts/${mode}`),library=path.join(base,'library'),data=path.join(base,'profile');
const fresh=process.argv.includes('--fresh');
if(fresh)await rm(data,{recursive:true,force:true});
await mkdir(data,{recursive:true});
let peakRss=process.memoryUsage().rss,firstOcr:number|undefined,finishedNative:number|undefined;
const start=performance.now();let lastLog=0;
const meter=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);
const indexer=new Indexer({dbPath:path.join(data,'library.sqlite'),cacheDir:path.join(data,'cache'),ocrDataDir:path.resolve('resources/ocr'),onState(s){
 if(s.progress.phase==='ocr'&&firstOcr===undefined){firstOcr=performance.now();finishedNative=firstOcr-start;}
 if(performance.now()-lastLog>15000){lastLog=performance.now();console.log(JSON.stringify({mode,seconds:Math.round((performance.now()-start)/1000),...s.stats,phase:s.progress.phase}));}
}});
try{
 await indexer.selectFolder(library);await indexer.waitForIdle();
 const finish=performance.now(),state=indexer.state();
 const baseReport={mode,fresh,networkBlocked:process.env.MATERIAL_FINDER_NETWORK_BLOCKED==='1',platform:os.platform(),cpu:os.cpus()[0]?.model,memoryGiB:os.totalmem()/2**30,seconds:(finish-start)/1000,nativeSeconds:(finishedNative??finish-start)/1000,ocrSeconds:firstOcr===undefined?0:(finish-firstOcr)/1000,peakProcessRssMiB:peakRss/2**20,stats:state.stats};
 let details:any;
 if(mode==='quality'){
  const cases=JSON.parse(await readFile(path.join(base,'quality-cases.json'),'utf8')) as Array<{query:string;file:string;page?:number;group:string}>;
  const results=cases.map(c=>{const r=indexer.store.search({text:c.query,limit:5});const rank=r.hits.findIndex(h=>h.relativePath===c.file&&(c.page===undefined||h.locator.type==='pdf'&&h.locator.page===c.page));return {...c,passed:rank>=0,rank:rank<0?null:rank+1,hits:r.total};});
  const groups=Object.fromEntries(['native','ocr','difficult'].map(group=>{const a=results.filter(x=>x.group===group);return [group,{total:a.length,passed:a.filter(x=>x.passed).length,rate:a.filter(x=>x.passed).length/a.length}];}));
  details={groups,results,ocrUnitsPerSecond:firstOcr?results.filter(x=>x.group==='ocr').length/((finish-firstOcr)/1000):null};
  if(groups.native.rate!==1||groups.ocr.rate<.9)process.exitCode=1;
 }else{
  const queries=Array.from({length:120},(_,i)=>({text:['保密协议解除条件','资料','采购 审批','历史记录','不存在的文档内容','页面编号 '+(200000+i)][i%6]!,offset:i%4*30,limit:30,folder:i%7===0?'分类1':undefined}));
  const results=queries.map(q=>({...q,...(()=>{const x=indexer.store.search(q);return {total:x.total,elapsedMs:x.elapsedMs};})()}));
  const sorted=results.map(r=>r.elapsedMs).sort((a,b)=>a-b);details={queries:results,queryP95Ms:sorted[Math.ceil(sorted.length*.95)-1],measurement:'core query only; UI benchmark is separate'};
  if(state.stats.units!==10000)process.exitCode=1;
 }
 const report={...baseReport,...details,indexAndCacheBytes:await directoryBytes(data),fileErrors:indexer.store.listDocuments().filter(d=>d.status==='error').map(d=>({file:d.relativePath,error:d.error}))};
 await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...baseReport,...(details.groups?{groups:details.groups}:{queryP95Ms:details.queryP95Ms})}));
 if(state.stats.errors||state.stats.queued||state.stats.ocrPending)process.exitCode=1;
}finally{clearInterval(meter);await indexer.close();}
