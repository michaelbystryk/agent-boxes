"""Simulated agent-boxes side bar screenshots, drawn cell by cell with the plugin's own
colours, meter maths and layout (hooks/register.tsx), at 2x for crisp README images.
Needs Pillow and the Windows Consolas and Segoe UI Symbol fonts: python docs/make_shots.py docs"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
S = 2  # pixel scale
FONT = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 15 * S)
BOLD = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 15 * S)
SYM = ImageFont.truetype("C:/Windows/Fonts/seguisym.ttf", 14 * S)
CW = round(FONT.getlength("M"))
CH = round(15 * S * 1.32)
COLS = 48  # bodyColumns, the plugin's default width
INNER = COLS - 4  # less border and padding
METER = max(8, COLS - 4 - 9)
METER5 = max(6, round(METER / 2 + 1e-9))

TERM = (12, 12, 12)  # the terminal's black (background option "black")
FG = "#e6e6e6"
DIM = "#8b949e"
YELLOW = "#e3b341"
TRACK = "#262626"

CLAUDE = [(200, 85, 45), (217, 119, 87), (242, 166, 90)]
OPENAI = [(105, 105, 105), (190, 190, 190), (255, 255, 255)]
GEMINI = [(66, 133, 244), (155, 114, 203), (217, 101, 112)]
NOW = [(56, 139, 253), (121, 192, 255)]
NEXT = [(163, 113, 247), (210, 168, 255)]
ROUTER = [(45, 186, 160), (125, 226, 200)]


def heat(used):
    return "#f85149" if used >= 85 else YELLOW if used >= 60 else "#3fb950"


def blend(stops, f):
    t = min(1, max(0, f)) * (len(stops) - 1)
    i = min(len(stops) - 2, int(t))
    a, b = stops[i], stops[i + 1]
    return "#%02x%02x%02x" % tuple(round(a[k] + (b[k] - a[k]) * (t - i)) for k in range(3))


# A row is a list of cells: (char, fg, bg, bold).
def text(s, fg=FG, bold=False):
    return [(ch, fg, None, bold) for ch in s]


def title(icon, name, brand):
    cells = [(icon, blend(brand, 0), None, True), (" ", None, None, False)]
    n = max(1, len(name) - 1)
    return cells + [(ch, blend(brand, i / n), None, True) for i, ch in enumerate(name)]


def meter(label, used, brand, width, shown=None):
    shown = shown if shown is not None else f"{round(used)}%"
    share = min(100, used) / 100
    halves = max(1, round(share * width * 2)) if share > 0 else 0

    def shade(h):
        return blend(brand, h / max(1, halves - 1)) if h < halves else TRACK

    cells = [("▌", shade(2 * i), shade(2 * i + 1), False) for i in range(width)]
    return cells + text(f" {label} {shown}", DIM)


def wrap(cells):
    """Ink-style wrap at the box's inner width, breaking at spaces."""
    rows = []
    while len(cells) > INNER:
        cut = max((i for i in range(INNER) if cells[i][0] == " "), default=INNER)
        rows.append(cells[:cut])
        cells = [(" ", None, None, False)] * 2 + cells[cut + 1:] if cells[0][0] in "◆└·" else cells[cut + 1:]
    return rows + [cells]


def card(icon, name, brand, used7, used5, body):
    rows = [title(icon, name, brand), meter("7d", used7, brand, METER), meter("5h", used5, brand, METER5)]
    return heat(used7), rows + body


def plain(icon, name, brand, body):
    return blend(brand, 0), [title(icon, name, brand)] + body


def agent(line, now=None, depth=0, kind=None, relay=False):
    """A run; a relay's run has Claude's ✻ in front instead of ◆."""
    if relay:
        head = [("✻", blend(CLAUDE, 0.5), None, False), (" ", None, None, False)] + text(line)
    else:
        head = text("  " * depth + ("◆ " if depth == 0 else "└ ") + line)
    if kind:
        head += text(f" · {kind}", DIM)
    out = wrap(head)
    if now:
        out += wrap(text("  " * depth + "  ↳ " + now, DIM))
    return out


def draw(boxes, path):
    rows = sum(len(b[1]) + 2 for b in boxes)
    pad = 14 * S
    img = Image.new("RGB", (COLS * CW + 2 * pad, rows * CH + 2 * pad), TERM)
    d = ImageDraw.Draw(img)
    y = pad
    for border, body in boxes:
        h = (len(body) + 2) * CH
        x0, y0 = pad + CW // 2, y + CH // 2
        x1, y1 = pad + COLS * CW - CW // 2, y + h - CH // 2
        d.rounded_rectangle([x0, y0, x1, y1], radius=CH // 2, outline=border, width=max(2, S + 1))
        for r, cells in enumerate(body):
            cy = y + (r + 1) * CH
            for c, (ch, fg, bg, bold) in enumerate(cells[:INNER]):
                cx = pad + (c + 2) * CW
                if ch == "▌":
                    d.rectangle([cx, cy + S, cx + CW // 2 - 1, cy + CH - 1 - S], fill=fg)
                    d.rectangle([cx + CW // 2, cy + S, cx + CW - 1, cy + CH - 1 - S], fill=bg)
                    continue
                if ch == " ":
                    continue
                font = BOLD if bold else FONT
                if not font.getmask(ch).getbbox() or ord(ch) in (0x2726, 0x273B, 0x25CE, 0x279C, 0x23F3, 0x25C6, 0x21B3, 0x21C4):
                    font = SYM
                w = font.getlength(ch)
                d.text((cx + (CW - w) / 2, cy + CH / 2), ch, font=font, fill=fg, anchor="lm")
        y += h
    img.save(path, optimize=True)
    return img


SCENES = {
    # Claude past its 7-day limit: the router steers to Opus on agy's quota; a relay runs on Codex.
    "crunch": dict(
        claude=(95, 62, "claude-opus-5-5", 71, [
            ("Review the auth flow", "Grep \"session\" src/", "reviewer"),
            ("Find the flaky tests", "Read jest.config.ts", "scout"),
        ]),
        codex=(75, 90, [
            ("login · gpt-6.1-sol high · 182k tok · 9m", "$ npm test -- auth", 0, True),
            ("write fixtures · 12k tok · 2m", None, 1, False),
        ], []),
        agy=(10, 4, [], [("Port the session store", "starting…")]),
        now=dict(waiting=False, task="Wiring the login form", done=3, total=7,
                 steps=["Add the session cookie", "Write the auth tests", "Update the changelog", "Open the PR"]),
        next=("Merge the auth branch once the tests pass", "Codex is 90% into its 5h window; land it before it resets."),
        router=("steer", "Opus 5.5 via agy", "refactor (large)", "best fit for long agentic coding / refactor", "GPT-6.1 Sol"),
    ),
    # Antigravity near its limit: the router sends a design task to Codex, and Astra is on it.
    "steady": dict(
        claude=(75, 33, "claude-sonnet-5-5", 38, [("Check the rollback path", "Read db/schema.sql", "reviewer")]),
        codex=(10, 2, [
            ("migration · gpt-6-astra xhigh · 64k · 4m", "$ rg -n \"ALTER TABLE\" db/", 0, True),
        ], []),
        agy=(95, 81, [
            ("API docs · gemini-4-argon · 41 steps · 18m", None, 0, False),
        ], []),
        now=dict(waiting=True, task="Reviewing the migration plan", done=5, total=6, steps=["Run it on staging"]),
        next=("Approve the plan, then run it on staging", "The plan is written; it needs your go-ahead."),
        router=("advise", "GPT-6 Astra", "design (large)", "best fit for architecture / hard design", "Opus 5.5"),
    ),
    # Before any routed prompt: the router shows the pool best placed now.
    "light": dict(
        claude=(10, 7, "claude-opus-5-5", 12, []),
        codex=(95, 48, [
            ("parser · gpt-6.1-sol high · 940k · 1h12m", "editing parser.py +84", 0, False),
        ], []),
        agy=(75, 20, [
            ("Bench · gemini-4-argon · 17 steps · 11m", None, 0, True),
        ], [("Port the lexer tests", "reporting back")]),
        now=dict(waiting=False, task="Splitting the parser module", done=1, total=4,
                 steps=["Move the lexer out", "Port the tests", "Benchmark both"]),
        next=("Compare the benchmark with main before merging", "The refactor touches the hot path."),
        router=("advise", None, None, "Claude best placed · 90% free · use it or lose it · 8 ready", None),
    ),
}


def boxes(sc):
    u7, u5, model, ctx, subs = sc["claude"]
    claude_body = [text(model, DIM), text(f"ctx {ctx}%", DIM)]
    for label, now, kind in subs:
        claude_body += agent(label, now, kind=kind)

    def tool_body(agents, waiting):
        if not agents and not waiting:
            return [text("no agents running", DIM)]
        out = []
        for line, now, depth, relay in agents:
            out += agent(line, now, depth, relay=relay)
        for label, state in waiting:
            out += wrap(agent(label, relay=True)[0] + text(f" · {state}", DIM))
        return out

    n = sc["now"]
    now_body = [text("⏳ waiting on you", YELLOW)] if n["waiting"] else []
    now_body += [text(n["task"]), meter("", 100 * n["done"] / n["total"], NOW, METER, f"{n['done']}/{n['total']}")]
    now_body += [text(f"· {s}", DIM) for s in n["steps"]]
    nxt, why = sc["next"]

    mode, pick, routed, reason, alt = sc["router"]
    router_title = title("⇄", "router", ROUTER) + text(f" · {mode}", DIM)
    if pick:
        router_body = wrap(text(pick) + text(f" · {routed}", DIM)) + wrap(text(reason + (f" · alt {alt}" if alt else ""), DIM))
    else:
        router_body = wrap(text(reason, DIM))
    return [
        card("✻", "claude", CLAUDE, u7, u5, claude_body),
        card("֎", "codex", OPENAI, sc["codex"][0], sc["codex"][1], tool_body(*sc["codex"][2:])),
        card("✦", "antigravity", GEMINI, sc["agy"][0], sc["agy"][1], tool_body(*sc["agy"][2:])),
        plain("◎", "now", NOW, now_body),
        plain("➜", "next", NEXT, wrap(text(nxt)) + wrap(text(why, DIM))),
        (blend(ROUTER, 0), [router_title] + router_body),
    ]


os.makedirs(OUT, exist_ok=True)
imgs = [draw(boxes(sc), os.path.join(OUT, f"{name}.png")) for name, sc in SCENES.items()]
gap = 24 * S
hero = Image.new("RGB", (sum(i.width for i in imgs) + gap * (len(imgs) - 1), max(i.height for i in imgs)), TERM)
x = 0
for i in imgs:
    hero.paste(i, (x, 0))
    x += i.width + gap
hero.save(os.path.join(OUT, "hero.png"), optimize=True)
print("wrote", [f for f in os.listdir(OUT)])
