# Why the catalog ranks what it ranks

Researched on **2026-10-18**. Most numbers come from secondary write-ups or from vendors' own launch tables. Every ranking follows public benchmarks; where none exists (shaders, art review), the row says so and uses the closest public proxy. Treat the rankings as a starting point, and reorder any category in `config.json` (see the [README](README.md)).

## Executors

| Executor | Runs as | Quota it spends | Cost class |
| --- | --- | --- | --- |
| Haiku 5.5 | `scout` (or general-purpose) | Claude | 1 |
| Sonnet 5.5 | `worker` (or general-purpose) | Claude | 4 |
| Opus 5.5 | `architect` (or general-purpose) | Claude | 4 |
| Fable 5.1 | general-purpose, **off by default** | Claude | 5 |
| GPT-6.1 Sol | `codex-builder`, `codex exec` high | Codex | 1 |
| GPT-6 Astra | `codex-astra`, `codex exec` xhigh | Codex | 3 |
| Gemini 4 Argon | `agy-argon`, `agy -p` | agy, Gemini group | 2 |
| Gemini 3.8 Flash | `agy-flash`, `agy -p` | agy, Gemini group | 1 |
| Opus 5.5 via agy | `agy-opus`, `agy -p` | agy, Claude/GPT group | 4 |

Cost classes come from Artificial Analysis' cost to run its Intelligence Index: Fable $7.63, Opus $5.98, Sonnet $5.46, Astra $3.26, Argon $1.99, Flash $1.24, Sol $0.72, Haiku $0.21. Sonnet sits with Opus because it spends more tokens per task. Argon's $1.99 is its intro price, which is set to double.

Opus via agy exists because agy's AI Ultra plan runs Claude models on Google's own quota. Once Claude's 5-hour or 7-day window is nearly full, the router swaps the Opus and Sonnet places in a ranking for it.

## Categories

| Category | Ranked | Evidence |
| --- | --- | --- |
| Long agentic coding / refactor | Sonnet, Opus, Argon, Sol | AA Coding Agent Index (Oct 5): Sonnet 5.5 and Opus 5.5 in Claude Code first and second; Argon 64, Sol 63, Astra 62, Fable 62. [OfficeChai](https://officechai.com/ai/gemini-4-argon-with-antigravity-places-ahead-of-gpt-6-1-sol-on-codex-on-artificial-analysis-coding-agent-index/) |
| Terminal / scripts | Sonnet, Opus, Astra | Terminal-Bench 4.0 (per OfficeChai): Sonnet 63.6, Opus 59.6, Astra 59.1, Argon 57.1, Sol 56.1, Fable 52.0. Google's own table has Opus at 66.4. |
| Hard bug fix | Argon, Sonnet, Opus | DeepSWE v1.1 (per AA): Argon 77.5, Sonnet 71.3, Opus 69.5, Astra 68.5. Google's table: Argon 77.9, Opus 74.2. |
| Game dev (Unity C#, gameplay) | Opus, Sol, Astra | GameDevBench, 333 tasks: Opus xhigh 70.6%, Sol xhigh 70.0%, Astra high 68.8%. It tests Godot, the closest available proxy for Unity. [GitHub](https://github.com/waynchi/gamedevbench) |
| Shaders (HLSL / ShaderLab) | Opus, Sonnet, Sol | Inference only. The one ranking found (a vendor blog) says no model is good at shaders yet. |
| Blender `bpy` / 3D modelling | Opus, Astra, Sol, Argon | Weak: 3JSBench (three.js, Oct 9) has people preferring Opus's output most, with Astra passing correctness most often; no numbers published. [Forum post](https://discourse.threejs.org/t/3jsbench-a-benchmark-for-llm-generated-three-js-objects/95137). 3DCodeBench (Blender 5.0) and BlenderGym exist, with no current results for these models. |
| Art / visual review | Opus, Argon, Sonnet | No public vision benchmark covers these models (Arena's vision board was unreachable). Ranked by general intelligence as the closest proxy: AA Intelligence Opus 58, Sonnet 56; HLE Argon 57.1 ahead of Sonnet. |
| Code review | Opus, Sol, Argon | Inference; no code-review benchmark found. Argon's 15% hallucination rate on AA-Omniscience (Astra 51%, Sol 54%) supports it as a careful second opinion. The policy tells Claude never to have the builder review its own work. |
| Frontend / UI | Opus, Astra, Sonnet | WebDev Arena Opus 1813 vs Astra 1786, from an unverified forum comment. |
| Architecture / hard design | Opus, Sonnet, Argon | AA Intelligence Index: Opus 58, Sonnet 56, then Argon, Astra and Fable at 53; HLE breaks the tie for Argon (57.1 vs Astra 54.7). |
| Research / compare | Argon, Opus, Sonnet | Vals Index for professional and knowledge work (Oct 12): Argon 68.9, Sonnet 67.0, Opus 67.0; Opus leads AA Intelligence, so it goes second. [LetsDataScience](https://letsdatascience.com/blog/gemini-4-argon-public-independent-tests-rank-it-first-and-eighth) |
| Routine build | Sol, Sonnet, Flash | Price: Sol is close to Astra's coding scores at about a fifth of the cost. |
| Lookup / grep / digest | Haiku, Flash, Sol | Price and speed: Haiku 235 tok/s at $0.21 per task. |
| General (no match) | Opus, Sonnet, Sol | The best all-rounder first. |

## Why Fable 5.1 is off by default

Fable 5.1 makes no category's top 3 on a like-for-like benchmark. It has the lowest coding-agent scores of the Claude models listed, it is the most expensive per task, and it is the slowest (71 tok/s). Its strong numbers (HLE 65.0 with tools, SWE-bench Pro 81.2) come from launch coverage with no Opus 5.5 figure on the same test. It also scores zero on any task where its safety classifier steps in, which counts against it for borderline or security-adjacent work. Add `"enabled": ["fable"]` to the config to put it back in the roster, then rank it in `order`.

## Not covered

Arena.ai blocked the research fetch, so there are no Arena, vision, ARC-AGI, OSWorld, tau-bench, MMMU, GPQA, Aider or LiveCodeBench numbers here. Prices: Anthropic's are from its [pricing page](https://platform.claude.com/docs/en/about-claude/pricing); Sol's from [MyGreatLearning](https://www.mygreatlearning.com/blog/gpt-6-1-sol-vs-gemini-4-argon/); Astra's from [eesel.ai](https://www.eesel.ai/blog/gpt-6-astra-pricing), which conflicts with an older listing. Speeds are from the [Artificial Analysis leaderboard](https://artificialanalysis.ai/leaderboards/models).
