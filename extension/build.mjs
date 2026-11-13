// Builds the extension into extension/dist/bloom-web-clipper-<host>/ for one Bloom site and zips it for the stores.
//   node extension/build.mjs                                  → http://localhost:3000
//   BLOOM_ORIGIN=https://bloom.example.com node extension/build.mjs
// The protocol version and size limit come from the page side, so the two can't drift apart.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const origin = new URL(process.env.BLOOM_ORIGIN || "http://localhost:3000").origin;
const protocol = readFileSync(join(here, "../frontend/src/lib/learn/clip-protocol.ts"), "utf8");
const constant = (name) => {
  const value = protocol.match(new RegExp(`export const ${name} = ([\\d *]+);`))?.[1];
  if (!value) throw new Error(`${name} not found in clip-protocol.ts`);
  return value.split("*").reduce((product, factor) => product * Number(factor), 1);
};
const values = {
  __BLOOM_ORIGIN__: origin,
  __CLIP_PROTOCOL__: String(constant("CLIP_PROTOCOL")),
  __MAX_CLIP_BYTES__: String(constant("MAX_CLIP_BYTES")),
};

// No dots in the folder name: macOS treats a folder ending in .app as an application and the picker won't open it
const out = join(here, "dist", `bloom-web-clipper-${new URL(origin).host.replace(/[^\w-]/g, "-")}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, "src"), out, { recursive: true });
for (const file of ["manifest.json", "background.js", "bridge.js"]) {
  const path = join(out, file);
  let text = readFileSync(path, "utf8");
  for (const [placeholder, value] of Object.entries(values)) text = text.replaceAll(placeholder, value);
  if (/__[A-Z_]+__/.test(text)) throw new Error(`unfilled placeholder in ${file}`);
  writeFileSync(path, text);
}
execFileSync("zip", ["-qr", `${out}.zip`, "."], { cwd: out });
console.log(`${out}\n${out}.zip`);
