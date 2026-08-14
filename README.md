# 🍱 Bento

Orquestrador local de chats Claude — todos os seus chats ao mesmo tempo, num grid
estilo bento box, como o overview de um RTS.

Cada card é uma sessão completa do [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
rodando no working directory de um projeto seu, com streaming em tempo real,
pedidos de permissão dentro do card e resume com contexto completo.

## Requisitos

- Node.js 18+
- [Claude Code](https://claude.com/claude-code) instalado e logado (`claude login`).
  O Bento autentica pela sua assinatura via o login existente do Claude Code —
  **nunca pede nem armazena API key** (a variável `ANTHROPIC_API_KEY` é inclusive
  removida do ambiente das sessões para garantir isso).

## Rodando

```bash
npm install
npm run dev
```

Abra http://localhost:5173. O backend sobe em `127.0.0.1:4517` (somente localhost).

Para rodar sem o Vite dev server: `npm run build` e depois `npm start`
(serve o frontend buildado direto do backend, em http://localhost:4517).

## Uso

1. **Projetos** → registre pastas. Cada projeto é uma pasta com seu próprio
   `CLAUDE.md` e `.mcp.json` (formato padrão do Claude Code — seus MCPs de
   Atlassian, Slack, Drive etc. funcionam sem mudança). A sessão roda com esse
   working directory.
2. **+ Novo chat** (⌘K) → escolha o projeto, escreva o primeiro prompt. O card
   abre no grid e o título é gerado automaticamente.
3. O **✕** só tira o card da tela — a sessão vai para o **Histórico** e pode ser
   reaberta a qualquer momento com contexto completo (resume do SDK).

### Estados do card

| Estado | Visual |
| --- | --- |
| Trabalhando | ponto azul pulsando + indicador de atividade |
| Terminou | borda verde brilhando até você clicar no card + notificação de desktop |
| Esperando você | borda âmbar brilhando + pedido de permissão dentro do card (Permitir/Negar) |
| Idle | ponto apagado |

### Atalhos

- `⌘/Ctrl + 1..9` — pula para o card N (control groups de RTS).
  No Chrome/macOS use `Ctrl` (o navegador reserva `⌘+número` para trocar de aba).
- `⌘/Ctrl + K` — novo chat
- `Enter` envia · `Shift+Enter` quebra linha · `⌘⏎` envia no modal
- `Esc` — fecha modal / fullscreen
- Duplo clique no cabeçalho (ou ⤢) — expande o card para fullscreen

Ative as notificações de desktop pelo sininho na barra superior para ser avisado
quando um chat terminar ou pedir permissão, mesmo com a janela em segundo plano.

## Arquitetura

```
server/   Node + Express + ws — um SessionManager mantém cada sessão do Agent SDK
          viva em modo streaming input; canUseTool vira pedido de permissão no card;
          Stop/SessionEnd hooks + result marcam os estados; transcripts e session_ids
          persistem em data/ (gitignored)
web/      Vite + React — grid de cards, streaming via WebSocket, markdown, tema escuro
shared/   tipos do protocolo WS compartilhados entre server e web
```

Single user, 100% local. Fora de escopo: multi-usuário, deploy remoto, mobile.
