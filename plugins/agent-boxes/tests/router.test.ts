import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { EXECUTORS } from '../hooks/catalog'
import {
  DEFAULTS,
  categoryById,
  classify,
  contextNote,
  firstJson,
  leadLine,
  isContinuation,
  namedIn,
  outcomeOf,
  placement,
  policy,
  poolState,
  readConfig,
  roster,
  route,
  sizeOf,
  ownWords,
} from '../hooks/route'
import type { Loop, Quota, Size } from '../hooks/route'
import { bookQuota, isRateLimited, markLimited, newBook, takeScan } from '../hooks/router'

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

test('a bare "error" or "fails" is not a bug fix; fixing one is', () => {
  expect(classify('what does this error mean in the output')?.id).not.toBe('bugfix')
  expect(classify('it fails sometimes, why')?.id).not.toBe('bugfix')
  expect(classify('fix the error in the parser')?.id).toBe('bugfix')
  expect(classify('debug why the upload fails')?.id).toBe('bugfix')
  expect(classify('the login page is broken')?.id).not.toBe(undefined)
})

test('replies that carry on the task are continuations', () => {
  for (const t of ['yes', 'ok, and the tests', 'okay fix the error too', 'now push it', 'also the shader', 'then review it', 'and the docs', 'go', 'do it', 'plz', 'sure, refactor it']) {
    expect(isContinuation(t)).toBe(true)
  }
  for (const t of ['write a HLSL shader', 'nowhere to put it', 'android build', 'review the diff']) expect(isContinuation(t)).toBe(false)
})

test('the first balanced JSON object is taken, not a greedy span', () => {
  expect(firstJson('Sure: {"category": "bugfix"} and {"x": 1}')).toEqual({ category: 'bugfix' })
  expect(firstJson('{"a": "}{"} trailing }')).toEqual({ a: '}{' })
  expect(firstJson('{not json} {"b": {"c": 2}}')).toEqual({ b: { c: 2 } })
  expect(firstJson('bugfix')).toBeUndefined()
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

test("a Claude pick on this chat's own model stays in the loop, with no note at all", () => {
  const { r, place } = placed('shader', 'medium', ROOM, OPUS)
  expect(r.pick?.id).toBe('opus')
  expect(place.inLoop).toBe(true)
  expect(contextNote(r, ROOM, NOW, place)).toBeUndefined()
})

test("a pick that is the user's own agent definition goes to that agent, unless inLoop is 'all'", () => {
  const mine = all.map(x => (x.id === 'opus' ? { ...x, isCustom: true } : x))
  const r = route(categoryById('shader'), 'medium', ROOM, NOW, mine, DEFAULTS)
  expect(r.pick?.id).toBe('opus')
  expect(placement(r, ROOM, OPUS, DEFAULTS)).toMatchObject({
    inLoop: false,
    reason: expect.stringMatching(/your own architect definition/),
  })
  expect(placement(r, ROOM, OPUS, { ...DEFAULTS, inLoop: 'all' }).inLoop).toBe(true)
  expect(readConfig({ inLoop: 'all' }).inLoop).toBe('all')
  expect(readConfig({ inLoop: false }).inLoop).toBe(false)
  expect(readConfig({}).inLoop).toBe(true)
})

test('a model the user names wins the note; plain words name nothing', () => {
  const ids = (text: string) => namedIn(text, all).map(x => x.id)
  expect(ids('Use architect on Opus for this, even if Claude quota is low')).toEqual(['opus'])
  expect(ids('give it to GPT-6 Astra')).toEqual(['astra'])
  expect(ids('run it on sol')).toEqual(['sol'])
  expect(ids('add a muzzle flash and a worker thread to the opus magnum scene')).toEqual([])
  const { r, place } = placed('shader', 'medium', ROOM, OPUS)
  const note = contextNote(r, ROOM, NOW, place, namedIn('use sonnet', all))
  expect(note).toMatch(/You named Sonnet 5\.5/)
  expect(note).not.toMatch(/Do it in this loop|Suggested executor/)
})

test('a stronger or cheaper Claude pick than this chat is delegated', () => {
  expect(placed('shader', 'medium', ROOM, { model: 'claude-sonnet-5-5', context: 20 }).place).toMatchObject({
    inLoop: false,
    reason: expect.stringMatching(/stronger/),
  })
  const lookup = placed('lookup', 'medium', ROOM, OPUS)
  expect(lookup.r.pick?.id).toBe('haiku')
  expect(lookup.place).toMatchObject({ inLoop: false, reason: expect.stringMatching(/cheaper/) })
})

test('a small task or short lookup stays in the loop whatever pool is picked', () => {
  const lookup = placed('lookup', 'small', ROOM, OPUS)
  expect(lookup.r.pick?.id).toBe('haiku')
  expect(lookup.place).toMatchObject({ inLoop: true, reason: expect.stringMatching(/small task/) })
  expect(contextNote(lookup.r, ROOM, NOW, lookup.place)).toBeUndefined()
  const outside = placed('bugfix', 'small', ROOM, OPUS)
  expect(outside.r.pick?.id).toBe('argon')
  expect(outside.place.inLoop).toBe(true)
  // a large one with the same pick still goes out
  expect(placed('bugfix', 'large', ROOM, OPUS).place.inLoop).toBe(false)
  // Claude short: a small task still stays, with a one-line reminder
  const low: Quota = { ...ROOM, claude: { '5h': { used: 90 } } }
  const lowSmall = placed('bugfix', 'small', low, OPUS)
  expect(lowSmall.place.inLoop).toBe(true)
  expect(contextNote(lowSmall.r, low, NOW, lowSmall.place)).toBe('[router] Claude is near its limit: keep your own turns short.')
})

test('reviews always go to a reviewer, and "review this shader" is a review', () => {
  expect(classify('review this shader for precision bugs')?.id).toBe('review')
  expect(classify('review this shader for texture sampling bugs')?.id).toBe('review')
  expect(classify('review the render of the tower')?.id).toBe('art')
  const { r, place } = placed('review', 'medium', ROOM, OPUS)
  expect(r.pick?.pool).toBe('claude')
  expect(place.inLoop).toBe(false)
  const note = contextNote(r, ROOM, NOW, place)
  expect(note).toBe('[router] → architect model=opus (fallback codex-builder): review; a review needs a reviewer that did not build the work')
  expect(note).not.toMatch(/\n/)
})

test("Claude's unknown quota counts as not low; an unknown model, a full context or inLoop off delegate", () => {
  const bare: Quota = { codex: { '7d': { used: 30 } } }
  const unknown = placed('shader', 'medium', bare, OPUS)
  expect(unknown.r.isClaudeLow).toBe(false)
  expect(unknown.place.inLoop).toBe(true)
  expect(contextNote(unknown.r, bare, NOW, unknown.place)).toBeUndefined()
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
  // fit decided it, not quota: no quota in the note
  expect(contextNote(r, ROOM, NOW, place)).toBe('[router] → codex-builder (fallback architect model=opus): shader; best fit')
})

test('unknown Codex or agy quota scores below a known healthy pool', () => {
  expect(poolState('codex', undefined, NOW)).toMatchObject({ isKnown: false, isOut: false })
  // bugfix ranks Argon first; with agy unknown and Claude known healthy, Sonnet takes it
  const q: Quota = { claude: { '5h': { used: 30 }, '7d': { used: 30 } } }
  for (const size of ['medium', 'large'] as const) {
    expect(route(categoryById('bugfix'), size, q, NOW, all).pick?.id).toBe('sonnet')
  }
  // known and healthy, Argon keeps its first place
  expect(route(categoryById('bugfix'), 'medium', ROOM, NOW, all).pick?.id).toBe('argon')
})

test('a rate-limited pool is out, and the quota line says so', () => {
  const q: Quota = { ...ROOM, agy: { '7d': { used: 10 }, rateLimited: true } }
  const r = route(categoryById('bugfix'), 'medium', q, NOW, all)
  expect(r.scored.find(s => s.executor.id === 'argon')?.out).toBe('agy rate-limited')
  expect(r.pick?.id).toBe('sonnet')
  expect(r.isQuotaPick).toBe(true)
  expect(contextNote(r, q, NOW, placement(r, q, OPUS))).toMatch(/Gemini 4 Argon out: agy rate-limited;.*\[.*agy 7d 10% rate-limited/)
})

test('Claude past 85% of its 5h: Opus on agy, delegated', () => {
  const low: Quota = { ...ROOM, claude: { '5h': { used: 86 }, '7d': { used: 40 } } }
  const { r, place } = placed('shader', 'medium', low, OPUS)
  expect(r.pick?.id).toBe('opus-agy')
  expect(r.pick?.pool).toBe('agy-claude')
  // Opus and Sonnet stay candidates, marked out, with Opus via agy at Opus's rank
  expect(r.scored.find(s => s.executor.id === 'opus')?.out).toMatch(/Claude 5h 86%/)
  expect(r.scored.find(s => s.executor.id === 'sonnet')?.out).toMatch(/Claude 5h 86%/)
  expect(r.scored.find(s => s.executor.id === 'opus-agy')?.rank).toBe(0)
  expect(place.inLoop).toBe(false)
  // quota decided the pick, so the note carries it, on one line
  expect(contextNote(r, low, NOW, place)).toBe(
    '[router] → agy-opus (fallback codex-builder): shader; Opus 5.5 out: Claude 5h 86% [Claude 5h 86% 7d 40% · Codex 7d 30% · agy 7d 30% · agy Claude 7d 0%]',
  )
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
  expect(text).toMatch(/No \[router\] note: do the work in this loop/)
  expect(text).toMatch(/Result: rate-limited` hit its quota: move to the fallback at once/)
  expect(text).toMatch(/other failure, retry once, then move to the fallback/)
  expect(text).not.toMatch(/rate-limited twice/)
  expect(text).toMatch(/git diff/)
  expect(text).toMatch(/keep the work small and tell the user/)
})

// The scan's bookkeeping, alone: stale boxes, unknown pools, rate-limit cooldowns.
const box = (windows?: object, stale?: string) => ({ installed: true, limits: [], agents: [], windows, stale })
const scanOf = (codex: number, stale?: string) => ({ codex: box({ '7d': { used: codex } }, stale), agy: box(undefined) }) as never

test('a stale box keeps its last good reading about 10 minutes, then the pool is unknown', () => {
  const book = newBook()
  takeScan(book, scanOf(20), 0)
  expect(bookQuota(book, 0).codex).toEqual({ '7d': { used: 20 } })
  // the failed scan's numbers are not taken; the last good one stands a while
  takeScan(book, scanOf(99, 'scan timed out'), 5 * 60e3)
  expect(bookQuota(book, 9 * 60e3).codex).toEqual({ '7d': { used: 20 } })
  expect(bookQuota(book, 11 * 60e3).codex).toBeUndefined()
  // a fresh scan replaces it
  takeScan(book, scanOf(40), 12 * 60e3)
  expect(bookQuota(book, 12 * 60e3).codex).toEqual({ '7d': { used: 40 } })
  // a tool that is not installed drops its reading
  takeScan(book, { codex: { installed: false, limits: [], agents: [] }, agy: box() } as never, 13 * 60e3)
  expect(bookQuota(book, 13 * 60e3).codex).toBeUndefined()
})

test('a relay that ends "Result: rate-limited" puts its pool out until the cooldown or a later scan with room', () => {
  expect(isRateLimited('Argon hit its quota (429).\nResult: rate-limited\n')).toBe(true)
  expect(isRateLimited('Result: rate-limited, then retried')).toBe(false)
  expect(isRateLimited('Done.\nResult: out.md, err.txt')).toBe(false)
  const book = newBook()
  takeScan(book, scanOf(20), 0)
  markLimited(book, 'codex', 0)
  expect(bookQuota(book, 60e3).codex?.rateLimited).toBe(true)
  // a scan right after, or one repeating the old reading, may not see the limit: no clear
  takeScan(book, scanOf(21), 2 * 60e3)
  takeScan(book, scanOf(20), 7 * 60e3)
  expect(bookQuota(book, 7 * 60e3).codex?.rateLimited).toBe(true)
  const r = route(categoryById('build'), 'medium', { ...ROOM, ...bookQuota(book, 2 * 60e3) }, NOW, all)
  expect(r.pick?.id).not.toBe('sol')
  expect(r.why).toMatch(/GPT-6.1 Sol out: Codex rate-limited/)
  // a new reading 5 minutes on with room does
  takeScan(book, scanOf(25), 8 * 60e3)
  expect(bookQuota(book, 8 * 60e3).codex?.rateLimited).toBeUndefined()
  // and without one, the cooldown ends at 30 minutes
  markLimited(book, 'codex', 0)
  takeScan(book, scanOf(95), 6 * 60e3)
  expect(bookQuota(book, 29 * 60e3).codex?.rateLimited).toBe(true)
  expect(bookQuota(book, 31 * 60e3).codex?.rateLimited).toBeUndefined()
})

// The plugin itself, over a stand-in engine: the prompt note, steer, and a relay's end.
type Boot = { usage?: [number, number] | null; config?: object; files?: string[]; messages?: SessionMessage[]; scan?: object }
// Flip `failing.is` to make the bundled scan fail from then on (its boxes go stale).
const failing = { is: false }
const QSCAN = {
  codex: { installed: true, limits: [], agents: [], windows: { '7d': { used: 30 } } },
  agy: { installed: true, limits: [], agents: [], groups: { gemini: { '7d': { used: 5 } }, 'claude/gpt': { '7d': { used: 0 } } } },
}

async function boot($: Engine, on: On, opts: Boot = {}) {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const logs: string[] = []
  let completes = 0
  const writes = new Map<string, string>()
  const usage = opts.usage === undefined ? [20, 30] : opts.usage
  const unix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const config = '/home/u/.claude/agent-boxes/config.json'
  const folders = ['/home/u/.codex', '/home/u/.gemini/antigravity-cli']
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 20000, percent: 10 },
      rateLimits: usage
        ? [
            { kind: 'five_hour', percentUsed: usage[0] },
            { kind: 'seven_day', percentUsed: usage[1] },
          ]
        : [],
    },
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_$, e) => {
    const p = unix(e.path)
    return { value: writes.has(p) || folders.includes(p) || (opts.config !== undefined && p === config) || (opts.files ?? []).some(f => p.endsWith(f) && !p.startsWith('/home/u/.claude/')) }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => ({ value: unix(e.path) === config ? JSON.stringify(opts.config) : writes.get(unix(e.path)) ?? '' }))
  on('fs.write', (_$, e) => {
    writes.set(unix(e.path), e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('model.complete', e => {
    completes++
    return {
      value: {
        isAnswered: true,
        text: 'Category: {"category": "bugfix"} {"x": 1}',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  failing.is = false
  on('process.run', (_$, e) => {
    const isScan = e.argv.some(x => /boxes\.py$/.test(x))
    if (isScan && failing.is) throw new Error('process timed out after 20000 ms')
    return {
      value: {
        exitCode: 0,
        stdout: isScan ? JSON.stringify(opts.scan ?? QSCAN) : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'narrow' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('prompt.compose', () => ({ sections: [] }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'ag-1' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const history = () =>
    (writes.get('/home/u/.claude/agent-boxes/router-history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  const say = async (text: string) => {
    const got = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
    if ('drop' in got) throw new Error('dropped')
    return got.context?.join('\n') ?? ''
  }
  const spawn = (subagentType: string, model?: string) =>
    $.agent.spawn({
      tool_use_id: 't1',
      prompt: 'p',
      description: 'd',
      subagentType,
      model,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
  const end = (agentId: string, answer: string) =>
    $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer', agentId })
  return { clock, toasts, logs, history, completes: () => completes, say, spawn, end }
}

const BUG = 'the crash in the uploader when two files share a name needs a proper fix with a regression test'
const SHADER_ASK = 'write a HLSL shader for the water edge glow'

test('a reply within the follow-up window that starts with ok/now/and continues the task, keywords or not', async ($, on) => {
  const w = await boot($, on)
  expect(await w.say(BUG)).toMatch(/^\[router\] → agent-boxes:agy-argon/)
  // a continuation keeps the task's placement, so the off-Claude pick is repeated, not re-routed
  expect(await w.say('ok, and fix the error in the tests too')).toMatch(/^\[router\] → agent-boxes:agy-argon/)
  expect(await w.say('now refactor the uploader across the repo')).toMatch(/^\[router\] → agent-boxes:agy-argon/)
  expect(w.history().filter(x => x.event === 'route')).toHaveLength(1)
  // after the window, the same words route anew
  await w.clock.advance(16 * 60e3)
  await w.say('now refactor the uploader across the repo')
  expect(w.history().filter(x => x.event === 'route')).toHaveLength(2)
})

test('the classifier runs only for long prompts with no keyword, and its JSON reply is read', async ($, on) => {
  const w = await boot($, on)
  const before = w.completes()
  await w.say('tidy up the thing we talked about earlier please')
  expect(w.completes()).toBe(before)
  await w.say('so the uploader thing from yesterday is acting up again whenever two people send stuff at the same moment, sort it')
  expect(w.completes()).toBe(before + 1)
  expect(w.history().filter(x => x.event === 'route').at(-1)).toMatchObject({ category: 'bugfix' })
})

test('unknown Claude quota never delegates on its own', async ($, on) => {
  const w = await boot($, on, { usage: null })
  expect(await w.say(SHADER_ASK)).toBe('')
  expect(w.history().at(-1)).toMatchObject({ event: 'route', inLoop: true })
})

test('steer: a general-purpose spawn with no model, or a model no executor has, is left alone', async ($, on) => {
  const w = await boot($, on, { usage: [93, 40], config: { router: { mode: 'steer' } } })
  await w.say(SHADER_ASK)
  expect((await w.spawn('general-purpose')).model).toBe('claude-sonnet-5-5')
  await w.spawn('general-purpose', 'claude-mystery-1')
  expect(w.toasts.filter(t => /→/.test(t))).toEqual([])
  // Opus asked by its model id: Claude is out, so it moves to Opus via agy
  await w.spawn('general-purpose', 'claude-opus-5-5')
  expect(w.toasts.filter(t => /→/.test(t))).toEqual([expect.stringMatching(/general-purpose → agent-boxes:agy-opus/)])
})

test("a relay's rate-limited report sends the next prompt to the fallback", async ($, on) => {
  // register.tsx hands agentDone no answer yet: the router reads the relay's last reply
  const w = await boot($, on, { messages: [{ role: 'assistant', text: 'Argon hit its quota (429).\nResult: rate-limited', toolUses: [] }] })
  expect(await w.say(BUG)).toMatch(/→ agent-boxes:agy-argon/)
  await w.spawn('agent-boxes:agy-argon')
  await w.end('ag-1', 'Argon hit its quota (429).\nResult: rate-limited')
  expect(w.history().find(x => x.event === 'done')).toMatchObject({ rateLimited: 'agy' })
  await w.clock.advance(16 * 60e3)
  const next = await w.say(BUG)
  expect(next).toMatch(/Gemini 4 Argon out: agy rate-limited/)
  expect(next).not.toMatch(/→ agent-boxes:agy-argon/)
})

test('project agent definitions are trusted only with projectAgents', async ($, on) => {
  const w = await boot($, on, { usage: [93, 40], files: ['.claude/agents/agy-opus.md'] })
  expect(await w.say(SHADER_ASK)).toMatch(/→ agent-boxes:agy-opus/)
})

test('project agents opt in', async ($, on) => {
  const w = await boot($, on, { usage: [93, 40], files: ['.claude/agents/agy-opus.md'], config: { router: { projectAgents: true } } })
  expect(await w.say(SHADER_ASK)).toMatch(/→ agy-opus /)
})

test('a box with null windows is unknown: no reading, no lead, and it never clears a rate limit', () => {
  const book = newBook()
  takeScan(book, scanOf(20), 0)
  markLimited(book, 'codex', 0)
  const empty = { codex: box({ '5h': null, '7d': null }), agy: box({ '5h': { used: null }, '7d': null }) } as never
  takeScan(book, empty, 6 * 60e3)
  const q = bookQuota(book, 6 * 60e3)
  expect(q.agy).toBeUndefined()
  expect(q.codex).toEqual({ rateLimited: true })
  expect(leadLine({ codex: { '5h': null, '7d': null } }, NOW, all)).toBe(`quota unknown · ${all.length} ready`)
  expect(leadLine({ codex: { '7d': { used: 40 } }, agy: { '7d': { used: null } } }, NOW, all)).toMatch(/^Codex best placed · 60% free/)
})

test('steer redirects a spawn whose pool is out even when the category does not rank it', async ($, on) => {
  const out = { ...QSCAN, codex: { ...QSCAN.codex, windows: { '5h': { used: 99 }, '7d': { used: 40 } } } }
  const w = await boot($, on, { scan: out, config: { router: { mode: 'steer' } } })
  await w.say(SHADER_ASK)
  await w.spawn('agent-boxes:codex-astra')
  expect(w.toasts.filter(t => /→/.test(t))).toEqual([expect.stringMatching(/agent-boxes:codex-astra → general-purpose/)])
})

test('a short reply that names an executor gets the "You named" note and continues the task', async ($, on) => {
  const w = await boot($, on)
  await w.say(BUG)
  expect(await w.say('use sol')).toBe('[router] You named GPT-6.1 Sol: use that.')
  expect(await w.say('ok, on opus')).toBe('[router] You named Opus 5.5: use that.')
  expect(w.history().filter(x => x.event === 'route')).toHaveLength(1)
})

test('the best-placed line drops readings that expire while scans keep failing', async ($, on) => {
  const w = await boot($, on)
  const pane = { plugin: 'agent-boxes', component: 'Pane', requestId: 'agent-boxes', surface: 'terminal', props: { title: 'Agents', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
  const lead = async () => {
    const ui = await $.ui.mount(pane)
    const found = await ui.find({ type: 'Text', text: /best placed|quota unknown/ })
    await ui.unmount()
    return found
  }
  expect(await lead()).toMatchObject({ text: expect.stringMatching(/^agy Claude best placed · 100% free/) })
  failing.is = true
  await w.clock.advance(20 * 60e3)
  expect(await lead()).toMatchObject({ text: expect.stringMatching(/^Claude best placed · 70% free/) })
})

test('a short plan-step prompt is not small, and in-loop work still says where hand-offs go', async ($, on) => {
  const w = await boot($, on)
  expect(sizeOf('continue step 1')).toBe('medium')
  expect(sizeOf('do phase 2')).toBe('medium')
  expect(sizeOf('rename it')).toBe('small')
  const note = await w.say('fix the uploader bug')
  expect(note).toMatch(/^\[router\] (→|Do it here; if you hand any of it off →) agent-boxes:/)
})

test('tools named inside pasted text are not the user naming them', async ($, on) => {
  const w = await boot($, on)
  const pasted = 'why is this happening <pasted_content id="x1">Stop them and rerun on agy (Gemini 4 Argon, falling back to Codex)</pasted_content id="x1"> fix the uploader bug'
  expect(await w.say(pasted)).not.toMatch(/You named/)
  expect(ownWords(pasted)).not.toMatch(/Argon/)
})
