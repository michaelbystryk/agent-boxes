import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { EXECUTORS } from '../hooks/catalog'
import { DEFAULTS, categoryById, classify, poolState, readConfig, roster, route, sizeOf } from '../hooks/route'
import type { Quota } from '../hooks/route'

const NOW = Date.UTC(2026, 9, 18, 12)
const DAY = 24 * 3600e3
const all = roster(DEFAULTS)
const ids = (r: ReturnType<typeof route>) => r.scored.map(s => s.executor.id)

test('keywords sort prompts into categories', () => {
  expect(classify('write a bpy script that bevels the tower mesh')?.id).toBe('blender')
  expect(classify('the water shader in URP is too dark')?.id).toBe('shader')
  expect(classify('fix the player controller in Unity, it crashes on jump')?.id).toBe('gamedev')
  expect(classify('where is the brief file?')?.id).toBe('lookup')
  expect(classify('review the diff I just made to the parser and check my error handling')?.id).toBe('review')
  expect(classify('yes')).toBeUndefined()
})

test('size from length and scope words', () => {
  expect(sizeOf('fix it')).toBe('small')
  expect(sizeOf('write a HLSL shader for the water edge glow')).toBe('medium')
  expect(sizeOf('rebuild the whole tower set from scratch')).toBe('large')
  expect(sizeOf(Array(30).fill('word').join(' '))).toBe('medium')
})

test('Fable stays out unless enabled', () => {
  expect(all.some(x => x.id === 'fable')).toBe(false)
  expect(roster(readConfig({ enabled: ['fable'] })).some(x => x.id === 'fable')).toBe(true)
  expect(roster(readConfig({ disabled: ['argon'] })).some(x => x.id === 'argon')).toBe(false)
})

test('missing agent definitions drop their executors', () => {
  expect(roster(DEFAULTS, a => a !== 'agy-argon').some(x => x.id === 'argon')).toBe(false)
})

test('with room everywhere the best fit wins', () => {
  const quota: Quota = { claude: { '5h': { used: 20 }, '7d': { used: 30 } }, codex: { '7d': { used: 30 } } }
  const r = route(categoryById('shader'), 'medium', quota, NOW, all)
  expect(r.pick?.id).toBe('opus')
  expect(r.why).toMatch(/best fit/)
})

test('Claude near its 5h limit: never a Claude executor, Opus moves to agy', () => {
  const quota: Quota = {
    claude: { '5h': { used: 92 }, '7d': { used: 40 } },
    codex: { '7d': { used: 30 } },
    'agy-claude': { '7d': { used: 0 } },
  }
  const r = route(categoryById('shader'), 'medium', quota, NOW, all)
  expect(r.pick?.pool).not.toBe('claude')
  expect(ids(r)).toContain('opus-agy')
  expect(r.isClaudeLow).toBe(true)
  // without agy's Claude group the first Claude places are out, and Sol takes it
  const bare = route(categoryById('shader'), 'medium', quota, NOW, all.filter(x => x.id !== 'opus-agy'))
  expect(bare.pick?.id).toBe('sol')
  expect(bare.why).toMatch(/Opus 5.5 out: Claude 5h 92%/)
})

test('use it or lose it: a week resetting soon with most unused gets a bonus', () => {
  const soon = poolState('codex', { '7d': { used: 20, resetsAtMs: NOW + DAY } }, NOW)
  expect(soon.bonus).toBeGreaterThan(0.2)
  const ahead = poolState('codex', { '7d': { used: 80, resetsAtMs: NOW + 6 * DAY } }, NOW)
  expect(ahead.bonus).toBeLessThan(0)
  // gamedev: Opus first, Sol a close second; Codex's unused week tips it
  const quota: Quota = {
    claude: { '5h': { used: 60 }, '7d': { used: 70, resetsAtMs: NOW + 5 * DAY } },
    codex: { '7d': { used: 20, resetsAtMs: NOW + DAY } },
  }
  expect(route(categoryById('gamedev'), 'large', quota, NOW, all).pick?.id).toBe('sol')
})

test('the user can reorder a category', () => {
  const config = readConfig({ order: { blender: ['argon', 'astra'] } })
  expect(route(categoryById('blender'), 'medium', {}, NOW, all, config).pick?.id).toBe('argon')
})

test('every catalog rank names an executor', () => {
  const known = new Set(EXECUTORS.map(x => x.id))
  for (const id of ['lookup', 'blender', 'shader', 'gamedev', 'art', 'review', 'bugfix', 'frontend', 'terminal', 'design', 'research', 'refactor', 'build', 'general']) {
    for (const x of categoryById(id).ranked) expect(known.has(x)).toBe(true)
  }
})

type World = { writes: Map<string, string>; toasts: string[]; completes: () => number }

async function start($: Engine, on: On, config?: object, scan?: object, hasAgentFiles = true): Promise<World> {
  const writes = new Map<string, string>()
  const toasts: string[] = []
  let completes = 0
  const configPath = '/home/u/.claude/agent-router/config.json'
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 1000, percent: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 93 },
        { kind: 'seven_day', percentUsed: 40 },
      ],
    },
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  const quotaPath = '/home/u/.claude/agent-boxes/quota.json'
  const at = (path: string, end: string) => path.replace(/\\/g, '/').endsWith(end)
  on('fs.exists', (_$, e) => ({
    value: (hasAgentFiles && /agents[\\/]/.test(e.path)) || (config !== undefined && at(e.path, configPath)) || (scan !== undefined && at(e.path, quotaPath)),
  }))
  on('fs.read', (_$, e) => ({ value: JSON.stringify(at(e.path, quotaPath) ? { ...scan, atMs: NOW } : config ?? {}) }))
  on('fs.write', (_$, e) => {
    writes.set(e.path.replace(/\\/g, '/'), e.text)
    return { value: undefined }
  })
  on('model.complete', () => {
    completes++
    return { value: { isAnswered: true, text: 'design', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('prompt.compose', () => ({ sections: [] }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'ag-1' }))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  return { writes, toasts, completes: () => completes }
}

const SCAN = {
  codex: { '7d': { used: 18 } },
  agy: { gemini: { '7d': { used: 2 } }, 'claude/gpt': { '7d': { used: 0 } } },
}

test('a user prompt gets a hidden route note and the side bar file', async ($, on) => {
  const { writes } = await start($, on, undefined, SCAN)
  const got = await $.prompt.submit({ text: 'write a HLSL shader for the water edge glow', wait: false, origin: { kind: 'composer' } })
  if ('drop' in got) throw new Error('dropped')
  const note = got.context?.join('\n') ?? ''
  expect(note).toMatch(/\[agent-router\].*shaders/)
  // Claude's 5h is at 93%: Opus moves to agy's Claude group
  expect(note).toMatch(/Opus 5.5 via agy/)
  expect(note).toMatch(/Claude is near its limit/)
  const file = [...writes].find(([path]) => path.endsWith('/home/u/.claude/agent-router/route-sess-1.json'))?.[1]
  expect(file && JSON.parse(file).pick).toBe('Opus 5.5 via agy')
})

test('without agent files it routes to its own relays and general-purpose', async ($, on) => {
  await start($, on, undefined, SCAN, false)
  const got = await $.prompt.submit({ text: 'write a HLSL shader for the water edge glow', wait: false, origin: { kind: 'composer' } })
  if ('drop' in got) throw new Error('dropped')
  const note = got.context?.join('\n') ?? ''
  expect(note).toMatch(/subagent_type "agent-router:agy-opus"/)
  const compose = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Agent', 'Bash'],
    outputStyle: null,
    traits: [],
  })
  const text = compose.sections.map(x => x.text).join('\n')
  expect(text).toMatch(/Sonnet 5.5: subagent_type "general-purpose", model "sonnet"/)
  expect(text).toMatch(/subagent_type "agent-router:codex-builder"/)
})

test('a short reply gets no note and no model call', async ($, on) => {
  const w = await start($, on, undefined, SCAN)
  const got = await $.prompt.submit({ text: 'yes go on', wait: false, origin: { kind: 'composer' } })
  if ('drop' in got) throw new Error('dropped')
  expect(got.context).toBeUndefined()
  expect(w.completes()).toBe(0)
})

test('mode off leaves prompts alone', async ($, on) => {
  await start($, on, { mode: 'off' }, SCAN)
  const got = await $.prompt.submit({ text: 'write a HLSL shader for the water edge glow', wait: false, origin: { kind: 'composer' } })
  if ('drop' in got) throw new Error('dropped')
  expect(got.context).toBeUndefined()
})

test('steer mode moves a Claude spawn off Claude when it is out', async ($, on) => {
  const { toasts } = await start($, on, { mode: 'steer' }, SCAN)
  await $.prompt.submit({ text: 'write a HLSL shader for the water edge glow', wait: false, origin: { kind: 'composer' } })
  const spawned = await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'write the shader',
    description: 'shader',
    subagentType: 'worker',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  expect(spawned.agentId).toBe('ag-1')
  expect(toasts[0]).toMatch(/worker → agy-opus/)
})

test('advise mode never rewrites a spawn', async ($, on) => {
  const { toasts } = await start($, on, undefined, SCAN)
  await $.prompt.submit({ text: 'write a HLSL shader for the water edge glow', wait: false, origin: { kind: 'composer' } })
  const spawned = await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'write the shader',
    description: 'shader',
    subagentType: 'worker',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  expect(spawned.model).toBe('claude-sonnet-5-5')
  expect(toasts).toEqual([])
})
