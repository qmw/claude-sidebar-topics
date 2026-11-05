# sidebar-topics

A Claude Code mod that keeps a **Topics** pane beside the chat, listing the
points in this conversation on which Claude is waiting for you:

- `?` a question Claude asked you
- `!` a go-ahead Claude wants before doing something
- `•` information or a decision Claude needs

Click a topic to see the ask in Claude's words, then either type your answer
in the reply field and press Enter (it is sent into the conversation as
`About "<topic>": <your answer>` and the topic is settled), press **discuss**
to have Claude lay out the context and its recommendation for that topic, or
press **done** to settle it without a reply.

Topics come from two places. A question dialog (AskUserQuestion) is a topic
for as long as it is open. After every reply, a small model call (Haiku) reads
the reply and lists the asks in it that are still waiting on you, and marks
the open ones your last message or the reply settled. `/topics add <text>`
notes a topic by hand.

The pane opens by itself in a fullscreen terminal wide enough for a sidebar
(110 columns or more). `/topics` opens or focuses it anywhere; `/topics clear`
forgets every topic. The status line counts the open ones, and a toast appears
when a reply raises new ones. Topics are kept per session, so
`claude --resume` brings them back.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install sidebar-topics --marketplace qmw/claude-sidebar-topics
```

Answer `y` to add the marketplace, then pick a scope. The user scope, the
default, installs it once for every session you start afterwards. From a shell
the same install is:

```
claude plugin install sidebar-topics --marketplace qmw/claude-sidebar-topics --scope user
```

To run it from a checkout instead: `claude --plugin-dir <path to this folder>`.

## Cost

One Haiku call per reply, with the reply and your last message as its input.

## Files

- `.claude-plugin/plugin.json`: the manifest
- `.claude-plugin/marketplace.json`: makes this repository installable
- `hooks/hooks.json`, `hooks/register.tsx`: the hooks module
- `hooks/register.test.tsx`: tests, run with `claude plugin test .`
- `types/index.d.ts`: the topic type and the mod's state contract
