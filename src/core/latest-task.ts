/** One active operation and one replaceable pending operation. */
export class LatestTask<T, R> {
  private active = false;
  private pending?: { input: T; resolve: (r: R) => void; reject: (e: Error) => void };
  constructor(private run: (input: T) => Promise<R>) {}
  submit(input: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.pending?.reject(new Error('SEARCH_SUPERSEDED'));
      this.pending = { input, resolve, reject };
      void this.drain();
    });
  }
  private async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending) {
        const next = this.pending; this.pending = undefined;
        try { next.resolve(await this.run(next.input)); } catch (e) { next.reject(e instanceof Error ? e : new Error(String(e))); }
      }
    } finally { this.active = false; }
  }
}
