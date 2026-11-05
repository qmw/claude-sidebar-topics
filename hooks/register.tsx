import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Topic, TopicKind, TopicRecord } from '../types'

const PANE = 'topics'
const TITLE = 'Topics'
const KEY = 'topics:'
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const READER_MODEL = 'haiku'

// Change the tag when a topic's fields change: it declines what an earlier
// version stored, which outlives a reload.
const topics = atom({ plugin: 'sidebar-topics', key: 'topics' } as const, [], {
  shape: 'topics-2',
})
const selected = atom({ plugin: 'sidebar-topics', key: 'selected' } as const, '')
const sent = atom({ plugin: 'sidebar-topics', key: 'sent' } as const, 0)
const notice = atom({ plugin: 'sidebar-topics', key: 'notice' } as const, '')
const busy = atom({ plugin: 'sidebar-topics', key: 'busy' } as const, false)
const lastPrompt = atom({ plugin: 'sidebar-topics', key: 'lastPrompt' } as const, '')

const KINDS: readonly TopicKind[] = ['question', 'go', 'input']

const fit = (text: string, width: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  const w = Math.max(4, width)
  return t.length <= w ? t : t.slice(0, w - 1) + '…'
}

const head = (text: string, max: number) => {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

const tail = (text: string, max: number) => {
  const t = text.trim()
  return t.length <= max ? t : '…' + t.slice(t.length - max + 1)
}

const age = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

const glyph = (kind: TopicKind) => (kind === 'question' ? '?' : kind === 'go' ? '!' : '•')

const tint = (kind: TopicKind) => (kind === 'go' ? 'yellow' : kind === 'question' ? 'cyan' : 'green')

const label = (kind: TopicKind) =>
  kind === 'question' ? 'a question for you' : kind === 'go' ? 'waits for your go' : 'needs your input'

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Writes the list to the store, so `claude --resume` brings it back. */
async function save($: EngineInterface, list: Topic[]) {
  const record: TopicRecord = { savedAt: await $.clock.now(), topics: list }
  await $.store.set(KEY + (await $.session.id()), record)
}

/** Reads this session's list from the store; drops other sessions' old ones. */
async function load($: EngineInterface): Promise<Topic[]> {
  const mine = KEY + (await $.session.id())
  const now = await $.clock.now()
  let found: Topic[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY)) continue
    const record = (await $.store.get(key)) as Partial<TopicRecord> | undefined
    const list = Array.isArray(record?.topics) ? record.topics : []
    if (key === mine) {
      found = list.filter(t => t && typeof t.id === 'string' && typeof t.title === 'string')
    } else if (typeof record?.savedAt !== 'number' || now - record.savedAt > KEEP_MS) {
      await $.store.delete(key)
    }
  }
  return found
}

/** Changes the list, keeps it, and refreshes the status line. */
async function change($: EngineInterface, fn: (list: Topic[]) => Topic[]) {
  const list = await update($, topics, fn)
  await save($, list)
  const open = list.filter(t => t.isOpen).length
  $.ui.status(open > 0 ? `${open} topic${open === 1 ? '' : 's'} await${open === 1 ? 's' : ''} you` : undefined)
  return list
}

async function add($: EngineInterface, items: { title: string; detail: string; kind: TopicKind; id?: string }[]) {
  const now = await $.clock.now()
  return change($, list => {
    const out = [...list]
    for (const item of items) {
      const title = fit(item.title, 80)
      if (title.length === 0) continue
      if (out.some(t => t.isOpen && sameTitle(t.title, title))) continue
      out.push({
        id: item.id ?? newId(),
        title,
        detail: head(item.detail, 400),
        kind: item.kind,
        isOpen: true,
        createdAt: now,
      })
    }
    return out
  })
}

async function settle($: EngineInterface, ids: readonly string[]) {
  if (ids.length === 0) return
  const now = await $.clock.now()
  const set = new Set(ids)
  await change($, list =>
    list.map(t => (t.isOpen && set.has(t.id) ? { ...t, isOpen: false, resolvedAt: now } : t)),
  )
}

const READER_SYSTEM = `You read one reply an AI coding assistant wrote to its user, and you list the points on which the assistant is now waiting for the user: a question it asks the user, a decision it leaves to the user, a go-ahead it asks for before doing something, or information it needs from the user. Rhetorical questions, questions the assistant answers itself, and offers the user has no reason to act on ("let me know if you want more") are not such points. Also say which of the already open topics the user's last message or this reply has settled: answered, decided, done, or no longer asked.

Answer with JSON only, no prose and no code fence, of this exact shape:
{"resolved": ["<open topic id>", ...], "new": [{"title": "<at most 60 characters naming the point>", "detail": "<the ask in the assistant's own words, at most 200 characters>", "kind": "question" | "go" | "input"}, ...]}

Do not list a point that an open topic already covers. Use kind "question" for a question, "go" for a go-ahead or confirmation before acting, "input" for information or a decision the assistant needs. Both lists may be empty.`

const readerPrompt = (open: Topic[], prompt: string, answer: string) => {
  const list = open.length === 0 ? '(none)' : open.map(t => `- ${t.id}: ${t.title}`).join('\n')
  return `Open topics (id: title):\n${list}\n\nThe user's last message:\n<<<\n${tail(prompt, 2000)}\n>>>\n\nThe assistant's reply:\n<<<\n${tail(answer, 12000)}\n>>>`
}

type Reading = { resolved: string[]; new: { title: string; detail: string; kind: TopicKind }[] }

const parseReading = (text: string): Reading | undefined => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { resolved?: unknown; new?: unknown }
  const resolved = Array.isArray(r.resolved) ? r.resolved.filter((x): x is string => typeof x === 'string') : []
  const fresh = Array.isArray(r.new)
    ? r.new
        .filter((x): x is { title?: unknown; detail?: unknown; kind?: unknown } => !!x && typeof x === 'object')
        .map(x => ({
          title: typeof x.title === 'string' ? x.title : '',
          detail: typeof x.detail === 'string' ? x.detail : '',
          kind: KINDS.includes(x.kind as TopicKind) ? (x.kind as TopicKind) : ('input' as TopicKind),
        }))
        .filter(x => x.title.length > 0)
    : []
  return { resolved, new: fresh }
}

/** Reads one reply for open asks, with a small model call; never throws. */
async function readReply($: EngineInterface, answer: string, prompt: string) {
  const open = (await read($, topics)).filter(t => t.isOpen)
  await update($, busy, () => true)
  try {
    const reply = await $.model.complete({
      model: READER_MODEL,
      system: READER_SYSTEM,
      prompt: readerPrompt(open, prompt, answer),
      maxTokens: 1200,
      timeoutMs: 60_000,
    })
    if (!reply.isAnswered) {
      $.ui.log(`sidebar-topics: the reply was not read (${reply.reason})`, { to: 'debug' })
      return
    }
    const reading = parseReading(reply.text)
    if (!reading) {
      $.ui.log(`sidebar-topics: the reader's answer was not JSON`, { to: 'debug' })
      return
    }
    await settle($, reading.resolved)
    const before = (await read($, topics)).length
    const after = (await add($, reading.new)).length
    const added = after - before
    if (added > 0) $.ui.toast(`${added} topic${added === 1 ? '' : 's'} await${added === 1 ? 's' : ''} you`)
  } catch (error) {
    $.ui.log(`sidebar-topics: reading the reply failed: ${String(error)}`, { to: 'debug' })
  } finally {
    await update($, busy, () => false)
  }
}

/** Sends your answer to a topic into the conversation and settles the topic. */
async function answer($: EngineInterface, topic: Topic, text: string) {
  const body = text.trim()
  if (body.length === 0) return
  void $.prompt.submit({ text: `About "${topic.title}": ${body}` })
  await settle($, [topic.id])
  await update($, sent, n => n + 1)
  await update($, notice, () => `Answered "${fit(topic.title, 40)}".`)
}

async function discuss($: EngineInterface, topic: Topic) {
  void $.prompt.submit({
    text: `Let's discuss the open topic "${topic.title}": ${topic.detail}\nGive me the context and your recommendation, then wait for my answer.`,
  })
  await update($, notice, () => `Asked to discuss "${fit(topic.title, 40)}".`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'topics',
      description: 'Open the Topics pane; `/topics add <text>` notes a topic, `/topics clear` forgets all',
    })
    const stored = await load($)
    await change($, list => (list.length > 0 ? list : stored))
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'topics' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'clear') {
      await change($, () => [])
      await update($, selected, () => '')

      return { text: 'Topics forgotten.' }
    }
    if (args.startsWith('add ')) {
      const text = args.slice(4).trim()
      await add($, [{ title: text, detail: text, kind: 'input' }])
      void $.ui.open({ id: PANE, title: TITLE })

      return { text: `Topic noted: ${fit(text, 80)}` }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return {
      text: opened.isPlaced ? 'Topics pane opened.' : `Topics pane: ${opened.reason}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e)
    const kind = e.origin.kind
    const mine = kind === 'plugin' && e.origin.name === 'sidebar-topics'
    if (kind === 'composer' || kind === 'bridge' || kind === 'sdk' || mine) {
      await update($, lastPrompt, () => e.text)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool !== 'AskUserQuestion') return next(e)
    const asked = (e as unknown as { questions?: { question?: string; options?: { label?: string }[] }[] }).questions ?? []
    const ids: string[] = []
    const items = asked.map((q, i) => {
      const id = `${e.tool_use_id ?? newId()}:${i}`
      ids.push(id)
      const options = (q.options ?? []).map(o => o.label ?? '').filter(Boolean)
      return {
        id,
        title: q.question ?? 'A question',
        detail: options.length > 0 ? `${q.question ?? ''} Options: ${options.join(', ')}` : q.question ?? '',
        kind: 'question' as TopicKind,
      }
    })
    await add($, items)
    const ran = await next(e)
    await settle($, ids)

    return ran
    // A failure of the bookkeeping never blocks the dialog: it goes on (or
    // its settled result stands, when `next` had already run it).
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim().length > 0) {
      const prompt = await read($, lastPrompt)
      void readReply($, e.answer, prompt)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, topics)
    const picked = await read($, selected)
    const count = await read($, sent)
    const line = await read($, notice)
    const reading = await read($, busy)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const open = list.filter(t => t.isOpen).sort((a, b) => b.createdAt - a.createdAt)
    const done = list.filter(t => !t.isOpen)
    const chosen = list.find(t => t.id === picked)

    const row = (t: Topic) => {
      const when = age(now - t.createdAt)
      return (
        <Button key={`t:${t.id}`} plain onPress={() => update($, selected, cur => (cur === t.id ? '' : t.id))}>
          <Text color={tint(t.kind)}>{glyph(t.kind)}</Text>{' '}
          <Text weight={t.id === picked ? 'bold' : 'regular'}>{fit(t.title, width - when.length - 4)}</Text>{' '}
          <Text dimColor>{when}</Text>
        </Button>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="bold">
            Awaiting you <Text dimColor>({open.length})</Text>
          </Text>
          {open.length === 0 && <Text dimColor>Nothing waits for you.</Text>}
          {open.map(row)}
          {reading && <Text dimColor>Reading the last reply…</Text>}
        </Box>
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text weight="bold">{fit(chosen.title, width - 4)}</Text>
            <Text dimColor>
              {label(chosen.kind)} · {age(now - chosen.createdAt)} ago{chosen.isOpen ? '' : ' · settled'}
            </Text>
            {chosen.detail.length > 0 && <Text wrap="wrap">{chosen.detail}</Text>}
            <Input
              key={`reply:${chosen.id}:${count}`}
              placeholder="Your answer, Enter sends it"
              submitLabel="send"
              rows={2}
              onSubmit={value => void answer($, chosen, value)}
            />
            {line.length > 0 && <Text dimColor>{line}</Text>}
            <Box flexDirection="row" gap={1}>
              <Button key="discuss" plain onPress={() => void discuss($, chosen)}>
                discuss
              </Button>
              {chosen.isOpen && (
                <Button key="done" plain dimColor onPress={() => void settle($, [chosen.id])}>
                  done
                </Button>
              )}
              <Button key="close-detail" plain dimColor onPress={() => update($, selected, () => '')}>
                close
              </Button>
            </Box>
          </Box>
        )}
        <Box flexDirection="column">
          {done.length > 0 && (
            <Button key="clear-done" plain dimColor onPress={() => void change($, l => l.filter(t => t.isOpen))}>
              {done.length} settled · clear
            </Button>
          )}
          <Text dimColor>{fit('Click a topic to answer or discuss it. /topics add <text> notes one.', width)}</Text>
        </Box>
      </Box>
    )
  })
}
