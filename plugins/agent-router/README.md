# agent-router

A [Claude Code](https://claude.com/claude-code) plugin that decides who should take each task when you have Claude, [Codex](https://github.com/openai/codex) and Google Antigravity (`agy`) all at once. On each of your prompts, it:

1. **Sorts the request** into a category: Blender, shaders, Unity/game dev, art review, code review, bug fix, refactor, terminal, design, research, routine build, lookup, frontend or general. Keywords decide first; when none match, one short Haiku call does.
2. **Picks an executor** from that category's benchmark ranking ([RESEARCH.md](RESEARCH.md)), weighted by live quota:
   - A pool is skipped near its limit: 5h at 90% or 7d at 95%. Claude stops earlier, at 85% / 92%, because Claude also runs this chat.
   - **Use it or lose it:** a 7-day window that resets soon with a lot unused earns a bonus. One used ahead of the clock gets a penalty.
   - Big tasks weigh quota more. Small tasks lean toward cheap executors.
   - When Claude is short, Opus and Sonnet places go to **Opus via agy**, the same model on Google's quota.
3. **Tells Claude**, in a hidden note on the prompt (press ctrl+o to see it), for example: `Suggested executor: Gemini 4 Argon, via subagent_type "agent-router:agy-argon". Why: best fit for hard bug fix. Fallback: Sonnet 5.5…`. A fixed routing policy in the system prompt explains the roster and the rules: delegate substantive work, do quick steps yourself, a reviewer is never the builder, and a model you name yourself always wins.

With [agent-boxes](../agent-boxes) (installed with it), the pick shows in the side bar's Next box as `⇄ Gemini 4 Argon · best fit for …`.

## Install

```
/plugin install agent-router --marketplace michaelbystryk/agent-boxes
```

Or from your shell: `claude plugin install agent-router@agent-boxes`. agent-boxes comes with it; its scan supplies the Codex and agy quota.

You need whichever CLIs you want routed to: `codex` signed in for Sol and Astra, and `agy` signed in for Argon, Flash and Opus via agy. An executor's pool with no quota reading counts as unknown, not empty. Argon needs an agy plan that includes it (AI Pro or Ultra).

## Executors and agents

Each executor runs as a subagent type. Your own definition wins: `~/.claude/agents/<name>.md`, then the project's `.claude/agents/<name>.md`. Without one:

- The Codex and agy relays use this plugin's own `agent-router:codex-builder`, `codex-astra`, `agy-argon`, `agy-flash` and `agy-opus`. Each is a Haiku relay that writes the brief to a file, runs `codex exec` or `agy -p`, and reports back.
- Claude's `scout`, `worker` and `architect` become `general-purpose` on Haiku, Sonnet or Opus.

The relays run `codex exec -s workspace-write` and `agy -p … --dangerously-skip-permissions`, or read-only / `--mode plan` for reviews and plans. Claude Code still asks you before each launch unless your permission rules allow it.

## Options

Optional `~/.claude/agent-router/config.json` (or under `$CLAUDE_CONFIG_DIR`):

```json
{ "mode": "advise", "disabled": ["flash"], "order": { "blender": ["astra", "opus"] } }
```

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `"advise"` | `advise` adds the policy and the per-prompt note. `steer` also rewrites a spawn whose pool is out of quota to the category's best live executor, with a `⇄ worker → …` toast. Forks, resumes, teammates and workflow agents are never rewritten. `off` does nothing. |
| `disabled` | `[]` | Executor ids to leave out: `haiku`, `sonnet`, `opus`, `fable`, `sol`, `astra`, `argon`, `flash`, `opus-agy`. |
| `enabled` | `[]` | Executors that are off by default and that you want: `fable`. |
| `order` | `{}` | Per category id, a ranking that replaces the catalog's, by executor id. |
| `classify` | `true` | Ask a small model when no keyword matches. Turn off to label those prompts `general`. |
| `classifyModel` | `"haiku"` | Model for that call. |

`/route` prints the last pick with every candidate's score, the live quota, and any agent the roster is missing.

## Alongside Claude Code's own model settings

Claude Code's built-in choices are Claude-only and blind to the task and to quota:

- `opusplan` switches models on plan mode.
- `fallbackModel` steps in on overload, not on rate limits.
- Subagents take their model from their definition or `CLAUDE_CODE_SUBAGENT_MODEL`.

agent-router leaves all of them alone and only suggests (or in `steer` mode sets) each spawn's agent type and model. If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set, Claude model picks are overridden, and `/route` says so.

## Files

- `~/.claude/agent-router/route-<session>.json`: the last pick, for the agent-boxes side bar.
- `~/.claude/agent-router/history.jsonl`: each spawn (category, the suggestion, what ran) and how long it took, capped at 1000 lines. Recorded for later tuning; v0.1 doesn't learn from it yet.
- Reads `~/.claude/agent-boxes/quota.json`, which agent-boxes writes when Codex or agy quota changes. Readings older than 6 hours are ignored.

## Develop

```sh
claude plugin validate plugins/agent-router
claude plugin test plugins/agent-router
```

`hooks/catalog.ts` holds the executors and rankings, `hooks/route.ts` the classifier and balancer (pure functions), and `hooks/register.tsx` the hooks.
