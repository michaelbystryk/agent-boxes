import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, PluginOptions, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { Brief, ClaudeBox, Route, Scan, SubAgent, Task, ToolBox, Window } from '../types'
import { EXECUTORS } from './catalog'
import type { Pool } from './catalog'
import { readConfig as readRouterConfig } from './route'
import {
  agentDone,
  forgetRoute,
  refresh as refreshRouter,
  routeCommand,
  routeNote,
  turnDone,
  routingPolicy,
  spawnedAgent,
  startRouter,
  steered,
} from './router'

const POLL_MS = 5000
const HIDDEN_POLL_MS = 60000
const PICK_AGE_MS = 10 * 60000
const LOG_TTL_MS = 30 * 60000
const LOG_MAX = 128
const PANE = 'agent-boxes'
// Tried in order when the `python` option is empty; `py` is the Windows launcher.
const PYTHONS = [['python3'], ['python'], ['py']]
// Exits 0 only on Python 3.8+: Python 2, the macOS xcode stub and broken shims fail it.
const VERSION_CHECK = 'import sys; sys.exit(sys.version_info < (3, 8))'
// After a failed discovery, look again after 1 m, then 2 m, 4 m, ... up to 30 m.
const RETRY_MS = 60000
const RETRY_MAX_MS = 30 * 60000
// How often to look at the Codex and Antigravity folders again.
const TOOLS_MS = 5 * 60000
// Below this many rows, the router box shows its pick on one line.
const SHORT_ROWS = 28

const scan = atom({ plugin: 'agent-boxes', key: 'scan' } as const, null)
const claude = atom({ plugin: 'agent-boxes', key: 'claude' } as const, null)
const subagents = atom({ plugin: 'agent-boxes', key: 'subagents' } as const, [])
const brief = atom({ plugin: 'agent-boxes', key: 'brief' } as const, null)
const tasks = atom({ plugin: 'agent-boxes', key: 'tasks' } as const, [])
// The router box, which router.ts writes.
const route = atom({ plugin: 'agent-boxes', key: 'route' } as const, null)

// The options: the defaults below, changed by `<claude dir>/agent-boxes/config.json`, read once per
// session. plugin.json declares no userConfig, because Claude Code asks for every option that has no
// saved value when the plugin is installed, defaults or not.
type Tools = { codex: boolean; agy: boolean }
type Config = {
  brief: boolean
  briefModel: string
  width: number
  background: 'black' | 'dock'
  python: string
  // Tools whose box is left out and whose quota and runs are not scanned.
  hidden: Tools
}
let config: Config = {
  brief: true,
  briefModel: 'haiku',
  width: 48,
  background: 'black',
  python: '',
  hidden: { codex: false, agy: false },
}

// Each tool's router pools: Antigravity's Claude models run on its own quota.
const TOOL_POOLS: Record<keyof Tools, Pool[]> = { codex: ['codex'], agy: ['agy', 'agy-claude'] }

// A tool is hidden when the router has every one of its executors disabled
// (`"router": { "disabled": ["sol", "astra"] }` for Codex): the user has said they don't use it.
function hiddenTools(router: unknown): Tools {
  const { disabled } = readRouterConfig(typeof router === 'string' ? { mode: router } : router)
  const isOff = (key: keyof Tools) =>
    EXECUTORS.filter(x => TOOL_POOLS[key].includes(x.pool)).every(x => disabled.includes(x.id))
  return { codex: isOff('codex'), agy: isOff('agy') }
}

function readConfig(options: PluginOptions): Config {
  const str = (k: string, fallback: string) => (typeof options[k] === 'string' ? (options[k] as string) : fallback)
  const width = typeof options.width === 'number' ? Math.round(options.width) : 48
  return {
    brief: options.brief !== false,
    briefModel: str('briefModel', 'haiku').trim() || 'haiku',
    width: Math.min(120, Math.max(30, width)),
    background: options.background === 'dock' ? 'dock' : 'black',
    python: str('python', '').trim(),
    hidden: hiddenTools(options.router),
  }
}

let options: PluginOptions = {}

async function loadConfig($: EngineInterface, gen: number) {
  await folders($, gen)
  if (gen !== loadGen) return
  const path = `${claudeDir}/agent-boxes/config.json`
  try {
    const file: unknown = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {}
    if (gen === loadGen) config = readConfig({ ...options, ...(file && typeof file === 'object' ? (file as PluginOptions) : {}) })
  } catch {
    if (gen === loadGen) config = readConfig(options)  // an unreadable or broken file keeps the defaults
  }
}

const pct = (v?: number) => (v === undefined ? '–' : `${Math.round(v)}%`)

type Rgb = [number, number, number]

// 7d usage heat for the border: green below 60%, yellow from 60%, red from 85%.
const heat = (used: number) => (used >= 85 ? '#f85149' : used >= 60 ? '#e3b341' : '#3fb950')
// A meter's unused cells.
const TRACK = '#262626'
// Each company's colours, swept across its name and its meter's filled part: Claude's deep
// orange to light orange (never white); OpenAI's black-and-white (grey to white on a dark
// terminal); Gemini's sparkle (blue, purple, rose), Antigravity being Google's.
const CLAUDE: Rgb[] = [[200, 85, 45], [217, 119, 87], [242, 166, 90]]
const OPENAI: Rgb[] = [[105, 105, 105], [190, 190, 190], [255, 255, 255]]
const GEMINI: Rgb[] = [[66, 133, 244], [155, 114, 203], [217, 101, 112]]
// The Now and Next boxes: blue for what is under way, violet for what is recommended after.
const NOW: Rgb[] = [[56, 139, 253], [121, 192, 255]]
const NEXT: Rgb[] = [[163, 113, 247], [210, 168, 255]]
const ROUTER: Rgb[] = [[45, 186, 160], [125, 226, 200]]

function blend(stops: Rgb[], f: number) {
  const t = Math.min(1, Math.max(0, f)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(t))
  const a = stops[i] ?? stops[0]!
  const b = stops[i + 1] ?? a
  const mix = (k: 0 | 1 | 2) => Math.round(a[k] + (b[k] - a[k]) * (t - i))
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(mix(0))}${hex(mix(1))}${hex(mix(2))}`
}

const windowOf = (limits: SessionRateLimit[], kind: string) =>
  limits.find(w => w.kind === kind)?.percentUsed

// The window with its reset time, for the router.
function rawWindow(limits: SessionRateLimit[], kind: string): Window | null {
  const w = limits.find(l => l.kind === kind)
  if (!w) return null
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(at) ? { used: w.percentUsed, resetsAtMs: at } : { used: w.percentUsed }
}

// Module state; register() resets all of it, so a reload starts clean.
let isScanning = false
// An urgent poll asked for while one ran; it runs once more after.
let isPollQueued = false
// Whether the latest poll found the pane placed and scanned.
let scannedPlaced = false
let hiddenPolledAtMs: number | undefined
let isBriefing = false
// A summary asked for while one ran, and the turn it is for.
let queuedGen: number | undefined
// Bumped on each turn and prompt; a summary begun under an older one is dropped.
let turnGen = 0
// The Python 3.8+ command (argv prefix) that passed the version check, once found.
let python: string[] | undefined
// When discovery last started, how many in a row failed, and whether one runs now.
let lookedAtMs: number | undefined
let discoverFails = 0
let isDiscovering = false
// When the cached interpreter last failed to start.
let lostAtMs: number | undefined
// Which optional tools have folders, and when that was looked at.
let tools: { codex: boolean; agy: boolean; atMs: number } | undefined
// The last scan that worked, kept through slow or failed ones.
let lastGood: Scan | null = null
let failures = 0
let skipScans = 0
// Collapse changing paths, ids and counters; retain only a bounded set of recent categories.
const loggedOnce = new Map<string, number>()
const errorCategory = (text: string) => text.toLowerCase()
  .replace(/["'][^"'\n]*[\\/][^"'\n]*["']/g, '<path>')
  .replace(/(?:[a-z]:)?[\\/][^\s,;:)]+/g, '<path>')
  .replace(/\b((?:sub)?agent|request)(?:[ _-]?id)?(?:\s*[:=]\s*|\s+)["']?[\w-]+["']?/g, '$1 <id>')
  .replace(/\b(?:0x[\da-f]+|[\da-f]{8,}|[\da-f]{8}(?:-[\da-f]+)+)\b/g, '<hex>')
  .replace(/\b[\w-]*\d[\w-]*\b/g, '<number>')
const logOnce = async ($: EngineInterface, text: string, gen: number) => {
  if (gen !== loadGen) return
  const now = await $.clock.now()
  if (gen !== loadGen) return
  for (const [key, at] of loggedOnce) if (now - at >= LOG_TTL_MS) loggedOnce.delete(key)
  const key = errorCategory(text)
  if (loggedOnce.has(key)) return
  if (loggedOnce.size >= LOG_MAX) loggedOnce.delete(loggedOnce.keys().next().value!)
  loggedOnce.set(key, now)
  await $.ui.log(text)
}
// Claude's own folder (CLAUDE_CONFIG_DIR, else ~/.claude) and the home folder.
let claudeDir: string | undefined
let homeDir: string | undefined
// Whether the side bar's open-at-start was decided (fullscreen known).
let isAutoOpenDecided = false

// Relay subagents (a Claude harness around codex exec or agy -p) whose run a scan has found.
let relayed = new Set<string>()

// The pool a relay subagent's type runs on: codex-builder, agent-boxes:agy-flash and the like.
const relayPool = (type: string) => (/codex/i.test(type) ? 'codex' : /agy|antigravity/i.test(type) ? 'agy' : undefined)
// Bumped by register(), so work begun by an earlier load drops its result.
let loadGen = 0
// /clear keeps the hooks and polling timer, but invalidates work for the old conversation.
let sessionGen = 0
const isCurrent = (gen: number, session: number) => gen === loadGen && session === sessionGen

const clip = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

// A tool call in a few words: the file, the command's first line, the pattern, or the tool alone.
function describe(tool: string, input: Record<string, unknown>) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  const command = str('command')
  if (command) return clip(`$ ${command.split('\n')[0]}`, 60)
  if (path) return clip(`${tool} ${baseName(path)}`, 60)
  const what = str('pattern') ?? str('description') ?? str('query') ?? str('url')
  return clip(what ? `${tool} ${what}` : tool, 60)
}

const isLive = (a: AgentInfo) => a.status === 'pending' || a.status === 'running' || a.status === 'waiting'

// The engine says nothing of the platform; Windows sets OS=Windows_NT (inherited under MSYS too).
const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

// Home is USERPROFILE first on Windows (as Python and Claude Code take it; MSYS's HOME can differ),
// HOME first elsewhere. Empty variables fall through.
async function folders($: EngineInterface, gen: number) {
  if (gen !== loadGen) return
  if (claudeDir && homeDir) return
  const home = (await $.env.get('HOME')) || ''
  const profile = (await $.env.get('USERPROFILE')) || ''
  const homePath = (await isWindows($)) ? profile || home : home || profile
  const configPath = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${homePath}/.claude`
  if (gen !== loadGen) return
  homeDir = homePath
  claudeDir = configPath
}

async function watchAgents($: EngineInterface, gen: number, session: number) {
  const live = (await $.agent.list()).filter(isLive)
  const ids = new Set(live.map(a => a.id))
  const next: SubAgent[] = []
  for (const a of live) {
    if (!isCurrent(gen, session)) return
    let now: string | undefined
    try {
      const said = await $.session.messages({ agentId: a.id })
      for (let i = Array.isArray(said) ? said.length - 1 : -1; i >= 0; i--) {
        const calls = said[i]?.toolUses
        const last = calls?.[calls.length - 1]
        if (last) {
          now = describe(last.tool, last.input)
          break
        }
      }
    } catch (err) {
      // An agent may finish between listing and fetching its messages; inspect the others.
      await logOnce($, `agent-boxes: agent inspection: ${String(err)}`, gen)
      continue
    }
    next.push({
      id: a.id,
      label: clip(a.name ?? a.description, 40),
      type: a.type,
      isNested: a.parentId !== undefined && ids.has(a.parentId),
      now,
    })
  }
  if (isCurrent(gen, session)) await update($, subagents, old => (!isCurrent(gen, session) || JSON.stringify(old) === JSON.stringify(next) ? old : next))
}

// This session's task list, as Claude Code keeps it: <claude dir>/tasks/<session id>/<n>.json.
async function readTasks($: EngineInterface, gen: number, session: number) {
  await folders($, gen)
  if (!isCurrent(gen, session)) return
  const folder = `${claudeDir}/tasks/${await $.session.id()}`
  const next: Task[] = []
  if (await $.fs.exists(folder)) {
    for (const entry of await $.fs.list(folder)) {
      if (!isCurrent(gen, session)) return
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const t = JSON.parse(await $.fs.read(`${folder}/${entry.name}`)) as Record<string, unknown>
        const status = t.status
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        next.push({
          id: String(t.id ?? entry.name.slice(0, -5)),
          subject: typeof t.subject === 'string' ? t.subject : '',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : null,
          status,
        })
      } catch {
        // a task file mid-write; the next poll reads it
      }
    }
  }
  next.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  if (isCurrent(gen, session)) await update($, tasks, old => (!isCurrent(gen, session) || JSON.stringify(old) === JSON.stringify(next) ? old : next))
}

// Runs the summary for the turn `gen`, then once more for a turn that ended while it ran.
// A prompt submitted meanwhile cancels the queued one (prompt.submit clears queuedGen).
async function briefing($: EngineInterface, gen: number, workerGen: number) {
  if (workerGen !== loadGen || !config.brief) return
  if (isBriefing) {
    queuedGen = gen
    return
  }
  isBriefing = true
  try {
    let next: number | undefined = gen
    while (workerGen === loadGen && next !== undefined) {
      queuedGen = undefined
      await briefOnce($, next, workerGen)
      if (workerGen !== loadGen) return
      next = queuedGen
    }
  } finally {
    if (workerGen === loadGen) isBriefing = false
  }
}

const briefText = (text: string) => text.replace(/<{3,}|>{3,}/g, s => s.replace(/</g, '‹').replace(/>/g, '›'))

// Read only the first balanced object, ignoring braces and escaped quotes in JSON strings.
function firstObject(text: string) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

// Asks a small model what the session is doing and what to do after, from the last request and reply.
async function briefOnce($: EngineInterface, gen: number, workerGen: number) {
  const session = sessionGen
  if (workerGen !== loadGen || gen !== turnGen) return
  try {
    const said = await $.session.messages()
    let at = said.length - 1
    while (at >= 0 && !(said[at]?.role === 'user' && said[at]?.text.trim() && !said[at]?.toolResults?.length)) at--
    const asked = said[at]
    if (!asked) return
    const reply = said
      .slice(at + 1)
      .filter(m => m.role === 'assistant' && m.text.trim())
      .map(m => m.text)
      .join('\n')
    // The latest request has no answer yet: nothing to summarise.
    if (!reply.trim()) return
    if (workerGen !== loadGen || gen !== turnGen) return
    if (await isPlaced($)) {
      if (!isCurrent(workerGen, session) || gen !== turnGen) return
      await readTasks($, workerGen, session)
    }
    if (workerGen !== loadGen || gen !== turnGen) return
    const list = await read($, tasks)
    if (workerGen !== loadGen || gen !== turnGen) return
    const listed = list.length
      ? `Task list:\n<<<${briefText(list.map(t => `- [${t.status}] ${t.subject}`).join('\n'))}>>>\n\n`
      : ''
    const r = await $.model.complete({
      model: config.briefModel,
      maxTokens: 400,
      timeoutMs: 30000,
      system: 'You summarise a live coding session for a narrow status side bar. Reply with one JSON object and nothing else.',
      prompt:
        `The user's latest request:\n<<<${briefText(asked.text.slice(-2500))}>>>\n\n` +
        `The assistant's reply so far:\n<<<${briefText(reply.slice(-5000))}>>>\n\n${listed}` +
        'Return {"task": string (8 words max: what is being worked on now), ' +
        '"steps": string[] (up to 3 remaining steps, 8 words max each; [] when done), ' +
        '"next": string (12 words max: the most useful thing to do after this, recommended to the user), ' +
        '"why": string (12 words max), ' +
        '"waiting": boolean (true when the reply ends asking the user to answer or decide something)}',
    })
    if (!r.isAnswered || workerGen !== loadGen || gen !== turnGen) return
    const json = firstObject(r.text)
    if (!json) return
    const got = JSON.parse(json) as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    const next: Brief = {
      task: text(got.task),
      steps: Array.isArray(got.steps) ? got.steps.map(text).filter(Boolean).slice(0, 3) : [],
      next: text(got.next),
      why: text(got.why) || undefined,
      isWaiting: got.waiting === true,
    }
    await update($, brief, old => (workerGen === loadGen && gen === turnGen ? next : old))
  } catch (err) {
    await logOnce($, `agent-boxes: brief failed: ${String(err)}`, workerGen)
  }
}

// The user answered: drop the waiting marker, any summary in flight and any queued.
async function clearWaiting($: EngineInterface, gen: number) {
  if (gen !== loadGen) return
  const session = sessionGen
  turnGen++
  queuedGen = undefined
  await update($, brief, old => (isCurrent(gen, session) && old?.isWaiting ? { ...old, isWaiting: false } : old))
}

// After /clear the conversation is new: drop the old one's summary and task list.
async function forget($: EngineInterface, gen: number) {
  if (gen !== loadGen) return
  const session = ++sessionGen
  turnGen++
  queuedGen = undefined
  isPollQueued = false
  relayed.clear()
  await update($, brief, old => (isCurrent(gen, session) ? null : old))
  if (isCurrent(gen, session)) await update($, tasks, old => (isCurrent(gen, session) ? [] : old))
}

async function measure($: EngineInterface, gen: number, rateLimits?: SessionRateLimit[]) {
  if (gen !== loadGen) return
  const session = sessionGen
  try {
    const usage = await $.session.usage()
    const limits = rateLimits ?? usage.rateLimits
    const next: ClaudeBox = {
      model: await $.session.model(),
      context: usage.context.percent,
      fiveHour: windowOf(limits, 'five_hour'),
      sevenDay: windowOf(limits, 'seven_day'),
      windows: { '5h': rawWindow(limits, 'five_hour'), '7d': rawWindow(limits, 'seven_day') },
    }
    if (isCurrent(gen, session)) await update($, claude, old => (!isCurrent(gen, session) || JSON.stringify(old) === JSON.stringify(next) ? old : next))
  } catch (err) {
    await logOnce($, `agent-boxes: usage: ${String(err)}`, gen)
  }
}

// The candidate commands: the python option as one path when that file exists (spaces and all),
// else split like a shell line with quotes kept together (`py -3`, `"C:/My Env/python.exe" -X utf8`);
// else python3, python, py.
async function candidates($: EngineInterface) {
  const option = config.python.trim()
  if (!option) return PYTHONS
  if (await $.fs.exists(option).catch(() => false)) return [[option]]
  const argv = [...option.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
  return [argv.filter(Boolean)]
}

// On macOS without the developer tools /usr/bin/python3 is a stub that may pop an install dialog.
// The engine exposes no platform, so this walks PATH: when python3 resolves to /usr/bin/python3
// and /usr/bin/xcode-select exists (macOS only), `xcode-select -p` must exit 0 first.
async function isStub($: EngineInterface, cmd: string[]) {
  if (cmd.length !== 1 || cmd[0] !== 'python3' || (await isWindows($))) return false
  for (const dir of ((await $.env.get('PATH')) || '').split(':')) {
    if (!dir || !(await $.fs.exists(`${dir}/python3`))) continue
    if (dir.replace(/\/+$/, '') !== '/usr/bin' || !(await $.fs.exists('/usr/bin/xcode-select'))) return false
    try {
      return (await $.process.run(['/usr/bin/xcode-select', '-p'], { timeoutMs: 10000 })).exitCode !== 0
    } catch {
      return true
    }
  }
  return false
}

// The first candidate that passes the version check.
async function discover($: EngineInterface, gen: number) {
  for (const cmd of await candidates($)) {
    if (gen !== loadGen) return
    try {
      if (await isStub($, cmd)) continue
      if (gen !== loadGen) return
      const ran = await $.process.run([...cmd, '-E', '-c', VERSION_CHECK], { timeoutMs: 10000 })
      if (ran.exitCode === 0) return cmd
    } catch {
      // not on PATH, or would not start; try the next
    }
  }
  return undefined
}

const retryMs = () => Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.max(0, discoverFails - 1))

// Starts discovery in the background, outside the poll, so tasks and subagents keep their cadence;
// after a failure, not before the back-off. A result asks for a poll at once.
async function startDiscovery($: EngineInterface, gen: number) {
  if (gen !== loadGen || isDiscovering) return
  const now = await $.clock.now()
  if (gen !== loadGen || isDiscovering) return
  if (lookedAtMs !== undefined && now - lookedAtMs < retryMs()) return
  lookedAtMs = now
  isDiscovering = true
  void discover($, gen)
    .catch(() => undefined)
    .then(found => {
      if (gen !== loadGen) return
      isDiscovering = false
      if (found) {
        python = found
        discoverFails = 0
      } else {
        discoverFails++
      }
      void poll($, true, gen)
    })
}

// A hidden tool counts as not installed: no box, and no Python run for it alone.
const shown = <T extends Tools>(found: T): T => ({
  ...found,
  codex: found.codex && !config.hidden.codex,
  agy: found.agy && !config.hidden.agy,
})

// Which tools are installed, from their folders alone (CODEX_HOME as codex_scan.py reads it);
// looked at again every TOOLS_MS, so a tool installed mid-session shows up.
async function installed($: EngineInterface, gen: number) {
  const now = await $.clock.now()
  if (gen !== loadGen) return undefined
  if (tools && now - tools.atMs < TOOLS_MS) return shown(tools)
  await folders($, gen)
  if (gen !== loadGen) return undefined
  const codexHome = (await $.env.get('CODEX_HOME')) || `${homeDir}/.codex`
  const found = {
    codex: await $.fs.exists(codexHome),
    agy: await $.fs.exists(`${homeDir}/.gemini/antigravity-cli`),
    atMs: now,
  }
  if (gen !== loadGen) return undefined
  tools = found
  return shown(tools)
}

const box = (isInstalled: boolean, error?: string): ToolBox => ({
  installed: isInstalled,
  limits: [],
  agents: [],
  ...(error ? { error } : {}),
})

// The scan with no Python: a box for each tool installed, saying what it needs.
const noPython = (has: { codex: boolean; agy: boolean }): Scan => {
  const needs = 'needs Python 3.8+ on PATH (or set the python option)'
  return { codex: box(has.codex, needs), agy: box(has.agy, needs) }
}

// A scan that was slow or failed with Python known: the last good boxes with a hint, and a back-off.
// The hint shows on the boxes in the pane, not in the transcript.
async function trouble($: EngineInterface, hint: string, gen: number, session: number): Promise<Scan | undefined> {
  if (!isCurrent(gen, session)) return undefined
  failures++
  skipScans = Math.min(6, 2 ** (failures - 1))
  let base = lastGood
  if (!base) {
    const has = await installed($, gen)
    if (!has || !isCurrent(gen, session)) return undefined
    base = { codex: box(has.codex), agy: box(has.agy) }
  }
  return { ...base, codex: { ...base.codex, stale: hint }, agy: { ...base.agy, stale: hint } }
}

// The interpreter could not start (gone from PATH, uninstalled): look for one again.
const isLost = (text: string) => /ENOENT|spawn|not recognized|cannot find|9009/i.test(text)

// Runs the bundled scan under the cached Python; undefined keeps the boxes as they are.
async function scanNow($: EngineInterface, gen: number, session: number): Promise<Scan | undefined> {
  const has = await installed($, gen)
  if (!has || !isCurrent(gen, session)) return undefined
  // Neither tool has a folder: no Python is looked for or run.
  if (!has.codex && !has.agy) return { codex: box(false), agy: box(false) }
  const cmd = python
  if (!cmd) {
    await startDiscovery($, gen)
    if (!isCurrent(gen, session)) return undefined
    // Until a discovery has failed, the boxes keep saying "scanning…".
    return discoverFails > 0 && !isDiscovering ? noPython(has) : undefined
  }
  const script = `${$.plugin.root}/scripts/boxes.py`
  // The first loss rediscovers at once; another within RETRY_MS (an interpreter that passes the
  // version check but cannot run the scan) waits out the back-off instead of looping.
  const lost = async () => {
    await logOnce($, `agent-boxes: ${cmd.join(' ')} would not start; looking for Python again`, gen)
    const now = await $.clock.now()
    if (!isCurrent(gen, session)) return undefined
    const isRepeat = lostAtMs !== undefined && now - lostAtMs < RETRY_MS
    lostAtMs = now
    python = undefined
    if (!isRepeat) {
      lookedAtMs = undefined
      discoverFails = 0
    }
    await startDiscovery($, gen)
    return isRepeat ? trouble($, 'Python would not start, retrying', gen, session) : undefined
  }
  let ran
  try {
    const sessionId = await $.session.id()
    if (!isCurrent(gen, session)) return undefined
    ran = await $.process.run([...cmd, '-E', script, sessionId], { timeoutMs: 20000 })
  } catch (err) {
    if (!isCurrent(gen, session)) return undefined
    const why = String(err)
    if (/time/i.test(why)) return trouble($, 'scan slow, retrying', gen, session)
    if (isLost(why)) return lost()
    return trouble($, 'scan failed, retrying', gen, session)
  }
  if (!isCurrent(gen, session)) return undefined
  if (ran.exitCode === 9009 || /not recognized/i.test(ran.stderr)) return lost()
  if (ran.exitCode !== 0) return trouble($, `scan failed (exit ${ran.exitCode}), retrying`, gen, session)
  let got: Scan
  try {
    got = JSON.parse(ran.stdout) as Scan
    if (typeof got?.codex !== 'object' || typeof got?.agy !== 'object' || !got.codex || !got.agy) throw new Error('shape')
  } catch {
    return trouble($, 'scan gave bad JSON, retrying', gen, session)
  }
  // The scan reads both tools; a hidden one's box, quota and runs are dropped.
  if (config.hidden.codex) got.codex = box(false)
  if (config.hidden.agy) got.agy = box(false)
  failures = 0
  skipScans = 0
  lastGood = got
  return got
}

const isPlaced = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)

async function pollOnce($: EngineInterface, gen: number, isUrgent: boolean) {
  const session = sessionGen
  try {
    const placed = await isPlaced($)
    if (!isCurrent(gen, session)) return
    scannedPlaced = placed
    let hiddenAt: number | undefined
    if (placed) {
      try {
        await readTasks($, gen, session)
      } catch (err) {
        await logOnce($, `agent-boxes: tasks: ${String(err)}`, gen)
      }
      if (!isCurrent(gen, session)) return
      try {
        await watchAgents($, gen, session)
      } catch (err) {
        await logOnce($, `agent-boxes: agents: ${String(err)}`, gen)
      }
    } else {
      const now = await $.clock.now()
      if (!isCurrent(gen, session)) return
      // Quota is needed by the router even if the pane has never been opened.
      if (!isUrgent && hiddenPolledAtMs !== undefined && now - hiddenPolledAtMs < HIDDEN_POLL_MS) return
      hiddenAt = now
    }
    if (!isCurrent(gen, session)) return
    if (!isUrgent && skipScans > 0) {
      skipScans--
      return
    }
    if (hiddenAt !== undefined) hiddenPolledAtMs = hiddenAt
    const next = await scanNow($, gen, session)
    if (!isCurrent(gen, session)) return
    for (const a of [...(next?.codex.agents ?? []), ...(next?.agy.agents ?? [])]) if (a.via) relayed.add(a.via)
    if (next) await update($, scan, old => (!isCurrent(gen, session) || JSON.stringify(old) === JSON.stringify(next) ? old : next))
    if (next && isCurrent(gen, session)) await refreshRouter($, next)
  } catch (err) {
    await logOnce($, `agent-boxes: scan: ${String(err)}`, gen)
  }
}

// One poll at a time; an urgent one asked for meanwhile runs right after.
async function poll($: EngineInterface, isUrgent: boolean, gen: number) {
  if (gen !== loadGen) return
  if (isScanning) {
    if (isUrgent) isPollQueued = true
    return
  }
  isScanning = true
  try {
    do {
      isPollQueued = false
      await pollOnce($, gen, isUrgent)
      isUrgent = isPollQueued
    } while (gen === loadGen && isPollQueued)
  } finally {
    if (gen === loadGen) isScanning = false
  }
}

export const register: Register = (on, given) => {
  options = given
  config = readConfig(options)
  const gen = ++loadGen
  loggedOnce.clear()
  isScanning = false
  isPollQueued = false
  scannedPlaced = false
  hiddenPolledAtMs = undefined
  isBriefing = false
  queuedGen = undefined
  turnGen = 0
  sessionGen = 0
  python = undefined
  lookedAtMs = undefined
  discoverFails = 0
  isDiscovering = false
  lostAtMs = undefined
  tools = undefined
  lastGood = null
  failures = 0
  skipScans = 0
  claudeDir = undefined
  homeDir = undefined
  isAutoOpenDecided = false
  relayed = new Set()
  on('session.start', async ($, e, next) => {
    const session = sessionGen
    if (!isCurrent(gen, session)) return next(e)
    await loadConfig($, gen)
    if (!isCurrent(gen, session)) return next(e)
    await $.command.register({ name: 'agent-boxes', description: 'Show the agent boxes side bar' })
    if (!isCurrent(gen, session)) return next(e)
    void measure($, gen)
    void poll($, false, gen)
    void briefing($, turnGen, gen)
    $.clock.every(POLL_MS, () => void poll($, false, gen))
    await folders($, gen)
    if (!isCurrent(gen, session)) return next(e)
    await startRouter($, claudeDir ?? '').catch(err => $.ui.log(`agent-boxes: router: ${String(err)}`))

    return next(e)
  })

  // Unasked, the pane is a side bar only where the surface docks panes (the fullscreen layout);
  // on the main screen it would take over the view above the prompt. The engine tells which only on
  // a drawing's viewport, so the always-drawn hint line under the prompt is watched, and passed
  // through untouched, until it says; /agent-boxes still opens the pane anywhere.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const isFullscreen = e.viewport?.isFullscreen
    if (gen === loadGen && !isAutoOpenDecided && isFullscreen !== undefined) {
      isAutoOpenDecided = true
      if (isFullscreen) void $.ui.open({ id: PANE, title: 'Agents', columns: config.width }).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const session = sessionGen
    const done = await next(e)
    if (!isCurrent(gen, session)) return done
    if (e.agentId === undefined) {
      turnGen++
      void briefing($, turnGen, gen)
      await turnDone($).catch(() => undefined)
    }
    if (isCurrent(gen, session)) await agentDone($, e.agentId, e.agentId === undefined ? undefined : e.answer).catch(() => undefined)

    return done
  })

  // Observe only: the prompt passes through untouched.
  // A /clear starts a new session id with no session.start, so the old summary would linger.
  on('session.end', async ($, e, next) => {
    if (gen !== loadGen) return next(e)
    if (e.reason === 'clear') {
      const session = sessionGen + 1
      await forget($, gen)
      if (isCurrent(gen, session)) await forgetRoute($).catch(() => undefined)
    }

    return next(e)
  })

  // A user's prompt may get the router's hidden note.
  on('prompt.submit', async ($, e, next) => {
    const session = sessionGen
    if (!isCurrent(gen, session)) return next(e)
    if (!e.isMeta) await clearWaiting($, gen)
    if (!isCurrent(gen, session)) return next(e)
    const note = await routeNote($, e)
    if (!isCurrent(gen, session)) return next(e)

    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('prompt.compose', async ($, e, next) => {
    const session = sessionGen
    const got = await next(e)
    if (!isCurrent(gen, session)) return got
    const policy = routingPolicy(e)

    return policy ? { sections: [...got.sections, policy] } : got
  })

  on('agent.spawn', async ($, e, next) => {
    const session = sessionGen
    if (!isCurrent(gen, session)) return next(e)
    const ran = await steered($, e)
    if (!isCurrent(gen, session)) return next(e)
    const done = await next(ran)
    if (isCurrent(gen, session)) await spawnedAgent($, e, ran, done).catch(() => undefined)

    return done
  })

  on('command.run', { command: 'route' }, async ($, e, next) => {
    if (gen !== loadGen) return next(e)
    return { text: await routeCommand($, e.args) }
  })

  on('command.run', { command: 'agent-boxes' }, async ($, e, next) => {
    const session = sessionGen
    if (!isCurrent(gen, session)) return next(e)
    await $.ui.open({ id: PANE, title: 'Agents', columns: config.width })
    if (isCurrent(gen, session) && !scannedPlaced) void poll($, true, gen)

    return { text: 'Agent boxes opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await measure($, gen, e.rateLimits)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const session = sessionGen
    if (!isCurrent(gen, session)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const c = await read($, claude)
    const s = await read($, scan)
    const agents = await read($, subagents)
    const b = await read($, brief)
    const list = await read($, tasks)
    const r = await read($, route)
    if (!isCurrent(gen, session)) return next(e)
    const BG = config.background === 'black' ? 'black' : undefined
    // On black, explicit light text so light themes stay readable; dock keeps the theme's.
    const FG = BG ? '#e6e6e6' : undefined
    const dim = BG ? { color: '#8b949e' } : { dimColor: true }
    // Placed now but not scanned while placed: scan at once.
    if (!scannedPlaced) void poll($, true, gen)

    // The 7d meter fills the box less its border, padding and the "7d 100%" label; the 5h one is half that.
    const meterWidth = Math.max(8, e.props.bodyColumns - 4 - 9)

    const title = (icon: string, name: string, brand: Rgb[]) => (
      <Text bold>
        <Text color={blend(brand, 0)}>{icon} </Text>
        {[...name].map((ch, i) => (
          <Text color={blend(brand, i / Math.max(1, name.length - 1))}>{ch}</Text>
        ))}
      </Text>
    )

    const meter = (label: string, used: number | undefined, brand: Rgb[], width: number, shown = pct(used)) => {
      // Half-cell steps: each cell is a left half block in one shade over a background in the next,
      // so the gradient moves twice per cell. The whole gradient runs over the filled halves, so it
      // shows at any usage; any use is one half.
      const share = used === undefined ? 0 : Math.min(100, used) / 100
      const halves = share > 0 ? Math.max(1, Math.round(share * width * 2)) : 0
      const shade = (half: number) => (half < halves ? blend(brand, half / Math.max(1, halves - 1)) : TRACK)
      return (
        <Text>
          {Array.from({ length: width }, (_, i) => (
            <Text color={shade(2 * i)} backgroundColor={shade(2 * i + 1)}>
              ▌
            </Text>
          ))}
          <Text {...dim}> {label} {shown}</Text>
        </Text>
      )
    }

    const card = (
      key: string,
      heading: RenderChildren,
      brand: Rgb[],
      fiveHour: number | undefined,
      used: number | undefined,
      body: RenderChildren,
    ) => (
      <Box
        key={key}
        borderStyle="round"
        borderColor={used === undefined ? blend(brand, 0) : heat(used)}
        flexDirection="column"
        paddingX={1}
        width="100%"
        backgroundColor={BG}
      >
        {heading}
        {meter('7d', used, brand, meterWidth)}
        {meter('5h', fiveHour, brand, Math.max(6, Math.round(meterWidth / 2)))}
        {body}
      </Box>
    )

    // Relays show in their pool's box, not Claude's: their run with Claude's ✻ in front, and
    // until the scan finds it (or once it has ended while the relay reports back), the relay itself.
    const launched = new Set([...(s?.codex.agents ?? []), ...(s?.agy.agents ?? [])].map(a => a.via).filter(Boolean))
    const relays = agents.filter(a => !a.isNested && relayPool(a.type))
    const claudeOwn = agents.filter(a => !relays.includes(a))
    const harness = <Text color={blend(CLAUDE, 0.5)}>✻ </Text>
    const toolBody = (box: ToolBox | undefined, pool: 'codex' | 'agy') => {
      const waiting = relays.filter(a => relayPool(a.type) === pool && !launched.has(a.id))
      return (
      <Box flexDirection="column" backgroundColor={BG}>
        {box === undefined && <Text {...dim}>scanning…</Text>}
        {box?.error && <Text color="error">{box.error}</Text>}
        {box?.limits.slice(1).map(line => <Text {...dim}>{line}</Text>)}
        {box?.hint && <Text {...dim}>{box.hint}</Text>}
        {box?.stale && <Text color="#e3b341">{box.stale}</Text>}
        {box !== undefined && box.agents.length === 0 && waiting.length === 0 && !box.error && <Text {...dim}>no agents running</Text>}
        {box?.agents.map(a => (
          <Box flexDirection="column" backgroundColor={BG}>
            <Text color={FG}>
              {'  '.repeat(a.depth)}
              {a.depth > 0 ? '└ ' : a.via ? harness : '◆ '}
              {a.text}
            </Text>
            {a.now && (
              <Text {...dim}>
                {'  '.repeat(a.depth)}  ↳ {a.now}
              </Text>
            )}
          </Box>
        ))}
        {waiting.map(a => (
          <Text color={FG}>
            {harness}
            {a.label} <Text {...dim}>· {relayed.has(a.id) ? 'reporting back' : 'starting…'}</Text>
          </Text>
        ))}
      </Box>
      )
    }

    // A tool's card shows while scanning and once the scan finds the tool installed.
    const tool = (key: 'codex' | 'agy', icon: string, name: string, brand: Rgb[], box: ToolBox | undefined) =>
      box?.installed === false ? null : card(key, title(icon, name, brand), brand, box?.fiveHour ?? undefined, box?.sevenDay ?? undefined, toolBody(box, key))

    // Now: the task list's item in progress and the ones pending, else the summary of the turn,
    // else the first pending task; all done says so.
    const active = list.find(t => t.status === 'in_progress')
    const done = list.filter(t => t.status === 'completed').length
    let pending = list.filter(t => t.status === 'pending').map(t => t.subject)
    let task = active ? active.activeForm || active.subject : b?.task
    if (!task && pending.length) [task, ...pending] = pending
    else if (!task && list.length) task = `all ${list.length} done`
    const steps = list.length ? pending.slice(0, 4) : b?.steps ?? []
    if (list.length && pending.length > 4) steps.push(`${pending.length - 4} more remaining`)

    const plain = (key: string, heading: RenderChildren, border: string, body: RenderChildren) => (
      <Box key={key} borderStyle="round" borderColor={border} flexDirection="column" paddingX={1} width="100%" backgroundColor={BG}>
        {heading}
        {body}
      </Box>
    )

    const nowBox = plain(
      'now',
      title('◎', 'now', NOW),
      blend(NOW, 0),
      <Box flexDirection="column" backgroundColor={BG}>
        {b?.isWaiting && <Text color="#e3b341">⏳ waiting on you</Text>}
        {task ? <Text color={FG}>{task}</Text> : <Text {...dim}>nothing under way</Text>}
        {list.length > 0 && meter('', (100 * done) / list.length, NOW, meterWidth, `${done}/${list.length}`)}
        {steps.map(step => (
          <Text {...dim}>· {step}</Text>
        ))}
      </Box>,
    )

    const nextBox = config.brief
      ? plain(
          'next',
          title('➜', 'next', NEXT),
          blend(NEXT, 0),
          <Box flexDirection="column" backgroundColor={BG}>
            {b?.next ? <Text color={FG}>{b.next}</Text> : <Text {...dim}>after the next turn</Text>}
            {b?.why && <Text {...dim}>{b.why}</Text>}
          </Box>,
        )
      : null

    // The router: its mode in the title; the last pick and fallback, or before any routed
    // prompt the pool best placed now. One line when the side bar is short.
    const routed = (x: Route) => (x.size ? `${x.category} (${x.size})` : x.category)
    const pickAge = r?.pick ? Math.max(0, (await $.clock.now()) - r.atMs) : 0
    const oldPick = pickAge >= PICK_AGE_MS
    const pickStyle = oldPick ? dim : { color: FG }
    const age = oldPick ? ` · ${Math.floor(pickAge / 60000)}m ago` : ''
    // In-loop placements have no delegated fallback, even if the ranking has an alternate.
    const fallback = r?.pick.startsWith('this loop (') ? '' : r?.fallback?.trim()
    const routerBox = r
      ? plain(
          'router',
          <Text>
            {title('⇄', 'router', ROUTER)}
            <Text {...dim}> · {r.mode}</Text>
          </Text>,
          blend(ROUTER, 0),
          !r.pick ? (
            <Text {...dim}>{r.lead || 'waiting for the first prompt'}</Text>
          ) : e.props.scroll.bodyRows < SHORT_ROWS ? (
            <Text {...pickStyle}>
              {r.pick} <Text {...dim}>· {r.category}{age}{fallback ? ` · alt ${fallback}` : ''}</Text>
            </Text>
          ) : (
            <Box flexDirection="column" backgroundColor={BG}>
              <Text {...pickStyle}>
                {r.pick} <Text {...dim}>· {routed(r)}{age}</Text>
              </Text>
              <Text {...dim}>
                {r.why}
                {fallback ? ` · alt ${fallback}` : ''}
              </Text>
            </Box>
          ),
        )
      : null

    return (
      <Box flexDirection="column" width="100%" minHeight={e.props.scroll.bodyRows} backgroundColor={BG}>
        {card(
          'claude',
          title('✻', 'claude', CLAUDE),
          CLAUDE,
          c?.fiveHour,
          c?.sevenDay,
          <Box flexDirection="column" backgroundColor={BG}>
            {c && <Text {...dim}>{c.model}</Text>}
            <Text {...dim}>ctx {pct(c?.context)}</Text>
            {claudeOwn.map(a => (
              <Box flexDirection="column" backgroundColor={BG}>
                <Text color={FG}>
                  {a.isNested ? '  └ ' : '◆ '}
                  {a.label} <Text {...dim}>· {a.type}</Text>
                </Text>
                {a.now && (
                  <Text {...dim}>
                    {a.isNested ? '  ' : ''}  ↳ {a.now}
                  </Text>
                )}
              </Box>
            ))}
            {/* headless `claude -p` runs this chat started (llm-blender-bench's bench.py), from boxes.py */}
            {s?.claude?.agents.map(a => (
              <Box flexDirection="column" backgroundColor={BG}>
                <Text color={FG}>◆ {a.text}</Text>
                {a.now && <Text {...dim}>  ↳ {a.now}</Text>}
              </Box>
            ))}
            {/* launches through loops, xargs or scripts whose run the scan could not confirm */}
            {(s?.unverified ?? 0) > 0 && (
              <Text {...dim}>{`${s?.unverified} ${s?.unverified === 1 ? 'command' : 'commands'} with unverified tracking`}</Text>
            )}
          </Box>,
        )}
        {tool('codex', '֎', 'codex', OPENAI, s?.codex)}
        {tool('agy', '✦', 'antigravity', GEMINI, s?.agy)}
        {nowBox}
        {nextBox}
        {routerBox}
      </Box>
    )
  })
}
