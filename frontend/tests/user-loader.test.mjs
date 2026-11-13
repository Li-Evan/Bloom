import assert from "node:assert/strict";
import { test } from "node:test";

const { createUserLoader } = await import("../src/lib/user-loader.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 假定时器：重试不真的等，由测试决定什么时候触发
function setup(load, delays = [10, 20, 30]) {
  const events = [];
  const failed = [];
  const timers = [];
  const loader = createUserLoader({
    load,
    onUser: (user) => events.push(["user", user && user.uuid]),
    onError: (e) => events.push(["error", e.message]),
    onFailed: (value) => failed.push(value),
    delays,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
  });
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fire = async () => {
    const timer = pending()[0];
    assert.ok(timer, "没有待触发的重试");
    timer.fired = true;
    await timer.fn();
  };
  return { loader, events, failed, pending, fire };
}

const user = (uuid) => ({ uuid });

test("首次失败、之后某次重试成功：设置用户，不再有请求和重试", async () => {
  let calls = 0;
  const { loader, events, pending, fire } = setup(async () => {
    calls++;
    if (calls === 1) throw new Error("backend restarting");
    return user("u1");
  });

  loader.sync("u1");
  await flush();
  assert.deepEqual(events, [["error", "backend restarting"]]);
  assert.equal(loader.loaded, false);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].ms, 10);

  await fire();
  assert.deepEqual(events, [["error", "backend restarting"], ["user", "u1"]]);
  assert.equal(loader.loaded, true);
  assert.equal(calls, 2);
  assert.equal(pending().length, 0, "成功后不再安排重试");

  loader.sync("u1");
  await flush();
  assert.equal(calls, 2, "同一个用户不会再请求");
});

test("连续失败只提示一次，按退避间隔重试，次数有上限", async () => {
  let calls = 0;
  const { loader, events, pending, fire } = setup(async () => {
    calls++;
    throw new Error("down");
  });

  loader.sync("u1");
  await flush();
  for (const ms of [10, 20, 30]) {
    assert.equal(pending()[0].ms, ms);
    await fire();
  }
  assert.equal(calls, 4, "首次 + 3 次重试");
  assert.equal(pending().length, 0, "重试用完就停");
  assert.deepEqual(events, [["error", "down"]], "只有首次失败提示");
  assert.equal(loader.loaded, false);
});

test("退出登录：清空用户，取消待重试，迟到的响应被忽略", async () => {
  let resolveLoad;
  let calls = 0;
  const { loader, events, pending } = setup(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("down"));
    return new Promise((resolve) => (resolveLoad = resolve));
  });

  loader.sync("u1");
  await flush();
  assert.equal(pending().length, 1);

  loader.sync(undefined);
  assert.equal(pending().length, 0, "重试被取消");
  assert.deepEqual(events.at(-1), ["user", null]);
  assert.equal(loader.loaded, false);

  // 退出前已发出、退出后才返回的请求不能把用户设回来
  loader.sync("u2");
  await flush();
  loader.sync(undefined);
  resolveLoad(user("u2"));
  await flush();
  assert.deepEqual(events.at(-1), ["user", null]);
  assert.ok(!events.some((e) => e[0] === "user" && e[1] === "u2"));
});

test("换了登录用户（uuid 变化）：清空旧用户并重新请求", async () => {
  const calls = [];
  const { loader, events } = setup(async () => {
    calls.push(1);
    return user(`u${calls.length}`);
  });

  loader.sync("u1");
  await flush();
  loader.sync("u1");
  await flush();
  assert.equal(calls.length, 1);

  loader.sync("u2");
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(events, [["user", "u1"], ["user", null], ["user", "u2"]]);
});

test("旧用户的慢响应不会覆盖新用户", async () => {
  const resolvers = [];
  const { loader, events } = setup(
    () => new Promise((resolve) => resolvers.push(resolve))
  );

  loader.sync("u1");
  loader.sync("u2");
  resolvers[0](user("u1"));
  await flush();
  assert.deepEqual(events, [["user", null]]);

  resolvers[1](user("u2"));
  await flush();
  assert.deepEqual(events.at(-1), ["user", "u2"]);
});

test("显式刷新：用户还没加载出来时立即请求 /api/me，成功后取消待重试", async () => {
  let calls = 0;
  const { loader, events, pending } = setup(async () => {
    calls++;
    if (calls === 1) throw new Error("down");
    return user("u1");
  });

  loader.sync("u1");
  await flush();
  assert.equal(pending().length, 1);

  await loader.reload();
  assert.equal(calls, 2);
  assert.deepEqual(events.at(-1), ["user", "u1"]);
  assert.equal(pending().length, 0);
});

test("显式刷新失败每次都提示；没登录时什么也不做", async () => {
  const { loader, events } = setup(async () => {
    throw new Error("still down");
  });

  await loader.reload();
  assert.deepEqual(events, [], "没登录不请求");

  loader.sync("u1");
  await flush();
  await loader.reload();
  assert.deepEqual(
    events.filter((e) => e[0] === "error").length,
    2,
    "自动首次一次 + 显式一次"
  );
});

test("stop（卸载）：取消待重试，之后的响应被忽略", async () => {
  const { loader, events, pending } = setup(async () => {
    throw new Error("down");
  });

  loader.sync("u1");
  await flush();
  assert.equal(pending().length, 1);
  loader.stop();
  assert.equal(pending().length, 0);
  assert.deepEqual(events, [["error", "down"]]);
});

test("重试进行中又显式刷新：作废进行中的那次，只留一个重试定时器，stop 之后什么都不剩", async () => {
  const inFlight = [];
  let calls = 0;
  const { loader, pending, fire } = setup(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("down"));
    return new Promise((resolve, reject) => inFlight.push({ resolve, reject }));
  });

  loader.sync("u1");
  await flush();
  await fire();
  assert.equal(inFlight.length, 1, "自动重试正在请求");

  const manual = loader.reload();
  assert.equal(inFlight.length, 2, "显式刷新另发一次请求");

  inFlight[0].reject(new Error("down"));
  inFlight[1].reject(new Error("down"));
  await manual;
  await flush();
  assert.equal(pending().length, 1, "两次都失败也只安排一个重试");

  loader.stop();
  assert.equal(pending().length, 0, "卸载后没有取消不掉的定时器");
});

test("重试用完后报告「已放弃」，显式刷新再试一次，成功后恢复；退出登录也清掉这个状态", async () => {
  let succeed = false;
  const { loader, events, failed, pending, fire } = setup(async () => {
    if (!succeed) throw new Error("down");
    return user("u1");
  });

  loader.sync("u1");
  await flush();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(failed, [], "还有重试时不算放弃");
    await fire();
  }
  await flush();
  assert.equal(pending().length, 0);
  assert.deepEqual(failed, [true]);

  await loader.reload();
  assert.deepEqual(failed, [true, false, true], "刷新开始时回到加载中，再失败又回到放弃");
  assert.equal(pending().length, 0, "手动刷新失败不再自动重试");

  succeed = true;
  await loader.reload();
  assert.deepEqual(failed, [true, false, true, false]);
  assert.deepEqual(events.at(-1), ["user", "u1"]);

  succeed = false;
  loader.sync("u2");
  await flush();
  for (let i = 0; i < 3; i++) await fire();
  await flush();
  assert.equal(failed.at(-1), true);
  loader.sync(undefined);
  assert.equal(failed.at(-1), false, "退出登录后不再是失败状态");
});
