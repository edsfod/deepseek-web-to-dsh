// DeepSeek Harness 数据目录（默认 ~/.dsh）里与导入有关的三样东西：
//   sessions/<项目目录>/<会话 id>/session.jsonl.zstd        会话日志
//   storages/workspace.json                                 工作区与会话归属
//   storages/session_projcache/sessions/<会话 id>.json      列表用的缓存（标题）
// 路径编码与文件布局按应用自己的实现（@deepseek-ai/dsh-session-persistence-jsonl、
// dsh-session-projection-cache，0.2.0-rc.2）。

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const LOG_VERSION = 0;
const LOG_FILENAME = "session.jsonl.zstd";
const CACHE_FILE_VERSION = 7;

/** 会话 id → 目录名：字母数字和 ._- 以外的字符写成 ~XXXX。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("会话 id 不能为空");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = raw[i];
    out += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch) ? ch : "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 工作目录 → 项目目录名：路径分隔符与冒号合并成一个 -，其余特殊字符写成 ~XXXX。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("工作目录不能为空");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = cwd[i];
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    readable += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch) ? ch : "~" + code.toString(16).toUpperCase().padStart(4, "0");
    separatorRun = false;
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export function projectDir(home, cwd) {
  return path.join(home, "sessions", projectKey(cwd));
}

export function sessionDir(home, cwd, id) {
  return path.join(projectDir(home, cwd), encodeSegment(id));
}

/** 这个会话在该工作目录下是否已有任何一代的日志（含应用升级后的 session.vN.jsonl.zstd）。 */
export function sessionExists(home, cwd, id) {
  let names;
  try {
    names = fs.readdirSync(sessionDir(home, cwd, id));
  } catch {
    return false;
  }
  return names.some((name) => /^session(\.v[1-9][0-9]*)?\.jsonl(\.zstd)?$/.test(name));
}

/**
 * 写一个新会话的日志：文件头单独一帧，全部事件一帧（应用要求首帧恰好是一行文件头）。
 * 先写临时文件再以「不覆盖」方式落位，已有同名文件时抛错。
 */
export function writeSessionLog(home, cwd, session) {
  const dir = sessionDir(home, cwd, session.id);
  const header = { type: "session", version: LOG_VERSION, id: session.id, createdAt: session.createdAt, cwd, delegationDepth: 0 };
  session.events.forEach((event, index) => {
    if (event.seq !== index) throw new Error(`事件序号不连续：第 ${index} 个事件的 seq 是 ${event.seq}`);
  });
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n"), ZSTD_OPTIONS);
  const eventFrame = zstdCompressSync(Buffer.from(session.events.map((e) => JSON.stringify(e)).join("\n") + "\n"), ZSTD_OPTIONS);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, LOG_FILENAME);
  const temp = path.join(dir, `${LOG_FILENAME}.${process.pid}.tmp`);
  fs.writeFileSync(temp, Buffer.concat([headerFrame, eventFrame]), { flag: "wx" });
  try {
    fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL); // 目标已存在时失败，不会覆盖
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

/** 读回一个日志的全部行（测试与核对用）：第 0 行是文件头，其余是事件。 */
export function readSessionLog(file) {
  const buffer = fs.readFileSync(file);
  // 文件是多个 zstd 帧接在一起，一次解压只解第一帧，按已消耗的字节数逐帧往后解。
  const parts = [];
  for (let offset = 0; offset < buffer.length; ) {
    const { buffer: plain, engine } = zstdDecompressSync(buffer.subarray(offset), { info: true });
    if (engine.bytesWritten === 0) throw new Error(`${file} 在第 ${offset} 字节处不是完整的 zstd 帧`);
    parts.push(plain);
    offset += engine.bytesWritten;
  }
  const text = Buffer.concat(parts).toString("utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/**
 * 列表缓存：应用列出没打开过的会话时只读它，不读日志；没有它，列表显示 Untitled。
 * 只写标题和列表元数据两行，其余各行由应用在打开会话时补全。
 */
export function writeListCache(home, cwd, session) {
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  const file = path.join(dir, `${encodeSegment(session.id)}.json`);
  if (fs.existsSync(file)) return false;
  const seq = session.events.length - 1;
  const record = {
    identity: { formatVersion: LOG_VERSION, createdAt: session.createdAt, cwd, isSeeded: false, inheritedEventCount: 0 },
    rows: {
      title: { ver: 1, seq, val: session.title },
      sessionListMetadata: { ver: 1, seq, val: { blank: false, lastPromptAt: session.lastPromptAt } },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: CACHE_FILE_VERSION, record }, null, 2) + "\n", { flag: "wx" });
  return true;
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

export function workspaceFile(home) {
  return path.join(home, "storages", "workspace.json");
}

function loadWorkspaces(home) {
  const file = workspaceFile(home);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`读不了 ${file}：${error.message}`);
    throw new Error(`找不到 ${file}：请先启动一次 DeepSeek Harness 再退出，让它建好数据目录`);
  }
  if (data?.unit?.name !== "workspace" || data.unit.version !== 2) {
    throw new Error(`${file} 的格式版本是 ${JSON.stringify(data?.unit)}，本工具只认 workspace 版本 2，为免写坏已停止`);
  }
  if (!data.tables?.workspaces || !Array.isArray(data.global?.workspaceIds)) {
    throw new Error(`${file} 的结构与预期不符，为免写坏已停止`);
  }
  return { file, data };
}

export function listWorkspaces(home) {
  const { data } = loadWorkspaces(home);
  const records = data.tables.workspaces;
  const ordered = [...data.global.workspaceIds.filter((id) => records[id]), ...Object.keys(records).filter((id) => !data.global.workspaceIds.includes(id))];
  return ordered.map((id) => ({ id, title: records[id].title, path: records[id].path, sessionCount: (records[id].sessionIds ?? []).length }));
}

/** 按 id、标题或目录找工作区；标题有重名时抛错。 */
export function findWorkspace(home, query) {
  const all = listWorkspaces(home);
  const byId = all.find((w) => w.id === query);
  if (byId) return byId;
  const resolved = path.resolve(query);
  const byPath = all.find((w) => path.resolve(w.path) === resolved);
  if (byPath) return byPath;
  const byTitle = all.filter((w) => w.title === query);
  if (byTitle.length > 1) throw new Error(`有 ${byTitle.length} 个工作区都叫「${query}」，请改用目录或 id 指定`);
  return byTitle[0];
}

/**
 * 把会话挂到工作区（没有就新建），一次写回。写之前把原文件复制成
 * workspace.json.before-import-<时间>，返回备份路径。
 * @param target { id } 已有工作区，或 { title, dir } 新建
 */
export function attachToWorkspace(home, target, sessionIds, now = new Date()) {
  const { file, data } = loadWorkspaces(home);
  const records = data.tables.workspaces;
  const stamp = now.toISOString();
  let id = target.id;
  let created = false;
  if (id === undefined) {
    id = Object.keys(records).find((key) => path.resolve(records[key].path) === path.resolve(target.dir));
    if (id === undefined) {
      id = randomUUID();
      records[id] = { path: target.dir, title: target.title, sessionIds: [], createdAt: stamp, updatedAt: stamp };
      data.global.workspaceIds = [id, ...data.global.workspaceIds];
      created = true;
    }
  }
  const record = records[id];
  if (!record) throw new Error(`工作区不存在：${id}`);
  const existing = new Set(record.sessionIds ?? []);
  const fresh = sessionIds.filter((sessionId) => !existing.has(sessionId));
  if (fresh.length === 0 && !created) return { id, created, added: 0, total: existing.size, backup: null };
  record.sessionIds = [...fresh, ...(record.sessionIds ?? [])];
  record.updatedAt = stamp;
  const backup = `${file}.before-import-${stamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(temp, file);
  return { id, created, added: fresh.length, total: record.sessionIds.length, backup };
}
