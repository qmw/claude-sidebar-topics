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
    scroll: { offset: 0, bodyRows: 30 },
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

function engine(on: On, prompts: string[]) {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'this-session' }))
  on('command.register', () => ({ value: { command: 'topics' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
}

test('a stored open topic is listed, answered from the pane, and settled', async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)
  mock.store(on, { 'topics:this-session': { savedAt: NOW - 60_000, topics: [open] } })

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
  expect(await ui.find({ type: 'Text', text: /Nothing waits/ })).toBeDefined()
  await ui.unmount()
})
