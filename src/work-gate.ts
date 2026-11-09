/** Coordinates engine work and exclusive runtime changes, independent of HTTP. */
export class WorkGate {
  private active = 0;
  private changing = false;
  private waiters: (() => void)[] = [];
  paused = true;
  constructor(paused = false) {
    this.paused = paused;
  }
  enter(): (() => void) | undefined {
    if (this.paused || this.changing) return;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) this.waiters.splice(0).forEach(resolve => resolve());
    };
  }
  async change<T>(operation: () => Promise<T>): Promise<T> {
    if (this.changing) throw new Error('A runtime change is in progress');
    this.changing = true;
    try {
      if (this.active) await new Promise<void>(resolve => this.waiters.push(resolve));
      return await operation();
    } finally {
      this.changing = false;
    }
  }
  get busy() {
    return this.changing;
  }
}
