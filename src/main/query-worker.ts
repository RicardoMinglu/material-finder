import { Store } from '../core/store';
const port = process.parentPort;
if (!port) throw new Error('Query worker requires an Electron utility process.');
let store: Store;
port.on('message', ({ data }: { data: { id: number; command: string; payload?: any } }) => {
  try {
    const p = data.payload;
    let result: unknown;
    switch (data.command) {
      case 'init': store = new Store(p.dbPath, { readOnly: true }); result = true; break;
      case 'state': result = store.getState(p); break;
      case 'search': result = store.search(p); break;
      case 'list': result = store.listPage(p); break;
      case 'document': result = store.getDocument(p); break;
      case 'library': result = store.getLibrary(); break;
      case 'preview': result = store.previewParts(p.documentId, p.unitId, p.query); break;
      case 'image': {
        const unit = store.getUnit(p);
        // Find through the content relation, not a capped document list.
        result = unit ? { unit, document: store.sourceForHash(unit.contentHash) } : undefined; break;
      }
      case 'close': store?.close(); result = true; break;
      default: throw new Error('未知查询操作。');
    }
    port.postMessage({ type: 'reply', id: data.id, result });
  } catch (e) { port.postMessage({ type: 'reply', id: data.id, error: e instanceof Error ? e.message : String(e) }); }
});
