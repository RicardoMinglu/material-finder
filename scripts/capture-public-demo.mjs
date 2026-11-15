import {_electron as electron} from 'playwright';
import {mkdir,rm,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {demoFixtures} from './fixtures.mjs';
const root=process.cwd(),work=path.join(root,'artifacts/demo'),library=path.join(work,'演示资料'),profile=path.join(work,'profile'),shots=path.join(root,'output/playwright/demo');
await rm(work,{recursive:true,force:true});await mkdir(shots,{recursive:true});await mkdir('docs/images',{recursive:true});await demoFixtures(library);
const executablePath=process.env.MATERIAL_FINDER_EXECUTABLE;
const app=await electron.launch({executablePath,args:executablePath?[]:[root],env:{...process.env,MATERIAL_FINDER_DATA:profile,MATERIAL_FINDER_IMPORT:''}});
let recording=false,recordTask,frames=[];
const frameDir=path.join(shots,'frames');await mkdir(frameDir,{recursive:true});
const logs=[];app.process().stderr.on('data',d=>logs.push(d.toString()));
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'选择资料文件夹',exact:true}).waitFor();
 recording=true;recordTask=(async()=>{while(recording){const start=Date.now(),file=path.join(frameDir,`${String(frames.length).padStart(5,'0')}.png`);await page.screenshot({path:file});frames.push({file,time:start});await new Promise(r=>setTimeout(r,Math.max(0,200-(Date.now()-start))));}})();
 await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},library);
 await page.waitForTimeout(2500);await page.getByRole('button',{name:'选择资料文件夹',exact:true}).click();
 for(let i=0;i<120;i++){const s=await page.evaluate(()=>window.materialFinder.getState());if(s.stats.ready===3&&s.progress.phase==='idle')break;await page.waitForTimeout(250);if(i===119)throw new Error('Demo OCR incomplete');}
 await page.getByRole('textbox',{name:'搜索资料',exact:true}).fill('采购 审批');await page.locator('.result-card').first().waitFor();
 const scan=page.locator('.result-card').filter({has:page.getByRole('heading',{name:'扫描会议记录.pdf',exact:true})});await scan.click();
 await page.waitForFunction(()=>document.querySelector('.pdf-sheet canvas')&&!document.querySelector('.pdf-sheet.is-loading'));
 await page.screenshot({path:path.join(shots,'search.png')});await copyFile(path.join(shots,'search.png'),'docs/images/search.png');
 await page.waitForTimeout(6000);await page.getByRole('button',{name:'复制片段及出处',exact:true}).click();await page.getByText('已复制片段及出处',{exact:true}).waitFor();await page.waitForTimeout(1800);
 await page.getByRole('button',{name:'文字',exact:true}).click();await page.waitForTimeout(3500);
 await page.getByRole('button',{name:'资料管理',exact:true}).click();await page.getByText('本机存储',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.managed-file').length===3);await page.screenshot({path:path.join(shots,'management.png')});await page.waitForTimeout(5000);
 await page.getByRole('button',{name:'关闭资料管理',exact:true}).click();await page.getByRole('button',{name:'文字',exact:true}).click();await page.waitForTimeout(3500);
 recording=false;await recordTask;
}catch(e){console.error(logs.slice(-10).join(''));const page=app.windows()[0];if(page){await page.screenshot({path:path.join(shots,'failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,2000));}throw e;}finally{recording=false;await recordTask?.catch(()=>{});await app.close();}
const output=path.join(shots,'material-finder-demo.mp4'),list=path.join(shots,'frames.txt');
await writeFile(list,frames.map((f,i)=>`file '${f.file}'\nduration ${i+1<frames.length?(frames[i+1].time-f.time)/1000:.2}`).join('\n')+`\nfile '${frames.at(-1).file}'\n`);
const result=spawnSync('ffmpeg',['-y','-f','concat','-safe','0','-i',list,'-vf','fps=30,scale=1440:940,setsar=1','-c:v','libx264','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',output],{encoding:'utf8'});
if(result.status!==0)throw new Error(result.stderr||'ffmpeg is required to encode the demo.');
await writeFile(path.join(shots,'demo.json'),JSON.stringify({video:output,frames:frames.length,seconds:(frames.at(-1).time-frames[0].time)/1000,originalFixtures:true},null,2));console.log(output);
