/**
 * What one session is doing, as the sidebar shows it:
 * - `idle`: started, no prompt sent yet
 * - `working`: a model turn runs
 * - `input`: the turn ended; the session waits for your next prompt
 * - `question`: an AskUserQuestion dialog is open
 * - `go`: a permission prompt waits for your approval
 */
export type TopicStatus = 'idle' | 'working' | 'input' | 'question' | 'go'

/** One session's record, kept in the mod's store under `topic:<session id>`. */
export type Topic = {
  /** The session id (`claude --resume <id>`). */
  id: string
  /** The directory the session runs in. */
  cwd: string
  /** The topic: the first prompt of the session, one line. */
  title: string
  status: TopicStatus
  /** What the session last said or asked: the question, or the answer's tail. */
  detail: string
  /** When the status last changed, ms since the epoch. */
  updatedAt: number
  /** The last heartbeat; a record not refreshed for a while is dropped. */
  seenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'sidebar-topics': {
      /** The records of every live session, as last read from the store. */
      topics: Shaped<Topic[]>
      /** The session id picked in the pane; '' for none. */
      selected: string
      /** How many replies were sent from the pane; bumps the reply field's key. */
      sent: number
      /** One line of feedback under the reply field. */
      notice: string
    }
  }
}
