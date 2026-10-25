// The router: sorts each user prompt into a task category, picks the executor best suited to it
// from the catalog and the live quota of all three subscriptions, and tells the main agent in a
// hidden note on the prompt. register.tsx hosts it: its hooks call the functions below, it hands
// over the scan's Codex and agy windows, and it draws the router box from the `route` value.
import { atom, update } from 'claude-code'
import type {
  AgentSpawnInput,
  AgentSpawnResult,
  EngineInterface,
  PromptComposeInput,
  PromptComposeSection,
  PromptSubmitInput,
  SessionRateLimit,
} from 'claude-code'

import type { Scan } from '../types'
import { CATEGORIES } from './catalog'
import type { Category, Executor } from './catalog'
import {
  DEFAULTS,
  categoryById,
  classify,
  contextNote,
  leadLine,
  namedIn,
  outcomeOf,
  placement,
  policy,
  quotaLine,
  readConfig,
  roster,
  route,
  sizeOf,
} from './route'
import type { Config, Loop, Placement, Quota, Route, Windows } from './route'

// Agent types that ship with Claude Code, and the relays this plugin ships in agents/.
const BUILT_IN = ['general-purpose', 'Explore', 'Plan']
const SHIPPED = ['codex-builder', 'codex-astra', 'agy-argon', 'agy-flash', 'agy-opus']
// A prompt this short with no keyword is a reply in the running task ("yes", "go on"): no note.
const REPLY_WORDS = 4
const HISTORY_LINES = 1000
// A prompt within this long of the last routed one is a follow-up: it leans toward the same executor.
const FOLLOW_MS = 15 * 60e3
// Bumped when the policy's rules change, so the history can compare before and after.
const POLICY_VERSION = 2

// The router box's state, drawn by register.tsx; null while the router is off.
const routeBox = atom({ plugin: 'agent-boxes', key: 'route' } as const, null)

// <claude dir>, from register.tsx at session start.
let claudeDir = ''
// The side bar's latest good scan, for Codex's and agy's windows.
let scanned: Scan | null = null
let config: Config = DEFAULTS
// Each catalog agent's spawnable type, or undefined when there is none.
let agents = new Map<string, string | undefined>()
// Catalog agents that are the user's or the project's own definitions.
let custom = new Set<string>()
// Executor ids the user named in the latest prompt: steer mode leaves their spawns alone.
let named = new Set<string>()
let last: { route: Route; atMs: number; place: Placement } | undefined
// Spawns this session started, by agent id, for the outcome log.
let spawned = new Map<string, { atMs: number; category: string; promptId?: string }>()
// The user's latest prompt, for the history: its id, when it came, and the spawns it led to.
// `isOpen` until its main turn completes; `isGraded` once an outcome is logged for it.
// A reply with no new task ("go on", an answer to a question) continues it: its turns and spawns
// count toward the same prompt.
let prompt:
  | { id: string; category: string; turnAtMs: number; spawns: number; isOpen: boolean; isGraded: boolean }
  | undefined
let promptCount = 0
let sessionMs = 0

// The `router` key of agent-boxes/config.json: an object of options, or a mode alone ("off").
async function loadConfig($: EngineInterface) {
  const path = `${claudeDir}/agent-boxes/config.json`
  try {
    const file = (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Record<string, unknown>) : {}
    const raw = file?.router
    config = readConfig(typeof raw === 'string' ? { mode: raw } : raw)
  } catch {
    config = DEFAULTS
  }
}

// Each catalog agent's spawnable type: a built-in, the user's or the project's own definition,
// this plugin's relay, or for a Claude model with no definition, general-purpose on that model.
async function findAgents($: EngineInterface) {
  const dir = claudeDir
  agents = new Map()
  custom = new Set()
  for (const x of roster({ ...config, enabled: [...config.enabled, 'fable'] })) {
    if (agents.has(x.agent)) continue
    let type: string | undefined
    if (BUILT_IN.includes(x.agent)) type = x.agent
    else if ((await $.fs.exists(`${dir}/agents/${x.agent}.md`)) || (await $.fs.exists(`.claude/agents/${x.agent}.md`))) {
      type = x.agent
      custom.add(x.agent)
    } else if (SHIPPED.includes(x.agent)) type = `agent-boxes:${x.agent}`
    else if (x.pool === 'claude' && x.model) type = 'general-purpose'
    agents.set(x.agent, type)
  }
}

const executors = () =>
  roster(config, a => agents.get(a) !== undefined).map(x => ({
    ...x,
    agent: agents.get(x.agent) ?? x.agent,
    isCustom: custom.has(x.agent),
  }))

// Claude's windows from the session; Codex's and agy's from the side bar's scan.
async function quota($: EngineInterface): Promise<Quota> {
  const q: Quota = {}
  try {
    q.claude = claudeWindows((await $.session.usage()).rateLimits)
  } catch {
    // no usage yet; Claude counts as unknown
  }
  const s = scanned
  if (s && !s.codex.stale && s.codex.installed !== false && s.codex.windows) q.codex = s.codex.windows
  if (s && !s.agy.stale && s.agy.installed !== false) {
    const gemini = s.agy.groups?.gemini ?? s.agy.windows
    if (gemini) q.agy = gemini
    if (s.agy.groups?.['claude/gpt']) q['agy-claude'] = s.agy.groups['claude/gpt']
  }
  return q
}

// The category by keywords, else by a small model for prompts long enough to be a new task.
async function categorize($: EngineInterface, text: string): Promise<Category | undefined> {
  const found = classify(text)
  if (found) return found
  const words = text.trim().split(/\s+/).length
  if (words <= REPLY_WORDS) return undefined
  if (!config.classify) return categoryById('general')
  try {
    const ids = CATEGORIES.map(c => `${c.id} (${c.title})`).join(', ')
    const r = await $.model.complete({
      model: config.classifyModel,
      maxTokens: 20,
      timeoutMs: 5000,
      system: 'You sort a request to a coding agent into one category. Reply with the category id alone.',
      prompt: `Categories: ${ids}, general.\n\nRequest:\n<<<${text.slice(0, 2000)}>>>`,
    })
    const id = r.isAnswered ? r.text.trim().toLowerCase().replace(/[^a-z]/g, '') : ''
    return categoryById(id)
  } catch {
    return categoryById('general')
  }
}

// The router box: the mode and best-placed pool, then the last routed prompt's pick. register.tsx
// also calls it after each scan, for the best-placed line.
export async function refresh($: EngineInterface, scan?: Scan) {
  if (scan) scanned = scan
  const r = last?.route
  const next = config.mode === 'off' ? null : {
    mode: config.mode,
    lead: leadLine(await quota($), await $.clock.now(), executors()),
    category: r?.category.id ?? '',
    size: r?.size ?? '',
    pick: r?.pick ? (last?.place.inLoop ? `this loop (${r.pick.label})` : r.pick.label) : '',
    fallback: r?.fallback?.label ?? '',
    why: r?.why ?? '',
    atMs: last?.atMs ?? 0,
  }
  await update($, routeBox, old => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
}

// Entries waiting for the history file. One writer drains them, so parallel spawns don't
// overwrite each other's read-modify-write.
let pending: string[] = []
let writing = false

async function log($: EngineInterface, entry: object) {
  pending.push(JSON.stringify(entry))
  if (writing) return
  writing = true
  const path = `${claudeDir}/agent-boxes/router-history.jsonl`
  try {
    while (pending.length) {
      const batch = pending
      pending = []
      const old = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
      await $.fs.write(path, [...old, ...batch].slice(-HISTORY_LINES).join('\n') + '\n')
    }
  } catch (err) {
    pending = []
    $.ui.log(`agent-boxes: router history: ${String(err)}`)
  } finally {
    writing = false
  }
}

// What /route prints: the last pick with every candidate's score, the quota and the mode.
async function report($: EngineInterface) {
  const now = await $.clock.now()
  const q = await quota($)
  const lines = [`router · mode ${config.mode} · ${quotaLine(q, now)}`]
  if ((await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')) === '1') {
    lines.push('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 is set: Claude model picks are overridden by CLAUDE_CODE_SUBAGENT_MODEL.')
  }
  if (!last) {
    lines.push('No prompt routed yet in this session.')
  } else {
    const r = last.route
    lines.push(`Last prompt: ${r.category.title} (${r.size}) → ${r.pick?.label ?? 'none'} (${r.why})`)
    lines.push(`  ${last.place.inLoop ? 'In this loop' : 'Delegated'}: ${last.place.reason}`)
    for (const s of r.scored) {
      lines.push(`  ${s.rank + 1}. ${s.executor.label.padEnd(18)} ${s.out ? `out: ${s.out}` : s.score.toFixed(2)}`)
    }
  }
  const missing = [...agents].filter(([, type]) => type === undefined).map(([a]) => a)
  if (missing.length) lines.push(`Missing agent definitions (left out): ${missing.join(', ')}`)
  return lines.join('\n')
}

// steer mode: a spawn whose pool is out goes to the best executor of the last prompt's category.
function steer(subagentType: string, model: string | undefined, quotaNow: Quota, now: number): Executor | undefined {
  const all = executors()
  const asked = all.find(x => x.agent === subagentType && (!x.model || !model || x.model === model))
  if (!asked || named.has(asked.id)) return undefined
  const category = last?.route.category ?? categoryById('general')
  const r = route(category, last?.route.size ?? 'medium', quotaNow, now, all, config)
  const isOut = r.scored.find(s => s.executor.id === asked.id)?.out ?? (asked.pool === 'claude' && r.isClaudeLow)
  if (!isOut || !r.pick || r.pick.id === asked.id) return undefined
  return r.pick
}

// register.tsx's hooks call these: the engine takes one hook per event from a module.

export async function startRouter($: EngineInterface, dir: string) {
  claudeDir = dir
  scanned = null
  last = undefined
  spawned = new Map()
  prompt = undefined
  named = new Set()
  promptCount = 0
  sessionMs = await $.clock.now()
  await loadConfig($)
  await findAgents($)
  await $.command.register({
    name: 'route',
    description: 'Show which model the router picks and why; /route pass or /route fail grades the last result',
  })
  await refresh($)
}

// The routing policy, for the agent that can delegate (the one offered the Agent tool).
export function routingPolicy(e: PromptComposeInput): PromptComposeSection | undefined {
  if (config.mode === 'off' || !e.tools.includes('Agent')) return undefined
  const list = executors()
  if (list.length < 2) return undefined
  return { id: 'agent-boxes:routing', text: policy(list), scope: 'session' }
}

// The hidden note for a user's prompt: its category's pick and fallback, with the quota.
export async function routeNote($: EngineInterface, e: PromptSubmitInput): Promise<string | undefined> {
  const isUsers = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
  if (config.mode === 'off' || e.isMeta || e.command || !isUsers || !e.text.trim()) return undefined
  let note: string | undefined
  try {
    const now = await $.clock.now()
    const category = await categorize($, e.text)
    const mentioned = namedIn(e.text, executors())
    named = new Set(mentioned.map(x => x.id))
    // This reply is the best signal of how the last prompt's work went: a new task grades it
    // either way, a continuation only when it says something about the result.
    const verdict = outcomeOf(e.text)
    if (prompt && !prompt.isGraded && (category || verdict !== 'unknown')) await grade($, verdict, 'reply')
    if (!category && prompt) {
      prompt.isOpen = true
      prompt.turnAtMs = now
      prompt.spawns = 0
    }
    if (category) {
      const q = await quota($)
      const prev = last && now - last.atMs < FOLLOW_MS ? last.route.pick?.id : undefined
      const r = route(category, sizeOf(e.text), q, now, executors(), config, prev)
      const loop = await mainLoop($)
      const place = placement(r, q, loop, config)
      last = { route: r, atMs: now, place }
      note = contextNote(r, q, now, place, mentioned)
      prompt = { id: `${sessionMs}-${++promptCount}`, category: category.id, turnAtMs: now, spawns: 0, isOpen: true, isGraded: false }
      await log($, {
        atMs: now,
        event: 'route',
        promptId: prompt.id,
        policy: POLICY_VERSION,
        category: category.id,
        size: r.size,
        suggested: r.pick?.agent,
        suggestedModel: r.pick?.model,
        inLoop: place.inLoop,
        placeReason: place.reason,
        named: mentioned.map(x => x.id),
        mainModel: loop.model,
        context: loop.context,
        quota: quotaLine(q, now),
      })
    }
    await refresh($)
  } catch (err) {
    $.ui.log(`agent-boxes: router: ${String(err)}`)
  }
  return note
}

const isPlain = (e: AgentSpawnInput) => !e.fork && !e.resume && !e.isTeammate && !e.workflow && e.parentAgentId === undefined

// steer mode's spawn, rewritten when its pool is out. A router failure never stops a spawn.
export async function steered($: EngineInterface, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  if (config.mode !== 'steer' || !isPlain(e)) return e
  try {
    const to = steer(e.subagentType, e.model, await quota($), await $.clock.now())
    if (!to) return e
    $.ui.toast(`⇄ ${e.subagentType} → ${to.agent} (${last?.route.why ?? 'quota'})`)
    return { ...e, subagentType: to.agent, model: to.model }
  } catch (err) {
    $.ui.log(`agent-boxes: steer: ${String(err)}`)
    return e
  }
}

// The outcome log: each spawn (the suggestion and what ran), then how long it took.
export async function spawnedAgent($: EngineInterface, asked: AgentSpawnInput, ran: AgentSpawnInput, done: AgentSpawnResult) {
  if (config.mode === 'off' || !isPlain(asked) || !done.agentId) return
  const atMs = await $.clock.now()
  const category = last?.route.category.id ?? ''
  const promptId = prompt?.isOpen ? prompt.id : undefined
  if (prompt?.isOpen) prompt.spawns++
  spawned.set(done.agentId, { atMs, category, promptId })
  await log($, {
    atMs,
    event: 'spawn',
    promptId,
    agentId: done.agentId,
    category,
    suggested: last?.route.pick?.agent,
    agent: ran.subagentType,
    model: done.model,
    isSteered: ran !== asked,
  })
}

export async function agentDone($: EngineInterface, agentId: string | undefined) {
  const run = agentId ? spawned.get(agentId) : undefined
  if (!run || !agentId) return
  spawned.delete(agentId)
  const atMs = await $.clock.now()
  await log($, { atMs, event: 'done', promptId: run.promptId, agentId, category: run.category, ms: atMs - run.atMs })
}

// A main turn on the routed prompt ended (the first, or one after a continuing reply): how it ran
// (in this loop or delegated) and how long it took. The eval adds a prompt's turns up.
export async function turnDone($: EngineInterface) {
  if (!prompt?.isOpen) return
  prompt.isOpen = false
  const atMs = await $.clock.now()
  await log($, {
    atMs,
    event: 'turn',
    promptId: prompt.id,
    category: prompt.category,
    ran: prompt.spawns ? 'delegated' : 'in-loop',
    spawns: prompt.spawns,
    ms: atMs - prompt.turnAtMs,
  })
}

// An outcome for the last routed prompt, from the next reply's words or from /route pass|fail.
async function grade($: EngineInterface, outcome: string, source: 'reply' | 'user') {
  if (!prompt) return
  prompt.isGraded = true
  await log($, { atMs: await $.clock.now(), event: 'outcome', promptId: prompt.id, category: prompt.category, outcome, source })
}

// This chat's model and context, for placement. Unknown parts stay unset.
async function mainLoop($: EngineInterface): Promise<Loop> {
  const loop: Loop = {}
  try {
    loop.model = await $.session.model()
  } catch {
    // unknown model: placement delegates
  }
  try {
    loop.context = (await $.session.usage()).context.percent
  } catch {
    // unknown context
  }
  return loop
}

// A /clear starts a new conversation: the last pick no longer applies.
export async function forgetRoute($: EngineInterface) {
  last = undefined
  spawned = new Map()
  prompt = undefined
  await refresh($)
}

// What /route prints, after re-reading the config and the agent definitions. `/route pass` or
// `/route fail` grades the last routed prompt's result instead.
export async function routeCommand($: EngineInterface, args = '') {
  const verdict = args.trim().toLowerCase()
  if (verdict === 'pass' || verdict === 'fail') {
    if (!prompt) return 'No routed prompt to grade yet in this session.'
    await grade($, verdict, 'user')
    return `Logged ${verdict} for the last routed prompt (${prompt.category}).`
  }
  await loadConfig($)
  await findAgents($)
  await refresh($)
  return report($)
}

function claudeWindows(limits: SessionRateLimit[]): Windows {
  const one = (kind: string) => {
    const w = limits.find(l => l.kind === kind)
    if (!w) return null
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return Number.isFinite(at) ? { used: w.percentUsed, resetsAtMs: at } : { used: w.percentUsed }
  }
  return { '5h': one('five_hour'), '7d': one('seven_day') }
}
