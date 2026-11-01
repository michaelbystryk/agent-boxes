// The router proper, free of the engine so tests can drive it: what kind of task a prompt is,
// and which executor should take it given each pool's quota.
import { CATEGORIES, EXECUTORS, GENERAL } from './catalog'
import type { Category, Executor, Pool } from './catalog'

export type Win = { used: number | null; resetsAtMs?: number }
/** A pool's windows; `rateLimited` when a relay of the pool just hit a 429 / quota error. */
export type Windows = { '5h'?: Win | null; '7d'?: Win | null; rateLimited?: boolean }
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
  /**
   * Do work picked for a Claude model in the main loop when it can (see placement). `true` leaves
   * the user's own agent definitions to their agents; `'all'` folds those in too.
   */
  inLoop: boolean | 'all'
  /**
   * Trust the workspace's own `.claude/agents/*.md` as executors. Off by default: an untrusted
   * repo could otherwise force delegation into an agent it wrote.
   */
  projectAgents: boolean
}

export const DEFAULTS: Config = {
  mode: 'advise',
  disabled: [],
  enabled: [],
  order: {},
  classify: true,
  classifyModel: 'haiku',
  inLoop: true,
  projectAgents: false,
}

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
    inLoop: o.inLoop === false ? false : o.inLoop === 'all' ? 'all' : true,
    projectAgents: o.projectAgents === true,
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
// A domain wins over an activity, except a short lookup question and a code review: "review
// this shader" wants an independent reviewer, not a shader writer. Art has its own review.
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
  // "review this shader for texture bugs" is still a code review: art keeps only reviews of
  // the look itself, with no code material named.
  if (hits('review') && (!hits('art') || ['shader', 'blender', 'gamedev', 'frontend'].some(hits))) return byId('review')
  for (const id of [...DOMAINS, ...ACTIVITIES]) if (hits(id)) return byId(id)
  return undefined
}

export const categoryById = (id: string) => CATEGORIES.find(c => c.id === id) ?? GENERAL

// A reply that carries on the running task ("ok, and the tests too", "now push it"): within the
// follow-up window it continues the last prompt whatever keywords it holds.
const GO_ON = /^\s*(yes|yeah|yep|ok(ay)?|sure|now|also|then|and|go|do it|plz)\b/i

export function isContinuation(text: string) {
  return GO_ON.test(text)
}

const HOUR = 3600e3
const LENGTH: Record<'5h' | '7d', number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR }
const OUT: Record<'5h' | '7d', number> = { '5h': 90, '7d': 95 }
// Claude also runs this session itself, so its executors stop earlier.
const CLAUDE_OUT: Record<'5h' | '7d', number> = { '5h': 85, '7d': 92 }
// Fit by rank: the first choice, then each next a little less.
const FIT = [1, 0.85, 0.72, 0.62, 0.55]
// A follow-up prompt leans toward the executor that took the one before, so one piece of work
// doesn't hop between vendors turn by turn. Reviews and lookups are deliberate splits: no lean.
const STICKY = 1.15
const UNSTICKY = ['review', 'lookup']

export type PoolState = { isOut: boolean; isKnown: boolean; headroom: number; bonus: number; reason?: string }
// An outside pool with no reading may be signed out or empty: it scores below a known healthy one.
// Claude's own unknown (API key, first prompt) is not penalised: this chat runs on it anyway.
const UNKNOWN_HEADROOM = 0.6
const UNKNOWN_PENALTY = 0.7

/**
 * A pool's standing: out when a window is near full; headroom the least spare share of its windows
 * (unknown counts as 0.6); bonus up to +0.3 when the 7d window resets soon with much unused
 * (use it or lose it), down to -0.3 when it is used ahead of the clock.
 */
export function poolState(pool: Pool, w: Windows | undefined, now: number): PoolState {
  const limits = pool === 'claude' ? CLAUDE_OUT : OUT
  if (w?.rateLimited) return { isOut: true, isKnown: true, headroom: 0, bonus: 0, reason: `${POOL_NAMES[pool]} rate-limited` }
  let headroom = 1
  let isKnown = false
  for (const key of ['5h', '7d'] as const) {
    const used = w?.[key]?.used
    if (typeof used !== 'number') continue
    isKnown = true
    if (used >= limits[key]) return { isOut: true, isKnown: true, headroom: 0, bonus: 0, reason: `${POOL_NAMES[pool]} ${key} ${Math.round(used)}%` }
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
  return { isOut: false, isKnown, headroom: isKnown ? headroom : UNKNOWN_HEADROOM, bonus }
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
  /** Quota, not fit, decided the pick: the first-ranked was out or another pool had more room. */
  isQuotaPick: boolean
}

export function route(
  category: Category,
  size: Size,
  quota: Quota,
  now: number,
  executors: Executor[],
  config: Config = DEFAULTS,
  /** The executor id that took the previous prompt, for a follow-up. */
  prev?: string,
): Route {
  const byId = new Map(executors.map(x => [x.id, x]))
  const states = new Map<Pool, PoolState>()
  const stateOf = (pool: Pool) => {
    if (!states.has(pool)) states.set(pool, poolState(pool, quota[pool], now))
    return states.get(pool)!
  }
  const ranked = (config.order[category.id] ?? category.ranked).filter(id => byId.has(id))
  // Claude short: Opus/Sonnet stay candidates (marked out), and the same model on agy's quota
  // joins at the same rank, when that is set up.
  const relief = byId.get('opus-agy')
  const slots: { id: string; rank: number }[] = []
  ranked.forEach((id, rank) => {
    if (!slots.some(s => s.id === id)) slots.push({ id, rank })
    const x = byId.get(id)!
    if (relief && x.pool === 'claude' && x.id !== 'haiku' && stateOf('claude').isOut && !slots.some(s => s.id === relief.id)) {
      slots.push({ id: relief.id, rank })
    }
  })
  const weight = size === 'large' ? 1 : size === 'medium' ? 0.6 : 0.3
  const thrift = size === 'small' ? 0.15 : size === 'medium' ? 0.05 : 0
  const scored: Scored[] = slots.map(({ id, rank }) => {
    const executor = byId.get(id)!
    const s = stateOf(executor.pool)
    if (s.isOut) return { executor, score: 0, rank, out: s.reason }
    const fit = FIT[Math.min(rank, FIT.length - 1)]!
    const stick = executor.id === prev && !UNSTICKY.includes(category.id) ? STICKY : 1
    const unknown = !s.isKnown && executor.pool !== 'claude' ? UNKNOWN_PENALTY : 1
    const score = (unknown * stick * fit * (1 - weight + weight * s.headroom) * (1 + s.bonus)) / (1 + thrift * (executor.cost - 1))
    return { executor, score, rank }
  })
  const live = scored.filter(s => !s.out).sort((a, b) => b.score - a.score)
  const pick = live[0]?.executor
  const fallback = live.find(s => s.executor.pool !== pick?.pool)?.executor ?? live[1]?.executor
  const first = scored[0]
  let why: string
  let isQuotaPick = false
  if (!pick) why = 'every pool near its limit'
  else if (first && first.executor.id !== pick.id) {
    isQuotaPick = true
    why = first.out ? `${first.executor.label} out: ${first.out}` : `${POOL_NAMES[pick.pool]} has more room`
  } else why = `best fit for ${category.title}`
  return { category, size, pick, fallback, scored, why, isClaudeLow: stateOf('claude').isOut, isQuotaPick }
}

/**
 * The pool best placed for the next task, for the side bar's idle line: `agy best placed · 97% free · 8 ready`.
 * Only pools with an executor in the roster and a quota reading count.
 */
export function leadLine(quota: Quota, now: number, executors: Executor[]) {
  let best: { pool: Pool; s: PoolState } | undefined
  for (const pool of new Set(executors.map(x => x.pool))) {
    if (!quota[pool]) continue
    const s = poolState(pool, quota[pool], now)
    if (s.isOut || !s.isKnown) continue
    if (!best || s.headroom * (1 + s.bonus) > best.s.headroom * (1 + best.s.bonus)) best = { pool, s }
  }
  const ready = `${executors.length} ready`
  if (!best) return `quota unknown · ${ready}`
  const lose = best.s.bonus > 0 ? ' · use it or lose it' : ''
  return `${POOL_NAMES[best.pool]} best placed · ${Math.round(best.s.headroom * 100)}% free${lose} · ${ready}`
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
    if (w.rateLimited) bits.push('rate-limited')
    if (bits.length) parts.push(`${POOL_NAMES[pool]} ${bits.join(' ')}`)
  }
  return parts.join(' · ') || 'quota unknown'
}

const how = (x: Executor) => `subagent_type "${x.agent}"${x.model ? `, model "${x.model}"` : ''}`

/** The main loop: its model id and how full its context is (percent). */
export type Loop = { model?: string; context?: number }
export type Placement = { inLoop: boolean; reason: string }

// Claude models by strength; a model id or alias matches by family name.
const TIERS: [RegExp, number][] = [[/haiku/i, 1], [/sonnet/i, 2], [/opus/i, 3], [/fable/i, 4]]
const tierOf = (model?: string) => TIERS.find(([re]) => re.test(model ?? ''))?.[1]
// Past this share of context, new work goes to a fresh one; large work goes sooner.
const CONTEXT_FULL = 60
const CONTEXT_FULL_LARGE = 40

/**
 * Where the pick's work should run. A review goes to an independent reviewer. A small task stays
 * in this loop whatever the pick: briefing an agent costs more than doing it. Outside quota
 * (Codex, agy) is otherwise delegated: that is what spreading the load is for. A Claude pick
 * stays in this loop, which keeps its context and spends the same quota a subagent would, unless:
 * the user turned that off; Claude is short; the pick is the user's own definition; the pick is a
 * cheaper or stronger model than this loop's; or the context is filling up. Claude's quota unknown
 * (API key, first prompt) counts as not short.
 */
export function placement(r: Route, _quota: Quota, loop: Loop, config: Config = DEFAULTS): Placement {
  const pick = r.pick
  if (!pick) return { inLoop: false, reason: 'every pool near its limit' }
  if (!config.inLoop) return { inLoop: false, reason: 'inLoop is off in the config' }
  if (r.category.id === 'review') return { inLoop: false, reason: 'a review needs a reviewer that did not build the work' }
  if (r.size === 'small') return { inLoop: true, reason: 'a small task: quicker here than briefing an agent' }
  if (pick.pool !== 'claude') return { inLoop: false, reason: 'it spends quota outside Claude' }
  if (pick.isCustom && config.inLoop !== 'all') {
    return { inLoop: false, reason: `your own ${pick.agent} definition has its own instructions and tools` }
  }
  if (r.isClaudeLow) return { inLoop: false, reason: 'Claude is near its limit' }
  const mine = tierOf(loop.model)
  const theirs = tierOf(pick.model ?? pick.label)
  if (!mine || !theirs) return { inLoop: false, reason: "this chat's model is unknown" }
  if (theirs < mine) return { inLoop: false, reason: `${pick.label} is cheaper than this chat's model` }
  if (theirs > mine) return { inLoop: false, reason: `${pick.label} is stronger than this chat's model` }
  const full = r.size === 'large' ? CONTEXT_FULL_LARGE : CONTEXT_FULL
  if (typeof loop.context === 'number' && loop.context >= full) {
    return { inLoop: false, reason: `this chat's context is ${Math.round(loop.context)}% full` }
  }
  return { inLoop: true, reason: `${pick.label} is this chat's own model` }
}

/**
 * Executors the user named in the prompt: a full label (`GPT-6 Astra`) anywhere, or an agent
 * name (`architect`, `codex-builder`) or a model's own name (`opus`, `sol`) after a word like
 * "use" or "on", so "a muzzle flash" or "a worker thread" names nothing.
 */
export function namedIn(text: string, executors: Executor[]): Executor[] {
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const has = (word: string, cue = '') => new RegExp(`(^|[^\\w-])${cue}${escape(word)}($|[^\\w-])`, 'i').test(text)
  const CUE = '(?:use|using|with|on|via|ask|have|give it to|send it to|run it on)\\s+(?:the\\s+)?'
  return executors.filter(x => {
    const base = x.agent.replace(/^[^:]*:/, '')
    if (has(x.label)) return true
    if (base !== 'general-purpose' && has(base, CUE)) return true
    return x.id !== 'opus-agy' && has(x.id, CUE)
  })
}

/** The note for a prompt that names its executor: the user's pick wins. */
export const namedNote = (named: Executor[]) => `[router] You named ${named.map(x => x.label).join(' / ')}: use that.`

// An executor in a note: its subagent type, and the model when it needs one.
const short = (x: Executor) => `${x.agent}${x.model ? ` model=${x.model}` : ''}`

/**
 * The hidden note attached to a user prompt, kept to one short line or none: no note means do it
 * in this loop. A delegation names the executor, the fallback and why; quota only when it decided.
 */
export function contextNote(r: Route, quota: Quota, now: number, place?: Placement, named: Executor[] = []): string | undefined {
  if (named.length) return namedNote(named)
  if (!r.pick) {
    return `[router] Every pool is near its limit (${quotaLine(quota, now)}). Don't delegate: keep the work small and tell the user.`
  }
  if (place?.inLoop) {
    return r.isClaudeLow ? '[router] Claude is near its limit: keep your own turns short.' : undefined
  }
  const fallback = r.fallback ? ` (fallback ${short(r.fallback)})` : ''
  const fit = r.why.startsWith('best fit') ? 'best fit' : r.why
  const why = r.pick.pool === 'claude' && place ? (r.isQuotaPick ? `${r.why}; ${place.reason}` : place.reason) : fit
  const low = r.isClaudeLow && !/Claude/.test(why) ? '; Claude is near its limit' : ''
  const q = r.isQuotaPick || r.isClaudeLow ? ` [${quotaLine(quota, now)}]` : ''
  return `[router] → ${short(r.pick)}${fallback}: ${r.category.id}; ${why}${low}${q}`
}

/** The first balanced JSON object in a model's reply (prose or a second object may follow), or undefined. */
export function firstJson(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown
          if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
        } catch {
          // not JSON after all: try the next brace
        }
        break
      }
    }
  }
  return undefined
}

// A reply that says the last result was wrong, or that it was fine. Neither is proof; the
// history keeps the signal next to the route so a few dozen prompts can be compared.
const REWORK = /\b(wrong|still (broken|failing|fails|there|not)|broke|revert|undo|try again|redo|doesn'?t work|didn'?t work|not working|that'?s not)\b/i
const ACCEPT = /\b(thanks|thank you|great|perfect|looks good|lgtm|works now|nice|ship it|push( it)?|merge( it)?)\b/i

/** The next prompt's verdict on the last result: rework, accept, or unknown. */
export function outcomeOf(text: string): 'rework' | 'accept' | 'unknown' {
  if (REWORK.test(text)) return 'rework'
  if (ACCEPT.test(text)) return 'accept'
  return 'unknown'
}

/** The routing policy for the main agent's system prompt; it changes only with the roster. */
export function policy(executors: Executor[]) {
  const roster = executors.map(x => `- ${x.label}: ${how(x)} (${POOL_NAMES[x.pool]} quota)${x.note ? `; ${x.note}` : ''}`)
  return [
    '# Model routing (agent-boxes router)',
    'Work is spread over three subscriptions: Claude, OpenAI Codex and Google Antigravity (agy). Each user prompt may carry a [router] note naming the executor best suited to it, picked from benchmark fit and live quota.',
    'Rules:',
    '- No [router] note: do the work in this loop. A note `[router] → <subagent_type> [model=<m>] (fallback …): why` means delegate the task through the Agent tool to that subagent_type (with that model, if given). Do quick, trivial steps yourself either way.',
    '- Work for Codex or agy is delegated: it spends quota outside Claude. Work for a Claude model stays in this loop unless a note says otherwise: a subagent would spend the same quota and hand back only a summary. Parallel work on disjoint paths and broad read-only sweeps can still go out.',
    '- When Claude is near its limit, delegate all substantive work and keep your own turns short. When every pool is near its limit, keep the work small and tell the user.',
    "- A relay's report ends with a `Result:` line naming its output and error files. After edits, check the working tree (git diff), not the report. Read the output file, only the parts you need, when the report is unclear or the work was a review, plan or research. A relay without that line: rely on its report and the working tree.",
    '- If the user named a model or agent, use theirs and ignore the suggestion.',
    '- A reviewer must not be the agent that built the work; prefer one on another subscription.',
    '- A relay that reports `Result: rate-limited` hit its quota: move to the fallback at once, no retry. On any other failure, retry once, then move to the fallback.',
    'Executors:',
    ...roster,
  ].join('\n')
}
