// 离线打包：用 esbuild 把源码 + 全部依赖（@modelcontextprotocol/sdk、zod 等）
// 打成一个自包含的 dist/index.js（ESM，platform=node）。
// 目标机只需 dist/index.js + dist/knowledge/，无需 node_modules、无需联网。
// 使用绝对路径，避免依赖执行时的 cwd。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, cpSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const OUT_DIR = join(ROOT, "dist");
const log = [];
const say = (m) => log.push(m);

await build({
  entryPoints: [join(SRC, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20", // 与目标机 Node 版本保持一致（当前目标机为 v20.x）
  format: "esm",
  outfile: join(OUT_DIR, "index.js"),
  sourcemap: false,
  logLevel: "info",
});

// 归一化 shebang：无论源码/esbuild 是否带 shebang，都保证「第 1 行恰好一个」
// 这是之前 Linux 上 SyntaxError 的根因——源码自带 shebang + banner 又加一个 → 第 2 行报错。
const outFile = join(OUT_DIR, "index.js");
let code = readFileSync(outFile, "utf8");
code = code.replace(/^#![^\n]*\r?\n/, ""); // 去掉已有的（可能多个）shebang
code = "#!/usr/bin/env node\n" + code; // 只加一个到最前面
writeFileSync(outFile, code);

// 让 dist/ 自带上 type:module，保证目标机（无论是否含 package.json）
// 以 ESM 加载 index.js，避免 CJS 加载器解析 import 失败。
writeFileSync(join(OUT_DIR, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

// 清理 tsc 多文件产物残留（打包后不再需要，避免与单文件混淆/被误读）
for (const d of ["client", "tools", "resolver"]) {
  rmSync(join(OUT_DIR, d), { recursive: true, force: true });
}
for (const f of [
  "config.js", "config.js.map",
  "http-server.js", "http-server.js.map",
  "target-registry.js", "target-registry.js.map",
  "index.js.map",
]) {
  if (existsSync(join(OUT_DIR, f))) rmSync(join(OUT_DIR, f), { force: true });
}

// 知识库文档运行时从磁盘读取，不内联进 bundle，单独拷贝
rmSync(join(OUT_DIR, "knowledge"), { recursive: true, force: true });
cpSync(join(SRC, "knowledge"), join(OUT_DIR, "knowledge"), { recursive: true });

const { statSync } = await import("node:fs");
const size = statSync(join(OUT_DIR, "index.js")).size;
say(`✅ 离线打包完成：dist/index.js (${Math.round(size / 1024)}KB，自包含) + dist/knowledge/`);
writeFileSync(join(ROOT, "build-offline.log"), log.join("\n") + "\n");
