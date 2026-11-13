import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function publicVarsReadByCode() {
  const found = new Set();
  for (const file of await sourceFiles(join(root, "frontend/src"))) {
    for (const [, name] of (await readFile(file, "utf8")).matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      found.add(name);
    }
  }
  return [...found].sort();
}

const dockerfile = await read("frontend/Dockerfile");
const [builder, runner] = dockerfile.split(/^FROM node:22-slim AS runner$/m);
const buildArgs = [...builder.matchAll(/^ARG (NEXT_PUBLIC_[A-Z0-9_]+)=(.*)$/gm)].map((m) => m[1]).sort();

test("前端镜像构建参数：代码里读的每个 NEXT_PUBLIC_* 都在构建阶段声明为带默认值的 ARG，也只有它们", async () => {
  assert.deepEqual(buildArgs, await publicVarsReadByCode());
  assert.doesNotMatch(builder, /^ARG NEXT_PUBLIC_[A-Z0-9_]+$/m, "每个 ARG 都要有默认值");
  for (const name of buildArgs) {
    assert.match(builder, new RegExp(`${name}=\\$${name}\\b`), `${name} 没有导出为构建阶段的 ENV`);
  }
});

test("构建阶段拿不到任何密钥：没有 secret 挂载，没有密钥类 ARG/ENV，运行阶段也不带 NEXT_PUBLIC_*", () => {
  // 只看指令，不看注释：注释里可以说明密钥由谁在运行时提供
  const instructions = dockerfile.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(instructions, /type=secret/);
  assert.doesNotMatch(instructions, /\.env/);
  assert.doesNotMatch(instructions, /(AUTH_SECRET|JWT_SECRET|CLIENT_SECRET|AUTH_GITHUB_SECRET|AUTH_GOOGLE_SECRET|BACKEND_URL)/);
  assert.doesNotMatch(runner.replace(/^\s*#.*$/gm, ""), /NEXT_PUBLIC_/);
});

test("compose 没有 secrets；前端的密钥只在运行时由 environment 提供，不进构建参数", async () => {
  const compose = await read("docker-compose.yml");
  assert.doesNotMatch(compose, /^secrets:/m);
  const frontend = compose.split(/^ {2}frontend:$/m)[1]?.split(/^ {2}\S/m)[0];
  assert.ok(frontend, "compose 里没有 frontend 服务");
  const args = frontend.match(/^ {6}args:\n((?: {8}.+\n)+)/m)?.[1] ?? "";
  assert.doesNotMatch(args, /SECRET/);
});

test("前端 .env.example 列出全部 NEXT_PUBLIC_*（构建参数的值只来自前端环境文件这一处）", async () => {
  const example = await read("frontend/.env.example");
  for (const name of buildArgs) {
    assert.match(example, new RegExp(`^#? ?${name}=`, "m"), name);
  }
});
