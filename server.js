/**
 * ╔══════════════════════════════════════════════════╗
 * ║   DIBAU – Servidor de Relay WebSocket Online     ║
 * ║   Conecta jogadores de qualquer parte do mundo   ║
 * ║   Host cria sala → recebe código de 6 letras     ║
 * ║   Guest entra com o código → jogo começa         ║
 * ╚══════════════════════════════════════════════════╝
 *
 * Como funciona:
 *  - O Godot (host) envia CREATE_ROOM  → servidor cria sala e devolve código
 *  - O Godot (guest) envia JOIN_ROOM:{code} → servidor junta os dois
 *  - Toda mensagem de jogo é um relay simples: o que um envia, o outro recebe
 *  - Sem lógica de jogo no servidor → tudo roda no Godot (host é autoridade)
 */

const WebSocket = require('ws');
const http      = require('http');

const PORT = process.env.PORT || 8080;

// ── Estrutura de salas ──
// rooms: Map<código, { host: ws, guest: ws|null, createdAt: number }>
const rooms = new Map();

// ── Servidor HTTP simples (necessário para plataformas como Render/Railway) ──
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Dibau Relay Server OK | Salas ativas: ${rooms.size}\n`);
});

const wss = new WebSocket.Server({ server: httpServer });

// ── Utilitários ──
function generateCode() {
  // Letras e números fáceis de digitar, sem ambiguidade (sem 0/O, 1/I, etc.)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function relay(ws, obj) {
  if (!ws || !ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  // Envia para o adversário
  const other = ws.role === 'host' ? room.guest : room.host;
  send(other, obj);
}

// ── Conexão WebSocket ──
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[+] Conexão de ${ip}`);

  ws.roomCode = null;
  ws.role     = null;  // 'host' | 'guest'
  ws.isAlive  = true;

  // Keepalive ping/pong
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      send(ws, { type: 'ERROR', msg: 'JSON inválido' });
      return;
    }

    console.log(`[MSG] ${ws.role || 'sem-sala'} | ${msg.type}`);

    switch (msg.type) {

      // ── HOST cria sala ──
      case 'CREATE_ROOM': {
        if (ws.roomCode) {
          send(ws, { type: 'ERROR', msg: 'Já estás numa sala.' });
          return;
        }
        let code;
        let attempts = 0;
        do {
          code = generateCode();
          attempts++;
        } while (rooms.has(code) && attempts < 100);

        rooms.set(code, {
          host:      ws,
          guest:     null,
          createdAt: Date.now(),
        });
        ws.roomCode = code;
        ws.role     = 'host';

        send(ws, { type: 'ROOM_CREATED', code });
        console.log(`[SALA] Criada: ${code}`);
        break;
      }

      // ── GUEST entra na sala ──
      case 'JOIN_ROOM': {
        if (ws.roomCode) {
          send(ws, { type: 'ERROR', msg: 'Já estás numa sala.' });
          return;
        }
        const code = (msg.code || '').toUpperCase().trim();
        if (!code || code.length !== 6) {
          send(ws, { type: 'ERROR', msg: 'Código inválido.' });
          return;
        }
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'ERROR', msg: 'Sala não encontrada. Verifica o código.' });
          return;
        }
        if (room.guest !== null) {
          send(ws, { type: 'ERROR', msg: 'Sala já está cheia.' });
          return;
        }

        room.guest  = ws;
        ws.roomCode = code;
        ws.role     = 'guest';

        send(ws, { type: 'JOINED', code });
        // Avisa o host que o guest entrou
        send(room.host, { type: 'GUEST_JOINED' });
        console.log(`[SALA] Guest entrou em: ${code}`);
        break;
      }

      // ── RELAY: mensagem de jogo (qualquer tipo de dado do Godot) ──
      case 'RELAY': {
        relay(ws, { type: 'RELAY', data: msg.data });
        break;
      }

      // ── PING manual ──
      case 'PING': {
        send(ws, { type: 'PONG' });
        break;
      }

      default:
        send(ws, { type: 'ERROR', msg: `Tipo desconhecido: ${msg.type}` });
    }
  });

  // ── Desconexão ──
  ws.on('close', () => {
    console.log(`[-] Desconectado: ${ws.role || 'sem-sala'} ${ws.roomCode || ''}`);
    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const other = ws.role === 'host' ? room.guest : room.host;
    send(other, { type: 'OPPONENT_LEFT' });

    if (ws.role === 'host') {
      // Host saiu → encerra a sala
      rooms.delete(ws.roomCode);
      console.log(`[SALA] Encerrada: ${ws.roomCode}`);
    } else {
      // Guest saiu → sala continua, host pode aceitar novo guest
      room.guest = null;
    }
  });

  ws.on('error', (err) => {
    console.error(`[ERRO] ${err.message}`);
  });
});

// ── Keepalive a cada 30s (evita timeout em plataformas de cloud) ──
const keepAliveInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(keepAliveInterval));

// ── Limpa salas antigas (> 3 horas) a cada 15 minutos ──
setInterval(() => {
  const now = Date.now();
  const limit = 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (now - room.createdAt > limit) {
      send(room.host,  { type: 'ROOM_EXPIRED' });
      send(room.guest, { type: 'ROOM_EXPIRED' });
      rooms.delete(code);
      console.log(`[SALA] Expirada: ${code}`);
    }
  }
}, 15 * 60 * 1000);

// ── Inicia servidor ──
httpServer.listen(PORT, () => {
  console.log(`\n✅  Dibau Relay Server rodando na porta ${PORT}`);
  console.log(`    WebSocket: ws://localhost:${PORT}`);
  console.log(`    HTTP:      http://localhost:${PORT}\n`);
});
