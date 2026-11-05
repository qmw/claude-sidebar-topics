import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'sidebar-topics',
  component: 'Pane',
  requestId: 'topics',
  props: {
    title: 'Topics',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = 1_700_000_000_000

const open = {
  id: 'db',
  title: 'Which database to use?',
  detail: 'Postgres or SQLite? Postgres fits the deploy target better.',
  kind: 'question',
  isOpen: true,
  createdAt: NOW - 120_000,
}

const peerTopic = {
  id: 'deploy',
  title: 'Deploy to staging now?',
  detail: 'The build is green; say go and I deploy to staging.',
  kind: 'go',
  isOpen: true,
  createdAt: NOW - 30_000,
}

function engine(on: On, prompts: string[], sends: { to: string; text: string }[] = []) {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'this-session' }))
  on('session.cwd', () => ({ value: '/home/me/here' }))
  on('command.register', () => ({ value: { command: 'topics' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })

    return { isDelivered: true as const }
  })
}

test('a stored open topic is listed, answered from the pane, and settled', async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)
  mock.store(on, {
    'topics:this-session': { sessionId: 'this-session', cwd: '/home/me/here', savedAt: NOW - 60_000, seenAt: NOW - 60_000, topics: [open] },
  })

  await $.session.start({ cwd: '/home/me/here', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 't:db' }))?.text).toContain('Which database')
    await ui.press({ key: 't:db' })
    expect(await ui.find({ type: 'Text', text: /deploy target/ })).toBeDefined()
    await ui.press({ key: 'close-detail' })
    expect(await ui.find({ type: 'Text', text: /deploy target/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't:db' })
  await ui.input({ key: 'reply:db:0', text: 'Postgres.' })
  expect(prompts.at(-1)).toBe('About "Which database to use?": Postgres.')
  // Answered: it leaves the open list and the settled count appears.
  expect(await ui.find({ key: 't:db' })).toBeUndefined()
  expect((await ui.find({ key: 'clear-done' }))?.text).toContain('1 settled')
  await ui.unmount()
})

test("another live session's open topic is listed below and answered by message", async ($, on) => {
  const prompts: string[] = []
  const sends: { to: string; text: string }[] = []
  engine(on, prompts, sends)
  mock.store(on, {
    'topics:peer-session': { sessionId: 'peer-session', cwd: '/home/me/shop', savedAt: NOW - 5_000, seenAt: NOW - 5_000, topics: [peerTopic] },
    'topics:gone-session': { sessionId: 'gone-session', cwd: '/home/me/old', savedAt: NOW - 5_000, seenAt: NOW - 600_000, topics: [{ ...peerTopic, id: 'stale' }] },
  })

  await $.session.start({ cwd: '/home/me/here', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing waits for you here/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
  expect((await ui.find({ key: 't:deploy' }))?.text).toContain('Deploy to staging')
  // A session not heard from is not shown.
  expect(await ui.find({ key: 't:stale' })).toBeUndefined()

  await ui.press({ key: 't:deploy' })
  expect(await ui.find({ type: 'Text', text: /build is green/ })).toBeDefined()
  await ui.input({ key: 'reply:deploy:0', text: 'Go.' })
  expect(sends.at(-1)?.text).toBe('About "Deploy to staging now?": Go.')
  expect(prompts).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Answered in shop/ })).toBeDefined()
  await ui.unmount()
})

test('a question dialog is a topic while it is open', async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)
  mock.store(on, {})
  let seen: string | undefined
  on('tool.call', async () => {
    // The dialog is up: the pane lists the question now.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    seen = (await ui.find({ key: 't:q1:0' }))?.text
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start({ cwd: '/home/me/here', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'AskUserQuestion',
    tool_use_id: 'q1',
    questions: [{ question: 'Deploy now?', header: 'Deploy', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
  })

  expect(seen).toContain('Deploy now?')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 't:q1:0' })).toBeUndefined()
  expect((await ui.find({ key: 'clear-done' }))?.text).toContain('1 settled')
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ title: 'old' }], version: 1 } }))
  on('session.id', () => ({ value: 'this-session' }))
  mock.clock(on, { now: NOW })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing waits for you here/ })).toBeDefined()
  await ui.unmount()
})
