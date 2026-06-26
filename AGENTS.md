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
