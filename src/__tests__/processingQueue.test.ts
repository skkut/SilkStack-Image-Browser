import { describe, expect, it, vi, afterEach } from 'vitest';
import type { QueueState } from '../services/processingQueue';

// The queue keeps module-level chain state, so each test gets a FRESH module
// instance via vi.resetModules() + dynamic import (same idiom as
// reprocessStore.test.ts for the store's module-level singletons).
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A gate that blocks a job until release() is called. */
const gated = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('processingQueue', () => {
  it('serializes jobs FIFO — a second job starts only after the first resolves', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    const order: string[] = [];
    const { gate, release } = gated();
    const pA = processingQueue.enqueue(async () => {
      order.push('a-start');
      await gate;
      order.push('a-end');
    });
    const pB = processingQueue.enqueue(async () => { order.push('b'); });

    await flush();
    expect(order).toEqual(['a-start']);   // B is queued behind the gated A

    release();
    await Promise.all([pA, pB]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('enqueueOnce coalesces pending duplicates — fn runs once, both callers share the promise', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    let runs = 0;
    const fn = async () => { runs += 1; };
    const p1 = processingQueue.enqueueOnce('k', fn);
    const p2 = processingQueue.enqueueOnce('k', fn);

    expect(p2).toBe(p1);                  // joined the pending job's promise
    await Promise.all([p1, p2]);
    expect(runs).toBe(1);
  });

  it('enqueueOnce while RUNNING does not swallow — a second job runs after', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    let runs = 0;
    const { gate, release } = gated();
    const p1 = processingQueue.enqueueOnce('k', async () => { runs += 1; await gate; });
    await flush();                        // first job is now running
    const p2 = processingQueue.enqueueOnce('k', async () => { runs += 1; });

    release();
    await Promise.all([p1, p2]);
    expect(runs).toBe(2);                 // running job did NOT swallow the new one
  });

  it('waitForIdle resolves true after drain and false on timeout', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');
    vi.useFakeTimers();

    const { gate, release } = gated();
    const jobP = processingQueue.enqueue(async () => { await gate; });
    await vi.advanceTimersByTimeAsync(0);

    const idleP1 = processingQueue.waitForIdle(1000);
    await vi.advanceTimersByTimeAsync(1400);
    expect(await idleP1).toBe(false);     // still gated → timed out

    release();
    await jobP;
    expect(await processingQueue.waitForIdle(5000)).toBe(true); // drained
  });

  it('isolates job errors — a throwing job logs and the next job still runs', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    const p1 = processingQueue.enqueue(async () => { throw new Error('boom'); });
    const p2 = processingQueue.enqueue(async () => { order.push('second'); });

    await Promise.all([p1, p2]);          // p1 resolves even though the job threw
    expect(order).toEqual(['second']);
    expect(errorSpy).toHaveBeenCalledWith('[processingQueue] job failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('dropQueued removes pending jobs — fn never runs, promise resolves as a no-op', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    const { gate, release } = gated();
    const first = processingQueue.enqueueOnce('k', async () => { await gate; });
    await flush();                        // first is running
    let queuedRan = false;
    const second = processingQueue.enqueueOnce('k', async () => { queuedRan = true; });

    processingQueue.dropQueued('k');      // only the PENDING job is dropped
    await second;                         // resolves as a no-op
    release();
    await first;
    expect(queuedRan).toBe(false);
    expect(processingQueue.isIdle()).toBe(true);
  });

  it('subscribe emits busy/label transitions and unsubscribes', async () => {
    vi.resetModules();
    const { processingQueue } = await import('../services/processingQueue');

    const events: QueueState[] = [];
    const unsubscribe = processingQueue.subscribe((s) => events.push(s));

    const { gate, release } = gated();
    const jobP = processingQueue.enqueue(async () => { await gate; }, { label: 'labeled job' });
    await flush();

    expect(events.some((e) => e.busy && e.label === 'labeled job')).toBe(true);

    release();
    await jobP;
    expect(events[events.length - 1].busy).toBe(false);
    expect(events[events.length - 1].label).toBeNull();

    unsubscribe();
    const countAfterUnsubscribe = events.length;
    await processingQueue.enqueue(async () => {});
    expect(events.length).toBe(countAfterUnsubscribe);
  });
});
