import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-boxes',
  component: 'Pane',
  requestId: 'agent-boxes',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SCAN = {
  codex: {
    installed: true,
    limits: ['5h 3% · 7d 35%'],
    fiveHour: 3,
    sevenDay: 35,
    agents: [
      { depth: 0, text: 'fix login · gpt-6.1-sol high · 120k tok · 4m', now: 'editing login.py' },
      { depth: 1, text: 'sub task · 3k tok · 1m' },
    ],
  },
  agy: { installed: true, limits: ['5h 0% · 7d 0%'], agents: [], fiveHour: 0, sevenDay: null },
}

const TASKS: Record<string, object> = {
  '1.json': { id: '1', subject: 'Scan Codex actions', status: 'completed' },
  '2.json': { id: '2', subject: 'Draw the Now box', activeForm: 'Drawing the Now box', status: 'in_progress' },
  '3.json': { id: '3', subject: 'Run the tests', status: 'pending' },
  '4.json': { id: '4', subject: 'Dropped', status: 'deleted' },
}

const BRIEF =
  '{"task":"Agent activity boxes","steps":["Write tests"],"next":"Restart to see the side bar","why":"Hot reload only","waiting":true}'

type Setup = {
  opened?: string[]
  scan?: object
  tasks?: Record<string, object>
  // Commands that are not on PATH (process.run rejects for them).
  missing?: string[]
  // Folders that exist, besides the task folder; by default both tools' folders.
  folders?: string[]
  // Commands that run but fail the 3.8 version check (Python 2, a stub).
  old?: string[]
  // Commands that run and exit 1 (xcode-select without the developer tools).
  failing?: string[]
  // Makes the bundled scan reject as a spawn error (the interpreter went away) from this many scans on.
  lostFrom?: number
  // Whether the pane is placed; flip `placed.is` to place it later.
  placed?: { is: boolean }
  // Makes the bundled scan reject (a timeout) from this many scans on.
  scanFailsFrom?: number
  // Answers model.complete; the default answers BRIEF at once.
  complete?: (clock: MockClock) => Promise<string>
  env?: Record<string, string>
  // How long each version check takes.
  checkMs?: number
  // The main conversation's messages; the default is one request and its reply.
  messages?: SessionMessage[]
  // agent-boxes/config.json: an object is written as JSON, a string as is; absent by default.
  config?: object | string
  // agent-router's route file for this session; absent by default.
  route?: object
}

type World = {
  argvs: (readonly string[])[]
  clock: MockClock
  scans: () => (readonly string[])[]
  checks: () => (readonly string[])[]
  completes: () => number
  lists: () => number
  logs: string[]
  writes: Map<string, string>
}

const TOOL_FOLDERS = ['/home/u/.codex', '/home/u/.gemini/antigravity-cli']

// The engine hands fs hooks absolute paths, drive letter and backslashes included on Windows.
const unix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// Stands in for the engine, the file system and the bundled scan beneath the plugin.
async function start($: Engine, on: On, setup: Setup = {}): Promise<World> {
  const { opened = [], scan = SCAN, tasks = TASKS, missing = [], folders = TOOL_FOLDERS, old = [], failing = [] } = setup
  const { placed = { is: true } } = setup
  const argvs: (readonly string[])[] = []
  const clock = mock.clock(on)
  let completes = 0
  let lists = 0
  const logs: string[] = []
  const writes = new Map<string, string>()
  const taskDir = '/home/u/.claude/tasks/sess-1'
  const configPath = '/home/u/.claude/agent-boxes/config.json'
  const { config } = setup
  const routePath = '/home/u/.claude/agent-router/route-sess-1.json'
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 82000, percent: 41 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12 },
        { kind: 'seven_day', percentUsed: 30 },
      ],
    },
  }))
  on('env.get', (_$, e) => ({ value: setup.env?.[e.name] ?? (e.name === 'HOME' ? '/home/u' : undefined) }))
  on('fs.exists', (_$, e) => ({
    value:
      (unix(e.path) === taskDir && Object.keys(tasks).length > 0) ||
      folders.includes(unix(e.path)) ||
      (config !== undefined && unix(e.path) === configPath) ||
      (setup.route !== undefined && unix(e.path) === routePath),
  }))
  on('fs.list', () => ({
    value: Object.keys(tasks).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$, e) =>
    unix(e.path) === configPath && config !== undefined
      ? { value: typeof config === 'string' ? config : JSON.stringify(config) }
      : unix(e.path) === routePath
      ? { value: JSON.stringify(setup.route) }
      : { value: JSON.stringify(tasks[unix(e.path).slice(taskDir.length + 1)]) },
  )
  on('fs.write', (_$, e) => {
    writes.set(unix(e.path), e.text)
    return { value: undefined }
  })
  on('agent.list', () => {
    lists++
    return {
    value: [
      { id: 'a1', description: 'Review the parser', type: 'reviewer', status: 'running' },
      { id: 'a2', description: 'Old search', type: 'scout', status: 'completed' },
    ],
    }
  })
  on('session.messages', (_$, e) => ({
    value:
      e.agentId === 'a1'
        ? [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/parser.ts' } }] }]
        : setup.messages ?? [
            { role: 'user', text: 'add a next box', toolUses: [] },
            { role: 'assistant', text: 'Done. Restart?', toolUses: [] },
          ],
  }))
  on('model.complete', async () => {
    completes++
    return {
      value: {
        isAnswered: true,
        text: setup.complete ? await setup.complete(clock) : BRIEF,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  // The scans proper, and the version checks.
  const scans = () => argvs.filter(a => a.some(x => /boxes\.py$/.test(x)))
  const checks = () => argvs.filter(a => a.includes('-c'))
  on('process.run', async (_$, e) => {
    argvs.push(e.argv)
    if (missing.includes(e.argv[0] ?? '')) throw new Error(`spawn ${e.argv[0]} ENOENT`)
    const isCheck = e.argv.includes('-c')
    if (isCheck && setup.checkMs) await clock.sleep(setup.checkMs)
    const isScan = !isCheck && e.argv.some(x => /boxes\.py$/.test(x))
    if (isScan && setup.scanFailsFrom !== undefined && scans().length > setup.scanFailsFrom) {
      throw new Error('process timed out after 20000 ms')
    }
    // Rejects $.process.run with this reason, as the engine does when the command cannot start.
    if (isScan && setup.lostFrom !== undefined && scans().length > setup.lostFrom) {
      return { deny: `spawn ${e.argv[0]} ENOENT` }
    }
    return {
      value: {
        exitCode: (isCheck && old.includes(e.argv[0] ?? '')) || failing.includes(e.argv[0] ?? '') ? 1 : 0,
        stdout: isCheck ? '' : JSON.stringify(scan),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.panes', () => ({
    value: [{ id: 'agent-boxes', title: 'Agents', isShown: placed.is, isFocused: false, isPlaced: placed.is }],
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: placed.is ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { argvs, clock, scans, checks, completes: () => completes, lists: () => lists, logs, writes }
}

test('each tool gets its own box with its agents', async ($, on) => {
  const { argvs, scans } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'claude' })).toBeDefined()
    expect(await ui.find({ key: 'codex' })).toBeDefined()
    expect(await ui.find({ key: 'agy' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx 41%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7d 30%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 3%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 0%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7d 35%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7d –/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fix login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /└ sub task/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no agents running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ editing login\.py/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review the parser/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ Read parser\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Old search/ })).toBeUndefined()
    await ui.unmount()
  }
  // One version check, then the bundled script with -E and the session id under the first Python 3.8+.
  expect(argvs[0]).toEqual(['python3', '-E', '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'])
  expect(argvs.filter(a => a[2] === '-c').length).toBe(1)
  const run = scans()[0]
  expect(run?.[0]).toBe('python3')
  expect(run?.[1]).toBe('-E')
  expect(run?.at(-2)).toMatch(/scripts[\\/]boxes\.py$/)
  expect(run?.at(-1)).toBe('sess-1')
})

test("agent-router's box shows its mode and the best-placed pool before any prompt", async ($, on) => {
  await start($, on, { route: { mode: 'advise', lead: 'agy best placed · 97% free · 8 ready', pick: '', atMs: 1 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'router' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· advise/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agy best placed · 97% free/ })).toBeDefined()
  await ui.unmount()
})

test("agent-router's pick and fallback show in its box, not in next", async ($, on) => {
  const route = { mode: 'steer', lead: '', category: 'bugfix', size: 'medium', pick: 'Gemini 4 Argon', fallback: 'Sonnet 5.5', why: 'best fit for hard bug fix', atMs: 1 }
  await start($, on, { route })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Gemini 4 Argon/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bugfix \(medium\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /best fit for hard bug fix · alt Sonnet 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⇄ Gemini/ })).toBeUndefined()
  await ui.unmount()
  // A short side bar puts it on one line.
  const short = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } } })
  expect(await short.find({ type: 'Text', text: /Gemini 4 Argon · bugfix · alt Sonnet 5\.5/ })).toBeDefined()
  await short.unmount()
})

test('no router box with agent-router off or not installed', async ($, on) => {
  await start($, on, { route: { mode: 'off', lead: '', pick: '', atMs: 1 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'router' })).toBeUndefined()
  await ui.unmount()
})

test('no router box without agent-router', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'router' })).toBeUndefined()
  await ui.unmount()
})

const HINT = {
  plugin: 'agent-boxes',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('opens itself in the side bar once the layout is fullscreen', async ($, on) => {
  const opened: string[] = []
  const { clock } = await start($, on, { opened })
  expect(opened).toEqual([])
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal', viewport: { columns: 160, rows: 40, isFullscreen: true } })
  await ui.unmount()
  await clock.settle()
  expect(opened).toEqual(['agent-boxes'])
})

test('not fullscreen: no pane uninvited, but /agent-boxes opens it', async ($, on) => {
  const opened: string[] = []
  await start($, on, { opened })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal', viewport: { columns: 160, rows: 40, isFullscreen: false } })
  await ui.unmount()
  // Decided once: a later fullscreen-looking drawing does not open it either.
  const again = await $.ui.mount({ ...HINT, surface: 'terminal', viewport: { columns: 160, rows: 40, isFullscreen: true } })
  await again.unmount()
  expect(opened).toEqual([])
  await $.command.run({ command: 'agent-boxes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(opened).toEqual(['agent-boxes'])
})

test('with no Codex or Antigravity folder, no Python runs at all', async ($, on) => {
  const folders: string[] = []
  const { argvs, clock } = await start($, on, { folders })
  await clock.advance(60000)
  expect(argvs.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'codex' })).toBeUndefined()
  expect(await ui.find({ key: 'agy' })).toBeUndefined()
  expect(await ui.find({ key: 'claude' })).toBeDefined()
  await ui.unmount()
  // Installed mid-session: seen within five minutes.
  folders.push('/home/u/.codex')
  await clock.advance(250000)
  expect(argvs.length).toBeGreaterThan(0)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ key: 'codex' })).toBeDefined()
  await after.unmount()
})

test('now shows the task list, next shows the recommendation', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'now' })).toBeDefined()
  expect(await ui.find({ key: 'next' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Drawing the Now box/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· Run the tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Dropped/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Restart to see the side bar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting on you/ })).toBeDefined()
  await ui.unmount()
})

test('without a task list, now falls back to the summary', async ($, on) => {
  await start($, on, { tasks: {} })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Agent activity boxes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· Write tests/ })).toBeDefined()
  await ui.unmount()
})

test('tools that are not installed get no box', async ($, on) => {
  await start($, on, { scan: { codex: { installed: false, limits: [], agents: [] }, agy: { installed: false, limits: [], agents: [] } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'claude' })).toBeDefined()
  expect(await ui.find({ key: 'codex' })).toBeUndefined()
  expect(await ui.find({ key: 'agy' })).toBeUndefined()
  expect(await ui.find({ key: 'now' })).toBeDefined()
  await ui.unmount()
})

test('with no Python, an installed tool says what it needs', async ($, on) => {
  const { argvs } = await start($, on, { missing: ['python3', 'python', 'py'], folders: ['/home/u/.codex'] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(argvs.map(a => a[0])).toEqual(['python3', 'python', 'py'])
  expect(await ui.find({ key: 'codex' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /needs Python 3/ })).toBeDefined()
  expect(await ui.find({ key: 'agy' })).toBeUndefined()
  await ui.unmount()
})

test('summaries can be turned off', async ($, on) => {
  await start($, on, { tasks: {}, config: { brief: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /nothing under way/ })).toBeDefined()
  await ui.unmount()
})

test('a broken config file keeps the defaults', async ($, on) => {
  await start($, on, { config: '{ "brief": fal' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'next' })).toBeDefined()
  await ui.unmount()
})

test('a candidate that fails the version check is skipped', async ($, on) => {
  const { argvs, scans } = await start($, on, { old: ['python3'] })
  expect(argvs.slice(0, 2).map(a => a[0])).toEqual(['python3', 'python'])
  expect(scans()[0]?.[0]).toBe('python')
  expect(scans().some(a => a[0] === 'python3')).toBe(false)
})

test('with no Python, looks again after a minute, not every poll', async ($, on) => {
  const { argvs, clock } = await start($, on, { missing: ['python3', 'python', 'py'] })
  expect(argvs.length).toBe(3)
  await clock.advance(30000)
  expect(argvs.length).toBe(3)
  await clock.advance(35000)
  expect(argvs.length).toBe(6)
})

test('CODEX_HOME decides whether Codex is installed', async ($, on) => {
  await start($, on, {
    missing: ['python3', 'python', 'py'],
    folders: ['/elsewhere/codex'],
    env: { CODEX_HOME: '/elsewhere/codex' },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'codex' })).toBeDefined()
  await ui.unmount()
})

test('a timed-out scan keeps the interpreter and the last boxes', async ($, on) => {
  const { argvs, clock, scans } = await start($, on, { scanFailsFrom: 1 })
  await clock.advance(5000)
  expect(scans().length).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /scan (slow|failed), retrying/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fix login/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /needs Python 3/ })).toBeUndefined()
  await ui.unmount()
  // Backs off a poll, then scans again with the same Python and no new version check.
  await clock.advance(5000)
  expect(scans().length).toBe(2)
  await clock.advance(5000)
  expect(scans().length).toBe(3)
  expect(argvs.filter(a => a[2] === '-c').length).toBe(1)
})

test('no scan runs while the pane is not placed', async ($, on) => {
  const placed = { is: false }
  const { argvs, clock, scans } = await start($, on, { placed })
  await clock.advance(15000)
  expect(argvs.length).toBe(0)
  // Placed: its first render scans at once.
  placed.is = true
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  expect(scans().length).toBe(1)
  await ui.unmount()
})

test('a turn that ends mid-summary gets its own summary after', async ($, on) => {
  let calls = 0
  const { clock, completes } = await start($, on, {
    complete: async c => {
      calls++
      if (calls === 1) await c.sleep(1000)
      return calls === 1 ? BRIEF : BRIEF.replace('Restart to see the side bar', 'Ship it')
    },
  })
  expect(completes()).toBe(1)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(completes()).toBe(1)
  await clock.advance(1000)
  expect(completes()).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ship it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Restart to see/ })).toBeUndefined()
  await ui.unmount()
})

test('waiting on you clears when the user submits a prompt', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /waiting on you/ })).toBeDefined()
  await ui.unmount()
  const entered = await $.prompt.submit({ text: 'yes, go', wait: false, origin: { kind: 'composer' } })
  expect('text' in entered && entered.text).toBe('yes, go')
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /waiting on you/ })).toBeUndefined()
  await after.unmount()
})

test('with no task under way, now shows the first pending task', async ($, on) => {
  await start($, on, {
    config: { brief: false },
    tasks: {
      '1.json': { id: '1', subject: 'Write the scan', status: 'pending' },
      '2.json': { id: '2', subject: 'Test it', status: 'pending' },
    },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Write the scan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· Test it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nothing under way/ })).toBeUndefined()
  await ui.unmount()
})

test('discovery backs off: 1 m, then 2 m, then 4 m', async ($, on) => {
  const { checks, clock } = await start($, on, { missing: ['python3', 'python', 'py'] })
  expect(checks().length).toBe(3)
  await clock.advance(65000) // t = 65 s: the 1 m retry ran
  expect(checks().length).toBe(6)
  await clock.advance(100000) // t = 165 s: under 2 m since
  expect(checks().length).toBe(6)
  await clock.advance(20000) // t = 185 s
  expect(checks().length).toBe(9)
  await clock.advance(200000) // t = 385 s: under 4 m since
  expect(checks().length).toBe(9)
  await clock.advance(40000) // t = 425 s
  expect(checks().length).toBe(12)
})

test('tasks and subagents keep polling while discovery runs', async ($, on) => {
  // Each version check takes 10 s; the polls at 5 s and 10 s must not wait for it.
  const { clock, lists, scans } = await start($, on, { checkMs: 10000 })
  const atStart = lists()
  await clock.advance(10000)
  expect(lists() - atStart).toBeGreaterThanOrEqual(2)
  expect(scans().length).toBeGreaterThanOrEqual(1)
})

test('a spawn error under the cached interpreter looks for Python again', async ($, on) => {
  const { checks, clock, scans } = await start($, on, { lostFrom: 1 })
  expect(checks().length).toBe(1)
  expect(scans().length).toBe(1)
  await clock.advance(5000)
  // The scan could not start: a new version check at once, no minute's wait. Here the new one
  // cannot start the scan either, so the next waits out the back-off rather than looping.
  expect(checks().length).toBe(2)
  expect(scans().length).toBe(3)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /fix login/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Python would not start/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(30000)
  expect(checks().length).toBe(2)
})

test('prompt.submit cancels a queued summary', async ($, on) => {
  let calls = 0
  const { clock, completes } = await start($, on, {
    complete: async c => {
      calls++
      if (calls === 1) await c.sleep(1000)
      return BRIEF
    },
  })
  expect(completes()).toBe(1)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5000)
  expect(completes()).toBe(1)
  // The summary in flight was for an older turn: dropped.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Restart to see/ })).toBeUndefined()
  await ui.unmount()
})

test('no summary while the latest request has no reply yet', async ($, on) => {
  const { completes } = await start($, on, { messages: [{ role: 'user', text: 'do the thing', toolUses: [] }] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(completes()).toBe(0)
})

test('/clear drops the old conversation summary', async ($, on) => {
  await start($, on, { complete: async () => BRIEF })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Restart to see/ })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  expect(await ui.find({ type: 'Text', text: /Restart to see/ })).toBeUndefined()
  await ui.unmount()
})

test('a python path with spaces is one argument', async ($, on) => {
  const { checks } = await start($, on, {
    folders: [...TOOL_FOLDERS, '/opt/My Env/bin/python'],
    config: { python: '/opt/My Env/bin/python' },
  })
  expect(checks()[0]?.[0]).toBe('/opt/My Env/bin/python')
})

test('a quoted python path keeps its arguments', async ($, on) => {
  const { checks } = await start($, on, { config: { python: '"/opt/My Env/python" -X utf8' } })
  expect(checks()[0]?.slice(0, 3)).toEqual(['/opt/My Env/python', '-X', 'utf8'])
})

test('on Windows, USERPROFILE comes before HOME', async ($, on) => {
  await start($, on, {
    missing: ['python3', 'python', 'py'],
    folders: ['/win/u/.codex'],
    env: { OS: 'Windows_NT', USERPROFILE: '/win/u', HOME: '/home/u' },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'codex' })).toBeDefined()
  await ui.unmount()
})

test('an empty HOME falls back to USERPROFILE', async ($, on) => {
  await start($, on, { missing: ['python3', 'python', 'py'], folders: ['/win/u/.codex'], env: { HOME: '', USERPROFILE: '/win/u' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'codex' })).toBeDefined()
  await ui.unmount()
})

test('the python option takes arguments', async ($, on) => {
  const { checks, scans } = await start($, on, { config: { python: 'py -3' } })
  expect(checks()[0]).toEqual(['py', '-3', '-E', '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'])
  expect(scans()[0]?.slice(0, 3)).toEqual(['py', '-3', '-E'])
})

test('macOS: the xcode stub python3 is skipped without the developer tools', async ($, on) => {
  const { argvs, scans } = await start($, on, {
    env: { PATH: '/usr/bin:/bin' },
    folders: [...TOOL_FOLDERS, '/usr/bin/python3', '/usr/bin/xcode-select'],
    failing: ['/usr/bin/xcode-select'],
  })
  expect(argvs[0]).toEqual(['/usr/bin/xcode-select', '-p'])
  expect(argvs.some(a => a[0] === 'python3')).toBe(false)
  expect(scans()[0]?.[0]).toBe('python')
})
