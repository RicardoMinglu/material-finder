import { Indexer } from '../core/indexer';
import type { AppState } from '../shared/types';
const port = process.parentPort;
if (!port) throw new Error('Index worker must be launched as an Electron utility process.');
let indexer: Indexer;
let commands = Promise.resolve();
port.on('message', ({ data }: { data: { id?: number; command: string; payload?: any } }) => {
  commands = commands.then(async () => {
    try {
      if (data.command === 'init') {
        indexer = new Indexer({ ...data.payload, onState: (state: AppState) => port.postMessage({ type: 'state', state }) });
        indexer.start();
      } else if (data.command === 'folder') await indexer.selectFolder(data.payload);
      else if (data.command === 'refresh') indexer.refresh();
      else if (data.command === 'pause') indexer.pause();
      else if (data.command === 'resume') indexer.resume();
      else if (data.command === 'retry') await indexer.retry(data.payload);
      else if (data.command === 'close') await indexer.close();
      if (data.id !== undefined) port.postMessage({ type: 'reply', id: data.id, result: true });
    } catch (error) {
      port.postMessage({ type: 'reply', id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
