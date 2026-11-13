import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "make-build-env-"));

// 假的 docker：只记下收到的参数（和 DOCKER_BUILDKIT），不真的构建
const log = join(dir, "docker.log");
writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "BUILDKIT=$DOCKER_BUILDKIT $@" >> "${log}"\n`);
chmodSync(join(dir, "docker"), 0o755);

function make(target) {
  writeFileSync(log, "");
  const result = spawnSync("make", [target], {
    cwd: root,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  return { ...result, docker: readFileSync(log, "utf8") };
}

// NEXT_PUBLIC_* 用 Dockerfile 里的默认值，构建不再要前端环境文件
for (const target of ["build", "up"]) {
  test(`make ${target}：开着 BuildKit 调用 docker compose`, () => {
    const result = make(target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.docker, /^BUILDKIT=1 compose /);
    assert.match(result.docker, target === "build" ? /\bcompose build\b/ : /\bcompose up -d --build\b/);
  });
}
