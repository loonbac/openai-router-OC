# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| "judgment day", "review adversarial", "dual review", "doble review" | judgment-day | /home/loonbac/.config/opencode/skills/judgment-day/SKILL.md |
| "create a new skill", "add agent instructions", "document patterns for AI" | skill-creator | /home/loonbac/.config/opencode/skills/skill-creator/SKILL.md |
| "creating a GitHub issue", "reporting a bug", "requesting a feature" | issue-creation | /home/loonbac/.config/opencode/skills/issue-creation/SKILL.md |
| "creating a pull request", "opening a PR", "preparing changes for review" | branch-pr | /home/loonbac/.config/opencode/skills/branch-pr/SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### judgment-day
- Launch TWO sub-agents via delegate (async, parallel) — NEVER sequential
- Both judges receive identical target but work independently without cross-contamination
- Warning classification: Can a normal user trigger it? YES → real (fix required), NO → theoretical (report only)
- MUST NOT declare APPROVED until: 0 CRITICALs + 0 confirmed real WARNINGs
- After Fix Agent returns, IMMEDIATELY re-launch judges in parallel for re-judgment

### skill-creator
- Create skill when: pattern repeated, project conventions differ, complex workflow needs guidance
- Don't create when: documentation already exists, pattern trivial, one-off task
- Skill structure: `skills/{name}/SKILL.md` (required), optional `assets/` and `references/`
- Frontmatter required: name, description (with trigger), license (Apache-2.0), metadata

### issue-creation
- Blank issues disabled — MUST use bug report or feature request template
- Every issue gets `status:needs-review` automatically; maintainer MUST add `status:approved`
- Questions go to Discussions, not issues
- Workflow: search duplicates → choose template → fill required fields → submit

### branch-pr
- Every PR MUST link an approved issue — no exceptions
- Every PR MUST have exactly one `type:*` label
- Branch naming: `type/description` matching `^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)/[a-z0-9._-]+$`
- Conventional commits: `type(scope): description` with type mapping to PR labels

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| README | /home/loonbac/openai-router-OC/README.md | Project documentation |
| openspec/ | /home/loonbac/openai-router-OC/openspec/ | Existing SDD artifacts (proposal, design, spec, explore, tasks) |

Read the convention files listed above for project-specific patterns and rules. All referenced paths have been extracted — no need to read index files to discover more.
