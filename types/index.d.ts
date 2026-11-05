/**
 * What kind of input a topic waits for:
 * - `question`: the assistant asked you something
 * - `go`: the assistant asks for a go-ahead before doing something
 * - `input`: the assistant needs information or a decision from you
 */
export type TopicKind = 'question' | 'go' | 'input'

/** One point in this conversation on which the assistant waits for you. */
export type Topic = {
  id: string
  /** One short line naming the topic. */
  title: string
  /** The ask itself, in the assistant's words. */
  detail: string
  kind: TopicKind
  /** True until you answered it, marked it done, or it was found settled. */
  isOpen: boolean
  /** When it was raised, ms since the epoch. */
  createdAt: number
  /** When it was settled, ms since the epoch. */
  resolvedAt?: number
}

/** What the store keeps per session, under `topics:<session id>`. */
export type TopicRecord = {
  savedAt: number
  topics: Topic[]
}

declare module 'claude-code' {
  interface PluginState {
    'sidebar-topics': {
      /** Every topic of this conversation, open and settled. */
      topics: Shaped<Topic[]>
      /** The topic id picked in the pane; '' for none. */
      selected: string
      /** How many replies went out from the pane; bumps the reply field's key. */
      sent: number
      /** One line of feedback under the card. */
      notice: string
      /** True while the last reply is being read for open asks. */
      busy: boolean
      /** The text of the last prompt you sent, for the reader's context. */
      lastPrompt: string
    }
  }
}
