import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MagicClient } from "../client/magic-client.js";
import type { SearchResult } from "../client/types.js";
import type { ToolDef } from "./group.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 知识库目录：兼容两种构建布局
 *  - 单文件打包：dist/index.js → dist/knowledge
 *  - tsc 多文件：dist/tools/knowledge.js → dist/knowledge
 *  - 回退源码：src/knowledge
 */
function resolveKnowledgeDir(): string | null {
  const candidates = [
    join(__dirname, "knowledge"),
    join(__dirname, "..", "knowledge"),
    join(__dirname, "..", "..", "src", "knowledge"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

interface KSection {
  file: string;
  category: string;
  docTitle: string;
  heading: string;
  level: number;
  text: string;
}

interface KDoc {
  file: string;
  category: string;
  title: string;
  sections: KSection[];
}

const KB: KDoc[] = [];
let KB_LOAD_ERROR: string | null = null;

function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else if (name.endsWith(".md")) out.push(rel);
  }
}

function stripFrontMatter(content: string): { body: string; title: string } {
  const m = content.match(/^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/);
  if (!m) return { body: content, title: "" };
  const titleM = m[1].match(/title:\s*"([^"]+)"/);
  return { body: content.slice(m[0].length), title: titleM ? titleM[1] : "" };
}

function parseDoc(relPath: string, content: string, category: string): KDoc {
  const { body, title } = stripFrontMatter(content);
  const lines = body.split(/\r?\n/);
  const headingRe = /^(#{1,4})\s+(.+?)\s*$/;
  const sections: KSection[] = [];
  let preamble: string[] = [];
  let cur: { level: number; heading: string; buf: string[] } | null = null;

  const flushCur = () => {
    if (cur) {
      const text = cur.buf.join("\n").trim();
      if (text) sections.push({ file: relPath, category, docTitle: title, heading: cur.heading, level: cur.level, text });
      cur = null;
    }
  };
  const flushPreamble = () => {
    const text = preamble.join("\n").trim();
    if (text) sections.push({ file: relPath, category, docTitle: title, heading: "", level: 0, text });
    preamble = [];
  };

  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      flushCur();
      flushPreamble();
      cur = { level: m[1].length, heading: m[2].trim(), buf: [] };
    } else if (cur) {
      cur.buf.push(line);
    } else {
      preamble.push(line);
    }
  }
  flushCur();
  flushPreamble();

  let docTitle = title;
  if (!docTitle && sections.length) docTitle = sections[0].heading;
  return { file: relPath, category, title: docTitle, sections };
}

function loadKnowledge(): void {
  const dir = resolveKnowledgeDir();
  if (!dir) {
    KB_LOAD_ERROR = "知识库目录未找到（src/knowledge 与 dist/knowledge 均不存在）";
    return;
  }
  const files: string[] = [];
  walk(dir, "", files);
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), "utf-8");
      const category = f.split("/")[0].replace(/^\d+\./, "");
      KB.push(parseDoc(f, content, category));
    } catch {
      // 单个文件解析失败不影响整体加载
    }
  }
  KB.sort((a, b) => a.file.localeCompare(b.file));
}

try {
  loadKnowledge();
} catch (e) {
  KB_LOAD_ERROR = (e as Error).message;
}

/** 把查询拆成词（按空白），无空格的中文短语退化为整串单 token */
function tokenize(q: string): string[] {
  const t = q
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return t.length ? t : [q.toLowerCase()];
}

/** 对单个小节按所有 token 累加打分（heading/file/title 命中加权，正文命中计数） */
function scoreSection(s: KSection, tokens: string[]): number {
  const headL = s.heading.toLowerCase();
  const fileL = s.file.toLowerCase();
  const titleL = s.docTitle.toLowerCase();
  const textL = s.text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (headL.includes(t)) score += 6;
    if (fileL.includes(t)) score += 4;
    if (titleL.includes(t)) score += 3;
    let idx = textL.indexOf(t);
    let cnt = 0;
    while (idx !== -1 && cnt < 20) {
      cnt++;
      idx = textL.indexOf(t, idx + t.length);
    }
    score += cnt;
  }
  return score;
}

function listTopics(): string {
  if (KB_LOAD_ERROR) return `⚠️ ${KB_LOAD_ERROR}`;
  if (!KB.length) return "知识库为空。";
  const byCat = new Map<string, KDoc[]>();
  for (const d of KB) {
    const arr = byCat.get(d.category) ?? [];
    arr.push(d);
    byCat.set(d.category, arr);
  }
  const lines: string[] = ["magic-api 知识库文档分类："];
  for (const [cat, docs] of byCat) {
    lines.push(`\n## ${cat}`);
    for (const d of docs) lines.push(`- ${d.title || d.file}  （${d.file}）`);
  }
  return lines.join("\n");
}

function makeSnippet(text: string, tokens: string[], len: number): string {
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  if (firstIdx === -1) {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > len ? t.slice(0, len) + "…" : t;
  }
  const start = Math.max(0, firstIdx - Math.floor(len / 3));
  const end = Math.min(text.length, start + len);
  const s = text.slice(start, end).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (end < text.length ? "…" : "");
}

export const magicScriptHelpTool: ToolDef<{ topic: string }, string> = {
  name: "magic_script_help",
  description:
    "查询 magic-api 官方文档知识库（函数/模块/配置/指南/插件等）。传入主题关键词（如 db / http / date / 分页 / 自定义函数 / 事务 / 多数据源），返回最相关文档的完整内容；不传或传空则列出全部文档分类。",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", description: "主题关键词，如 db / http / 分页 / query / 自定义函数" } },
    required: ["topic"],
  },
  readonly: true,
  handler: async (_client, args) => {
    const q = (args.topic ?? "").trim();
    if (!q) return listTopics();
    const tokens = tokenize(q);

    // 按文档打分：单文档最佳小节分 + 命中数；文件名/标题命中给决定性加权，
    // 避免 "date" 这类子串误中 "update" 而选错文档。
    const ranked = KB.map((doc) => {
      let best = 0;
      let matches = 0;
      for (const sec of doc.sections) {
        const s = scoreSection(sec, tokens);
        if (s > 0) matches++;
        if (s > best) best = s;
      }
      let score = best + matches * 0.5;
      if (tokens.some((t) => doc.file.toLowerCase().includes(t))) score += 100;
      if (tokens.some((t) => doc.title.toLowerCase().includes(t))) score += 20;
      return { doc, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
      return `未找到与「${q}」相关的文档。\n\n可查询的主题：\n${listTopics()}`;
    }

    const top = ranked[0];
    const parts = top.doc.sections
      .filter((sec) => scoreSection(sec, tokens) > 0)
      .map((sec) => `### ${sec.heading || sec.docTitle}\n\n${sec.text}`);
    const MAX = 5000;
    let out = `📄 ${top.doc.title || top.doc.file}（${top.doc.file}）\n\n` + parts.join("\n\n");
    if (out.length > MAX) out = out.slice(0, MAX) + "\n…(内容已截断，可用 search_knowledge 精确定位)";
    if (ranked.length > 1) {
      out +=
        `\n\n其它相关文档：` +
        ranked
          .slice(1, 4)
          .map((d) => `${d.doc.title || d.doc.file}（${d.doc.file}）`)
          .join("、");
    }
    return out;
  },
};

export const searchKnowledgeTool: ToolDef<{ query: string; limit?: number }, string> = {
  name: "search_knowledge",
  description:
    "在 magic-api 官方文档知识库中全文检索，跨所有文档返回相关片段、出处与摘要。适合模糊/多文档查找（如「日期格式化」「ES 插件」「统一异常处理」）。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索关键词，如 date / 事务 / ES / 自定义函数 / 日期格式化 / 统一异常处理" },
      limit: { type: "number", description: "返回结果条数，默认 6，最大 15" },
    },
    required: ["query"],
  },
  readonly: true,
  handler: async (_client, args) => {
    const q = (args.query ?? "").trim();
    if (!q) return "请提供 query 关键词。";
    const tokens = tokenize(q);
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 15);

    const scored: { sec: KSection; sc: number }[] = [];
    for (const doc of KB) {
      for (const sec of doc.sections) {
        const sc = scoreSection(sec, tokens);
        if (sc > 0) scored.push({ sec, sc });
      }
    }
    scored.sort((a, b) => b.sc - a.sc);
    if (!scored.length) return `未找到与「${args.query}」相关的内容。`;

    const parts = scored.slice(0, limit).map(({ sec, sc }, i) => {
      const snippet = makeSnippet(sec.text, tokens, 240);
      const head = sec.heading || sec.docTitle || "(概述)";
      return `${i + 1}. 【${head}】 ${sec.file}  (score=${sc})\n   ${snippet}`;
    });
    return `命中 ${scored.length} 个片段，展示前 ${parts.length}：\n\n` + parts.join("\n\n");
  },
};

export const searchCodeTool: ToolDef<{ keyword: string }, SearchResult[]> = {
  name: "search_code",
  description: "在所有接口/函数脚本中全局搜索关键词（搜索的是线上 magic-api 的脚本代码，非文档）。",
  inputSchema: {
    type: "object",
    properties: { keyword: { type: "string" } },
    required: ["keyword"],
  },
  readonly: true,
  handler: async (client, args) => {
    return client.managementGet<SearchResult[]>("search", { keyword: args.keyword });
  },
};
