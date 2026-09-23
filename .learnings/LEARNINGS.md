## [LRN-20260716-001] pitfall

**Logged**: 2026-07-16T00:00:00Z
**Priority**: high
**Status**: active
**Area**: ci

### Summary
dogfood-review 跑的是提交进 git 的 `dist/index.cjs`（编译产物），不是 PR 的 `src/*.ts`。只改 src、不重新 build 并提交 dist，会导致自我评审用**旧代码**评审新代码，且**静默无报错**——评审结论看似正常，实则无效。

### Details
完整链路：`dogfood.yml` → `uses: ./` → `action.yml` → `node ${{ github.action_path }}/dist/index.cjs`。`dist/` 是 committed 的（`.gitignore` 明确注释 "dist/ is committed: the action runs `node dist/index.cjs` with no install"），所以 action 永远跑 git 里那个 dist，而非当前 src。

这个缺口实际触发过：verifier PR（#24）合并时只改了 src、没重建 dist。用 `grep buildVerifierAgent dist/index.cjs` 追溯发现，verifier 代码直到后来的 #28 才进 dist。也就是说 #24 合并后有一段时间窗口，dogfood-review 在用 pre-verifier 代码评审 verifier 改动。同样地，#33 的安全修复（`resolveInside`）合并后 dist 里也没有（`grep "path outside repository"` = 0），直到 #34 在 CI 内加 build step 才修掉这个根因。

最隐蔽的点：**没有 CI 报错**。评审照常出结论、照常发评论，只是它评审的代码和你以为的不一样。reviewers 也看不出来，因为他们 review 的 diff 是 src，dogfood 跑的是 dist。

### Suggested Action
两类修法，#34 走的是第二种（治本）：
1. 加 CI 校验：build 到临时文件再与 committed dist diff，不同步则 fail（强制每 PR 带 dist 重建）。
2. CI 内当场 build：dogfood workflow 在 `uses: ./` 前加 `npm ci && npm run build`，让 action 永远跑当前 src 编译的 dist，committed dist 不再需要保持同步。

**调试技巧**：验证 dist 是否含某次 src 改动，用 `grep "<改动里的特征字符串>" dist/index.cjs`，比对比时间戳可靠得多。

### Metadata
- Source: session_analysis
- Related Files: .github/workflows/dogfood.yml, action.yml, .gitignore, dist/index.cjs
- Tags: ci, dogfood, dist, build-artifact, silent-failure

---

## [LRN-20260716-002] pitfall

**Logged**: 2026-07-16T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: testing

### Summary
在 `orchestrate.ts` 顶层 `import` 任何会拉入 `@earendil-works/pi-agent-core` 的模块，会搞挂 `orchestrate-*.test.ts` 测试套件（报 `No "exports" main defined in .../pi-agent-core/package.json`）。需要把这种 import 改成函数内的**懒加载** `await import()`。

### Details
`pi-agent-core` 的 `package.json` 用了 `exports` map，而 `tsx` 在 `node --test` 下解析不了这个 map，于是加载失败。`orchestrate.ts` 本身的顶层 import 没问题（它只 type-import `Provider`、且 `runReview` 虽值-import 但惰性），但一旦在顶层加一行 `import { buildVerifierAgent } from "./verifier-agent.js"`，而 `verifier-agent.ts` 顶层 `import { Agent } from "@earendil-works/pi-agent-core"`，就会在模块求值期触发加载 → 整个 `orchestrate.ts` 不可 import → `orchestrate-style-guide.test.ts` / `orchestrate-modelid.test.ts` 全挂，连带 cancel 后续测试。

坑点：这个失败**只在跑全套测试时才出现**，单独写新模块时 `npm run typecheck` 全绿、新模块自己的测试也过，直到那两个既有测试套件被牵连才暴露。一开始容易误以为是新代码的 bug。

修法：把 `import { buildVerifierAgent }` 移进 `runTeamReview` 函数体里，改成 `const { buildVerifierAgent } = await import("./verifier-agent.js");`。这样 pi-agent-core 只在真跑 verifier 时加载，测试图里不会出现它。

### Suggested Action
往 `orchestrate.ts`（或任何被 `*.test.ts` import 的"纯逻辑"模块）加新依赖前，先问一句：这个新依赖的顶层会不会触发 `pi-agent-core` / 其他 `exports`-map 包的加载？会的话，import 放进函数体做懒加载。判断标志：新模块顶层有没有 `import ... from "@earendil-works/pi-agent-core"`。

`review.ts` / `provider.ts` 已经是这种"只在运行时被加载"的模块（`provider.ts` 用 `openai-completions.lazy` 也印证了同一思路），可以照抄。

### Metadata
- Source: session_analysis
- Related Files: src/orchestrate.ts, src/verifier-agent.ts, src/orchestrate-style-guide.test.ts, src/orchestrate-modelid.test.ts
- Tags: testing, tsx, node-test, exports-map, lazy-import, pi-agent-core

---

## [LRN-20260716-003] pitfall

**Logged**: 2026-07-16T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: security

### Summary
路径越界校验必须用 `path.relative(root, resolved)` 判断，**不能用 `resolved.startsWith(root)`**。后者会把同名前缀的兄弟目录误判为子目录（如 cwd `/home/user/repo` 放行 `/home/user/repo-secret`）。

### Details
修 #26（read 工具路径穿越）时，自然的写法是 `if (!abs.startsWith(root)) reject`。但这错在：`/home/user/repo-secret`.startsWith(`/home/user/repo`) === true，而 `repo-secret` 是 cwd 的**兄弟目录**，不是子目录，应当拒绝。`startsWith` 把字符串前缀当成了路径包含关系，这是经典的路径校验 bug。

正确写法：`const rel = path.relative(root, resolved); if (rel === ".." || rel.startsWith(".." + sep) || path.isAbsolute(rel)) reject`。`path.relative` 把兄弟目录算成 `../repo-secret`（以 `..` 开头 → 拒），把不同盘符（Windows）算成绝对路径 → 拒。`rel === ""` 是 cwd 本身，放行。

这个 bug 自己很难发现——单元测试要专门构造同名前缀兄弟目录（`<cwd>-evil`）才会暴露，常规的 `/etc/passwd`、`../foo` 用例两种写法都过得去。

### Suggested Action
任何"路径必须在某根目录内"的校验，一律走 `path.relative`，并在测试里加一个 `startsWith` 能过但实际越界的同名前缀兄弟目录用例。`src/tools.ts:resolveInside` 是参考实现。

### Metadata
- Source: session_analysis
- Related Files: src/tools.ts, src/tools.test.ts
- Tags: security, path-traversal, path-relative, startsWith, unit-test

---

## [LRN-20260716-004] pitfall

**Logged**: 2026-07-16T00:00:00Z
**Priority**: medium
**Status**: active
**Area**: testing

### Summary
`node --test` 在 Windows 上跑全套时，`walk-grep.test.ts` 的 glob 用例失败：`compileGlob` 用 `[^/]*` 匹配 `*`，但 Windows 路径分隔符是 `\`，`**/*.ts` 匹配不上 `src\foo.ts`。这是 main 上的预存 bug，**与本次改动无关**，但会拖累 CI 全绿。

### Details
`walk-grep.ts` 的 `compileGlob`：`*` → `[^/]*`，`**` → `.*`。在 Linux（分隔符 `/`）下正确。但 `walkGrep` 用 `path.relative(cwd, ...)` 生成相对路径，在 Windows 上得到的是 `src\foo.ts`（反斜杠），于是 `^src/.*\.ts$` 匹配失败。dogfood-review 跑在 `ubuntu-latest` 上不暴露此问题，所以 main 的 CI 是绿的；但本地 Windows 开发者跑 `npm test` 会看到 1 个 fail。

### Suggested Action
修法二选一：
1. `compileGlob` 里把分隔符统一：匹配前对路径做 `.replace(/\\/g, "/")`，或在 regex 里同时认 `/` 和 `\`（`[^/\\]*`）。
2. glob 匹配用现成库（如 `minimatch`），但会引入依赖，与 repo"零依赖手搓"风格相悖。

倾向方案 1。建议开单独 issue 跟踪（不在当前 PR 范围内）。

### Metadata
- Source: session_analysis
- Related Files: src/walk-grep.ts, src/walk-grep.test.ts
- Tags: testing, windows, glob, path-separator, platform

---

## [LRN-20260901-005] pitfall

**Logged**: 2026-09-01T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: ci

### Summary
pi-agent-core 流中断时，末端 synthetic assistant message 的 text/usage 都是**空**，不会覆盖采集器里上一轮的旧值——"内容非空 + usage 非空"的守卫双双失效，中间思考片段被当成最终评审结果静默返回成功。

### Details
issue #59 首跑：四个 persona 全部只产出 "Let me check ..." 这类 pre-tool-call 片段，verdict UNKNOWN，run 却 success。根因链：pi-agent-core 在 stream 出错时 emit 一条 `content:[{text:""}]` + `EMPTY_USAGE` + `stopReason:"error"` 的合成消息（agent-loop.js 对 error/aborted 直接 return；Agent.handleRunFailure 同构）。旧 `collectFromAgent` 只在 text 非空时更新 `lastAssistantText`、只在 usage 非空时更新 `lastUsage`——合成消息两个字段都空，于是 fragment（上一条 assistant 消息）和上一轮 usage 原封不动保留；`!collected.usage` 守卫不触发，error run 被当成功。同 issue 还暴露两个伴随缺陷：(1) `message_end` 和 `turn_end` 都带 `.message`，两个事件都 push 导致 JSONL transcript 里每条 assistant 消息重复两份；(2) 发评论的 fetch 无重试，self-hosted runner 一次 "fetch failed" 就把跑完的评审整体丢弃（run d35a811d 日志 `postPrComment: failed (fetch failed); skipping`）。

### Suggested Action
判断 agent run 是否成功，**永远看终态消息的 stopReason/errorMessage，不要用 content/usage 非空当成功信号**——合成失败消息恰好把它们留空。发 PR 评论的路径用 `withTransientRetry`（src/retry.ts）包住 find-or-create 序列。排查这类"成功但有鬼"的 run：看 run log 里有没有 `trying next fallback` / `coordinator failed`（error run 的旁证），再对照 PR 评论里 persona section 是否是思考片段开头（"Let me ..."）。

### Metadata
- Source: session_analysis
- Related Files: src/collect-review.ts, src/review.ts, src/retry.ts, src/pr-comment.ts
- Tags: pi-agent-core, stream-error, silent-failure, github-api, retry, issue-59

---

## [LRN-20260909-001] pitfall

**Logged**: 2026-09-09T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: ci

### Summary
调用方的 review workflow 没写 `actions/checkout` 时，self-hosted runner 的 `$GITHUB_WORKSPACE` 跨 job 持久，reviewer 的 read/grep 和 verifier 的磁盘检查会**静默读到上一个 job 留下的旧 checkout**，基于旧树事实产出幻觉 Blocking 并给出错误 verdict。

### Details
issue #67（实锤于 review-server-neo PR #15 首轮，sha 15fd2ce）：review workflow 直接 `uses: pi-review-agent@v1`，没有 checkout 步骤；本 action 也不做 checkout（README 示例里有，但没人强制）。self-hosted runner 的 workspace 保留着 CI job 早前的 checkout（甚至是 #13 合并前的 main），于是 reviewer "看见" FuncMap 缺 `add`/`num`、`MarkDone` 只有 6 参——都是旧树事实。verifier 的规则层用 API 拉的真 diff 做行号检查所以能 demote（`file not found on disk`——PR 新增文件在旧树里不存在），但 demote 发生在 coordinator 之后，verdict/prose 不会被修正（issue #67 后半，另修）。

关键鉴别信号：PR 评论里 demote 理由出现 **`file not found on disk` 且该文件确实在 PR diff 里** → workspace 一定不是 head 树。

### Suggested Action
修法（本条对应的 fix）：diff 里 `new file mode` 的文件在任何正确的 head/merge checkout 里都必然存在，对其做 fs.access 存在性检查，缺任一即 fail-closed 并在错误信息里指引加 `actions/checkout`（src/workspace-check.ts，入口接线在 index.ts main）。modified/deleted 文件无法用存在性区分新旧树，是有意的部分防护。给使用方排查：先看 workflow 有没有 checkout 步骤，再看 runner 是不是 self-hosted（GitHub-hosted 的 workspace 空目录，反而会让 reviewer 全程 grep 不到东西）。

### Metadata
- Source: user_feedback
- Related Files: src/workspace-check.ts, src/index.ts, src/verifier.ts, action.yml
- Tags: self-hosted, stale-workspace, checkout, hallucination, fail-closed, issue-67

---

## [LRN-20260923-001] pitfall

**Logged**: 2026-09-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: ci

### Summary
git（及 `gh pr diff` / GitHub `.diff` API）对非 ASCII 文件名输出**带引号 + 3 位八进制字节转义**（`core.quotepath` 默认开启）；解析 diff 头时若不解码 `\NNN`，任何含非 ASCII 路径的文件身份都是错的。

### Details
Svtter/hugo-blog PR #134（新增中文文件名博文）review job 直接失败：#67 stale-tree guard 报 "workspace is not the PR head tree"，而工作区其实是正确的 head checkout。判别特征：同一 PR 里纯 ASCII 的新增文件通过检查、只有中文路径被 miss，且报错信息里路径本身带 `\347\232\204` 八进制转义。

根因在 `src/diff-path.ts` 的 `parseDiffPath()`：quoted 分支原样返回引号内内容（注释还声称 "git has already escaped anything tricky"），没有把 `\NNN` 解码回字节再按 UTF-8 组装。`fs.access` 拿字面量 `...omp-\347\232\204-...` 去磁盘找，磁盘上是真实 UTF-8「的」，必然 miss。

`parseDiffPath` 被 `changed-lines.ts`（inline comment file key）、`diff-filter.ts`、`workspace-check.ts` 三处共用——即使不崩，非 ASCII 文件的 inline comment 也会全部 miss。#68 的回归测试只覆盖了含空格的 quoted 路径，没覆盖八进制转义。

### Suggested Action
- 判断标志：错误信息/日志里的路径出现 `\NNN` 八进制序列 = 转义没被解码。
- 修法模板：quoted 分支后接 C-style 反转义——`\NNN`（3 位八进制）收进字节 buffer 最后整体按 UTF-8 decode（一个转义是**多字节字符的单个字节**，不能逐个 toString）；`\"` / `\\` 映射字面字符；未知转义保留原样。a-side 正则用 `(?:[^"\\]|\\.)*` 而非 `[^"]*`，否则路径内的 `\"` 提前截断匹配。
- 写 diff 解析测试时，务必包含一个非 ASCII 文件名用例（这是 #68 测试矩阵的缺口）。

### Metadata
- Source: session_analysis
- Related Files: src/diff-path.ts, src/workspace-check.ts, src/changed-lines.ts, src/diff-filter.ts
- Tags: git, quotepath, diff-parsing, non-ascii, false-positive, issue-74

---

## [LRN-20260923-002] pitfall

**Logged**: 2026-09-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: testing

### Summary
自研文件遍历 + 硬编码忽略表（dist/build/vendor…）会让「提交构建产物」型仓库的 grep 证据静默为空；搜索范围应交给 git（tracked/gitignore 语义）判定。另：`git grep --relative` 是 git 2.44+ 才有的选项，老 runner 上整个调用直接报 unknown option。

### Details
#75 的 dogfood 评审给出假 blocking（「dist 里 grep 不到 unquoteGitPath」）——事实是 dist 已提交且含该函数，但旧 `walkGrep` 的 IGNORE 表无条件跳过 `dist/` 且无任何提示（issue #76）。评审把「工具拒绝看」当成「验证过不存在」，coordinator 按「证据充分者优先」采纳假证据。对照 alibaba/open-code-review 的做法：搜索直接 `git -c core.quotepath=false grep --untracked`，tracked 文件（含提交的构建产物）必可搜、.gitignore 决定排除、非 ASCII 路径字面输出。

实现时踩坑：`git grep --relative` 在 git 2.39（本机/部分 runner）不存在，报 `unknown option 'relative'`——整条命令失败而不是降级。git grep 默认就按 cwd 相对输出路径，无需该选项。

### Suggested Action
- 判断标志：评审引用「grep 无匹配」作为存在性否证时，先确认工具的搜索范围定义在哪（硬编码表 = 静默盲区；git tracked = 与仓库事实一致）。
- 修法模板：`git -c core.quotepath=false grep --no-color -n --untracked (-F|-P) -e <pattern> [-- :(glob)<glob>]`；glob 用 `:(glob)` 前缀走 wildmatch（`*` 不跨 `/`，`**` 跨）。退出码 1 = 无匹配，128 + "not a git repository" = 回退非 git 遍历。不要用 `--relative`（2.44+ only）。
- 截断时先数完所有匹配行再截断渲染，Note 行报真实总数——模型需要区分「少」和「被截断」。

### Metadata
- Source: session_analysis
- Related Files: src/walk-grep.ts, src/tools.ts, internal/tool/code_search.go (alibaba/open-code-review)
- Tags: git-grep, ignore-list, build-artifacts, negative-evidence, issue-76, compatibility
