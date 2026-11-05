import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Topic, TopicStatus } from '../types'

const PANE = 'topics'
const TITLE = 'Topics'
const KEY = 'topic:'
const POLL_MS = 2_000
const BEAT_MS = 20_000
// A session that has not refreshed its record for this long is gone (killed,
// crashed): its record is dropped by whichever session reads it next.
const STALE_MS = 90_000

// Change the tag when a record's fields change: it declines what an earlier
// version stored, which outlives a reload.
const topics = atom({ plugin: 'sidebar-topics', key: 'topics' } as const, [], {
  shape: 'topics-1',
})
const selected = atom({ plugin: 'sidebar-topics', key: 'selected' } as const, '')
const sent = atom({ plugin: 'sidebar-topics', key: 'sent' } as const, 0)
const notice = atom({ plugin: 'sidebar-topics', key: 'notice' } as const, '')

const WAITING: readonly TopicStatus[] = ['question', 'go', 'input', 'idle']
const isWaiting = (t: Topic) => WAITING.includes(t.status)

const firstLine = (text: string) =>
  text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? ''

const fit = (text: string, width: number) => {
  const w = Math.max(4, width)
  return text.length <= w ? text : text.slice(0, w - 1) + '…'
}

const tail = (text: string, max: number) => {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= max ? t : '…' + t.slice(t.length - max + 1)
}

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const age = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

const glyph = (status: TopicStatus) =>
  status === 'question' ? '?' : status === 'go' ? '!' : status === 'working' ? '~' : '•'

const tint = (status: TopicStatus) =>
  status === 'question' || status === 'go'
    ? 'yellow'
    : status === 'working'
      ? 'cyan'
      : 'green'

const label = (status: TopicStatus) =>
  status === 'question'
    ? 'asks you a question'
    : status === 'go'
      ? 'waits for your go'
      : status === 'input'
        ? 'waits for your input'
        : status === 'idle'
          ? 'new, no prompt yet'
          : 'working'

/** Every live record in the store, stale ones dropped, newest change first. */
async function loadAll($: EngineInterface): Promise<Topic[]> {
  const now = await $.clock.now()
  const out: Topic[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY)) continue
    const t = (await $.store.get(key)) as Partial<Topic> | undefined
    if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue
    if (typeof t.seenAt !== 'number' || now - t.seenAt > STALE_MS) {
      await $.store.delete(key)
      continue
    }
    out.push({
      id: t.id,
      cwd: t.cwd ?? '',
      title: t.title ?? '',
      status: t.status ?? 'idle',
      detail: t.detail ?? '',
      updatedAt: t.updatedAt ?? t.seenAt,
      seenAt: t.seenAt,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** Re-reads the store into the pane's value; toasts a topic newly waiting. */
async function refresh($: EngineInterface) {
  const list = await loadAll($)
  const before = await read($, topics)
  if (JSON.stringify(before) === JSON.stringify(list)) return
  const me = await $.session.id()
  for (const t of list) {
    if (t.id === me || !isWaiting(t) || t.status === 'idle') continue
    const was = before.find(b => b.id === t.id)
    if (was && !isWaiting(was)) {
      $.ui.toast(`${glyph(t.status)} ${fit(t.title || base(t.cwd), 60)} ${label(t.status)}`)
    }
  }
  await update($, topics, () => list)
  const waiting = list.filter(t => isWaiting(t) && t.id !== me).length
  $.ui.status(waiting > 0 ? `${waiting} topic${waiting === 1 ? '' : 's'} waiting` : undefined)
}

async function own($: EngineInterface): Promise<Topic | undefined> {
  const id = await $.session.id()
  const t = (await $.store.get(KEY + id)) as Topic | undefined
  return t && typeof t === 'object' ? t : undefined
}

/** Writes this session's record: `patch` over what stands, heartbeat renewed. */
async function mark($: EngineInterface, patch: Partial<Topic>) {
  const id = await $.session.id()
  const now = await $.clock.now()
  const prev = await own($)
  const record: Topic = {
    id,
    cwd: prev?.cwd ?? (await $.session.cwd()),
    title: prev?.title ?? '',
    status: prev?.status ?? 'idle',
    detail: prev?.detail ?? '',
    updatedAt: prev?.updatedAt ?? now,
    ...patch,
    seenAt: now,
  }
  if (Object.keys(patch).length > 0) record.updatedAt = now
  await $.store.set(KEY + id, record)
  await refresh($)
}

/** Sends `text` into the picked session: this one's prompt, or a peer message. */
async function reply($: EngineInterface, target: string, text: string) {
  const body = text.trim()
  if (body.length === 0) return
  const me = await $.session.id()
  let line: string
  if (target === me) {
    void $.prompt.submit({ text: body })
    line = 'Sent to this session.'
  } else {
    const result = await $.session.send({ to: { sessionId: target }, text: body })
    line = result.isDelivered ? 'Sent to that session.' : `Not delivered: ${result.reason}`
  }
  await update($, sent, n => n + 1)
  await update($, notice, () => line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'topics',
      description: 'Open the Topics sidebar; `/topics clear` forgets every record',
    })
    await mark($, {})
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(POLL_MS, () => refresh($))
    $.clock.every(BEAT_MS, () => mark($, {}))

    return next(e)
  })

  on('command.run', { command: 'topics' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      for (const key of await $.store.keys()) {
        if (key.startsWith(KEY)) await $.store.delete(key)
      }
      await mark($, {})

      return { text: 'Topics forgotten; this session registered again.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return {
      text: opened.isPlaced ? 'Topics pane opened.' : `Topics pane: ${opened.reason}`,
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const prev = await own($)
    const line = firstLine(e.text)
    await mark($, {
      status: 'working',
      title: prev?.title || fit(line, 80),
      detail: line ? `You: ${tail(line, 240)}` : prev?.detail ?? '',
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const text = e.isAborted ? '(interrupted)' : e.answer
    await mark($, { status: 'input', detail: tail(text, 300) })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.tool === 'AskUserQuestion') {
      const asked = (e as unknown as { questions?: { question?: string }[] }).questions
      const question = asked?.map(q => q.question ?? '').filter(Boolean).join(' / ')
      await mark($, { status: 'question', detail: tail(question || 'A question', 300) })
    }
    const ran = await next(e)
    const now = await own($)
    if (now && (now.status === 'question' || now.status === 'go')) {
      await mark($, { status: 'working' })
    }

    return ran
    // A failure of the bookkeeping never blocks the tool: the call goes on
    // (or its settled result stands, when `next` had already run it).
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await mark($, { status: 'go', detail: tail(e.message, 300) })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await $.store.delete(KEY + e.sessionId)
    $.ui.status(undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, topics)
    const picked = await read($, selected)
    const count = await read($, sent)
    const line = await read($, notice)
    const me = await $.session.id()
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const chosen = list.find(t => t.id === picked)
    const waiting = list.filter(isWaiting)
    const working = list.filter(t => !isWaiting(t))

    const row = (t: Topic) => {
      const meta = `${base(t.cwd)} ${age(now - t.updatedAt)}${t.id === me ? ' ·here' : ''}`
      const title = fit(t.title || `(${label(t.status)})`, width - meta.length - 4)

      return (
        <Button
          key={`t:${t.id}`}
          plain
          onPress={() => update($, selected, cur => (cur === t.id ? '' : t.id))}
        >
          <Text color={tint(t.status)}>{glyph(t.status)}</Text>{' '}
          <Text weight={t.id === picked ? 'bold' : 'regular'}>{title}</Text>{' '}
          <Text dimColor>{meta}</Text>
        </Button>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="bold">
            Awaiting you <Text dimColor>({waiting.length})</Text>
          </Text>
          {waiting.length === 0 && <Text dimColor>Nothing waits for you.</Text>}
          {waiting.map(row)}
        </Box>
        <Box flexDirection="column">
          <Text weight="bold">
            Working <Text dimColor>({working.length})</Text>
          </Text>
          {working.length === 0 && <Text dimColor>No session is working.</Text>}
          {working.map(row)}
        </Box>
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text weight="bold">{fit(chosen.title || `(${label(chosen.status)})`, width - 4)}</Text>
            <Text dimColor>
              {chosen.cwd} · {label(chosen.status)}
            </Text>
            {chosen.detail.length > 0 && <Text wrap="wrap">{chosen.detail}</Text>}
            <Input
              key={`reply:${chosen.id}:${count}`}
              placeholder={chosen.id === me ? 'Reply here, Enter sends' : 'Reply to that session, Enter sends'}
              submitLabel="send"
              rows={2}
              onSubmit={value => void reply($, chosen.id, value)}
            />
            {line.length > 0 && <Text dimColor>{line}</Text>}
            <Box flexDirection="row" gap={1}>
              {chosen.id !== me && (
                <Button
                  key="copy-resume"
                  plain
                  dimColor
                  onPress={press =>
                    void $.ui.copy({ text: `claude --resume ${chosen.id}`, surface: press.surface })
                  }
                >
                  copy resume command
                </Button>
              )}
              <Button key="close-detail" plain dimColor onPress={() => update($, selected, () => '')}>
                close
              </Button>
            </Box>
          </Box>
        )}
        <Text dimColor>{fit('Click a topic to read and reply. /topics opens this pane.', width)}</Text>
      </Box>
    )
  })
}
