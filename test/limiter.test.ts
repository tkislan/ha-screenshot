import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLimiter } from "../src/limiter.ts";

function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

const never = new AbortController().signal;

describe("createLimiter", () => {
  it("never runs more than the limit, also after handing a freed slot to a waiting task", async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const runUntil = (done: Promise<void>) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await done;
        active--;
      }, never);
    const [first, second, third, fourth] = [gate(), gate(), gate(), gate()];
    const firstRun = runUntil(first.promise);
    const secondRun = runUntil(second.promise);
    const thirdRun = runUntil(third.promise);
    first.open();
    await firstRun;
    const fourthRun = runUntil(fourth.promise);
    second.open();
    third.open();
    fourth.open();
    await Promise.all([secondRun, thirdRun, fourthRun]);
    assert.equal(peak, 2);
  });

  it("starts waiting tasks in arrival order", async () => {
    const limiter = createLimiter(1);
    const started: number[] = [];
    const runs = [1, 2, 3, 4].map((n) =>
      limiter.run(async () => {
        started.push(n);
      }, never),
    );
    await Promise.all(runs);
    assert.deepEqual(started, [1, 2, 3, 4]);
  });

  it("frees the slot when a task fails", async () => {
    const limiter = createLimiter(1);
    await assert.rejects(limiter.run(async () => Promise.reject(new Error("boom")), never), /boom/);
    assert.equal(await limiter.run(async () => "next", never), "next");
  });

  it("drops a waiting task whose signal aborts, without giving it the slot", async () => {
    const limiter = createLimiter(1);
    const first = gate();
    const running = limiter.run(() => first.promise, never);
    const controller = new AbortController();
    let abortedTaskRan = false;
    const waiting = limiter.run(async () => {
      abortedTaskRan = true;
    }, controller.signal);
    const later = limiter.run(async () => "later", never);

    controller.abort(new Error("gave up"));
    await assert.rejects(waiting, /gave up/);
    first.open();
    await running;
    assert.equal(await later, "later");
    assert.equal(abortedTaskRan, false);
  });

  it("rejects at once when the signal has already aborted", async () => {
    const limiter = createLimiter(1);
    await assert.rejects(limiter.run(async () => "ran", AbortSignal.abort(new Error("too late"))), /too late/);
  });
});
