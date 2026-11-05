import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peer, Topic, TopicKind, TopicRecord } from '../types'

const PANE = 'topics'
const TITLE = 'Topics'
const KEY = 'topics:'
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const POLL_MS = 3_000
const BEAT_MS = 20_000
// A session that has not refreshed its record for this long is not shown.
const STALE_MS = 90_000
const READER_MODEL = 'haiku'

// Change the tag when a topic's fields change: it declines what an earlier
// version stored, which outlives a reload.
const topics = atom({ plugin: 'sidebar-topics', key: 'topics' } as const, [], {
  shape: 'topics-2',
})
const others = atom({ plugin: 'sidebar-topics', key: 'others' } as const, [], {
  shape: 'others-1',
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

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const glyph = (kind: TopicKind) => (kind === 'question' ? '?' : kind === 'go' ? '!' : '•')

const tint = (kind: TopicKind) => (kind === 'go' ? 'yellow' : kind === 'question' ? 'cyan' : 'green')

const label = (kind: TopicKind) =>
  kind === 'question' ? 'a question for you' : kind === 'go' ? 'waits for your go' : 'needs your input'

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const isTopic = (t: unknown): t is Topic =>
  !!t && typeof t === 'object' && typeof (t as Topic).id === 'string' && typeof (t as Topic).title === 'string'

/** Writes this session's record to the store: the list, and a heartbeat. */
async function save($: EngineInterface, list: Topic[], seenAt?: number) {
  const now = await $.clock.now()
  const sessionId = await $.session.id()
  const record: TopicRecord = {
    sessionId,
    cwd: await $.session.cwd(),
    savedAt: now,
    seenAt: seenAt ?? now,
    topics: list,
  }
  await $.store.set(KEY + sessionId, record)
}

/** Reads this session's list from the store; drops other sessions' old ones. */
async function load($: EngineInterface): Promise<Topic[]> {
  const mine = KEY + (await $.session.id())
  const now = await $.clock.now()
  let found: Topic[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY)) continue
    const record = (await $.store.get(key)) as Partial<TopicRecord> | undefined
    const list = Array.isArray(record?.topics) ? record.topics.filter(isTopic) : []
    if (key === mine) {
      found = list
    } else if (typeof record?.savedAt !== 'number' || now - record.savedAt > KEEP_MS) {
      await $.store.delete(key)
    }
  }
  return found
}

function status($: EngineInterface, mine: Topic[], peers: Peer[]) {
  const here = mine.filter(t => t.isOpen).length
  const elsewhere = peers.reduce((n, p) => n + p.topics.length, 0)
  const parts = [here > 0 ? `${here} here` : '', elsewhere > 0 ? `${elsewhere} elsewhere` : ''].filter(Boolean)
  $.ui.status(parts.length > 0 ? `topics: ${parts.join(' · ')}` : undefined)
}

/** Changes this session's list, keeps it, and refreshes the status line. */
async function change($: EngineInterface, fn: (list: Topic[]) => Topic[]) {
  const list = await update($, topics, fn)
  await save($, list)
  status($, list, await read($, others))
  return list
}

/** Reads the other live sessions' open topics from the store into the pane. */
async function poll($: EngineInterface) {
  const mine = await $.session.id()
  const now = await $.clock.now()
  const peers: Peer[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY) || key === KEY + mine) continue
    const record = (await $.store.get(key)) as Partial<TopicRecord> | undefined
    if (!record || typeof record.seenAt !== 'number' || now - record.seenAt > STALE_MS) continue
    const open = (Array.isArray(record.topics) ? record.topics.filter(isTopic) : []).filter(t => t.isOpen)
    if (open.length === 0) continue
    peers.push({
      sessionId: record.sessionId ?? key.slice(KEY.length),
      cwd: record.cwd ?? '',
      topics: open.sort((a, b) => b.createdAt - a.createdAt),
    })
  }
  peers.sort((a, b) => (b.topics[0]?.createdAt ?? 0) - (a.topics[0]?.createdAt ?? 0))
  const before = await read($, others)
  if (JSON.stringify(before) === JSON.stringify(peers)) return
  const known = new Set(before.flatMap(p => p.topics.map(t => t.id)))
  const fresh = peers.flatMap(p => p.topics.filter(t => !known.has(t.id)).map(t => ({ peer: p, topic: t })))
  if (fresh.length > 0 && before.length + known.size > 0) {
    const first = fresh[0]
    if (first) $.ui.toast(`${base(first.peer.cwd)}: ${glyph(first.topic.kind)} ${fit(first.topic.title, 60)}`)
  }
  await update($, others, () => peers)
  status($, await read($, topics), peers)
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

async function settleByTitle($: EngineInterface, title: string) {
  const ids = (await read($, topics)).filter(t => t.isOpen && sameTitle(t.title, title)).map(t => t.id)
  await settle($, ids)
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
    if (added > 0) $.ui.toast(`${plural(added, 'topic')} await${added === 1 ? 's' : ''} you`)
  } catch (error) {
    $.ui.log(`sidebar-topics: reading the reply failed: ${String(error)}`, { to: 'debug' })
  } finally {
    await update($, busy, () => false)
  }
}

/** Where a picked topic lives: this session, or a peer. */
type Found = { topic: Topic; peer?: Peer }

async function find($: EngineInterface, id: string): Promise<Found | undefined> {
  const mine = (await read($, topics)).find(t => t.id === id)
  if (mine) return { topic: mine }
  for (const peer of await read($, others)) {
    const topic = peer.topics.find(t => t.id === id)
    if (topic) return { topic, peer }
  }
  return undefined
}

/** Sends text into the topic's session: this one's prompt, or a peer message. */
async function deliver($: EngineInterface, found: Found, text: string): Promise<string> {
  if (!found.peer) {
    void $.prompt.submit({ text })
    return 'this session'
  }
  const result = await $.session.send({ to: { sessionId: found.peer.sessionId }, text })
  if (!result.isDelivered) throw new Error(result.reason)
  return base(found.peer.cwd)
}

/** Your answer to a topic, sent into its session; a topic of this session is settled. */
async function answer($: EngineInterface, found: Found, text: string) {
  const body = text.trim()
  if (body.length === 0) return
  try {
    const where = await deliver($, found, `About "${found.topic.title}": ${body}`)
    if (!found.peer) await settle($, [found.topic.id])
    await update($, notice, () => `Answered in ${where}.`)
  } catch (error) {
    await update($, notice, () => `Not delivered: ${String(error)}`)
  }
  await update($, sent, n => n + 1)
}

async function discuss($: EngineInterface, found: Found) {
  const { topic } = found
  try {
    const where = await deliver(
      $,
      found,
      `Let's discuss the open topic "${topic.title}": ${topic.detail}\nGive me the context and your recommendation, then wait for my answer.`,
    )
    await update($, notice, () => `Asked ${where} to discuss it.`)
  } catch (error) {
    await update($, notice, () => `Not delivered: ${String(error)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'topics',
      description: 'Open the Topics pane; `/topics add <text>` notes a topic, `/topics clear` forgets all',
    })
    const stored = await load($)
    await change($, list => (list.length > 0 ? list : stored))
    await poll($)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(POLL_MS, () => poll($))
    $.clock.every(BEAT_MS, async () => save($, await read($, topics)))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Keep the list for a resume, but stop showing this session to the others.
    await save($, await read($, topics), 0)
    $.ui.status(undefined)

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

  // An answer sent from another session's pane settles the topic it names.
  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined && (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message')) {
      const named = /^About "([^"]+)": /.exec(e.text)
      if (named?.[1]) await settleByTitle($, named[1])
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
    const peers = await read($, others)
    const picked = await read($, selected)
    const count = await read($, sent)
    const line = await read($, notice)
    const reading = await read($, busy)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const open = list.filter(t => t.isOpen).sort((a, b) => b.createdAt - a.createdAt)
    const done = list.filter(t => !t.isOpen)
    const chosen = await find($, picked)
    const elsewhere = peers.reduce((n, p) => n + p.topics.length, 0)

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
            This session <Text dimColor>({open.length})</Text>
          </Text>
          {open.length === 0 && <Text dimColor>Nothing waits for you here.</Text>}
          {open.map(row)}
          {reading && <Text dimColor>Reading the last reply…</Text>}
        </Box>
        <Box flexDirection="column">
          <Text weight="bold">
            Other sessions <Text dimColor>({elsewhere})</Text>
          </Text>
          {peers.length === 0 && <Text dimColor>No other session waits for you.</Text>}
          {peers.map(peer => (
            <Box key={`peer:${peer.sessionId}`} flexDirection="column">
              <Text dimColor>{fit(base(peer.cwd) || peer.sessionId, width)}</Text>
              {peer.topics.map(row)}
            </Box>
          ))}
        </Box>
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text weight="bold">{fit(chosen.topic.title, width - 4)}</Text>
            <Text dimColor>
              {chosen.peer ? `${base(chosen.peer.cwd)} · ` : ''}
              {label(chosen.topic.kind)} · {age(now - chosen.topic.createdAt)} ago
              {chosen.topic.isOpen ? '' : ' · settled'}
            </Text>
            {chosen.topic.detail.length > 0 && <Text wrap="wrap">{chosen.topic.detail}</Text>}
            <Input
              key={`reply:${chosen.topic.id}:${count}`}
              placeholder={chosen.peer ? 'Your answer, Enter sends it to that session' : 'Your answer, Enter sends it'}
              submitLabel="send"
              rows={2}
              onSubmit={value => void answer($, chosen, value)}
            />
            {line.length > 0 && <Text dimColor>{line}</Text>}
            <Box flexDirection="row" gap={1}>
              <Button key="discuss" plain onPress={() => void discuss($, chosen)}>
                discuss
              </Button>
              {!chosen.peer && chosen.topic.isOpen && (
                <Button key="done" plain dimColor onPress={() => void settle($, [chosen.topic.id])}>
                  done
                </Button>
              )}
              {chosen.peer && (
                <Button
                  key="copy-resume"
                  plain
                  dimColor
                  onPress={press =>
                    void $.ui.copy({ text: `claude --resume ${chosen.peer?.sessionId ?? ''}`, surface: press.surface })
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
