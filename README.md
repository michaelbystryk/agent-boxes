# agent-boxes

A side bar for [Claude Code](https://claude.com/claude-code) that shows, at a glance:

- **Usage meters** for Claude, and for [Codex](https://github.com/openai/codex) and Antigravity if you use them: the 7-day and 5-hour windows, with a border that turns yellow at 60% and red at 85%.
- **What every running agent is doing**: Claude's subagents and any Codex runs this chat started, each with its latest action (`↳ $ npm test`, `↳ editing app.ts`), plus any Antigravity runs this chat started (title, model, steps and elapsed time).
- **Now**: the task in progress, a progress bar, and the steps left, taken from Claude's task list.
- **Next**: a one-line recommendation for what to do after this turn.

![agent-boxes: three example side bars, each with Claude, Codex, Antigravity, Now and Next boxes](docs/hero.png)

Each box's border goes green, then yellow at 60% of its 7-day window, then red at 85%. The meters are gradients in each company's colours. These are simulated examples; the side bar is 48 columns wide by default. Full size: [crunch](docs/crunch.png) · [steady](docs/steady.png) · [light](docs/light.png).

## Install

The side bar is a terminal feature and needs the fullscreen TUI.

Type this at the Claude Code prompt:

```
/plugin install agent-boxes --marketplace michaelbystryk/agent-boxes
```

Answer `y` to add the marketplace, then press Enter for the user scope. Run `/reload-plugins` to load it in the chat you're in; new chats load it on their own.

Or install it from your shell:

```sh
claude plugin marketplace add michaelbystryk/agent-boxes
claude plugin install agent-boxes@agent-boxes
```

Any other chat that's already open needs `/reload-plugins` too.

To update later, run `claude plugin update agent-boxes@agent-boxes`, then `/reload-plugins` in open chats.

### What it needs

| | |
| --- | --- |
| **Claude Code 2.1.302 or later** | Required (tested on 2.1.302). Check with `claude --version`; update with `claude update`. |
| **The fullscreen TUI** | Required for the side bar. Turn it on in `/config`, or set `"tui": "fullscreen"` in `~/.claude/settings.json`. |
| **A terminal at least 144 columns wide** | The side bar opens by itself from 144 columns, and from 110 once you've opened it with `/agent-boxes`. |
| **Python 3.8+** on `PATH` | Needed only for the Codex and Antigravity boxes. The Claude, Now and Next boxes work without it. |
| **Codex / Antigravity** | Optional. Each tool's box appears only when the tool is installed (`~/.codex` or `$CODEX_HOME`, `~/.gemini/antigravity-cli`). |

## Options

Installing asks nothing: every option starts at its default. To change one, create `~/.claude/agent-boxes/config.json` (or `$CLAUDE_CONFIG_DIR/agent-boxes/config.json`) with just the options you want, then start a new chat or run `/reload-plugins`:

```json
{ "width": 56, "background": "dock" }
```

| Option | Default | What it does |
| --- | --- | --- |
| `brief` | `true` | After each of Claude's turns, asks a small model what's under way and what to do next. Turn it off to drop the Next box and the extra model call. |
| `briefModel` | `"haiku"` | Model alias or ID used for the summaries. |
| `width` | `48` | Columns the side bar asks for. |
| `background` | `"black"` | `black` uses a black background with light text so it reads on any theme. `dock` uses the side bar's own colours. |
| `python` | `""` | Command used to run Python, such as `"py -3"` or a full path. When empty, it tries `python3`, `python`, then `py` (requiring 3.8+). |

## How it works

- **Claude:** usage, context and subagents come straight from Claude Code. Each subagent's `↳` line is its latest tool call.
- **Now:** reads the chat's task list from `~/.claude/tasks/<session>/` (`$CLAUDE_CONFIG_DIR` is respected across all `~/.claude` paths). With no task list, the summary model fills it in.
- **Next** and the `⏳ waiting on you` marker: one short call to the summary model after each main turn. It sends your latest request, Claude's reply (trimmed to a few thousand characters) and the task list. The call runs on your own Claude account like any other request.
- **Codex:** `scripts/boxes.py` polls every 5 seconds. It finds the `codex exec` runs this chat started by matching the chat's shell commands to Codex's local thread database in `~/.codex` (or `$CODEX_HOME`). Each run's `↳` line is the last item in its rollout log: a command, an edit or a message. Quota comes from the rate limits Codex logs.
- **Antigravity:** found the same way, by matching `agy -p` runs to `~/.gemini/antigravity-cli/conversation_summaries.db`. Each run shows its title, model, steps and elapsed time (only Codex runs and Claude subagents get a `↳` latest-action line). Quota comes from `agy -p /usage --output-format json`, a read-only command that spends no quota and opens no window. It runs after an Antigravity run changes something (at most every 2 minutes), and otherwise once an hour.

Everything runs on your own machine. Nothing is sent anywhere except the summary call above.

## Troubleshooting

- **No side bar:** check the fullscreen TUI and terminal width (above). It opens by itself from 144 columns, and from 110 once you've opened it with `/agent-boxes`.
- **"needs Python 3.8+" / Python 2 / macOS `python3` asks for developer tools:** install Python 3 from [python.org](https://www.python.org) or Homebrew, or set the `python` option (see [Options](#options)) to a working Python 3.8+ interpreter.
- **Codex quota shows `–`:** stays `–` until Codex has logged at least one run in the last 7 days.
- **Codex runs don't show up:** only runs this chat started with `codex exec` are listed, and only for 12 hours after they start.
- **Antigravity quota shows `–`:** `agy` must be on `PATH` (on Windows, the default `%LOCALAPPDATA%gyingy.exe` also works) and signed in. The first reading takes a few seconds.
- **`scan slow` hint:** the 5-second background scan took longer than usual (for example, while reading large session logs or waiting on disk). It keeps the previous reading and catches up on the next poll.
- **State and cache files:** stored in `~/.claude/agent-boxes/` (or `$CLAUDE_CONFIG_DIR/agent-boxes/`). Delete that folder to clear cached Antigravity quota readings.
- **Uninstall:** run `/plugin uninstall agent-boxes` in Claude Code, or `claude plugin uninstall agent-boxes@agent-boxes` from your shell.

## Develop

```sh
git clone https://github.com/michaelbystryk/agent-boxes
claude --plugin-dir ./agent-boxes      # run a chat with your working copy
claude plugin validate ./agent-boxes
claude plugin test ./agent-boxes
(cd agent-boxes && python3 -E -m unittest tests/test_scan.py)   # the scanners' tests
python3 -E agent-boxes/scripts/boxes.py <session-id>   # the scan's raw JSON
```

`hooks/register.tsx` is the side bar. `scripts/` holds the Codex and Antigravity scanners.

## License

MIT
