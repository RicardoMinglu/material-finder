import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync, strToU8 } from 'fflate';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fontPath=path.join(root,'resources/fonts/NotoSansCJKsc-Regular.otf');
GlobalFonts.registerFromPath(fontPath,'FixtureCJK');
const fontBytes=await readFile(fontPath);
const description='这是一份资料快搜原创验证文档，仅包含虚构的办公与学习内容。采购流程需要记录申请日期、负责人员和审批结果，历史记录用于核对原文。';
function bitmap(title, lines, height=1100) {
 const c=createCanvas(1600,height),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,1600,height);x.fillStyle='#183e38';x.font='52px FixtureCJK';x.fillText(title,90,130);x.fillStyle='#222';x.font='38px FixtureCJK';
 lines.forEach((line,i)=>x.fillText(line,90,240+i*80));return c.toBuffer('image/png');
}
function wrap(text,n=30){const a=[];for(let i=0;i<text.length;i+=n)a.push(text.slice(i,i+n));return a;}
async function nativePdf(pages) {
 const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);const font=await pdf.embedFont(fontBytes,{subset:true});
 for(const [i,text]of pages.entries()){const p=pdf.addPage([595,842]);p.drawText('资料快搜 · 原创示例',{x:45,y:780,size:20,font,color:rgb(.1,.3,.25)});wrap(text).forEach((line,j)=>p.drawText(line,{x:45,y:730-j*22,size:13,font}));p.drawText(String(i+1),{x:530,y:35,size:11,font});}
 return pdf.save();
}
async function scanPdf(images){const pdf=await PDFDocument.create();for(const bytes of images){const image=await pdf.embedPng(bytes),height=595*image.height/image.width,p=pdf.addPage([595,height]);p.drawImage(image,{x:0,y:0,width:595,height});}return pdf.save();}
function docx(paragraphs, image) {
 const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
 const imageParagraph=image?'<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>':'';
 const files={
 '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
 '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
 'word/document.xml':strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.map(t=>`<w:p><w:r><w:t>${escape(t)}</w:t></w:r></w:p>`).join('')}${imageParagraph}</w:body></w:document>`),
 };
 if(image){files['word/_rels/document.xml.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>');files['word/media/image.png']=image;}
 return zipSync(files);
}
function rtf(text){return `{\\rtf1\\ansi\\ansicpg936\\uc1 ${[...text].map(c=>c.charCodeAt(0)>127?`\\u${c.charCodeAt(0)>32767?c.charCodeAt(0)-65536:c.charCodeAt(0)}?`:c).join('')}}`;}
export async function qualityFixtures(destination){
 await mkdir(destination,{recursive:true});const cases=[];
 async function save(file,bytes){await writeFile(path.join(destination,file),bytes);}
 const nativePages=[];
 for(let i=0;i<40;i++){const id=210000+i,text=`档案编号 ${id}。${description}请查询采购流程与审批记录。`;nativePages.push(text);cases.push({query:`档案编号 ${id}`,file:'办公手册.pdf',page:i+1,group:'native'});}
 await save('办公手册.pdf',await nativePdf(nativePages));
 const scans=[];
 for(let i=0;i<30;i++){const id=320000+i;scans.push(bitmap('扫描档案', [`档案编号 ${id}`,'请核对采购流程与审批记录。','此页是原创测试资料，非真实业务文件。']));cases.push({query:`档案编号 ${id}`,file:'扫描档案.pdf',page:i+1,group:'ocr'});}
 await save('扫描档案.pdf',await scanPdf(scans));
 for(let i=0;i<10;i++){const id=430000+i,file=`图片笔记-${i}.png`;await save(file,bitmap('课堂笔记',[`资料编号 ${id}`,'工作效率与学习方法。','整理资料时请保留原始出处。']));cases.push({query:`资料编号 ${id}`,file,group:'ocr'});}
 for(let i=0;i<10;i++){const id=540000+i,file=`项目记录-${i}.docx`;await save(file,docx([`项目编号 ${id}`,description]));cases.push({query:`项目编号 ${id}`,file,group:'native'});}
 for(let i=0;i<10;i++){const id=650000+i,file=`历史记录-${i}.doc`;await save(file,rtf(`记录编号 ${id}。${description}`));cases.push({query:`记录编号 ${id}`,file,group:'native'});}
 for(let i=0;i<5;i++){const id=760000+i,file=`内嵌图片-${i}.docx`;await save(file,docx([description],bitmap('文档内嵌图片',[`图片编号 ${id}`,'此图片需要离线文字识别。'])));cases.push({query:`图片编号 ${id}`,file,group:'ocr'});}
 const longLines=Array.from({length:35},(_,i)=>i===31?'长图编号 870031':'资料整理需要保留出处并核对原文。');await save('长图笔记.png',bitmap('长图识别示例',longLines,3300));cases.push({query:'长图编号 870031',file:'长图笔记.png',group:'ocr'});
 // Difficult examples are reported separately and are not used to tune the clear-print gate.
 const difficult=createCanvas(1600,1100),ctx=difficult.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1600,1100);ctx.translate(200,230);ctx.rotate(.12);ctx.fillStyle='#999';ctx.font='26px FixtureCJK';ctx.fillText('困难样本编号 980001，倾斜且低对比度。',0,0);await save('困难样本.png',difficult.toBuffer('image/png'));cases.push({query:'困难样本编号 980001',file:'困难样本.png',group:'difficult'});
 const distorted=await PDFDocument.create(),distortedImage=await distorted.embedPng(bitmap('变形扫描样本',['变形编号 980002','此页故意拉伸，用于报告困难样本效果。']));distorted.addPage([595,842]).drawImage(distortedImage,{x:0,y:0,width:595,height:842});await save('变形扫描.pdf',await distorted.save());cases.push({query:'变形编号 980002',file:'变形扫描.pdf',page:1,group:'difficult'});
 await writeFile(path.join(path.dirname(destination),'quality-cases.json'),JSON.stringify(cases,null,2));return cases;
}
export async function scaleFixtures(destination){
 await mkdir(destination,{recursive:true});
 for(let d=0;d<100;d++){
  const dir=path.join(destination,`分类${d%5}`);await mkdir(dir,{recursive:true});
  const pages=Array.from({length:100},(_,p)=>`文档编号 ${100000+d}，页面编号 ${200000+d*100+p}。${description.repeat(7)}${p%17===0?'保密协议解除条件需要双方书面确认。':''}`);
  await writeFile(path.join(dir,`资料${String(d).padStart(3,'0')}.pdf`),await nativePdf(pages));
 }
 return {files:100,pages:10000};
}
export async function demoFixtures(destination){
 await mkdir(destination,{recursive:true});
 await writeFile(path.join(destination,'项目归档手册.pdf'),await nativePdf(['归档编号 202601。'+description+'归档完成后应核对原始记录。','文档保管应保留来源。'+description]));
 await writeFile(path.join(destination,'扫描会议记录.pdf'),await scanPdf([bitmap('会议记录 · 扫描件',['项目采购需要两级审批。','每次审批均需保存负责人和日期。','会议决定：本周完成归档清单。'])]));
 await writeFile(path.join(destination,'工作笔记.docx'),docx(['资料整理工作笔记',description,'采购审批完成后，请复制原文出处以便核对。']));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const mode=process.argv[2]??'quality',dir=path.resolve(process.argv[3]??`artifacts/${mode}/library`);
 console.log(JSON.stringify(mode==='scale'?await scaleFixtures(dir):mode==='demo'?await demoFixtures(dir):{queries:(await qualityFixtures(dir)).length,directory:dir}));
}
