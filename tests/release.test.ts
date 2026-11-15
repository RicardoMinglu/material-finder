import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store';
import { normalizeText, prepareQuery, rankText } from '../src/core/search';
import { collectCache } from '../src/core/cache';
import { LatestTask } from '../src/core/latest-task';

function add(store: Store, name: string, hash=name) { return store.upsertSource({path:`/library/${name}`,name,relativePath:name,hash,kind:'pdf',size:1,mtime:1}); }
function put(store: Store, hash:string, text:string, n=1) { return store.upsertUnit(hash,{key:`p${n}`,ordinal:n,locator:{type:'pdf',page:n},text,spans:[],needsOcr:false}); }
async function temp(t:any) { const p=await mkdtemp(path.join(os.tmpdir(),'finder-release-'));t.after(()=>rm(p,{recursive:true,force:true}));return p; }

// An independent exhaustive reference, deliberately slow on tiny generated cases.
function reference(text:string, terms:string[], phrase:string) {
  if(!terms.every(t=>text.includes(t)))return null;
  if(text.includes(phrase))return {exact:true,proximity:phrase.length};
  const events=terms.flatMap((term,i)=>{const hits=[];for(let at=0;at<text.length;at++)if(text.startsWith(term,at))hits.push({start:at,end:at+term.length,term:i});return hits;}).sort((a,b)=>a.start-b.start||a.end-b.end);
  let shortest=Infinity;
  for(let left=0;left<events.length;left++)for(let right=left;right<events.length;right++){
    const slice=events.slice(left,right+1);
    if(new Set(slice.map(x=>x.term)).size===terms.length)shortest=Math.min(shortest,Math.max(...slice.map(x=>x.end))-slice[0]!.start);
  }
  return {exact:false,proximity:shortest};
}
test('linear proximity and bounded candidates agree with an exhaustive reference',()=>{
  const db=new Store(':memory:');
  try {
    const queries=['甲 乙','甲甲 甲','乙 甲','甲 乙 丙','丙乙 乙','不存在'];
    let seed=7;const texts:string[]=[];
    for(let i=0;i<180;i++){let text='';for(let j=0;j<22;j++){seed=(seed*1664525+1013904223)>>>0;text+='甲乙丙丁'[(seed>>>16)%4];}text+=i%3?'甲乙':'甲间隔乙';texts.push(text);add(db,`d${i}`);put(db,`d${i}`,text);}
    for(const q of queries){const prepared=prepareQuery(q);const expected=texts.flatMap((text,i)=>{const r=reference(text,prepared.terms,prepared.phrase);assert.deepEqual(rankText(text,prepared),r);return r?[{i,...r}]:[];}).sort((a,b)=>Number(b.exact)-Number(a.exact)||a.proximity-b.proximity||a.i-b.i);
      for(const offset of [0,30,90,170]){const actual=db.search({text:q,offset,limit:30});assert.equal(actual.total,expected.length);assert.deepEqual(actual.hits.map(h=>h.name),expected.slice(offset,offset+30).map(x=>`d${x.i}`));}
    }
  }finally{db.close();}
});
test('read-only query cache invalidates after commits from an independent writer',async t=>{
  const dir=await temp(t), dbPath=path.join(dir,'library.sqlite');const writer=new Store(dbPath),reader=new Store(dbPath,{readOnly:true});
  try{add(writer,'a');put(writer,'a','采购与审批');assert.equal(reader.search({text:'采购'}).total,1);put(writer,'a','只有新内容');assert.equal(reader.search({text:'采购'}).total,0);assert.equal(reader.search({text:'新内容'}).total,1);}finally{reader.close();writer.close();}
});
test('document list pages and literal filters do not leak into summary state',()=>{
  const db=new Store(':memory:');try{for(let i=0;i<205;i++){add(db,`类别/a_${i}`);if(i%2===0)db.setStatus(`类别/a_${i}`,'error','test');}
    assert.equal(db.listPage().files.length,100);assert.equal(db.listPage({offset:200}).files.length,5);assert.equal(db.listPage({status:'error'}).total,103);assert.equal(db.listPage({text:'a_'}).total,205);assert.equal(db.listPage({text:'%'}).total,0);assert.ok(!('files' in db.getState()));assert.equal(db.getState().counts.pdf,205);
  }finally{db.close();}
});
test('adjacent preview follows ordinals even when pages were inserted in reverse order',()=>{
 const db=new Store(':memory:');try{const d=add(db,'a');put(db,'a','third',3);const second=put(db,'a','second',2);put(db,'a','first',1);const p=db.previewParts(d.id,second.id,'second');assert.equal(p.before.at(-1)!.text,'first');assert.equal(p.after[0]!.text,'third');assert.throws(()=>db.previewParts(999,second.id,''));}finally{db.close();}
});
test('only unreferenced owned cache entries are collected, never originals or symlink targets',async t=>{
 const dir=await temp(t),root=path.join(dir,'cache');await mkdir(path.join(root,'sources'),{recursive:true});const keep='a'.repeat(64),drop='b'.repeat(64),linked='c'.repeat(64);
 await writeFile(path.join(root,'sources',keep+'.pdf'),'keep');await writeFile(path.join(root,'sources',drop+'.pdf'),'obsolete');await writeFile(path.join(root,'README'),'unknown');const original=path.join(dir,'original.pdf');await writeFile(original,'original');await symlink(original,path.join(root,'sources',linked+'.pdf'));
 assert.equal(await collectCache(root,new Set([keep])),1);await access(original);await access(path.join(root,'sources',keep+'.pdf'));await access(path.join(root,'README'));await assert.rejects(access(path.join(root,'sources',drop+'.pdf')));
});
test('rapid searches run first and newest only; failures do not wedge the queue',async()=>{
 let release!:()=>void;const barrier=new Promise<void>(r=>release=r),seen:number[]=[];
 const queue=new LatestTask<number,number>(async n=>{seen.push(n);if(n===1)await barrier;if(n===4)throw new Error('worker gone');return n;});
 const first=queue.submit(1);const middle=queue.submit(2).catch(e=>e.message);const last=queue.submit(3);release();assert.equal(await first,1);assert.equal(await middle,'SEARCH_SUPERSEDED');assert.equal(await last,3);assert.deepEqual(seen,[1,3]);await assert.rejects(queue.submit(4),/worker gone/);assert.equal(await queue.submit(5),5);
});
test('a copied 1.0.1 database keeps source/unit identities, pause state, and schema',async t=>{
 const dir=await temp(t),old=path.join(dir,'old.sqlite'),next=path.join(dir,'next.sqlite');const legacy=new DatabaseSync(old);legacy.exec(await readFile('tests/fixtures/schema-1.0.1.sql','utf8'));
 const text='保留旧版资料原文',norm=normalizeText(text);legacy.prepare('INSERT INTO meta VALUES (?,?)').run('rootPath',JSON.stringify('/library'));legacy.prepare('INSERT INTO meta VALUES (?,?)').run('paused','true');legacy.prepare("INSERT INTO contents(hash,status,extracted) VALUES ('legacy','ready',1)").run();legacy.prepare("INSERT INTO sources(id,path,relative_path,name,kind,size,mtime,hash) VALUES (7,'/library/旧版.pdf','旧版.pdf','旧版.pdf','pdf',123,456,'legacy')").run();legacy.prepare('INSERT INTO units(id,content_hash,unit_key,ordinal,locator,text,spans,needs_ocr,normalized,offsets) VALUES (?,?,?,?,?,?,?,?,?,?)').run(13,'legacy','page-1',1,JSON.stringify({type:'pdf',page:1}),text,'[]',0,norm.text,JSON.stringify({starts:norm.starts,ends:norm.ends}));
 const schema=legacy.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();legacy.close();await copyFile(old,next);const db=new Store(next);try{const hit=db.search({text:'旧版'}).hits[0]!;assert.equal(hit.documentId,7);assert.equal(hit.unitId,13);assert.equal(db.getState().progress.phase,'paused');assert.equal(db.getState().stats.ocrPending,0);}finally{db.close();}
 const check=new DatabaseSync(next);assert.deepEqual(check.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),schema);check.close();
});
