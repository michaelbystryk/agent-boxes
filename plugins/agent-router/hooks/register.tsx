import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import { CATEGORIES } from './catalog'
import type { Category, Executor } from './catalog'
import {
  DEFAULTS,
  categoryById,
  classify,
  leadLine,
  contextNote,
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

// agent-boxes' scan writes Codex's and agy's windows here; older than this, they are ignored.
const QUOTA_MAX_AGE_MS = 6 * 3600e3

let config: Config = DEFAULTS
let claudeDir: string | undefined
let homeDir: string | undefined
// Each catalog agent's spawnable type, or undefined when there is none.
let agents = new Map<string, string | undefined>()
let last: { route: Route; quota: Quota; atMs: number } | undefined
// Spawns this session started, by agent id, for the outcome log.
let spawned = new Map<string, { atMs: number; category: string }>()

const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

async function folders($: EngineInterface) {
  if (claudeDir && homeDir) return
  const home = (await $.env.get('HOME')) || ''
  const profile = (await $.env.get('USERPROFILE')) || ''
  homeDir = (await isWindows($)) ? profile || home : home || profile
  claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${homeDir}/.claude`
}

const dir = () => `${claudeDir}/agent-router`

async function loadConfig($: EngineInterface) {
  await folders($)
  const path = `${dir()}/config.json`
  try {
    config = readConfig((await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {})
  } catch {
    config = DEFAULTS
  }
}

// Each catalog agent's spawnable type: a built-in, the user's or the project's own definition,
// this plugin's relay, or for a Claude model with no definition, general-purpose on that model.
async function findAgents($: EngineInterface) {
  await folders($)
  agents = new Map()
  for (const x of roster({ ...config, enabled: [...config.enabled, 'fable'] })) {
    if (agents.has(x.agent)) continue
    let type: string | undefined
    if (BUILT_IN.includes(x.agent)) type = x.agent
    else if ((await $.fs.exists(`${claudeDir}/agents/${x.agent}.md`)) || (await $.fs.exists(`.claude/agents/${x.agent}.md`))) {
      type = x.agent
    } else if (SHIPPED.includes(x.agent)) type = `agent-router:${x.agent}`
    else if (x.pool === 'claude' && x.model) type = 'general-purpose'
    agents.set(x.agent, type)
  }
}

const executors = () =>
  roster(config, a => agents.get(a) !== undefined).map(x => ({ ...x, agent: agents.get(x.agent) ?? x.agent }))

function claudeWindows(limits: SessionRateLimit[]): Windows {
  const one = (kind: string) => {
    const w = limits.find(l => l.kind === kind)
    if (!w) return null
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return Number.isFinite(at) ? { used: w.percentUsed, resetsAtMs: at } : { used: w.percentUsed }
  }
  return { '5h': one('five_hour'), '7d': one('seven_day') }
}

// Claude's windows from the session; Codex's and agy's from the file agent-boxes' scan writes.
async function quota($: EngineInterface): Promise<Quota> {
  const q: Quota = {}
  try {
    q.claude = claudeWindows((await $.session.usage()).rateLimits)
  } catch {
    // no usage yet; Claude counts as unknown
  }
  try {
    await folders($)
    const path = `${claudeDir}/agent-boxes/quota.json`
    if (!(await $.fs.exists(path))) return q
    const shared = JSON.parse(await $.fs.read(path)) as {
      codex?: Windows | null
      agy?: Record<string, Windows> | null
      atMs?: number
    }
    if (typeof shared.atMs !== 'number' || (await $.clock.now()) - shared.atMs > QUOTA_MAX_AGE_MS) return q
    if (shared.codex) q.codex = shared.codex
    if (shared.agy?.gemini) q.agy = shared.agy.gemini
    if (shared.agy?.['claude/gpt']) q['agy-claude'] = shared.agy['claude/gpt']
  } catch {
    // mid-write or unreadable; the next prompt reads it
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

// The side bar's state for this session: the mode and best-placed pool from the start,
// then the last routed prompt's pick. agent-boxes draws it as the router box.
async function writeState($: EngineInterface) {
  await folders($)
  const path = `${dir()}/route-${await $.session.id()}.json`
  const now = await $.clock.now()
  const list = executors()
  const r = last?.route
  const body = {
    mode: config.mode,
    lead: config.mode === 'off' ? '' : leadLine(await quota($), now, list),
    category: r?.category.id ?? '',
    size: r?.size ?? '',
    pick: r?.pick?.label ?? '',
    fallback: r?.fallback?.label ?? '',
    why: r?.why ?? '',
    atMs: now,
  }
  await $.fs.write(path, JSON.stringify(body)).catch(() => undefined)
}

async function log($: EngineInterface, entry: object) {
  await folders($)
  const path = `${dir()}/history.jsonl`
  try {
    const old = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
    await $.fs.write(path, [...old, JSON.stringify(entry)].slice(-HISTORY_LINES).join('\n') + '\n')
  } catch (err) {
    $.ui.log(`agent-router: history: ${String(err)}`)
  }
}

// What /route prints: the last pick with every candidate's score, the quota and the mode.
async function report($: EngineInterface) {
  const now = await $.clock.now()
  const q = await quota($)
  const lines = [`agent-router · mode ${config.mode} · ${quotaLine(q, now)}`]
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

export const register: Register = on => {
  config = DEFAULTS
  claudeDir = undefined
  homeDir = undefined
  agents = new Map()
  last = undefined
  spawned = new Map()

  on('session.start', async ($, e, next) => {
    await loadConfig($)
    await findAgents($)
    await $.command.register({ name: 'route', description: 'Show which model agent-router picks and why' })
    await writeState($)

    return next(e)
  })

  // The routing policy, for the agent that can delegate (the one offered the Agent tool).
  on('prompt.compose', async ($, e, next) => {
    const got = await next(e)
    if (config.mode === 'off' || !e.tools.includes('Agent')) return got
    const list = executors()
    if (list.length < 2) return got

    return { sections: [...got.sections, { id: 'agent-router:policy', text: policy(list), scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const isUsers = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (config.mode === 'off' || e.isMeta || e.command || !isUsers || !e.text.trim()) return next(e)
    // Every prompt refreshes the side bar's best-placed line; a routed one also sets the pick.
    let note: string | undefined
    try {
      const category = await categorize($, e.text)
      if (category) {
        const now = await $.clock.now()
        const q = await quota($)
        const r = route(category, sizeOf(e.text), q, now, executors(), config)
        last = { route: r, quota: q, atMs: now }
        note = contextNote(r, q, now)
      }
      await writeState($)
    } catch (err) {
      $.ui.log(`agent-router: ${String(err)}`)
    }

    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    let input = e
    const isPlain = !e.fork && !e.resume && !e.isTeammate && !e.workflow && e.parentAgentId === undefined
    // A router failure must never stop a spawn: on any error the spawn goes ahead as asked.
    if (config.mode === 'steer' && isPlain) {
      try {
        const now = await $.clock.now()
        const to = steer(e.subagentType, e.model, await quota($), now)
        if (to) {
          input = { ...e, subagentType: to.agent, model: to.model }
          $.ui.toast(`⇄ ${e.subagentType} → ${to.agent} (${last?.route.why ?? 'quota'})`)
        }
      } catch (err) {
        input = e
        $.ui.log(`agent-router: steer: ${String(err)}`)
      }
    }
    const done = await next(input)
    if (config.mode !== 'off' && isPlain && done.agentId) {
      const atMs = await $.clock.now()
      const category = last?.route.category.id ?? ''
      spawned.set(done.agentId, { atMs, category })
      await log($, {
        atMs,
        event: 'spawn',
        agentId: done.agentId,
        category,
        suggested: last?.route.pick?.agent,
        agent: input.subagentType,
        model: done.model,
        isSteered: input !== e,
      }).catch(() => undefined)
    }

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const run = e.agentId ? spawned.get(e.agentId) : undefined
    if (run && e.agentId) {
      spawned.delete(e.agentId)
      await log($, { atMs: await $.clock.now(), event: 'done', agentId: e.agentId, category: run.category, ms: (await $.clock.now()) - run.atMs })
    }

    return done
  })

  on('command.run', { command: 'route' }, async $ => {
    await loadConfig($)
    await findAgents($)
    await writeState($)

    return { text: await report($) }
  })
}
