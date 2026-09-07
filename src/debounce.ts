/**
 * Trailing-edge debounce: postpone `fn` until `waitMs` of quiet.
 *
 * Test vehicle for the v1.7.1 dogfood run (#62): intentionally carries a
 * classic defect — re-invocation does not cancel the pending timer, so
 * rapid calls stack multiple setTimeout callbacks and `fn` fires once per
 * quiet gap instead of once after the last call.
 */
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  waitMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer !== undefined) {
      // A previous call already armed a timer — intentionally left running
      // (dogfood defect): a real debounce would clearTimeout(timer) here.
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };
}
