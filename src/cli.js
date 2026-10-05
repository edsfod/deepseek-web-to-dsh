import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

import { buildSessions, normalizeTitle } from "./convert.js";
import { attachToWorkspace, deleteArchived, findWorkspace, listWorkspaces, planDeleteArchived, projectDir, sessionExists, workspaceFile, writeListCache, writeSessionLog } from "./store.js";

const DEFAULT_PORT = 3080;
const APP_NAME = "DeepSeek Harness";

const HELP = `dsh-chat-import：把 DeepSeek 网页版（chat.deepseek.com）导出的聊天记录导入 DeepSeek Harness

用法：
  dsh-chat-import <conversations.json> --new-workspace <标题> [--workspace-dir <目录>]
  dsh-chat-import <conversations.json> --workspace <标题|目录|id>
  dsh-chat-import --list-workspaces
  dsh-chat-import --delete-archived [--dry-run]

选项：
  --new-workspace <标题>     新建一个工作区放导入的会话
  --workspace-dir <目录>     新工作区的目录，默认 <文档>/deepseek-harness/<标题>
  --workspace <标题|目录|id> 放进已有的工作区
  --branches <current|all|others>
                             重新生成回答、编辑提问会留下多条分支。current（默认）只导入
                             网页版当前显示的那条；others 只导入其余分支，每条成为一个
                             独立会话，标题带「（分支 N）」；all 两者都导入
  --no-reasoning             不导入思考过程和搜索结果（默认保留，界面上可折叠）
  --dry-run                  只解析并统计，不写任何文件
  --home <目录>              Harness 数据目录，默认 $DSH_HOME 或 ~/.dsh
  --port <端口>              用来判断 dsh web 是否在运行的端口，默认 ${DEFAULT_PORT}
  --force                    检测到 Harness 在运行也照样导入（不建议）
  --list-workspaces          列出已有工作区
  --delete-archived          彻底删除 Harness 里已归档的全部会话（Harness 自己只能归档，
                             不能删除）。不限于导入的会话；删除后不能恢复，先用 --dry-run 看清单
  -v, --version / -h, --help

导入前请退出 DeepSeek Harness（桌面版连托盘图标一起退出，dsh web 按 Ctrl+C）：
它运行时会用内存里的状态覆盖工作区文件。重复运行是安全的，已导入的会话会跳过。
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { files: [], port: DEFAULT_PORT, reasoning: true, branches: "current" };
  const value = (i, name) => {
    if (i >= argv.length) throw new UsageError(`${name} 后面缺少值`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--new-workspace": args.newWorkspace = value(++i, arg); break;
      case "--workspace-dir": args.workspaceDir = value(++i, arg); break;
      case "--workspace": args.workspace = value(++i, arg); break;
      case "--home": args.home = value(++i, arg); break;
      case "--port": args.port = Number(value(++i, arg)); break;
      case "--branches": args.branches = value(++i, arg); break;
      case "--no-reasoning": args.reasoning = false; break;
      case "--dry-run": args.dryRun = true; break;
      case "--force": args.force = true; break;
      case "--list-workspaces": args.listWorkspaces = true; break;
      case "--delete-archived": args.deleteArchived = true; break;
      case "-v": case "--version": args.version = true; break;
      case "-h": case "--help": args.help = true; break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`不认识的选项：${arg}`);
        args.files.push(arg);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new UsageError("--port 要是 1 到 65535 的整数");
  if (!["current", "all", "others"].includes(args.branches)) throw new UsageError("--branches 只能是 current、all 或 others");
  if (args.workspace !== undefined && args.newWorkspace !== undefined) throw new UsageError("--workspace 和 --new-workspace 只能用一个");
  if (args.workspaceDir !== undefined && args.newWorkspace === undefined) throw new UsageError("--workspace-dir 要和 --new-workspace 一起用");
  return args;
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/** 桌面版与 dsh 命令的进程（都叫 DeepSeek Harness）；查不了时返回空，只靠端口判断。 */
function appProcesses() {
  const self = new Set([process.pid, process.ppid]);
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${APP_NAME}.exe`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return out.split(/\r?\n/).map((line) => Number(line.split('","')[1])).filter((pid) => Number.isInteger(pid) && !self.has(pid));
    }
    const out = execFileSync("pgrep", ["-f", APP_NAME], { encoding: "utf8" });
    return out.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && !self.has(pid));
  } catch {
    return [];
  }
}

function readConversations(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不了 ${file}：${error.message}`);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : null;
  if (!list) throw new Error(`${file} 不是 DeepSeek 网页版导出的 conversations.json（应是会话数组）`);
  return list;
}

function readVersion() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return void console.log(HELP);
  if (args.version) return void console.log(readVersion());

  const home = path.resolve(expandHome(args.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")));
  if (args.listWorkspaces) {
    for (const w of listWorkspaces(home)) console.log(`${w.title}\t${w.sessionCount} 个会话\t${w.path}\t${w.id}`);
    return;
  }
  if (args.deleteArchived) return void (await runDeleteArchived(home, args));
  if (args.files.length !== 1) throw new UsageError("请给出一个 conversations.json 的路径");
  if (args.workspace === undefined && args.newWorkspace === undefined) throw new UsageError("请用 --new-workspace <标题> 或 --workspace <标题|目录|id> 指定工作区");

  // 1. 解析
  const source = path.resolve(expandHome(args.files[0]));
  const conversations = readConversations(source);
  const sessions = [];
  const unusable = [];
  const totals = { turns: 0, messages: 0, reasoning: 0 };
  let otherBranches = 0;
  let branched = 0;
  for (const conv of conversations) {
    const built = buildSessions(conv, { keepReasoning: args.reasoning, branches: args.branches });
    if (built.error) {
      unusable.push({ id: conv?.id, title: conv?.title, error: built.error });
      continue;
    }
    otherBranches += built.others;
    if (built.others > 0) branched++;
    for (const session of built.sessions) {
      sessions.push(session);
      for (const key of Object.keys(totals)) totals[key] += session.stats[key];
    }
  }
  console.log(`导出文件：${source}`);
  console.log(`网页版会话 ${conversations.length} 个，其中 ${branched} 个有其它分支（共 ${otherBranches} 条）`);
  if (unusable.length > 0) console.log(`没有内容、不导入的 ${unusable.length} 个`);
  const what = { current: "只导入当前显示的分支", others: "只导入其它分支", all: "导入全部分支" }[args.branches];
  console.log(`${what}：${sessions.length} 个会话（${totals.turns} 轮，${totals.messages} 条消息，其中 ${totals.reasoning} 条回答带思考过程）`);
  if (args.branches === "current" && otherBranches > 0) console.log(`其它分支可以用 --branches others 另外导入`);
  const ids = new Set();
  for (const session of sessions) {
    if (ids.has(session.id)) throw new Error(`导出文件里有重复的会话 id：${session.id}`);
    ids.add(session.id);
  }
  if (sessions.length === 0) throw new Error("没有可导入的会话");

  // 2. 工作区
  let target;
  if (args.workspace !== undefined) {
    const found = findWorkspace(home, args.workspace);
    if (!found) throw new Error(`找不到工作区「${args.workspace}」，可用 --list-workspaces 查看`);
    target = { id: found.id, title: found.title, dir: found.path, isNew: false };
  } else {
    const title = normalizeTitle(args.newWorkspace);
    if (!title) throw new UsageError("--new-workspace 的标题不能为空");
    const dir = path.resolve(expandHome(args.workspaceDir ?? path.join(os.homedir(), "Documents", "deepseek-harness", title.replace(/[<>:"/\\|?*]/g, "_"))));
    listWorkspaces(home); // 数据目录不对的话在这里就报错，不等到写完会话
    target = { title, dir, isNew: true };
  }
  console.log(`工作区：${target.title} → ${target.dir}${target.isNew ? "（新建）" : ""}`);

  if (args.dryRun) return void console.log("--dry-run：没有写任何文件");

  // 3. Harness 不能在运行
  await requireStopped(args, "导入");

  // 4. 写会话日志与列表缓存
  if (target.isNew) fs.mkdirSync(target.dir, { recursive: true });
  const cwd = fs.realpathSync.native(target.dir);
  const written = [];
  const skipped = [];
  const failed = [];
  for (const session of sessions) {
    try {
      if (sessionExists(home, cwd, session.id)) {
        skipped.push(session);
      } else {
        writeSessionLog(home, cwd, session);
        written.push(session);
      }
      writeListCache(home, cwd, session);
    } catch (error) {
      failed.push({ session, error });
    }
  }
  console.log(`写入会话 ${written.length} 个，已存在跳过 ${skipped.length} 个，失败 ${failed.length} 个`);
  for (const { session, error } of failed.slice(0, 20)) console.error(`  失败 ${session.id}（${session.title ?? "无标题"}）：${error.message}`);

  // 5. 挂到工作区：只挂日志确实在盘上的会话，新的在前、按创建时间从近到远
  const attach = [...written, ...skipped].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const result = attachToWorkspace(home, target.isNew ? { title: target.title, dir: cwd } : { id: target.id }, attach.map((s) => s.id));
  console.log(`工作区「${target.title}」新挂 ${result.added} 个会话，现有 ${result.total} 个`);
  if (result.backup) console.log(`改动前的工作区文件备份在：${result.backup}`);
  console.log(`\n完成。启动 ${APP_NAME} 即可在「${target.title}」下看到这些会话。`);
  console.log(`要撤销：退出应用，删除 ${projectDir(home, cwd)}，再用上面的备份换回 ${workspaceFile(home)}。`);
  if (failed.length > 0) process.exitCode = 1;
}

async function requireStopped(args, action) {
  const running = [];
  if (await portOpen(args.port)) running.push(`端口 ${args.port} 上有服务在监听（dsh web）`);
  const pids = appProcesses();
  if (pids.length > 0) running.push(`${APP_NAME} 进程在运行（PID ${pids.slice(0, 5).join("、")}）`);
  if (running.length === 0) return;
  if (!args.force) throw new Error(`${running.join("；")}。\n请先退出 ${APP_NAME}（桌面版连托盘图标一起退出）再${action}；确认无关的话加 --force。`);
  console.warn(`警告：${running.join("；")}，按 --force 继续`);
}

async function runDeleteArchived(home, args) {
  if (args.files.length > 0) throw new UsageError("--delete-archived 不接受文件参数");
  const plan = planDeleteArchived(home);
  for (const item of plan.kept) console.log(`保留 ${item.title ?? item.id}：未归档的会话 ${item.neededBy} 是从它分叉出来的`);
  if (plan.items.length === 0) return void console.log("没有可删除的已归档会话");
  const own = plan.items.filter((item) => !item.subagent);
  console.log(`已归档、将删除的会话 ${own.length} 个${plan.items.length > own.length ? `，连同它们的子代理会话 ${plan.items.length - own.length} 个` : ""}：`);
  for (const item of own) console.log(`  ${item.title ?? "（无标题）"}\t${item.id}${item.dirs.length === 0 ? "\t（盘上已没有日志，只清登记）" : ""}`);
  if (args.dryRun) return void console.log("--dry-run：没有删除任何东西");
  await requireStopped(args, "删除");
  const result = deleteArchived(home, plan);
  console.log(`已删除 ${plan.items.length} 个会话（${result.dirs} 个目录）`);
  console.log(`改动前的工作区文件备份在：${result.backup}（只能恢复列表，会话内容已删除）`);
}

export async function run(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n用 --help 看用法。`);
      process.exitCode = 2;
    } else {
      console.error(`出错：${error.message}`);
      process.exitCode = 1;
    }
  }
}
