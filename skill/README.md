# pi-review-agent skill

A skill for the Oh My Pi / Claude Code harness that lets an agent install `sun-praise/pi-review-agent` into any repository via natural language ("setup pi review", "安装 pi-review-agent", etc.).

## Install

### Option A: into `~/.claude/skills/` (user-global, all sessions)

```bash
git clone https://github.com/sun-praise/pi-review-agent.git /tmp/pra
cp -r /tmp/pra/skill/setup-pi-review ~/.claude/skills/
rm -rf /tmp/pra
# restart your harness session — new skill is picked up
```

### Option B: per-project (only that repo's sessions)

Symlink or copy into the project's `.claude/skills/`:

```bash
mkdir -p .claude/skills
cp -r /path/to/pi-review-agent/skill/setup-pi-review .claude/skills/
```

## What it does

When the user asks to set up AI code review / pi-review-agent, the agent will:

1. Confirm the target repo
2. Check for existing review setup (flag opencode multi-review migration path if found)
3. Generate the workflow YAML (default: team mode, 3 personas + coordinator)
4. Point to the secrets URL (`LITELLM_URL`, `LITELLM_API_KEY`)
5. Remind about `pull-requests: write` permission
6. Explain how to verify `cacheRead > 0` after the first PR

## Files

- `SKILL.md` — the skill body (frontmatter + workflow)
- `references/workflow-template.md` — ready-to-paste workflow YAMLs (team / single / custom-model / path-filtered / verdict-gated)
- `references/inputs.md` — full action input/output reference
- `references/migration-from-opencode.md` — drop-in migration from opencode-actions/multi-review
- `references/troubleshooting.md` — cacheRead=0, comment not posted, verdict UNKNOWN, etc.

## Updating the skill

Edit files here, then mirror to `~/.claude/skills/setup-pi-review/` (or just symlink). The harness reads from `~/.claude/skills/` at session start.
