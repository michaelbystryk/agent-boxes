import { expect, test } from 'claude-code/testing'

import { EXECUTORS } from '../hooks/catalog'
import {
  DEFAULTS,
  categoryById,
  classify,
  contextNote,
  outcomeOf,
  placement,
  policy,
  poolState,
  readConfig,
  roster,
  route,
  sizeOf,
} from '../hooks/route'
import type { Loop, Quota, Size } from '../hooks/route'

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

const ROOM: Quota = {
  claude: { '5h': { used: 20 }, '7d': { used: 30 } },
  codex: { '7d': { used: 30 } },
  agy: { '7d': { used: 30 } },
  'agy-claude': { '7d': { used: 0 } },
}
const OPUS = { model: 'claude-opus-5-5', context: 20 }
const placed = (category: string, size: Size, quota: Quota, loop: Loop, config = DEFAULTS) => {
  const r = route(categoryById(category), size, quota, NOW, all, config)
  return { r, place: placement(r, quota, loop, config) }
}

test('a Claude pick on this chat\'s own model stays in the loop, with one instruction', () => {
  const { r, place } = placed('shader', 'medium', ROOM, OPUS)
  expect(r.pick?.id).toBe('opus')
  expect(place.inLoop).toBe(true)
  const note = contextNote(r, ROOM, NOW, place)
  expect(note).toMatch(/Do it in this loop/)
  expect(note).not.toMatch(/Suggested executor/)
})

test('a stronger or cheaper Claude pick than this chat is delegated', () => {
  expect(placed('shader', 'medium', ROOM, { model: 'claude-sonnet-5-5', context: 20 }).place).toMatchObject({
    inLoop: false,
    reason: expect.stringMatching(/stronger/),
  })
  const lookup = placed('lookup', 'small', ROOM, OPUS)
  expect(lookup.r.pick?.id).toBe('haiku')
  expect(lookup.place).toMatchObject({ inLoop: false, reason: expect.stringMatching(/cheaper/) })
})

test('reviews always go to a reviewer, and "review this shader" is a review', () => {
  expect(classify('review this shader for precision bugs')?.id).toBe('review')
  expect(classify('review the render of the tower')?.id).toBe('art')
  const { r, place } = placed('review', 'medium', ROOM, OPUS)
  expect(r.pick?.pool).toBe('claude')
  expect(place.inLoop).toBe(false)
  const note = contextNote(r, ROOM, NOW, place)
  expect(note).toMatch(/Suggested executor/)
  expect(note).toMatch(/Delegate it: a review/)
  expect(note).not.toMatch(/Do it in this loop/)
})

test('unknown quota, unknown model, a full context or inLoop off all delegate', () => {
  const bare: Quota = { codex: { '7d': { used: 30 } } }
  expect(placed('shader', 'medium', bare, OPUS).place.reason).toMatch(/quota is unknown/)
  expect(placed('shader', 'medium', ROOM, {}).place.reason).toMatch(/model is unknown/)
  expect(placed('shader', 'medium', ROOM, { ...OPUS, context: 70 }).place.reason).toMatch(/70% full/)
  expect(placed('shader', 'large', ROOM, { ...OPUS, context: 45 }).place.inLoop).toBe(false)
  expect(placed('shader', 'medium', ROOM, { ...OPUS, context: 45 }).place.inLoop).toBe(true)
  expect(placed('shader', 'medium', ROOM, OPUS, readConfig({ inLoop: false })).place.reason).toMatch(/inLoop is off/)
})

test('an outside pick is delegated even with Claude healthy', () => {
  const { r, place } = placed('shader', 'medium', ROOM, OPUS, readConfig({ order: { shader: ['sol', 'opus'] } }))
  expect(r.pick?.id).toBe('sol')
  expect(place).toMatchObject({ inLoop: false, reason: expect.stringMatching(/outside Claude/) })
  expect(contextNote(r, ROOM, NOW, place)).toMatch(/Suggested executor: GPT-6.1 Sol/)
})

test('Claude past 85% of its 5h: Opus on agy, delegated', () => {
  const low: Quota = { ...ROOM, claude: { '5h': { used: 86 }, '7d': { used: 40 } } }
  const { r, place } = placed('shader', 'medium', low, OPUS)
  expect(r.pick?.id).toBe('opus-agy')
  expect(r.pick?.pool).toBe('agy-claude')
  expect(place.inLoop).toBe(false)
  expect(contextNote(r, low, NOW, place)).toMatch(/near its limit: delegate substantive work/)
})

test('with every pool out the note says not to delegate', () => {
  const out: Quota = {
    claude: { '5h': { used: 99 } },
    codex: { '5h': { used: 99 } },
    agy: { '5h': { used: 99 } },
    'agy-claude': { '5h': { used: 99 } },
  }
  const { r, place } = placed('shader', 'medium', out, OPUS)
  expect(r.pick).toBeUndefined()
  expect(place.inLoop).toBe(false)
  expect(contextNote(r, out, NOW, place)).toMatch(/Don't delegate/)
})

test('a follow-up leans toward the last executor, except for reviews', () => {
  const score = (category: string, prev?: string) =>
    route(categoryById(category), 'medium', ROOM, NOW, all, DEFAULTS, prev).scored.find(s => s.executor.id === 'sonnet')!.score
  expect(Math.abs(score('bugfix', 'sonnet') / score('bugfix') - 1.15)).toBeLessThan(1e-9)
  const review = (prev?: string) =>
    route(categoryById('review'), 'medium', ROOM, NOW, all, DEFAULTS, prev).scored.find(s => s.executor.id === 'sol')!.score
  expect(review('sol')).toBe(review())
})

test('the next reply grades the last result', () => {
  expect(outcomeOf("that's still broken")).toBe('rework')
  expect(outcomeOf('revert it')).toBe('rework')
  expect(outcomeOf('perfect, push it')).toBe('accept')
  expect(outcomeOf('now add a settings page')).toBe('unknown')
})

test('the policy gives one instruction per note and bounded output reading', () => {
  const text = policy(all)
  expect(text).toMatch(/Work for Codex or agy is delegated/)
  expect(text).toMatch(/stays in this loop when the note says so/)
  expect(text).toMatch(/git diff/)
  expect(text).toMatch(/keep the work small and tell the user/)
})
