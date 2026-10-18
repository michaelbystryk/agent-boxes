// The router proper, free of the engine so tests can drive it: what kind of task a prompt is,
// and which executor should take it given each pool's quota.
import { CATEGORIES, EXECUTORS, GENERAL } from './catalog'
import type { Category, Executor, Pool } from './catalog'

export type Win = { used: number | null; resetsAtMs?: number }
export type Windows = { '5h'?: Win | null; '7d'?: Win | null }
export type Quota = Partial<Record<Pool, Windows>>
export type Size = 'small' | 'medium' | 'large'

export type Config = {
  mode: 'advise' | 'steer' | 'off'
  /** Executor ids to leave out, on top of the catalog's. */
  disabled: string[]
  /** Executor ids the catalog leaves out by default that the user wants (e.g. fable). */
  enabled: string[]
  /** Per-category ranking that replaces the catalog's, by executor id. */
  order: Record<string, string[]>
  /** Ask a small model when no keyword matches. */
  classify: boolean
  classifyModel: string
}

export const DEFAULTS: Config = { mode: 'advise', disabled: [], enabled: [], order: {}, classify: true, classifyModel: 'haiku' }

export function readConfig(raw: unknown): Config {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const order: Record<string, string[]> = {}
  if (o.order && typeof o.order === 'object') {
    for (const [k, v] of Object.entries(o.order as Record<string, unknown>)) if (ids(v).length) order[k] = ids(v)
  }
  return {
    mode: o.mode === 'steer' || o.mode === 'off' ? o.mode : 'advise',
    disabled: ids(o.disabled),
    enabled: ids(o.enabled),
    order,
    classify: o.classify !== false,
    classifyModel: typeof o.classifyModel === 'string' && o.classifyModel.trim() ? o.classifyModel.trim() : 'haiku',
  }
}

/** The executors this user can route to: the catalog less disabled ones and those whose agent is missing. */
export function roster(config: Config, hasAgent: (agent: string) => boolean = () => true): Executor[] {
  return EXECUTORS.filter(x => {
    if (config.disabled.includes(x.id)) return false
    if (x.isDisabled && !config.enabled.includes(x.id)) return false
    return hasAgent(x.agent)
  })
}

// Domains name the material (Blender, shaders); activities name the work (review, fix).
// A domain wins over an activity, except a short lookup question.
const DOMAINS = ['blender', 'shader', 'gamedev', 'art', 'frontend']
const ACTIVITIES = ['review', 'bugfix', 'refactor', 'terminal', 'design', 'research', 'build', 'lookup']

export function sizeOf(text: string): Size {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  if (words > 80 || /\b(entire|whole|from scratch|every (file|tower|scene)|end to end)\b/i.test(text)) return 'large'
  // Short prompts often ask for big work, so only a few words count as small.
  return words < 6 ? 'small' : 'medium'
}

/** The category by keywords alone, or undefined when nothing matches. */
export function classify(text: string): Category | undefined {
  const byId = (id: string) => CATEGORIES.find(c => c.id === id)
  const hits = (id: string) => byId(id)?.words.test(text) ?? false
  if (hits('lookup') && sizeOf(text) === 'small') return byId('lookup')
  for (const id of [...DOMAINS, ...ACTIVITIES]) if (hits(id)) return byId(id)
  return undefined
}

export const categoryById = (id: string) => CATEGORIES.find(c => c.id === id) ?? GENERAL

const HOUR = 3600e3
const LENGTH: Record<'5h' | '7d', number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR }
const OUT: Record<'5h' | '7d', number> = { '5h': 90, '7d': 95 }
// Claude also runs this session itself, so its executors stop earlier.
const CLAUDE_OUT: Record<'5h' | '7d', number> = { '5h': 85, '7d': 92 }
// Fit by rank: the first choice, then each next a little less.
const FIT = [1, 0.85, 0.72, 0.62, 0.55]

export type PoolState = { isOut: boolean; headroom: number; bonus: number; reason?: string }

/**
 * A pool's standing: out when a window is near full; headroom the least spare share of its windows
 * (unknown counts as 0.6); bonus up to +0.3 when the 7d window resets soon with much unused
 * (use it or lose it), down to -0.3 when it is used ahead of the clock.
 */
export function poolState(pool: Pool, w: Windows | undefined, now: number): PoolState {
  const limits = pool === 'claude' ? CLAUDE_OUT : OUT
  let headroom = 1
  let isKnown = false
  for (const key of ['5h', '7d'] as const) {
    const used = w?.[key]?.used
    if (typeof used !== 'number') continue
    isKnown = true
    if (used >= limits[key]) return { isOut: true, headroom: 0, bonus: 0, reason: `${POOL_NAMES[pool]} ${key} ${Math.round(used)}%` }
    headroom = Math.min(headroom, 1 - used / 100)
  }
  let bonus = 0
  const week = w?.['7d']
  if (typeof week?.used === 'number' && week.resetsAtMs) {
    const left = Math.min(1, Math.max(0, (week.resetsAtMs - now) / LENGTH['7d']))
    const surplus = 1 - week.used / 100 - left
    if (surplus > 0.1) bonus = Math.min(0.3, surplus * 0.5)
    else if (surplus < -0.15) bonus = Math.max(-0.3, surplus * 0.5)
  }
  return { isOut: false, headroom: isKnown ? headroom : 0.6, bonus }
}

export const POOL_NAMES: Record<Pool, string> = { claude: 'Claude', codex: 'Codex', agy: 'agy', 'agy-claude': 'agy Claude' }

export type Scored = { executor: Executor; score: number; rank: number; out?: string }

export type Route = {
  category: Category
  size: Size
  pick?: Executor
  fallback?: Executor
  scored: Scored[]
  why: string
  isClaudeLow: boolean
}

export function route(
  category: Category,
  size: Size,
  quota: Quota,
  now: number,
  executors: Executor[],
  config: Config = DEFAULTS,
): Route {
  const byId = new Map(executors.map(x => [x.id, x]))
  const states = new Map<Pool, PoolState>()
  const stateOf = (pool: Pool) => {
    if (!states.has(pool)) states.set(pool, poolState(pool, quota[pool], now))
    return states.get(pool)!
  }
  const ranked = (config.order[category.id] ?? category.ranked).filter(id => byId.has(id))
  // Claude short: its Opus/Sonnet places go to the same model on agy's quota, when that is set up.
  const relief = byId.get('opus-agy')
  const ids: string[] = []
  for (const id of ranked) {
    const x = byId.get(id)!
    const swap = x.pool === 'claude' && x.id !== 'haiku' && stateOf('claude').isOut && relief ? relief.id : id
    if (!ids.includes(swap)) ids.push(swap)
  }
  const weight = size === 'large' ? 1 : size === 'medium' ? 0.6 : 0.3
  const thrift = size === 'small' ? 0.15 : size === 'medium' ? 0.05 : 0
  const scored: Scored[] = ids.map((id, rank) => {
    const executor = byId.get(id)!
    const s = stateOf(executor.pool)
    if (s.isOut) return { executor, score: 0, rank, out: s.reason }
    const fit = FIT[Math.min(rank, FIT.length - 1)]!
    const score = fit * (1 - weight + weight * s.headroom) * (1 + s.bonus) / (1 + thrift * (executor.cost - 1))
    return { executor, score, rank }
  })
  const live = scored.filter(s => !s.out).sort((a, b) => b.score - a.score)
  const pick = live[0]?.executor
  const fallback = live.find(s => s.executor.pool !== pick?.pool)?.executor ?? live[1]?.executor
  const first = scored[0]
  let why: string
  if (!pick) why = 'every pool near its limit'
  else if (first && first.executor.id !== pick.id) {
    why = first.out ? `${first.executor.label} out: ${first.out}` : `${POOL_NAMES[pick.pool]} has more room`
  } else why = `best fit for ${category.title}`
  return { category, size, pick, fallback, scored, why, isClaudeLow: stateOf('claude').isOut }
}

const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v)}%` : '–')

function resetIn(ms: number | undefined, now: number) {
  if (!ms || ms <= now) return ''
  const h = Math.round((ms - now) / HOUR)
  return h < 24 ? ` resets ${h}h` : ` resets ${Math.round(h / 24)}d`
}

/** One line of every pool's windows: `Claude 5h 40% 7d 22% · Codex 7d 18% resets 6d · ...`. */
export function quotaLine(quota: Quota, now: number) {
  const parts: string[] = []
  for (const pool of ['claude', 'codex', 'agy', 'agy-claude'] as const) {
    const w = quota[pool]
    if (!w) continue
    const bits = (['5h', '7d'] as const)
      .filter(k => w[k])
      .map(k => `${k} ${pct(w[k]?.used)}${k === '7d' ? resetIn(w[k]?.resetsAtMs, now) : ''}`)
    if (bits.length) parts.push(`${POOL_NAMES[pool]} ${bits.join(' ')}`)
  }
  return parts.join(' · ') || 'quota unknown'
}

const how = (x: Executor) => `subagent_type "${x.agent}"${x.model ? `, model "${x.model}"` : ''}`

/** The hidden note attached to a user prompt. */
export function contextNote(r: Route, quota: Quota, now: number) {
  if (!r.pick) {
    return `[agent-router] Every pool is near its limit (${quotaLine(quota, now)}). Keep work small and tell the user.`
  }
  const lines = [
    `[agent-router] This request looks like ${r.category.title} (${r.size}).`,
    `Suggested executor: ${r.pick.label}, via ${how(r.pick)}. Why: ${r.why}.`,
  ]
  if (r.fallback) lines.push(`Fallback: ${r.fallback.label}, via ${how(r.fallback)}.`)
  lines.push(`Quota: ${quotaLine(quota, now)}.`)
  if (r.isClaudeLow) {
    lines.push('Claude is near its limit: delegate substantive work to the suggestion and keep your own turns short.')
  }
  return lines.join('\n')
}

/** The routing policy for the main agent's system prompt; it changes only with the roster. */
export function policy(executors: Executor[]) {
  const roster = executors.map(x => `- ${x.label}: ${how(x)} (${POOL_NAMES[x.pool]} quota)${x.note ? `; ${x.note}` : ''}`)
  return [
    '# Model routing (agent-router)',
    'Work is spread over three subscriptions: Claude, OpenAI Codex and Google Antigravity (agy). Each user prompt may carry an [agent-router] note naming the executor best suited to it, picked from benchmark fit and live quota.',
    'Rules:',
    '- Do quick, trivial steps yourself. Delegate substantive work to the suggested executor through the Agent tool.',
    '- If the user named a model or agent, use theirs and ignore the suggestion.',
    '- A reviewer must not be the agent that built the work; prefer one on another subscription.',
    '- If an executor fails or is rate-limited twice, move to the fallback.',
    'Executors:',
    ...roster,
  ].join('\n')
}
