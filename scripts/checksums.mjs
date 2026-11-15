import { readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const lines=[];
for(const file of (await readdir('release')).filter(n=>/\.(exe|dmg)$/.test(n)).sort()){
 const hash=createHash('sha256');for await(const chunk of createReadStream(`release/${file}`))hash.update(chunk);lines.push(`${hash.digest('hex')}  ${file}`);
}
if(!lines.length)throw new Error('No installer artifacts found.');
await writeFile('release/SHA256SUMS.txt',lines.join('\n')+'\n');console.log(lines.join('\n'));
