# sidebar-topics

A Claude Code mod that keeps a **Topics** pane beside the chat, listing the
points on which Claude is waiting for you, in two sections:

- **This session**: the open asks of the conversation you are in
- **Other sessions**: the open asks of your other running Claude Code
  sessions, grouped by project

Each topic is marked by what it waits for:

- `?` a question Claude asked you
- `!` a go-ahead Claude wants before doing something
- `•` information or a decision Claude needs

Click a topic to see the ask in Claude's words. Type your answer in its field
and press Enter: for this session it goes into the conversation as
`About "<topic>": <your answer>` and settles the topic; for another session it
is delivered there as a message, and that session settles the topic when it
arrives. **discuss** asks the session to lay out the context and its
recommendation for that topic. **done** settles a topic of this session
without a reply, and **copy resume command** copies a `claude --resume` line
for another session.

Topics come from two places. A question dialog (AskUserQuestion) is a topic
for as long as it is open. After every reply, a small model call (Haiku) reads
the reply and lists the asks in it that are still waiting on you, and marks
the open ones your last message or the reply settled. `/topics add <text>`
notes a topic by hand.

The pane opens by itself in a fullscreen terminal wide enough for a sidebar
(110 columns or more). `/topics` opens or focuses it anywhere; `/topics clear`
forgets this session's topics. The status line counts the open topics here and
elsewhere, and a toast appears when a reply raises new ones or another session
starts waiting. Topics are kept per session, so `claude --resume` brings them
back.

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

Every session that should appear under "Other sessions" needs the mod loaded,
which the user scope gives you. To update later:

```
claude plugin marketplace update claude-sidebar-topics
claude plugin update sidebar-topics@claude-sidebar-topics
```

Running sessions pick up an update when they restart. To run the mod from a
checkout instead: `claude --plugin-dir <path to this folder>`.

## How the sessions see each other

Each session keeps its topics in the mod's own store, a JSON file under your
Claude Code configuration directory shared by all your sessions, under
`topics:<session id>`, with a heartbeat. The pane polls the store every three
seconds and shows the open topics of sessions heard from in the last 90
seconds. A session that ends stops showing at once; its topics stay for a
resume and are dropped after 30 days.

## Cost

One Haiku call per reply, with the reply and your last message as its input.

## Files

- `.claude-plugin/plugin.json`: the manifest
- `.claude-plugin/marketplace.json`: makes this repository installable
- `hooks/hooks.json`, `hooks/register.tsx`: the hooks module
- `hooks/register.test.tsx`: tests, run with `claude plugin test .`
- `types/index.d.ts`: the topic types and the mod's state contract
