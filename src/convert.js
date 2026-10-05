// 把 DeepSeek 网页版导出的一个会话转换成 DeepSeek Harness 的会话事件。
//
// 导出格式：会话 { id, title, inserted_at, updated_at, mapping }，mapping 是一棵
// 以 "root" 为根的消息树（重新生成、编辑提问会产生分支），每条消息带若干片段：
//   REQUEST 提问 / FILE 附件 / THINK 思考 / RESPONSE 回答 /
//   SEARCH、TOOL_SEARCH 搜索结果 / TOOL_OPEN、TOOL_FIND 无内容
//
// 输出用 Harness 最早的会话格式（版本 0）：应用保留着从版本 0 逐级升级的转换，
// 打开会话时自己升到当前版本，所以这里不跟随应用的格式升级。

const MAX_TITLE_BYTES = 80;
const PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-chat";

/** 去掉控制字符、合并空白，并按 UTF-8 字节数截断（应用对标题的限制）。 */
export function normalizeTitle(title) {
  const cleaned = String(title)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‎‏‪-‮⁠-⁤⁦-⁯﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  let used = 0;
  for (const ch of cleaned) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > MAX_TITLE_BYTES) break;
    out += ch;
    used += bytes;
  }
  return out.trimEnd();
}

function parseTime(iso) {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function formatSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function searchResultsText(results) {
  const lines = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r.url !== "string") continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url;
    lines.push(`- [${title.replace(/[\[\]]/g, " ")}](${r.url})`);
  }
  return lines.length > 0 ? `搜索结果：\n${lines.join("\n")}` : "";
}

function filesText(files) {
  const lines = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.file_name !== "string") continue;
    const size = formatSize(f.file_size);
    lines.push(`[附件：${f.file_name}${size ? `，${size}` : ""}，内容不在导出文件里]`);
  }
  return lines.join("\n");
}

/**
 * 一条消息 → { role, text, reasoning, model, time }；没有可用内容返回 null。
 * 思考与搜索结果进 reasoning（界面上可折叠），回答进 text。
 */
function parseMessage(m) {
  const fragments = Array.isArray(m.fragments) ? m.fragments : [];
  const user = [];
  const reasoning = [];
  const answer = [];
  for (const f of fragments) {
    if (!f || typeof f !== "object") continue;
    const content = typeof f.content === "string" ? f.content.trim() : "";
    switch (f.type) {
      case "REQUEST":
        if (content) user.push(content);
        break;
      case "FILE": {
        const text = filesText(f.files);
        if (text) user.push(text);
        break;
      }
      case "THINK":
        if (content) reasoning.push(content);
        break;
      case "SEARCH":
      case "TOOL_SEARCH": {
        const text = searchResultsText(f.results);
        if (text) reasoning.push(text);
        break;
      }
      case "RESPONSE":
        if (content) answer.push(content);
        break;
      default:
        // TOOL_OPEN、TOOL_FIND 没有内容；以后新增的片段类型若带文字，归入回答，不丢。
        if (content) answer.push(content);
    }
  }
  const model = typeof m.model === "string" && m.model.length > 0 ? m.model : DEFAULT_MODEL;
  const time = parseTime(m.inserted_at);
  if (user.length > 0) return { role: "user", text: user.join("\n\n"), model, time };
  if (reasoning.length === 0 && answer.length === 0) return null;
  return { role: "assistant", text: answer.join("\n\n"), reasoning: reasoning.join("\n\n"), model, time };
}

/**
 * 把消息树拆成从 root 到各叶子的路径。重新生成回答、编辑提问都会让一个节点有多个子节点；
 * 网页版默认显示每层最后一个子节点，那条路径排在第一个（main）。
 * 没有带来新内容的路径不要：整条路径的消息都已包含在另一条更长的路径里。
 * @returns {{ main: boolean, leaf: string, rows: object[] }[]}
 */
function branchPaths(conv) {
  const mapping = conv.mapping;
  if (!mapping || typeof mapping !== "object" || !mapping.root) return [];
  const rowOf = new Map();
  const row = (node) => {
    if (!rowOf.has(node)) rowOf.set(node, node.message && typeof node.message === "object" ? parseMessage(node.message) : null);
    return rowOf.get(node);
  };
  const paths = [];
  // 显式栈，深的会话不至于递归过深；visiting 防止坏数据里的环。
  const stack = [{ node: mapping.root, nodes: [], main: true, visiting: new Set() }];
  while (stack.length > 0) {
    const { node, nodes, main, visiting } = stack.pop();
    if (!node || typeof node !== "object" || visiting.has(node)) continue;
    const here = row(node) ? [...nodes, node] : nodes;
    const children = Array.isArray(node.children) ? node.children.map((c) => mapping[c]).filter(Boolean) : [];
    if (children.length === 0) {
      if (here.length > 0) paths.push({ main, leaf: String(here[here.length - 1].id ?? paths.length), nodes: here });
      continue;
    }
    const seen = new Set(visiting).add(node);
    children.forEach((child, index) => {
      stack.push({ node: child, nodes: here, main: main && index === children.length - 1, visiting: seen });
    });
  }
  // main 路径可能在空叶子处结束而没被收进来：补上它实际走到的那一段。
  if (!paths.some((p) => p.main)) {
    const nodes = [];
    const seen = new Set();
    for (let node = mapping.root; node && typeof node === "object" && !seen.has(node); ) {
      seen.add(node);
      if (row(node)) nodes.push(node);
      const children = Array.isArray(node.children) ? node.children.map((c) => mapping[c]).filter(Boolean) : [];
      node = children[children.length - 1];
    }
    if (nodes.length > 0) paths.push({ main: true, leaf: String(nodes[nodes.length - 1].id), nodes });
  }
  const isPrefix = (short, long) => short.length <= long.length && short.every((n, i) => n === long[i]);
  const kept = paths.filter((p) => p.main || !paths.some((q) => q !== p && (q.nodes.length > p.nodes.length || q.main) && isPrefix(p.nodes, q.nodes)));
  // 同一条节点序列只留一份（多个空叶子挂在同一节点下时会重复）
  const unique = [];
  for (const p of kept) {
    if (!unique.some((q) => q.nodes.length === p.nodes.length && isPrefix(p.nodes, q.nodes))) unique.push(p);
    else if (p.main) unique.find((q) => q.nodes.length === p.nodes.length && isPrefix(p.nodes, q.nodes)).main = true;
  }
  unique.sort((x, y) => Number(y.main) - Number(x.main) || x.leaf.localeCompare(y.leaf, "en", { numeric: true }));
  return unique.map((p) => ({ main: p.main, leaf: p.leaf, rows: p.nodes.map((n) => row(n)) }));
}

function assistantContent(row, keepReasoning) {
  const content = [];
  if (keepReasoning && row.reasoning) content.push({ type: "reasoning", text: row.reasoning });
  if (row.text) content.push({ type: "text", text: row.text });
  return content;
}

/**
 * 一个网页版会话 → 一个或多个 Harness 会话。Harness 的会话是一条直线，没有分支，
 * 所以每条分支各成一个完整的会话（从第一条消息到该分支的末尾）。
 * @param conv 导出文件里的一个会话
 * @param {{ keepReasoning?: boolean, branches?: "current" | "all" | "others" }} options
 *   branches：current（默认）只要网页版当前显示的那条；others 只要其余分支；all 都要
 * @returns {{ sessions: object[], others: number, error?: string }} others 是其余分支的条数
 */
export function buildSessions(conv, options = {}) {
  const mode = options.branches ?? "current";
  const sourceId = String(conv?.id ?? "").trim();
  if (!sourceId) return { sessions: [], others: 0, error: "会话没有 id" };
  const paths = branchPaths(conv);
  const others = paths.filter((p) => !p.main);
  const sessions = [];
  const baseTitle = typeof conv.title === "string" ? conv.title : "";
  paths.forEach((p) => {
    if (p.main ? mode === "others" : mode === "current") return;
    const index = others.indexOf(p) + 2;
    const built = buildOne(conv, p.rows, {
      keepReasoning: options.keepReasoning !== false,
      id: p.main ? `session-${sourceId}` : `session-${sourceId}-b${p.leaf}`,
      title: p.main ? normalizeTitle(baseTitle) : branchTitle(baseTitle, index),
    });
    if (built) sessions.push({ ...built, sourceId, branch: p.main ? null : index });
  });
  if (paths.length === 0) return { sessions, others: 0, error: "会话里没有消息" };
  return { sessions, others: others.length };
}

/** 兼容单会话用法：只取当前分支。 */
export function buildSession(conv, options = {}) {
  const { sessions, others, error } = buildSessions(conv, { ...options, branches: "current" });
  if (error) return { error };
  if (sessions.length === 0) return { error: "会话里没有消息" };
  sessions[0].stats.branches = others;
  return sessions[0];
}

function branchTitle(title, index) {
  const suffix = `（分支 ${index}）`;
  const base = normalizeTitle(title) || "无标题";
  let cut = base;
  while (Buffer.byteLength(cut) + Buffer.byteLength(suffix) > MAX_TITLE_BYTES) cut = [...cut].slice(0, -1).join("");
  return cut.trimEnd() + suffix;
}

function buildOne(conv, rows, { keepReasoning, id, title }) {
  // 相邻的「提问 + 回答」配成一轮；落单的各自成一轮。
  const turns = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.role === "user") {
      const next = rows[i + 1];
      if (next && next.role === "assistant") {
        turns.push({ user: row, assistant: next });
        i++;
      } else {
        turns.push({ user: row });
      }
    } else {
      turns.push({ assistant: row });
    }
  }
  // 去掉思考后变空的回答不写；整轮都空则跳过。
  const usable = [];
  for (const turn of turns) {
    const content = turn.assistant ? assistantContent(turn.assistant, keepReasoning) : [];
    if (!turn.user && content.length === 0) continue;
    usable.push({ user: turn.user, assistant: content.length > 0 ? turn.assistant : undefined, content });
  }
  if (usable.length === 0) return null;

  const createdAt = parseTime(conv.inserted_at) ?? usable[0].user?.time ?? usable[0].assistant?.time ?? Date.now();
  const events = [];
  const push = (type, data, time, extra) => {
    events.push({ type, seq: events.length, time, data, ...extra });
  };
  let messages = 0;
  let lastTime = createdAt;
  let lastPromptAt = null;
  const stats = { turns: usable.length, messages: 0, reasoning: 0, branches: 0 };

  usable.forEach((entry, index) => {
    const turn = index + 1;
    // 时间不许倒退：导出里偶有缺失或乱序的时间戳。
    const userTime = Math.max(lastTime, entry.user?.time ?? entry.assistant?.time ?? lastTime);
    const assistantTime = Math.max(userTime, entry.assistant?.time ?? userTime);
    push("turn/start", { turn }, userTime);
    push("step/start", { turn, step: 1 }, userTime);
    if (entry.user) {
      push("user/message", {
        id: `${id}-m${++messages}`,
        role: "user",
        content: [{ type: "text", text: entry.user.text }],
        source: { kind: "user" },
      }, userTime, { surfaceOp: "append" });
      lastPromptAt = userTime;
    }
    if (entry.assistant) {
      if (entry.content.some((block) => block.type === "reasoning")) stats.reasoning++;
      push("assistant/message", {
        turn,
        step: 1,
        message: {
          id: `${id}-m${++messages}`,
          role: "assistant",
          content: entry.content,
          source: { kind: "model", provider: PROVIDER, model: entry.assistant.model },
        },
      }, assistantTime, { surfaceOp: "append" });
    }
    push("step/end", { turn, step: 1 }, assistantTime);
    push("turn/end", { turn, reason: { kind: "completed" } }, assistantTime);
    lastTime = assistantTime;
  });
  stats.messages = messages;

  // 标题来源标成用户，应用就不会再自动改名。
  if (title) push("session/title", { title, messageSeqs: [], source: { kind: "user" } }, lastTime);
  push("session/end-seed", {}, lastTime);

  return { id, title: title || null, createdAt, lastPromptAt, events, stats };
}
