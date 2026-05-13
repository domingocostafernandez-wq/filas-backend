'use strict';
const { db } = require('../db/database');

const rooms         = new Map(); // branchId -> Set<ws>
const clientSockets = new Map(); // ticketId -> ws

function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    ws.isAlive  = true;
    ws.branchId = null;
    ws.ticketId = null;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try { handle(ws, JSON.parse(raw)); }
      catch { send(ws, { type: 'error', msg: 'JSON inválido' }); }
    });
    ws.on('close', () => {
      if (ws.branchId) rooms.get(ws.branchId)?.delete(ws);
      if (ws.ticketId) clientSockets.delete(ws.ticketId);
    });
  });

  const iv = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(iv));
}

function handle(ws, msg) {
  switch (msg.type) {

    case 'JOIN_BRANCH': {
      ws.branchId = msg.branchId;
      if (msg.ticketId) {
        ws.ticketId = msg.ticketId;
        clientSockets.set(msg.ticketId, ws);
        console.log(`✓ Cliente registrado: ticketId=${msg.ticketId} | Total clientes: ${clientSockets.size}`);
      }
      if (!rooms.has(msg.branchId)) rooms.set(msg.branchId, new Set());
      rooms.get(msg.branchId).add(ws);
      console.log(`✓ Sala ${msg.branchId}: ${rooms.get(msg.branchId).size} conexiones`);

      const state   = db.getQueueState(msg.branchId);
      const pending = db.getPending(msg.branchId);
      const counts  = db.countPending(msg.branchId);
      send(ws, { type: 'QUEUE_STATE', state, pending, counts });

      if (msg.ticketId) {
        const status = db.getTicketStatus(msg.ticketId);
        if (status) {
          console.log(`  Posición inicial: ${status.position}, turnos antes: ${status.turnsBefore}`);
          send(ws, { type: 'POSITION_UPDATE', ...status });
        }
      }
      break;
    }

    case 'CALL_NEXT': {
      const { branchId, service, box } = msg;
      callNext(branchId, service, box, ws);
      break;
    }

    case 'FINISH_TICKET': {
      const { ticketId, branchId } = msg;
      finishTicket(ticketId, branchId);
      break;
    }

    case 'MARK_ABSENT': {
      const { ticketId, branchId } = msg;
      db.setStatus(ticketId, 'absent');
      db.setQueueState(branchId, null, null, null);
      broadcast(branchId, { type: 'TICKET_ABSENT', ticketId, pending: db.getPending(branchId) });
      // Notificar al cliente que fue marcado ausente
      sendTo(ticketId, { type: 'TICKET_DONE', ticketId, reason: 'absent' });
      notifyAllPending(branchId);
      break;
    }

    case 'CANCEL_TICKET': {
      const { ticketId, branchId } = msg;
      db.setStatus(ticketId, 'cancelled');
      broadcast(branchId, {
        type: 'TICKET_CANCELLED', ticketId,
        pending: db.getPending(branchId),
      });
      notifyAllPending(branchId);
      break;
    }

    case 'CEDER_TICKET': {
      // Ceder de uno en uno hacia atrás
      const { ticketId, branchId } = msg;
      startCeder(ticketId, branchId);
      break;
    }

    case 'ACCEPT_CEDER': {
      const { ticketId, fromTicketId, branchId } = msg;
      finishCeder(fromTicketId, ticketId, branchId, true);
      break;
    }

    case 'REJECT_CEDER': {
      const { ticketId, fromTicketId, branchId } = msg;
      // Continuar con el siguiente
      advanceCeder(fromTicketId, branchId);
      break;
    }

    case 'REQUEST_SWAP': {
      const from = db.getTicket(msg.fromTicketId);
      const to   = db.getTicket(msg.toTicketId);
      if (!to) { send(ws, { type: 'SWAP_ERROR', msg: 'Usuario no disponible' }); break; }
      sendTo(msg.toTicketId, { type: 'SWAP_REQUEST', fromTicket: from, toTicket: to, expiresIn: 120 });
      send(ws, { type: 'SWAP_SENT' });
      break;
    }

    case 'ACCEPT_SWAP': {
      const result = db.swap(msg.fromTicketId, msg.toTicketId);
      if (!result) break;
      sendTo(msg.fromTicketId, { type: 'SWAP_ACCEPTED', newNumber: result.newNum1 });
      sendTo(msg.toTicketId,   { type: 'SWAP_ACCEPTED', newNumber: result.newNum2 });
      broadcast(msg.branchId, { type: 'QUEUE_UPDATED', pending: db.getPending(msg.branchId) });
      break;
    }

    case 'REJECT_SWAP': {
      sendTo(msg.fromTicketId, { type: 'SWAP_REJECTED' });
      break;
    }

    case 'PING':
      send(ws, { type: 'PONG' });
      break;
  }
}

// ── Lógica compartida (usada por WS y REST) ───────────────────────────────

function callNext(branchId, service, box, executiveWs) {
  const pending = db.getPending(branchId);
  const next    = pending.find(t => !service || t.service === service);
  if (!next) {
    if (executiveWs) send(executiveWs, { type: 'NO_TICKETS' });
    return null;
  }

  console.log(`📢 Llamando turno: ${next.number} (${next.id}) → ${box || 'Caja 1'}`);
  console.log(`   clientSockets registrados: ${clientSockets.size}`);
  clientSockets.forEach((_, id) => console.log(`   - ${id}`));

  db.setStatus(next.id, 'called');
  db.setQueueState(branchId, next.number, next.service, box || 'Caja 1');

  const afterPending = db.getPending(branchId);
  const counts = db.countPending(branchId);

  broadcast(branchId, {
    type: 'TICKET_CALLED',
    ticket: next,
    box: box || 'Caja 1',
    pending: afterPending,
    counts,
  });

  // Notificar directamente al cliente cuyo turno es
  const clientWs = clientSockets.get(next.id);
  console.log(`   WS del cliente llamado: ${clientWs ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
  sendTo(next.id, {
    type: 'YOUR_TURN',
    ticket: next,
    box: box || 'Caja 1',
    message: `¡Es tu turno! Dirígete a ${box || 'Caja 1'}`,
  });

  notifyAllPending(branchId);
  return next;
}

function finishTicket(ticketId, branchId) {
  db.setStatus(ticketId, 'finished');
  // Limpiar turno actual
  db.setQueueState(branchId, null, null, null);
  const pending = db.getPending(branchId);
  const counts  = db.countPending(branchId);

  broadcast(branchId, {
    type: 'TICKET_FINISHED',
    ticketId,
    pending,
    counts,
  });

  // Notificar al cliente que su ticket terminó (por si sigue en la app)
  sendTo(ticketId, { type: 'TICKET_DONE', ticketId });

  notifyAllPending(branchId);
}

// Notificar a cada cliente su posición actualizada
function notifyAllPending(branchId) {
  const pending = db.getPending(branchId);
  pending.forEach((t, i) => {
    const status = db.getTicketStatus(t.id);
    if (!status) return;
    sendTo(t.id, {
      type: 'POSITION_UPDATE',
      position:     i,
      turnsBefore:  i,
      estMinutes:   status.estMinutes,
      currentTurn:  pending[0]?.number || null,
      avgPerTicket: status.avgPerTicket,
    });
    // Avisar cuando faltan 3, 2 o 1
    if (i > 0 && i <= 3) {
      sendTo(t.id, { type: 'ALMOST_YOUR_TURN', position: i });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function send(ws, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(data));
}

function sendTo(ticketId, data) {
  send(clientSockets.get(ticketId), data);
}

function broadcast(branchId, data) {
  const payload = JSON.stringify(data);
  rooms.get(branchId)?.forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

// ── Ceder ticket — pregunta de uno en uno hacia atrás ─────────────────────

const cederSessions = new Map(); // fromTicketId -> { candidates, currentIdx, timer, branchId }

function startCeder(fromTicketId, branchId) {
  const pending = db.getPending(branchId);
  const fromIdx = pending.findIndex(t => t.id === fromTicketId);
  if (fromIdx === -1) return;

  // Candidatos: todos los que van DESPUÉS del que cede
  const candidates = pending.slice(fromIdx + 1);
  if (candidates.length === 0) {
    sendTo(fromTicketId, { type: 'CEDER_NO_CANDIDATES' });
    return;
  }

  cederSessions.set(fromTicketId, { candidates, currentIdx: 0, timer: null, branchId });
  askNextCandidate(fromTicketId);
}

function askNextCandidate(fromTicketId) {
  const session = cederSessions.get(fromTicketId);
  if (!session) return;

  const { candidates, currentIdx, branchId } = session;
  if (currentIdx >= candidates.length) {
    // Nadie aceptó
    sendTo(fromTicketId, { type: 'CEDER_NADIE_ACEPTO' });
    cederSessions.delete(fromTicketId);
    return;
  }

  const candidate = candidates[currentIdx];
  const fromTicket = db.getTicket(fromTicketId);

  // Notificar al candidato
  sendTo(candidate.id, {
    type:        'CEDER_REQUEST',
    fromTicket,
    toTicket:    candidate,
    expiresIn:   60,
    position:    currentIdx + 1,
    total:       candidates.length,
  });

  // Notificar al que cede quién está preguntando ahora
  sendTo(fromTicketId, {
    type:      'CEDER_ASKING',
    candidate: { name: candidate.client_name, number: candidate.number },
    position:  currentIdx + 1,
    total:     candidates.length,
    expiresIn: 60,
  });

  // Timer de 1 minuto — si no responde, avanzar al siguiente
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    advanceCeder(fromTicketId, branchId);
  }, 60000);
}

function advanceCeder(fromTicketId, branchId) {
  const session = cederSessions.get(fromTicketId);
  if (!session) return;
  session.currentIdx++;
  askNextCandidate(fromTicketId);
}

function finishCeder(fromTicketId, toTicketId, branchId, accepted) {
  const session = cederSessions.get(fromTicketId);
  if (session?.timer) clearTimeout(session.timer);
  cederSessions.delete(fromTicketId);

  if (!accepted) return;

  const fromTicket = db.getTicket(fromTicketId);
  const toTicket   = db.getTicket(toTicketId);
  if (!fromTicket || !toTicket) return;

  // El que recibe hereda el número del que cede
  const cedidoNumber = fromTicket.number;
  db.setStatus(fromTicketId, 'cancelled');

  // Actualizar número del receptor
  const t = db.getTicket(toTicketId);
  if (t) t.number = cedidoNumber;

  broadcast(branchId, {
    type:    'CEDER_ACCEPTED',
    fromTicketId,
    toTicketId,
    number:  cedidoNumber,
    pending: db.getPending(branchId),
  });

  // Notificar al que cedió
  sendTo(fromTicketId, {
    type:    'CEDER_DONE',
    toName:  toTicket.client_name,
    number:  cedidoNumber,
  });

  // Notificar al que recibió
  sendTo(toTicketId, {
    type:      'CEDER_RECEIVED',
    newNumber: cedidoNumber,
    fromName:  fromTicket.client_name,
  });

  notifyAllPending(branchId);
}

module.exports = { setupWebSocket, broadcast, send, sendTo, clientSockets, callNext, finishTicket };
