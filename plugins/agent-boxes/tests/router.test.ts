import { expect, test } from 'claude-code/testing'

import { EXECUTORS } from '../hooks/catalog'
import { DEFAULTS, categoryById, classify, contextNote, policy, poolState, readConfig, roster, route, sizeOf } from '../hooks/route'
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

test('a Claude pick with room stays in the loop; an outside pick is delegated', () => {
  const quota: Quota = { claude: { '5h': { used: 20 }, '7d': { used: 30 } }, codex: { '7d': { used: 30 } } }
  const own = route(categoryById('shader'), 'medium', quota, NOW, all)
  expect(own.pick?.pool).toBe('claude')
  expect(contextNote(own, quota, NOW)).toMatch(/do it in this loop/)
  const low: Quota = { ...quota, claude: { '5h': { used: 92 }, '7d': { used: 40 } } }
  const out = route(categoryById('shader'), 'medium', low, NOW, all)
  expect(out.pick?.pool).not.toBe('claude')
  expect(contextNote(out, low, NOW)).not.toMatch(/do it in this loop/)
  expect(contextNote(out, low, NOW)).toMatch(/delegate substantive work/)
})

test('the policy delegates outside quota and keeps Claude work in the loop', () => {
  const text = policy(all)
  expect(text).toMatch(/Codex or agy, delegate substantive work/)
  expect(text).toMatch(/runs on Claude and Claude has room, do the work in this loop/)
  expect(text).toMatch(/Full output|full output file/)
})
