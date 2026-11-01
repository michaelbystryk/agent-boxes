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

import type { Scan, ToolBox } from '../types'
import { CATEGORIES } from './catalog'
import type { Category, Executor, Pool } from './catalog'
import {
  DEFAULTS,
  categoryById,
  classify,
  contextNote,
  firstJson,
  isContinuation,
  poolState,
  leadLine,
  namedIn,
  namedNote,
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
const POLICY_VERSION = 3
// The small model sorts only prompts this long with no keyword: shorter ones are general, and
// a small or general task's placement wouldn't change with a finer label.
const CLASSIFY_WORDS = 15
const CLASSIFY_TIMEOUT_MS = 1500
// A provider's last good reading: used while scans keep coming; once its box goes stale (the
// scan failed or was slow), only this long, then the pool counts as unknown.
const STALE_MS = 10 * 60e3
const FRESH_MS = 60 * 60e3
// Claude's last reading, when the session has none (API key, a gap in rateLimits).
const CLAUDE_KEEP_MS = 5 * 3600e3
// A relay that reports `Result: rate-limited` puts its pool out this long, or until a scan at
// least CLEAR_AFTER_MS later shows a new reading with headroom (an unchanged or earlier one may
// not see the limit it hit).
const COOLDOWN_MS = 30 * 60e3
const CLEAR_AFTER_MS = 5 * 60e3
const RATE_LIMITED = /(^|\n)Result: rate-limited\s*$/
// The same background error category is logged at most this often.
const LOG_EVERY_MS = 30 * 60e3
// A spawn that ended with no turn.complete (aborted) is forgotten after this long.
const SPAWN_KEEP_MS = 3600e3

// The router box's state, drawn by register.tsx; null while the router is off.
const routeBox = atom({ plugin: 'agent-boxes', key: 'route' } as const, null)

// <claude dir>, from register.tsx at session start.
let claudeDir = ''
// Each pool's last good reading from the side bar's scan (Codex, agy) or the session (Claude).
// `limited`: pools a relay found rate-limited, when, and the reading then held (a scan that
// repeats it has not seen the limit, so it doesn't clear it).
type Reading = { w: Windows; atMs: number; isStale: boolean }
type Limit = { atMs: number; seen: string }
export type Book = { readings: Map<Pool, Reading>; limited: Map<Pool, Limit> }
export const newBook = (): Book => ({ readings: new Map(), limited: new Map() })

/** A relay of this pool reported a rate limit just now. */
export function markLimited(book: Book, pool: Pool, now: number) {
  book.limited.set(pool, { atMs: now, seen: JSON.stringify(book.readings.get(pool)?.w ?? null) })
}
let book = newBook()
// What the last scan-driven refresh drew from, so an unchanged scan costs nothing.
let scanSig = ''
// Background error categories already logged, and when.
let logged = new Map<string, number>()
let config: Config = DEFAULTS
// Each catalog agent's spawnable type, or undefined when there is none.
let agents = new Map<string, string | undefined>()
// Catalog agents that are the user's or the project's own definitions.
let custom = new Set<string>()
// Executor ids the user named in the latest prompt: steer mode leaves their spawns alone.
let named = new Set<string>()
let last: { route: Route; atMs: number; place: Placement } | undefined
// Spawns this session started, by agent id, for the outcome log.
let spawned = new Map<string, { atMs: number; category: string; promptId?: string; pool?: Pool }>()
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
    // The workspace's own agents only with `projectAgents`: an untrusted repo must not be able
    // to pull delegation into an agent it wrote.
    else if (
      (await $.fs.exists(`${dir}/agents/${x.agent}.md`)) ||
      (config.projectAgents && (await $.fs.exists(`.claude/agents/${x.agent}.md`)))
    ) {
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

// Codex's and agy's readings from a scan: a fresh box replaces the reading, a stale one keeps
// it (marked stale), a tool that is not installed or has no usage (`{"5h": null, "7d": null}`)
// drops it: such a pool is unknown, not healthy.
const hasUsage = (w: Windows | undefined): w is Windows =>
  typeof w?.['5h']?.used === 'number' || typeof w?.['7d']?.used === 'number'

export function takeScan({ readings, limited }: Book, scan: Scan, now: number) {
  const put = (pool: Pool, box: ToolBox | undefined, w: Windows | undefined) => {
    const old = readings.get(pool)
    if (!box || box.installed === false) readings.delete(pool)
    else if (box.stale) {
      if (old && !old.isStale) readings.set(pool, { ...old, isStale: true })
    } else if (hasUsage(w)) {
      readings.set(pool, { w, atMs: now, isStale: false })
      const hit = limited.get(pool)
      const isNews = hit !== undefined && JSON.stringify(w) !== hit.seen && now - hit.atMs >= CLEAR_AFTER_MS
      if (isNews && !poolState(pool, w, now).isOut) limited.delete(pool)
    } else readings.delete(pool)
  }
  put('codex', scan.codex, scan.codex?.windows)
  put('agy', scan.agy, scan.agy?.groups?.gemini ?? scan.agy?.windows)
  put('agy-claude', scan.agy, scan.agy?.groups?.['claude/gpt'])
}

// The book's quota: each reading while fresh (a stale box's only STALE_MS, Claude's
// CLAUDE_KEEP_MS); a pool a relay found rate-limited is out for its cooldown.
export function bookQuota({ readings, limited }: Book, now: number): Quota {
  const q: Quota = {}
  for (const [pool, r] of readings) {
    const keep = pool === 'claude' ? CLAUDE_KEEP_MS : r.isStale ? STALE_MS : FRESH_MS
    if (now - r.atMs <= keep) q[pool] = r.w
  }
  for (const [pool, hit] of limited) {
    if (now - hit.atMs >= COOLDOWN_MS) limited.delete(pool)
    else q[pool] = { ...q[pool], rateLimited: true }
  }
  return q
}

/** A relay's report that ends with the line `Result: rate-limited`. */
export const isRateLimited = (text: string) => RATE_LIMITED.test(text.trimEnd())

// Claude's windows from the session (else its last reading); Codex's and agy's from the scan.
async function quota($: EngineInterface, now: number): Promise<Quota> {
  try {
    const w = claudeWindows((await $.session.usage()).rateLimits)
    if (hasUsage(w)) book.readings.set('claude', { w, atMs: now, isStale: false })
  } catch {
    // no usage yet: the last reading, if any
  }
  return bookQuota(book, now)
}

// A background error, logged once per category (ids and numbers stripped) per LOG_EVERY_MS.
async function logOnce($: EngineInterface, what: string, err: unknown) {
  const text = `agent-boxes: ${what}: ${String(err)}`
  const key = text.replace(/\b[0-9a-f]{6,}(-[0-9a-f]+)*\b/gi, '#').replace(/\d+/g, '#')
  let now = 0
  try {
    now = await $.clock.now()
  } catch {
    // no clock: log it
  }
  const at = logged.get(key)
  if (at !== undefined && now - at < LOG_EVERY_MS) return
  logged.set(key, now)
  $.ui.log(text)
}

// The category by keywords, else by a small model for prompts long enough to be a new task.
async function categorize($: EngineInterface, text: string): Promise<Category | undefined> {
  const found = classify(text)
  if (found) return found
  const words = text.trim().split(/\s+/).length
  if (words <= REPLY_WORDS) return undefined
  // A blocking call on every prompt: only when a finer label could change the placement.
  if (!config.classify || words <= CLASSIFY_WORDS) return categoryById('general')
  try {
    const ids = CATEGORIES.map(c => `${c.id} (${c.title})`).join(', ')
    const r = await $.model.complete({
      model: config.classifyModel,
      maxTokens: 20,
      timeoutMs: CLASSIFY_TIMEOUT_MS,
      system: 'You sort a request to a coding agent into one category. Reply with the category id alone.',
      prompt: `Categories: ${ids}, general.\n\nRequest:\n<<<${text.slice(0, 2000)}>>>`,
    })
    return categoryById(r.isAnswered ? categoryIdIn(r.text) : '')
  } catch {
    return categoryById('general')
  }
}

// The classifier's reply: a category id alone, or a JSON object with one (`{"category": "x"}`).
function categoryIdIn(text: string) {
  const known = new Set([...CATEGORIES.map(c => c.id), 'general'])
  const obj = firstJson(text)
  const v = obj && (obj.category ?? obj.id)
  if (typeof v === 'string' && known.has(v.trim().toLowerCase())) return v.trim().toLowerCase()
  return text.toLowerCase().match(/[a-z]+/g)?.find(w => known.has(w)) ?? ''
}

// The router box: the mode and best-placed pool, then the last routed prompt's pick. register.tsx
// also calls it after each scan (the current one, stale boxes marked), for the best-placed line;
// a scan that changes no reading returns at once.
export async function refresh($: EngineInterface, scan?: Scan) {
  const now = await $.clock.now()
  if (scan) {
    takeScan(book, scan, now)
    // What the box would draw from now, expiry of stale readings and cooldowns included.
    const live = bookQuota(book, now)
    delete live.claude
    const sig = JSON.stringify([config.mode, last?.atMs, live])
    if (sig === scanSig) return
    scanSig = sig
  }
  const r = last?.route
  const next = config.mode === 'off' ? null : {
    mode: config.mode,
    lead: leadLine(await quota($, now), now, executors()),
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
    await logOnce($, 'router history', err)
  } finally {
    writing = false
  }
}

// What /route prints: the last pick with every candidate's score, the quota and the mode.
async function report($: EngineInterface) {
  const now = await $.clock.now()
  const q = await quota($, now)
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

// The executor a spawn runs: its agent type alone when only one executor has it; when several
// share it (general-purpose on Haiku, Sonnet, Opus), the one whose model the spawn names (alias,
// or a model id of that family). A shared type with no model names none.
function executorOf(subagentType: string, model: string | undefined, all = executors()): Executor | undefined {
  if (subagentType === 'general-purpose' && !model) return undefined
  const same = all.filter(x => x.agent === subagentType)
  if (same.length <= 1) return same[0]
  if (!model) return undefined
  const m = model.toLowerCase()
  return same.find(x => x.model === m) ?? same.find(x => x.model && m.split(/[^a-z0-9]+/).includes(x.model))
}

// steer mode: a spawn whose pool is out goes to the best executor of the last prompt's category.
function steer(subagentType: string, model: string | undefined, quotaNow: Quota, now: number): Executor | undefined {
  const all = executors()
  const asked = executorOf(subagentType, model, all)
  if (!asked || named.has(asked.id)) return undefined
  const category = last?.route.category ?? categoryById('general')
  const r = route(category, last?.route.size ?? 'medium', quotaNow, now, all, config)
  // Its own pool's standing, ranked in this category or not (a codex-builder spawn while Codex is out).
  const isOut = poolState(asked.pool, quotaNow[asked.pool], now).isOut
  if (!isOut || !r.pick || r.pick.id === asked.id) return undefined
  return r.pick
}

// register.tsx's hooks call these: the engine takes one hook per event from a module.

export async function startRouter($: EngineInterface, dir: string) {
  claudeDir = dir
  book = newBook()
  scanSig = ''
  logged = new Map()
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
    // "ok, and the tests", "now push it": within the follow-up window, the same task.
    evictSpawns(now)
    const mentioned = namedIn(e.text, executors())
    const follows = last !== undefined && now - last.atMs < FOLLOW_MS && isContinuation(e.text)
    const category = follows ? undefined : await categorize($, e.text)
    named = new Set(mentioned.map(x => x.id))
    // This reply is the best signal of how the last prompt's work went: a new task grades it
    // either way, a continuation only when it says something about the result.
    const verdict = outcomeOf(e.text)
    if (prompt && !prompt.isGraded && (category || verdict !== 'unknown')) await grade($, verdict, 'reply')
    // A reply that only names an executor ("use architect", "ok, on Opus") continues the task, and
    // still gets the note: the user's pick wins.
    if (!category && mentioned.length) note = namedNote(mentioned)
    if (!category && prompt) {
      prompt.isOpen = true
      prompt.turnAtMs = now
      prompt.spawns = 0
    }
    if (category) {
      const q = await quota($, now)
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
    await logOnce($, 'router', err)
  }
  return note
}

const isPlain = (e: AgentSpawnInput) => !e.fork && !e.resume && !e.isTeammate && !e.workflow && e.parentAgentId === undefined

// steer mode's spawn, rewritten when its pool is out. A router failure never stops a spawn.
export async function steered($: EngineInterface, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  if (config.mode !== 'steer' || !isPlain(e)) return e
  try {
    const now = await $.clock.now()
    const to = steer(e.subagentType, e.model, await quota($, now), now)
    if (!to) return e
    $.ui.toast(`⇄ ${e.subagentType} → ${to.agent} (${last?.route.why ?? 'quota'})`)
    return { ...e, subagentType: to.agent, model: to.model }
  } catch (err) {
    await logOnce($, 'steer', err)
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
  const pool = executorOf(ran.subagentType, ran.model ?? done.model)?.pool
  spawned.set(done.agentId, { atMs, category, promptId, pool })
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

// Drops spawns that never reported an end, so the map can't grow all session.
function evictSpawns(now: number) {
  for (const [id, run] of spawned) if (now - run.atMs > SPAWN_KEEP_MS) spawned.delete(id)
}

// A routed spawn ended. `answer` is turn.complete's `e.answer` (the report it handed back); left
// out, the agent's last reply is read. A relay whose report ends `Result: rate-limited` puts its
// pool out for COOLDOWN_MS, so the next prompt goes to the fallback.
export async function agentDone($: EngineInterface, agentId: string | undefined, answer?: string) {
  const run = agentId ? spawned.get(agentId) : undefined
  if (agentId) spawned.delete(agentId)
  const atMs = await $.clock.now()
  evictSpawns(atMs)
  if (!run || !agentId) return
  let text = answer
  if (text === undefined && run.pool && run.pool !== 'claude') {
    try {
      const said = await $.session.messages({ agentId })
      if (Array.isArray(said)) text = [...said].reverse().find(m => m.role === 'assistant' && m.text)?.text
    } catch {
      // gone already: no verdict
    }
  }
  const isLimited = run.pool !== undefined && text !== undefined && isRateLimited(text)
  if (isLimited) markLimited(book, run.pool!, atMs)
  await log($, {
    atMs,
    event: 'done',
    promptId: run.promptId,
    agentId,
    category: run.category,
    ms: atMs - run.atMs,
    ...(isLimited ? { rateLimited: run.pool } : {}),
  })
  if (isLimited) await refresh($)
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
