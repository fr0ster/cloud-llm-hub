import { Semaphore } from '../../srv/lib/semaphore';

// A tick that lets already-scheduled microtasks (promise handoffs) drain.
const flush = () => new Promise((r) => setImmediate(r));

describe('Semaphore', () => {
  it('coerces max to an integer >= 1', async () => {
    const s = new Semaphore(0);
    const r1 = await s.acquire(); // still gets 1 permit
    expect(s.active).toBe(1);
    let entered = false;
    s.acquire().then((r) => {
      entered = true;
      r();
    });
    await flush();
    expect(entered).toBe(false); // the 2nd is capped out at max=1
    r1();
    await flush();
    expect(entered).toBe(true);
  });

  it('lets up to `max` holders in immediately', async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.active).toBe(2);
    expect(s.pending).toBe(0);
  });

  it('queues callers past the cap and resumes them on release (FIFO)', async () => {
    const s = new Semaphore(2);
    const order: number[] = [];
    const r0 = await s.acquire();
    const r1 = await s.acquire();
    // Two more park in the queue.
    const p2 = s.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const p3 = s.acquire().then((r) => {
      order.push(3);
      return r;
    });
    await flush();
    expect(s.pending).toBe(2);
    expect(order).toEqual([]);

    r0(); // frees a slot → waiter #2 (first in) resumes
    await flush();
    expect(order).toEqual([2]);
    expect(s.pending).toBe(1);

    r1(); // → waiter #3 resumes
    await flush();
    expect(order).toEqual([2, 3]);
    expect(s.pending).toBe(0);

    (await p2)();
    (await p3)();
    expect(s.active).toBe(0);
  });

  it('release is idempotent — a double release frees only one slot', async () => {
    const s = new Semaphore(1);
    const r0 = await s.acquire();
    let secondEntered = false;
    let thirdEntered = false;
    s.acquire().then(() => {
      secondEntered = true;
    });
    s.acquire().then(() => {
      thirdEntered = true;
    });
    await flush();
    r0();
    r0(); // extra release must be ignored
    await flush();
    expect(secondEntered).toBe(true);
    expect(thirdEntered).toBe(false); // only ONE slot was freed
  });

  it('never exceeds max concurrent holders under a burst', async () => {
    const s = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const work = async () => {
      const release = await s.acquire();
      running++;
      peak = Math.max(peak, running);
      await flush(); // hold the permit across an async boundary
      running--;
      release();
    };
    await Promise.all(Array.from({ length: 10 }, () => work()));
    expect(peak).toBe(2); // the cap held across the whole burst
    expect(s.active).toBe(0);
    expect(s.pending).toBe(0);
  });
});
