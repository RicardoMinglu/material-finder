import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
if(process.platform!=='darwin')throw new Error('This OS-level offline harness is macOS-only. Verify Windows offline separately.');
const profile='(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))';
const probe=spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--input-type=module','-e',`try { await fetch('https://example.com',{signal:AbortSignal.timeout(5000)}); process.exit(1); } catch(e) { console.log(e.cause?.code || e.name); }`],{encoding:'utf8'});
if(probe.status!==0)throw new Error('Offline policy probe unexpectedly reached the network: '+probe.stderr);
await mkdir('artifacts/offline',{recursive:true});await writeFile('artifacts/offline/proof.json',JSON.stringify({policy:profile,externalFetchBlocked:true,probe:probe.stdout.trim(),scope:'Node, Electron, utility processes and OCR descendants; loopback allowed only for automation'},null,2));
const result=spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'scripts/smoke-electron.mjs'],{stdio:'inherit',env:{...process.env,MATERIAL_FINDER_NETWORK_BLOCKED:'1'}});
process.exitCode=result.status??1;
