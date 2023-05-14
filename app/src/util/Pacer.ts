export class Pacer {
  private last = 0;
  private intervalMs: number;
  constructor(props: { intervalMs: number }) {
    this.intervalMs = props.intervalMs;
  }

  test() {
    const now = Date.now();
    if (now > this.last + this.intervalMs) {
      this.last = now;
      return true;
    }
    return false;
  }
}
