# sidebar-topics

A Claude Code mod that keeps a **Topics** sidebar beside the chat. It lists
every Claude Code session you have running on this machine, with the ones
that are waiting for you at the top:

- `?` the session asks you a question (an AskUserQuestion dialog is open)
- `!` the session waits for your go (a permission prompt)
- `•` the session finished its turn and waits for your next prompt
- `~` the session is working

Click a topic to see what that session last said or asked, then type a reply
and press Enter. A reply to the session you are in goes to its prompt; a reply
to another session is delivered to it as a message, and it answers there. The
detail card also offers to copy a `claude --resume <id>` line for that session.

The pane opens by itself in a fullscreen terminal wide enough for a sidebar
(110 columns or more). `/topics` opens or focuses it anywhere; `/topics clear`
forgets every record. The status line shows how many other topics are waiting,
and a toast appears when another session starts waiting for you.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install sidebar-topics --marketplace qmw/claude-sidebar-topics
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it for
every session). From a shell the same line is `claude plugin install
sidebar-topics --marketplace qmw/claude-sidebar-topics`. Every session that
should appear in the sidebar needs the mod loaded, so install it at the user
scope.

To run it from a checkout instead: `claude --plugin-dir <path to this folder>`.

## How it works

Each session running the mod keeps one record in the mod's own store (a JSON
file under your Claude Code configuration directory, shared by all your
sessions): the session id, its directory, the first prompt as the topic title,
its status, and the last question or the tail of the last answer. The record is
updated on turn start, turn end, question dialogs and permission prompts,
refreshed by a heartbeat, removed when the session ends, and dropped by any
session that finds it stale (no heartbeat for 90 seconds). The pane polls the
store every two seconds.

## Files

- `.claude-plugin/plugin.json`: the manifest
- `.claude-plugin/marketplace.json`: makes this repository installable
- `hooks/hooks.json`, `hooks/register.tsx`: the hooks module
- `types/index.d.ts`: the record type and the mod's state contract
