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

const other = {
  id: 'other-session',
  cwd: '/home/me/shop',
  title: 'Fix the checkout bug',
  status: 'question',
  detail: 'Should I also patch the refund path?',
  updatedAt: NOW - 30_000,
  seenAt: NOW - 1_000,
}

test('a waiting session from the store is listed and can be replied to', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { 'topic:other-session': other })
  on('session.id', () => ({ value: 'this-session' }))
  on('session.cwd', () => ({ value: '/home/me/here' }))
  on('command.register', () => ({ value: { command: 'topics' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const sent: { to: unknown; text: string }[] = []
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true as const }
  })

  await $.session.start({ cwd: '/home/me/here', surface: 'terminal', isInteractive: true })

  for (const [round, surface] of (['terminal', 'desktop'] as const).entries()) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const row = await ui.find({ key: 't:other-session' })
    expect(row?.text).toContain('Fix the checkout bug')
    // This session registered itself too, waiting with no prompt yet.
    expect(await ui.find({ key: 't:this-session' })).toBeDefined()

    await ui.press({ key: 't:other-session' })
    expect(await ui.find({ type: 'Text', text: /refund path/ })).toBeDefined()

    // The field's key carries how many replies went out, so a sent one clears.
    await ui.input({ key: `reply:other-session:${round}`, text: 'Yes, patch both.' })
    expect(sent.at(-1)?.text).toBe('Yes, patch both.')
    expect(await ui.find({ type: 'Text', text: /Sent to that session/ })).toBeDefined()

    await ui.press({ key: 'close-detail' })
    expect(await ui.find({ type: 'Text', text: /refund path/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a record nobody refreshed is dropped from the store', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    'topic:stale': { ...other, id: 'stale', seenAt: NOW - 10 * 60_000 },
  })
  on('session.id', () => ({ value: 'this-session' }))
  on('session.cwd', () => ({ value: '/home/me/here' }))
  on('command.register', () => ({ value: { command: 'topics' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/home/me/here', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 't:stale' })).toBeUndefined()
  await ui.unmount()
})
