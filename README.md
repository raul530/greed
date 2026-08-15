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
- memory: each project remembers durable facts across sessions.
- documents: attach pdf, docx, xlsx, md. text gets extracted and indexed, so a new chat months later knows the docs exist and can read them.
- per chat: pick model (explicit version), reasoning effort, and permission mode (ask, or autonomous by default).
- attachments: paperclip or drag and drop.
- themes: orange, purple, green.
- shortcuts: cmd/ctrl+k new chat, cmd/ctrl+1..9 jump between cards.

## not in scope

multi user, remote deploy, mobile.

built on macos (document text extraction uses native macos tools).
