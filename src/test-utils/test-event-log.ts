/** A test fixture records an event at its producer and wakes listeners without a timer. */
export function createTestEventLog<T>() {
  const events: T[] = [];
  let next = Promise.withResolvers<void>();

  function record(event: T): void {
    events.push(event);
    const previous = next;
    next = Promise.withResolvers<void>();
    previous.resolve();
  }

  async function waitForCount(count: number): Promise<void> {
    while (events.length < count) {
      await next.promise;
    }
  }

  const recordedEvents: readonly T[] = events;
  return { events: recordedEvents, record, waitForCount };
}
