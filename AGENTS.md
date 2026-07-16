# 开发约定

## 分支与 worktree

**IMPORTANT**: 不要在 `main` 分支上直接开发。所有改动（功能、修复、文档、test vehicle）都在 `.worktrees/<branch>/` 下做，基于 `origin/main` 建分支，改完开 PR 合并。

```bash
git fetch origin --quiet
git worktree add .worktrees/<branch> origin/main -b <branch>
# ... 改代码、commit ...
git push -u origin <branch>
gh pr create ...
```

`.worktrees/` 已在 `.gitignore` 里。不要 commit 进去（会被 git 当 submodule，污染历史）。

## 发版与 tag

版本号格式 `vMAJOR.MINOR.PATCH`（semver）。每次发版：

1. 改 `package.json` 的 `version`
2. commit `release: vX.Y.Z`
3. 推 main
4. 打 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z"` + `git push origin vX.Y.Z`
5. `gh release create vX.Y.Z --notes-file <file>`（**用 --notes-file，不要 --notes 内联**，否则 shell 转义会让 `${{ }}` 和反引号变乱码）
6. **前移 major moving tag**（`v1` / `v2` ...）指向新 tag 同一个 commit：

```bash
git tag --force v1 vX.Y.Z
git push origin v1 --force
```

**Moving tag 规则**：
- `v1` 跟 v1.x.x 最新。发 v1.1.0 / v1.2.0 都要前移 `v1`。
- 发 v2.0.0（breaking）时**不动 v1**，新建 `v2`。
- 用户引用 `@v1` = 自动跟最新 v1.x，引用 `@vX.Y.Z` = 精确锁定。

## Release notes

- **永远用 `--notes-file`**，不要 `--notes "inline"`。inline 模式下 heredoc / shell 会让 `\`` 和 `${{ }}` 产生转义残留（之前 v1.0.0/v1.0.1 中过招）。
- 改已发版本的 notes 用 `gh release edit vX.Y.Z --notes-file <file>`。

## Marketplace 约束

GitHub Marketplace 对 action.yml 有硬限制：
- `description` ≤ **125 字符**（折叠后的单行长度，不是行数）。超了直接拒。
- 每个 `inputs.*` / `outputs.*` 都要有 `description`。
- `runs` 必须合法（composite / docker / node）。
- branding 可选但建议有（marketplace 卡片用）。

发版前自查：`python3 -c "import yaml; d=yaml.safe_load(open('action.yml')); print(len(' '.join(d['description'].split())))"`。

## Skill 约束（`skills/setup-pi-review/SKILL.md`）

这个 repo 自带一个 installer skill（`skills/setup-pi-review/`），用户通过 `npx skills add sun-praise/pi-review-agent` 装。Skills CLI（vercel-labs/skills）对 SKILL.md frontmatter 有几个静默失败陷阱：

- **目录名必须 `skills/`**（复数）。`skill/`（单数）不会被扫描。
- **`skills/` 下只放 skill 子目录**，不要混 README.md 等非 skill 文件（人类文档放仓库根的 `SKILLS.md`）。
- **`description` 字段避开 plain-scalar 里的单引号 `'` 和非 ASCII 引号**。`user's` 里的单引号会让 YAML parser 误判字符串结束，frontmatter 解析失败，skill 被**静默丢弃**（无报错）。修法：要么去掉这些字符，要么用 YAML 双引号 `"..."` 包裹整个 description 值。
- **改完用 `npx skills add <repo> --list` 验证能被发现**，不要假设改对了。

本地 `~/.claude/skills/setup-pi-review/` 是同一份镜像；改 repo 里那份后同步过去。

## 验证（CI 之外的本地验证）

改完代码、push 前：
1. `npx tsc --noEmit` —— typecheck 干净
2. `npx tsup` —— 重建 `dist/index.cjs`（action 跑的是 dist，不是 src）
3. 如果改了 review/provider 行为，本地跑一发：
   ```bash
   LITELLM_API_KEY=... LITELLM_BASE_URL=https://... npx tsx src/index.ts \
     --pr <num> --diff-file <path> --persona quality --sessions-root /tmp/sessions
   ```
4. dist 改了**必须 commit**（action 从 dist 跑，src 改了不 rebuild dist = 改动不生效）

## 项目结构

- `src/provider.ts` — LiteLLM→DeepSeek provider 配置（model 形状、cost、cacheRead 折扣）
- `src/personas.ts` — 6 个内置 persona + 自定义 persona 加载（`.github/reviewers/*.yaml`）
- `src/orchestrate.ts` — 并行跑 N persona + coordinator 综合 + verdict fallback
- `src/review.ts` — 单次 review（Agent + tools + JSONL session resume）
- `src/tools.ts` / `src/walk-grep.ts` — read/grep 工具
- `src/pr-comment.ts` — PR comment 发送 + edit-in-place（marker）
- `src/index.ts` — CLI / action 入口（env + args 双模式）
- `action.yml` — composite action 定义
- `dist/index.cjs` — tsup bundle 的单文件（action 跑这个）
- `.github/workflows/dogfood.yml` — 自审 workflow

## TS 规则（项目级 lint）

这个 repo 跑在 Oh My Pi harness 下，强制以下规则（违反会被 hook 拒绝）：

- 不用 `: any` / `as any`（用 `unknown` + 守卫 / schema / `as unknown as T` 带理由）
- 不提取只含一个表达式/一个 return 的函数（inline）
- 用 `Promise.withResolvers()` 而不是 `new Promise((resolve, reject) => ...)`
- 不用 `ReturnType<typeof fn>`（在拥有方命名并 export 类型）
- 顶层 `import type` 用于类型-only 依赖，不内联 `import("...").Type`
- 静态 import，不用 `await import("literal")`（除非运行时选定模块）
- 小静态字符串键查表用 `Record<K, V>`，不用 `Set`（运行时集合才用 Set）
- 不用 inline cast access（`(x as {a: unknown}).a`），用 `in` 守卫

## 关于 opencode multi-review 的关系

这个 repo 是 opencode-actions/multi-review 的替代品，解决后者一个无法绕开的问题：OpenAI-compatible provider 的 `tokens_cache_read` 永远是 0（anomalyco/opencode#34022）。pi-ai 没这个 bug。详见 README 的 "Why this exists"。

不要把 pi-review-agent 和 opencode multi-review 的概念混淆：
- session resume 机制不同（pi 用 JSONL 文件 + actions/cache；opencode 用 export/import bundle）
- persona yaml 格式兼容（drop-in），但运行时完全独立

## 经验沉淀（`.learnings/`）

**IMPORTANT**: 开发中遇到不直觉的坑、根因不明显的问题、容易复犯的错误，**必须**记到 `.learnings/LEARNINGS.md`。光靠记忆下次还会踩；写下来才能让后续开发（人 or agent）查到、少走弯路。**只放文件不够**——本节就是让 agent 知道这个机制的存在和用法，改动才会被执行。

### 何时记录

- 一个问题**根因不显而易见**（不是 typo、不是单纯配置笔误）
- **未来预计还会再犯**（不是已删除模块的历史包袱）
- 调试花了明显时间，且下次遇到靠 grep/报错不能秒定位

### 条目格式

```
## [LRN-YYYYMMDD-NNN] <type>          // type: pitfall / correction / convention
**Logged**: ISO 时间
**Priority**: high | medium | low
**Status**: active | resolved
**Area**: ci | testing | security | build | ...

### Summary     // 一句话：什么坑
### Details     // 发生了什么、为什么难发现、根因（引 file:line）
### Suggested Action  // 可复用的判断标志 / 修法模板
### Metadata
- Source: session_analysis | user_feedback | review
- Related Files: ...
- Tags: ...
```

详见 `.learnings/LEARNINGS.md` 现有条目（照抄格式）。

### 经验索引（按类别，排查时先 grep 关键词）

- **CI / dogfood 跑的是 dist 不是 src** — `uses: ./` 跑 `dist/index.cjs`；只改 src 不重建提交 dist = 自我评审用旧代码评审新代码，且**静默无报错**。调试技巧：`grep "<特征字符串>" dist/index.cjs`。→ LRN-20260716-001
- **orchestrate.ts 顶层 import pi-agent-core 搞挂测试** — exports map + tsx 在 `node --test` 下解析失败；新依赖若拉入 pi-agent-core 必须**懒加载** `await import()`（这是 TS 规则"静态 import"的已知例外，仅此一处）。→ LRN-20260716-002
- **路径越界校验用 path.relative 不用 startsWith** — `startsWith(root)` 会把同名前缀兄弟目录（`/repo` vs `/repo-secret`）误放行。→ LRN-20260716-003
- **walk-grep glob 在 Windows 失败** — `*` 编译成 `[^/]*`，但 Windows 分隔符是 `\`；CI 跑 ubuntu 不暴露，本地开发才中招。→ LRN-20260716-004

同类坑累积 ≥2 条时，把一句话警示提取到这里（pattern-level 提示）。

