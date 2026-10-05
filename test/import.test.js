import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSession, buildSessions, normalizeTitle } from "../src/convert.js";
import { attachToWorkspace, deleteArchived, encodeSegment, listWorkspaces, planDeleteArchived, projectKey, readSessionLog, sessionExists, writeListCache, writeSessionLog } from "../src/store.js";

const message = (time, ...fragments) => ({ model: "deepseek-reasoner", inserted_at: time, fragments });
const conversation = () => ({
  id: "c1",
  title: "  测试\u200B 标题 ",
  inserted_at: "2026-01-01T00:00:00.000Z",
  mapping: {
    root: { id: "root", children: ["1"], message: null },
    1: { id: "1", children: ["old", "2"], message: message("2026-01-01T00:00:01.000Z", { type: "FILE", files: [{ file_name: "a.png", file_size: 2048 }] }, { type: "REQUEST", content: "提问" }) },
    old: { id: "old", children: [], message: message("2026-01-01T00:00:02.000Z", { type: "RESPONSE", content: "被重新生成掉的回答" }) },
    2: { id: "2", children: [], message: message("2026-01-01T00:00:03.000Z", { type: "THINK", content: "思考" }, { type: "TOOL_SEARCH", results: [{ url: "https://example.com", title: "例子" }] }, { type: "TOOL_OPEN" }, { type: "RESPONSE", content: "回答" }) },
  },
});

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-chat-import-"));
  fs.mkdirSync(path.join(home, "storages"));
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), JSON.stringify({
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }));
  return home;
}

test("思考与搜索结果进 reasoning，回答进 text，只取当前分支", () => {
  const session = buildSession(conversation());
  assert.equal(session.id, "session-c1");
  assert.equal(session.title, "测试 标题");
  assert.deepEqual(session.events.map((e) => e.type), ["turn/start", "step/start", "user/message", "assistant/message", "step/end", "turn/end", "session/title", "session/end-seed"]);
  session.events.forEach((event, index) => assert.equal(event.seq, index));
  assert.equal(session.events[2].data.content[0].text, "[附件：a.png，2.0 KB，内容不在导出文件里]\n\n提问");
  assert.deepEqual(session.events[3].data.message.content, [
    { type: "reasoning", text: "思考\n\n搜索结果：\n- [例子](https://example.com)" },
    { type: "text", text: "回答" },
  ]);
  assert.equal(session.stats.branches, 1);
  assert.equal(session.lastPromptAt, Date.parse("2026-01-01T00:00:01.000Z"));
});

test("--no-reasoning 去掉思考；只有思考的回答整条不写", () => {
  const conv = conversation();
  assert.deepEqual(buildSession(conv, { keepReasoning: false }).events[3].data.message.content, [{ type: "text", text: "回答" }]);
  conv.mapping[2].message.fragments = [{ type: "THINK", content: "只有思考" }];
  assert.deepEqual(buildSession(conv, { keepReasoning: false }).events.map((e) => e.type), ["turn/start", "step/start", "user/message", "step/end", "turn/end", "session/title", "session/end-seed"]);
});

test("没有消息的会话报错，不产生空会话", () => {
  assert.equal(buildSession({ id: "x", mapping: { root: { id: "root", children: [] } } }).error, "会话里没有消息");
  assert.equal(buildSession({ mapping: {} }).error, "会话没有 id");
});

test("时间戳乱序时事件时间不倒退", () => {
  const conv = conversation();
  conv.mapping[2].message.inserted_at = "2025-12-31T00:00:00.000Z";
  const times = buildSession(conv).events.map((e) => e.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("标题按 UTF-8 字节截断，不切断字符", () => {
  const title = normalizeTitle("字".repeat(40));
  assert.equal(Buffer.byteLength(title), 78);
});

test("路径编码与应用一致", () => {
  assert.equal(projectKey("C:\\Users\\me\\Documents\\我的 chats"), "--C-Users-me-Documents-~6211~7684~0020chats--");
  assert.equal(projectKey("/home/me/a~b"), "--home-me-a~007Eb--");
  assert.equal(encodeSegment("session-1/2"), "session-1~002F2");
  assert.equal(encodeSegment(".."), "~002E~002E");
});

test("写日志、缓存、工作区；重复导入不覆盖、不重复挂", () => {
  const home = tempHome();
  const cwd = path.join(home, "ws");
  const session = buildSession(conversation());
  const file = writeSessionLog(home, cwd, session);
  const lines = readSessionLog(file);
  assert.deepEqual(lines[0], { type: "session", version: 0, id: "session-c1", createdAt: session.createdAt, cwd, delegationDepth: 0 });
  assert.equal(lines.length, session.events.length + 1);
  assert.ok(sessionExists(home, cwd, session.id));
  assert.throws(() => writeSessionLog(home, cwd, session), /EEXIST/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["session.jsonl.zstd"]);

  assert.equal(writeListCache(home, cwd, session), true);
  assert.equal(writeListCache(home, cwd, session), false);
  const cache = JSON.parse(fs.readFileSync(path.join(home, "storages", "session_projcache", "sessions", "session-c1.json"), "utf8"));
  assert.equal(cache.version, 7);
  assert.equal(cache.record.rows.title.val, "测试 标题");
  assert.equal(cache.record.rows.title.seq, session.events.length - 1);
  assert.deepEqual(cache.record.identity, { formatVersion: 0, createdAt: session.createdAt, cwd, isSeeded: false, inheritedEventCount: 0 });

  const first = attachToWorkspace(home, { title: "导入", dir: cwd }, [session.id]);
  assert.deepEqual([first.created, first.added, first.total], [true, 1, 1]);
  assert.ok(fs.existsSync(first.backup));
  const second = attachToWorkspace(home, { title: "导入", dir: cwd }, [session.id]);
  assert.deepEqual([second.created, second.added, second.backup], [false, 0, null]);
  assert.deepEqual(listWorkspaces(home).map((w) => [w.title, w.sessionCount]), [["导入", 1]]);
});

test("工作区文件版本不认识时拒绝写", () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), JSON.stringify({ unit: { name: "workspace", version: 3 } }));
  assert.throws(() => listWorkspaces(home), /只认 workspace 版本 2/);
});

test("其它分支各成一个完整会话；被更长路径包含的分支不重复导入", () => {
  const conv = conversation();
  // 再加一条：编辑过的提问（没有回答），以及一个空叶子
  conv.mapping.root.children = ["e", "1"];
  conv.mapping.e = { id: "e", children: [], message: message("2026-01-01T00:00:00.500Z", { type: "REQUEST", content: "编辑前的提问" }) };
  conv.mapping[2].children = ["empty"];
  conv.mapping.empty = { id: "empty", children: [], message: message("2026-01-01T00:00:04.000Z") };

  const all = buildSessions(conv, { branches: "all" });
  assert.equal(all.others, 2);
  assert.deepEqual(all.sessions.map((s) => [s.id, s.title, s.branch]), [
    ["session-c1", "测试 标题", null],
    ["session-c1-be", "测试 标题（分支 2）", 2],
    ["session-c1-bold", "测试 标题（分支 3）", 3],
  ]);
  // 当前分支与只取 current 时完全一样，重复导入才能认出来
  assert.deepEqual(all.sessions[0].events, buildSession(conv).events);
  const old = all.sessions[2].events.filter((e) => e.type.endsWith("/message"));
  assert.equal(old[0].data.content[0].text.endsWith("提问"), true);
  assert.equal(old[1].data.message.content[0].text, "被重新生成掉的回答");
  assert.deepEqual(buildSessions(conv, { branches: "others" }).sessions.map((s) => s.id), ["session-c1-be", "session-c1-bold"]);
  assert.equal(buildSessions(conv).sessions.length, 1);
});

test("分支标题加后缀后仍不超过长度上限", () => {
  const conv = conversation();
  conv.title = "字".repeat(40);
  const title = buildSessions(conv, { branches: "others" }).sessions[0].title;
  assert.ok(Buffer.byteLength(title) <= 80);
  assert.ok(title.endsWith("（分支 2）"));
});

test("删除已归档会话：只删归档的，分叉来源保留，登记、缓存、目录一起清", () => {
  const home = tempHome();
  const cwd = path.join(home, "ws");
  const make = (id) => {
    const conv = conversation();
    conv.id = id;
    const session = buildSession(conv);
    writeSessionLog(home, cwd, session);
    writeListCache(home, cwd, session);
    return session;
  };
  const [a, b, c] = ["a", "b", "c"].map(make);
  // d 是从 b 分叉出来的未归档会话（应用升级后的文件名与带 parentSession 的文件头）
  const forkDir = path.join(home, "sessions", projectKey(cwd), "session-d");
  fs.mkdirSync(forkDir);
  fs.writeFileSync(path.join(forkDir, "session.v4.jsonl"), JSON.stringify({ type: "session", version: 4, id: "session-d", createdAt: 1, cwd, isSeeded: true, delegationDepth: 0, parentSession: b.id }) + "\n");
  attachToWorkspace(home, { title: "导入", dir: cwd }, [a.id, b.id, c.id, "session-d"]);
  const file = path.join(home, "storages", "workspace.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.global.archivedSessionIds = [a.id, b.id, "session-ghost"];
  data.global.pinnedSessionIds = [a.id];
  fs.writeFileSync(file, JSON.stringify(data));

  const plan = planDeleteArchived(home);
  assert.deepEqual(plan.items.map((i) => [i.id, i.title, i.dirs.length]).sort(), [["session-a", "测试 标题", 1], ["session-ghost", null, 0]]);
  assert.deepEqual(plan.kept.map((k) => [k.id, k.neededBy]), [["session-b", "session-d"]]);
  assert.ok(sessionExists(home, cwd, a.id), "只算计划时不删");

  const result = deleteArchived(home, plan);
  assert.equal(result.dirs, 1);
  assert.ok(fs.existsSync(result.backup));
  assert.equal(sessionExists(home, cwd, a.id), false);
  assert.ok(sessionExists(home, cwd, b.id) && sessionExists(home, cwd, c.id));
  assert.equal(fs.existsSync(path.join(home, "storages", "session_projcache", "sessions", "session-a.json")), false);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.global.archivedSessionIds, [b.id]);
  assert.deepEqual(after.global.pinnedSessionIds, []);
  assert.deepEqual(Object.values(after.tables.workspaces)[0].sessionIds.sort(), [b.id, c.id, "session-d"].sort());
  assert.equal(planDeleteArchived(home).items.length, 0);
});
