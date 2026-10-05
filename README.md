# dsh-chat-import

把 DeepSeek 网页版（chat.deepseek.com）导出的聊天记录导入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，导入后的会话可以在 Harness 里接着聊。

- 列表里直接显示网页版的原标题。
- 思考过程和联网搜索结果保留为可折叠的思考内容，回答正文里只有回答。
- 不覆盖任何已有文件；重复运行会跳过已导入的会话。
- 没有第三方依赖，不联网。

在 DeepSeek Harness 0.2.0-rc.2 的 `dsh web` 界面上测试过（Windows）；桌面版读的是同一份数据。

## 用法

需要 Node.js 22.15 或更新（用到内置的 zstd）。

1. 在 chat.deepseek.com 的设置里导出全部历史对话，拿到压缩包，解压出 `conversations.json`。
2. 退出 DeepSeek Harness：桌面版连托盘图标一起退出，`dsh web` 按 Ctrl+C。它运行时会用内存里的状态覆盖工作区文件，所以工具检测到它在运行会拒绝导入。
3. 先看看会导入什么（不写文件），再正式导入：

```
npx github:edsfod/dsh-chat-import conversations.json --new-workspace "DeepSeek 网页版" --dry-run
npx github:edsfod/dsh-chat-import conversations.json --new-workspace "DeepSeek 网页版"
```

4. 启动 Harness，会话在新工作区「DeepSeek 网页版」下。

也可以克隆本仓库，把上面的 `npx github:edsfod/dsh-chat-import` 换成 `node bin/dsh-chat-import.js`。

| 选项 | 说明 |
|---|---|
| `--new-workspace <标题>` | 新建一个工作区放导入的会话 |
| `--workspace-dir <目录>` | 新工作区的目录，默认 `<文档>/deepseek-harness/<标题>` |
| `--workspace <标题\|目录\|id>` | 放进已有的工作区 |
| `--branches <current\|all\|others>` | 导入哪些分支，见下一节；默认 `current` |
| `--no-reasoning` | 不导入思考过程和搜索结果 |
| `--dry-run` | 只解析并统计，不写任何文件 |
| `--home <目录>` | Harness 数据目录，默认 `$DSH_HOME` 或 `~/.dsh` |
| `--port <端口>` | 判断 `dsh web` 是否在运行时检查的端口，默认 3080 |
| `--force` | 检测到 Harness 在运行也照样导入 |
| `--list-workspaces` | 列出已有工作区 |

## 导入了什么、没导入什么

| 网页版 | 导入后 |
|---|---|
| 提问 | 用户消息 |
| 回答 | 助手消息的正文 |
| 深度思考 | 助手消息里可折叠的思考内容 |
| 联网搜索结果 | 并入思考内容，一行一个链接 |
| 上传的文件 | 只在提问里留一行文件名和大小：导出文件里没有文件内容 |
| 重新生成、编辑提问产生的其它分支 | 默认不导入；`--branches others` 或 `all` 时每条分支成为一个独立会话 |
| 没有任何消息的会话 | 不导入 |

会话的创建时间、每条消息的时间、所用模型名照原样保留。

### 分支

在网页版里重新生成回答或编辑提问，旧的那条不会删，会话变成一棵树；Harness 的会话是一条直线。所以其它分支导入后各是一个完整的会话（从第一条消息到该分支的末尾），标题在原标题后加「（分支 N）」，与当前分支共有的前半段在每个会话里各有一份。整条都已包含在别的分支里的（例如编辑提问后没等到回答）不重复导入。

分支多的话建议放进另一个工作区，主列表不会被冲乱：

```
npx github:edsfod/dsh-chat-import conversations.json --new-workspace "DeepSeek 网页版"
npx github:edsfod/dsh-chat-import conversations.json --new-workspace "DeepSeek 网页版（其它分支）" --branches others
```

## 它写了哪些文件

都在 Harness 数据目录（默认 `~/.dsh`）里：

- `sessions/<工作区目录编码>/session-<网页版会话 id>/session.jsonl.zstd`：会话日志，用 Harness 最早的会话格式（版本 0）。Harness 保留着从版本 0 逐级升级的转换，第一次打开会话时自己升到当前格式，所以本工具不用跟着它的格式升级改。
- `storages/session_projcache/sessions/session-<id>.json`：列表缓存。Harness 列出没打开过的会话时只读它，没有的话列表里全是 Untitled。
- `storages/workspace.json`：把会话挂到工作区。改之前原文件复制为 `workspace.json.before-import-<时间>`；格式版本不是它认识的那个时拒绝写。

## 撤销

退出 Harness，然后：

1. 删除导入时提示的那个 `sessions/<工作区目录编码>` 目录（新建工作区时，里面只有这次导入的会话）。
2. 用 `workspace.json.before-import-<时间>` 换回 `storages/workspace.json`。

列表缓存里多出来的文件不影响使用，可以不管。

## 开发

```
node --test
```

要在真实界面里看效果又不碰自己的数据：把 `--home` 指到一个临时目录（先从 `~/.dsh` 复制 `storages`、`profiles` 过去），再用同一个目录作 `DSH_HOME` 启动 `dsh web --port <别的端口>`。

## 许可

MIT。会话存储的路径编码与文件布局依据 DeepSeek Harness（MIT）的实现。
