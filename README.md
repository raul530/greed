# greed

orchestrator for claude code threads.

many claude sessions at once, in a grid, like an rts overview. you send a prompt, the chat runs on its own, the card glows when it is done so you stop forgetting finished work.

## what it is

a local web app on top of the claude agent sdk. single user, no accounts, no cloud. each card is a full claude code session running in a project folder, with live streaming, in-card permissions, resume, and memory.

auth is your claude subscription via the existing claude code login. it never asks for or stores an api key.

## run

needs node 18+ and claude code installed and logged in (`claude login`).

```bash
npm install
npm run dev
```

then open http://localhost:5173.

## what it does

- projects: register a folder (like a repo). the session runs there and uses its claude.md and .mcp.json.
- memory: each project remembers durable facts across sessions, on optmem. see below.
- documents: attach pdf, docx, xlsx, md. text gets extracted and indexed, so a new chat months later knows the docs exist and can read them.
- per chat: pick model (explicit version), reasoning effort, and permission mode (ask, or autonomous by default).
- attachments: paperclip or drag and drop.
- resizable cards: drag the bottom right corner. width snaps to grid columns so the other cards reflow around it, height is free. the size sticks per chat.
- themes: orange, purple, green.
- shortcuts: cmd/ctrl+k new chat, cmd/ctrl+1..9 jump between cards.

## memory

each project has its own memory. after every turn a cheap model pulls durable facts out of the conversation and appends them to the project log. the log is append only and never edited, so nothing is ever deleted or overwritten.

what goes into the system prompt is not the whole log. it is a cover of it, built by [optmem](https://github.com/VictorTaelin/OptMem): recent memories verbatim, older ones folded into one line summaries, older still into summaries of summaries. the tree is binary, so the context stays a fixed number of lines no matter how much the project remembers. 60 memories or 60 thousand, the cost is the same.

detail is not lost, only folded. the agent gets two tools to unfold it:

- `memory_recall` regex search over every memory ever recorded
- `memory_zoom` open a summary block into its two halves, down to the raw lines

the store is byte compatible with optmem itself, so taelin's tool reads it directly:

```bash
MEMORY_DIR=data/memory/<project-id> ~/.optmem/memo wake
```

reading budget is 64 lines. change it per project in `data/memory/<project-id>/config`, or globally with `GREED_WAKE_LINES`. it is a reading budget, not a storage budget: change it whenever, nothing is recomputed.

old `data/memory/<project-id>.json` files are imported automatically on first run and kept as `.json.imported`.

memory, titles and document descriptions all run on haiku with connectors and extended thinking off. those two flags matter a lot: with them on, a one line call was costing 22k input tokens and 10k thinking tokens.

## credits

the memory system is [optmem](https://github.com/VictorTaelin/OptMem) by [victor taelin](https://github.com/VictorTaelin). the log format, the binary merge tree and the `cover` algorithm are his design, ported to typescript and wired into greed's automatic capture. greed differs in one way: taelin's agent runs `memo note` and pays its own compressions, while here a cheap model does both in the background between turns.

## not in scope

multi user, remote deploy, mobile.

built on macos (document text extraction uses native macos tools).
