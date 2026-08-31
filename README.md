# greed

orchestrator for claude code threads.

many claude sessions at once, in a grid, like an rts overview. you send a prompt, the chat runs on its own, the card glows when it is done so you stop forgetting finished work.

## what it is

a local web app on top of the claude agent sdk. single user, no accounts, no cloud. each card is a full claude code session running in a project folder, with live streaming, in-card permissions, resume, and memory.

auth is your claude subscription via the existing claude code login. it never asks for or stores an api key.

## run

needs node 18+ and claude code installed and logged in (`claude login`). there is an `.nvmrc` pinned to node 22, so `nvm use` picks the version this was built on.

```bash
npm install
npm run dev
```

then open http://localhost:5173.

`npm test` runs the test suite (host/origin matching plus a real server booted on an ephemeral port); `npm run typecheck` checks the types.

## phone (tailscale or lan)

greed binds to 127.0.0.1 and only answers to localhost by default. two env vars open it up:

- `GREED_HOST` — address the server listens on. default `127.0.0.1`. set it to one of the machine's addresses to make greed reachable from that network. `0.0.0.0` (every interface at once) also works, but it is opt-in on purpose: on a laptop it follows you onto café wifi.
- `GREED_ALLOWED_HOSTS` — extra hostnames accepted in the Host and Origin headers, on top of the loopback names and the bind address itself. comma or space separated. matching is exact after normalisation (case-insensitive, port ignored, a pasted scheme or trailing dot is stripped) — never substring.

everything lives on the server, so the phone is a second live window onto the same board, not a copy: history, streaming, permission prompts and previews are shared, and answering a prompt on the phone clears it on the desktop.

### over tailscale

1. install tailscale on the mac and on the iphone, sign both into the same account.
2. `tailscale status` on the mac shows its magicdns name (say `mac.tailnet-name.ts.net`) and its tailnet ip (`100.x.y.z`).
3. build once, then run bound to the tailnet:

```bash
npm run build
GREED_HOST=100.x.y.z GREED_ALLOWED_HOSTS=mac.tailnet-name.ts.net npm start
```

4. on the iphone, open `http://mac.tailnet-name.ts.net:4517` in safari. share → add to home screen gives it an icon and opens it full screen, without safari chrome.

with tailscale off on the phone the address simply stops resolving, which is the point: only devices in your tailnet can reach it.

### over plain lan

same idea bound to the mac's lan address, reached by its `.local` mdns name:

```bash
npm run build
GREED_HOST=192.168.x.y GREED_ALLOWED_HOSTS=your-mac.local npm start
```

then open `http://your-mac.local:4517` on the phone. caveat: anyone on that wifi can reach the port. fine at home, not in a café — prefer tailscale anywhere you don't own the network.

### what the host check is, and is not

the Host/Origin allowlist stops browsers from being tricked into talking to greed (dns rebinding, cross-site websocket hijacking). it is not authentication. anyone who can route to the bound address gets full access: driving claude sessions with filesystem write, and reading the project working folders through the preview route. on a tailnet that is acceptable because the network itself is the boundary; it is also exactly why you should not bind this to a public interface. while the bind stays on loopback, requests without a Host header and websockets without an Origin are accepted (local tools do that); the moment `GREED_HOST` leaves loopback, both headers become required and must match the allowlist.

### dev server

`npm run dev` picks up the same two variables — vite listens on `GREED_HOST`, accepts `GREED_ALLOWED_HOSTS`, and proxies to wherever the backend went. it works over the network, but for the phone prefer `npm run build && npm start`: one port, one origin, no proxy in the path.

## what it does

- projects: register a folder (like a repo). the session runs there and uses its claude.md and .mcp.json.
- memory: each project remembers durable facts across sessions, on optmem. see below.
- documents: attach pdf, docx, xlsx, md. text gets extracted and indexed, so a new chat months later knows the docs exist and can read them.
- per chat: pick model (explicit version), reasoning effort, permission mode (ask, or autonomous by default), and account (which claude subscription pays for it).
- attachments: paperclip or drag and drop.
- import: pull an existing claude code thread in as a card. it resumes the same session in the same folder, so the model keeps the context it already had.
- rename: double click a card title, or hit ✎ in history and in the projects list. renaming a project updates the chats that use it.
- delete: ✕ in history throws a chat away for good, transcript included. it asks first.
- resizable cards: drag the bottom right corner. the card takes exactly the size you drag, width and height, and the others move around it while you drag. the size sticks per chat.
- themes: three dark (orange, purple, green) and three light (paper, sage, lilac). pick one of each; on ◐ auto greed follows the os appearance, so it goes light by day and dark at sunset on its own. the button says which mode is on and the swatch in use is ringed.
- deliverables: the bar under each card lists what that chat just wrote (html, md, pdf, svg, csv, txt) and opens it in a 16:9 preview you can resize, reload and download. by default it shows only the batch from the last turn, so asking for a v2 shows the v2; `tudo N` opens everything the chat ever produced. the list is per chat, not per folder, even when several chats share a project.
- finder tag: on macos every file a chat creates gets tagged `greed` (yellow), so they are one click away in the finder sidebar and in `mdfind "kMDItemUserTags == 'greed'"`. existing tags on a file are kept. rename it with `GREED_FINDER_TAG`, or set it empty to turn it off. no-op on other systems.
- shortcuts: cmd/ctrl+k new chat, cmd/ctrl+1..9 jump between cards.

## accounts (profiles)

one claude login is enough, but if you have more than one subscription (say personal and work) each board can run on a different account.

a profile is just a claude code config folder. `~/.claude` is the default one; any `~/.claude-<name>` folder that has been logged in once is another account. to add one:

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude-work claude
# inside it, run: /login
```

greed detects the `~/.claude*` folders automatically. when there is more than one, the new chat modal shows an account picker, the card shows an `@name` badge, and everything that session spawns (the agent, /btw, background helpers) is billed to that account. boards with no explicit account use the default profile (`~/.claude`, or whatever `CLAUDE_CONFIG_DIR` the server was started with). the consumo page gets the same picker: subscription limits and history are tracked per account, while insights stay machine-wide.

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

multi user, remote deploy, public exposure (no auth, no accounts, no tunnels — see the phone section for what the host check does and does not protect). the phone gets the desktop layout in single-column form; a real mobile ui pass is its own project.

built on macos (document text extraction uses native macos tools).
