## Why

pi-review-agent 当前仅支持 GitHub，所有代码直接耦合 GitHub REST API 和 GitHub Actions 环境变量。许多团队使用 Gitea 作为自托管 Git 平台，无法使用此工具。适配 Gitea 可以扩大工具的适用范围，让更多团队受益于 AI 代码审查能力。

## What Changes

- 引入平台抽象层，解耦 GitHub 特定代码
- 实现 Gitea 平台适配器，支持 Gitea REST API v1
- 支持从 Gitea 环境变量（`GITEA_*`）解析 PR 上下文
- 支持 Gitea Actions 或独立 CLI 模式运行
- 保持 GitHub 功能完全不变，向后兼容

## Capabilities

### New Capabilities

- `platform-abstraction`: 定义统一的平台接口，抽象 PR 上下文获取、评论发送、环境解析等操作
- `gitea-adapter`: 实现 Gitea 平台适配器，调用 Gitea API 获取 PR 信息和发送评论
- `gitea-ci-integration`: 支持在 Gitea Actions 或独立 CLI 模式下运行

### Modified Capabilities

（无现有 capability 需要修改）

## Impact

**代码变更**：
- 新增 `src/platforms/` 目录，包含平台接口定义和适配器实现
- 重构 `src/github-context.ts` 和 `src/pr-comment.ts`，迁移到 GitHub 适配器
- 修改 `src/index.ts`，根据环境变量选择平台适配器

**API/接口**：
- 新增 CLI 参数：`--platform`（可选，自动检测优先）
- 新增环境变量前缀：`GITEA_*`（与 `GITHUB_*` 并行）

**依赖**：
- 无新增外部依赖，Gitea API 通过原生 `fetch` 调用

**系统影响**：
- GitHub 用户无需任何改动，行为完全一致
- Gitea 用户可通过环境变量或 CLI 参数启用
