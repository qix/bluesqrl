/**
 * Returns a timestamp thats always guaranteed to move forward
 */
export function nowMonotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
