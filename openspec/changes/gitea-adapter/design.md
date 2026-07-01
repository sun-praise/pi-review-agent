## Context

pi-review-agent 是一个 AI 代码审查工具，当前仅支持 GitHub。它通过 GitHub REST API 获取 PR 上下文（标题、描述、评论、变更文件）并发送审查评论。所有平台相关代码直接耦合在 `github-context.ts`、`pr-comment.ts` 和 `index.ts` 中。

Gitea 是一个流行的自托管 Git 平台，其 REST API 与 GitHub API 高度相似（同源于 GitLab），但存在端点路径、认证方式和部分字段名的差异。

## Goals / Non-Goals

**Goals:**
- 引入平台抽象层，将平台相关操作与核心审查逻辑解耦
- 实现 Gitea 适配器，支持 Gitea REST API v1
- 保持 GitHub 功能完全不变，向后兼容
- 支持自动检测平台（通过环境变量）或手动指定（CLI 参数）

**Non-Goals:**
- 不支持 GitLab、Bitbucket 等其他平台（本次仅 Gitea）
- 不实现 Gitea Actions 的完整集成（仅支持独立 CLI 模式）
- 不修改核心审查逻辑（LLM 调用、persona 管理）

## Decisions

### 1. 平台抽象接口设计

**决策**: 定义 `PlatformAdapter` 接口，封装所有平台相关操作。

```typescript
interface PlatformAdapter {
  // 获取 PR 上下文
  fetchPrContext(options: PrContextOptions): Promise<PrContext>
  
  // 发送/更新评论
  postComment(context: PrCommentContext, body: string): Promise<void>
  
  // 从环境变量解析 PR 信息
  resolvePrFromEnv(): PrInfo | null
}
```

**理由**: 
- 接口清晰，易于扩展新平台
- 将平台差异封装在适配器内部，核心逻辑无需修改
- 便于单元测试（mock 适配器）

**替代方案**: 
- 继承基类：耦合更强，不利于多平台并存
- 策略模式：类似，但接口更直观

### 2. Gitea API 兼容性处理

**决策**: 直接调用 Gitea REST API v1，不使用兼容层。

**理由**:
- Gitea API 与 GitHub API 相似度约 80%，差异可控
- 直接调用更清晰，避免引入额外依赖
- 便于处理 Gitea 特有功能（如标签、里程碑）

**关键差异点**:
- 端点路径：`/api/v1/repos/{owner}/{repo}/pulls/{index}` vs `/repos/{owner}/{repo}/pulls/{pr}`
- 认证：Bearer token vs `Authorization: token xxx`
- 字段名：`head.sha` vs `head_sha`（需映射）

### 3. 环境变量检测策略

**决策**: 优先检测 `GITEA_*` 环境变量，其次 `GITHUB_*`，最后 CLI 参数。

**理由**:
- 自动检测减少用户配置负担
- CLI 参数作为显式覆盖，优先级最高
- 避免平台冲突（同一环境不应同时有 GITEA 和 GITHUB）

**检测逻辑**:
1. `--platform` CLI 参数 → 直接使用
2. `GITEA_URL` 或 `GITEA_TOKEN` 存在 → Gitea
3. `GITHUB_REPOSITORY` 存在 → GitHub
4. 都不存在 → 报错

### 4. 目录结构

**决策**: 新增 `src/platforms/` 目录，按平台组织代码。

```
src/
  platforms/
    index.ts          # 导出适配器工厂
    types.ts          # PlatformAdapter 接口定义
    github/
      adapter.ts      # GitHub 适配器实现
      context.ts      # 从 github-context.ts 迁移
      comment.ts      # 从 pr-comment.ts 迁移
    gitea/
      adapter.ts      # Gitea 适配器实现
      context.ts      # Gitea PR 上下文获取
      comment.ts      # Gitea 评论发送
```

**理由**:
- 清晰分离不同平台代码
- 便于独立测试和维护
- 符合项目现有结构风格

## Risks / Trade-offs

**[风险] Gitea API 版本差异** → 在适配器中添加版本检测，记录 API 版本到日志，便于排查问题。

**[风险] 认证方式差异** → 统一使用 Bearer token，Gitea 1.18+ 支持，旧版本需文档说明。

**[风险] 环境变量冲突** → 在文档中明确说明：同一环境不应混用 GITEA 和 GITHUB 变量。

**[权衡] 自动检测 vs 显式配置** → 选择自动检测优先，减少配置负担，但可能在复杂环境下误判。CLI 参数作为安全阀。

**[权衡] 代码重复 vs 抽象复杂度** → GitHub 和 Gitea 适配器会有部分重复代码（如 HTTP 请求封装），但保持适配器独立更清晰，便于未来差异化处理。
