import { utilityProcess, type UtilityProcess } from 'electron';
export class ProcessClient {
  process: UtilityProcess | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private file: string, private name: string, private onEvent: (message: any) => void, private onExit: (code: number) => void) {}
  start() {
    if (this.process) return;
    const child = utilityProcess.fork(this.file, [], { serviceName: this.name, stdio: 'pipe' });
    this.process = child;
    child.stderr?.on('data', data => process.stderr.write(data));
    child.on('message', message => {
      if (message.type !== 'reply') { this.onEvent(message); return; }
      const pending = this.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
    });
    child.on('exit', code => {
      if (this.process === child) this.process = null;
      this.rejectAll('处理进程已退出，已保存的资料不会丢失。请重试。');
      this.onExit(code);
    });
  }
  request<T = any>(command: string, payload?: unknown): Promise<T> {
    const child = this.process;
    if (!child) return Promise.reject(new Error('处理进程未运行，请重试。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('处理超时，请重试。')); child.kill(); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, command, payload });
    });
  }
  private rejectAll(message: string) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } this.pending.clear(); }
  kill() { this.process?.kill(); }
}
