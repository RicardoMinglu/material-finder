import {open,readFile} from 'node:fs/promises';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Mac ARM64 installers must be built on Apple Silicon. Use the macos-15 CI job.');
const file=await open('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron','r');
try{const header=Buffer.alloc(8);await file.read(header,0,8,0);if(header.readUInt32LE(4)!==0x0100000c)throw new Error('Installed Electron runtime is not ARM64. Reinstall dependencies on Apple Silicon.');}finally{await file.close();}
const configured=JSON.parse(await readFile('package.json','utf8')).devDependencies.electron;
const installed=JSON.parse(await readFile('node_modules/electron/package.json','utf8')).version;
if(configured!==installed)throw new Error('Electron runtime version does not match the pinned package version.');
