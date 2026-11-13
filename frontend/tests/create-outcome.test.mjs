import assert from "node:assert/strict";
import { test } from "node:test";

const { ApiError, BackendUnreachableError } = await import("../src/lib/api-common.ts");
const { isUnconfirmedCreate } = await import("../src/lib/learn/create-outcome.ts");

test("没有收到后端应答的失败算「结果未确认」：断网、网关超时/错误（没有后端 detail）", () => {
  assert.equal(isUnconfirmedCreate(new BackendUnreachableError("x", new TypeError("fetch failed"))), true);
  for (const status of [500, 502, 503, 504, 524]) {
    assert.equal(isUnconfirmedCreate(new ApiError(status, "Gateway Time-out")), true, String(status));
  }
});

test("5xx 的响应体是通用兜底（服务器内部错误）、没有可识别的 detail，或 detail 不是后端认识的固定报错：后端可能在课程已提交之后才出错，同样算「结果未确认」", () => {
  const fallback = "服务器出了点问题，请稍后重试";
  assert.equal(isUnconfirmedCreate(new ApiError(500, fallback, fallback)), true);
  assert.equal(isUnconfirmedCreate(new ApiError(500, `${fallback}（原因：KeyError）`, `${fallback}（原因：KeyError）`)), true);
  assert.equal(isUnconfirmedCreate(new ApiError(500, "没见过的一句话", "没见过的一句话")), true);
  assert.equal(isUnconfirmedCreate(new ApiError(500, "x", { code: "something_else" })), true);
  assert.equal(isUnconfirmedCreate(new ApiError(502, "Bad Gateway", undefined)), true);
  assert.equal(isUnconfirmedCreate(new ApiError(503, "x", { message: "no code" })), true);
  // 只认原因前面那一截：拼在后面的原因不能让一句没见过的话冒充固定报错
  assert.equal(isUnconfirmedCreate(new ApiError(500, "x", "没见过的一句话（原因：没能创建课程，请稍后重试）")), true);
});

test("后端回了认识的固定报错的 5xx（带不带原因都算）和校验失败、冲突等 4xx 是确定的失败，不算「未确认」", () => {
  for (const [status, detail] of [
    [502, "没能调用模型服务，请稍后重试"],
    [500, "没能创建课程，请稍后重试"],
    [500, "没能创建课程，请稍后重试（原因：IntegrityError）"],
    [502, "资料没能完整整理出来，请减少资料或稍后重试"],
    [504, "资料处理时间过长，请减少文件数量或缩小文件后重试"],
  ]) {
    assert.equal(isUnconfirmedCreate(new ApiError(status, detail, detail)), false, detail);
  }
  assert.equal(isUnconfirmedCreate(new ApiError(400, "请输入想学的主题", "请输入想学的主题")), false);
  assert.equal(isUnconfirmedCreate(new ApiError(422, "x", [{ loc: ["body", "name"], msg: "required" }])), false);
  assert.equal(isUnconfirmedCreate(new ApiError(429, "资料课程生成频率过高，请稍后重试", "资料课程生成频率过高，请稍后重试")), false);
  assert.equal(isUnconfirmedCreate(new ApiError(404, "Not Found")), false);
  // 409 不再特殊：和别的 4xx 一样是确定的失败
  const duplicate = { code: "duplicate_request", message: "这次请求已经在处理或已完成，请到课程列表查看" };
  assert.equal(isUnconfirmedCreate(new ApiError(409, duplicate.message, duplicate)), false);
  assert.equal(isUnconfirmedCreate(new ApiError(409, "网页剪藏正在创建，请再点一次", "网页剪藏正在创建，请再点一次")), false);
  assert.equal(isUnconfirmedCreate(new Error("boom")), false);
  assert.equal(isUnconfirmedCreate("boom"), false);
});
