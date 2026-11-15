import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Indexer } from '../src/core/indexer';
import type { AppState } from '../src/shared/types';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const root = option('--root');
if (!root) throw new Error('Usage: npm run corpus -- --root /path/to/library --data /path/to/app-data [--native-only]');
const data = path.resolve(option('--data') ?? 'artifacts/corpus');
await mkdir(data, { recursive: true });
const started = Date.now();
let lastPrint = 0;
let indexer: Indexer;
let lastState: AppState | undefined;
indexer = new Indexer({ dbPath: path.join(data, 'library.sqlite'), cacheDir: path.join(data, 'cache'), ocrDataDir: path.resolve('resources/ocr'),
  onState(state) {
    lastState = state;
    if (args.includes('--native-only') && state.progress.phase === 'ocr') indexer.pause();
    if (Date.now() - lastPrint > 15000 || state.progress.phase === 'idle') {
      console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), ...state.stats, progress: state.progress }));
      lastPrint = Date.now();
    }
  },
});
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; indexer.pause(); });
try {
  await indexer.selectFolder(root);
  await indexer.waitForIdle();
  const state = lastState ?? indexer.state();
  const queries = ['资料', '管理', '工作效率', '采购 审批', '2026', 'the', '完全不存在的随机检索词xyz987654'];
  const searches = queries.map(text => { const result = indexer.store.search({ text, limit: 5 }); return { query: text, total: result.total, elapsedMs: Math.round(result.elapsedMs * 100) / 100, first: result.hits[0]?.name }; });
  const wordSummary = indexer.store.listDocuments().filter(f => f.kind === 'word').map(f => ({ name: f.name, status: f.status, units: f.unitCount, error: f.error }));
  const report = { finishedAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000, interrupted, stats: state.stats, errors: indexer.store.listDocuments().filter(f => f.status === 'error'), searches, wordSummary };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/corpus-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (state.stats.errors || state.stats.queued || state.stats.ocrPending && !args.includes('--native-only')) process.exitCode = 1;
} finally { await indexer.close(); }
