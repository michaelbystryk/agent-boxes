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
  policy,
  quotaLine,
  readConfig,
  roster,
  route,
  sizeOf,
} from './route'
import type { Config, Quota, Route, Windows } from './route'

// Agent types that ship with Claude Code, and the relays this plugin ships in agents/.
const BUILT_IN = ['general-purpose', 'Explore', 'Plan']
const SHIPPED = ['codex-builder', 'codex-astra', 'agy-argon', 'agy-flash', 'agy-opus']
// A prompt this short with no keyword is a reply in the running task ("yes", "go on"): no note.
const REPLY_WORDS = 4
const HISTORY_LINES = 1000

// The router box's state, drawn by register.tsx; null while the router is off.
const routeBox = atom({ plugin: 'agent-boxes', key: 'route' } as const, null)

// <claude dir>, from register.tsx at session start.
let claudeDir = ''
// The side bar's latest good scan, for Codex's and agy's windows.
let scanned: Scan | null = null
let config: Config = DEFAULTS
// Each catalog agent's spawnable type, or undefined when there is none.
let agents = new Map<string, string | undefined>()
let last: { route: Route; atMs: number } | undefined
// Spawns this session started, by agent id, for the outcome log.
let spawned = new Map<string, { atMs: number; category: string }>()

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
  for (const x of roster({ ...config, enabled: [...config.enabled, 'fable'] })) {
    if (agents.has(x.agent)) continue
    let type: string | undefined
    if (BUILT_IN.includes(x.agent)) type = x.agent
    else if ((await $.fs.exists(`${dir}/agents/${x.agent}.md`)) || (await $.fs.exists(`.claude/agents/${x.agent}.md`))) {
      type = x.agent
    } else if (SHIPPED.includes(x.agent)) type = `agent-boxes:${x.agent}`
    else if (x.pool === 'claude' && x.model) type = 'general-purpose'
    agents.set(x.agent, type)
  }
}

const executors = () =>
  roster(config, a => agents.get(a) !== undefined).map(x => ({ ...x, agent: agents.get(x.agent) ?? x.agent }))

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
    pick: r?.pick?.label ?? '',
    fallback: r?.fallback?.label ?? '',
    why: r?.why ?? '',
    atMs: last?.atMs ?? 0,
  }
  await update($, routeBox, old => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
}

async function log($: EngineInterface, entry: object) {
  const path = `${claudeDir}/agent-boxes/router-history.jsonl`
  try {
    const old = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
    await $.fs.write(path, [...old, JSON.stringify(entry)].slice(-HISTORY_LINES).join('\n') + '\n')
  } catch (err) {
    $.ui.log(`agent-boxes: router history: ${String(err)}`)
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
  if (!asked) return undefined
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
  await loadConfig($)
  await findAgents($)
  await $.command.register({ name: 'route', description: 'Show which model the router picks and why' })
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
    const category = await categorize($, e.text)
    if (category) {
      const now = await $.clock.now()
      const q = await quota($)
      const r = route(category, sizeOf(e.text), q, now, executors(), config)
      last = { route: r, atMs: now }
      note = contextNote(r, q, now)
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
  spawned.set(done.agentId, { atMs, category })
  await log($, {
    atMs,
    event: 'spawn',
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
  await log($, { atMs, event: 'done', agentId, category: run.category, ms: atMs - run.atMs })
}

// A /clear starts a new conversation: the last pick no longer applies.
export async function forgetRoute($: EngineInterface) {
  last = undefined
  spawned = new Map()
  await refresh($)
}

// What /route prints, after re-reading the config and the agent definitions.
export async function routeCommand($: EngineInterface) {
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
