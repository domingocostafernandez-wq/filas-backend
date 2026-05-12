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

module.exports = { setupWebSocket, broadcast, send, sendTo, clientSockets, callNext, finishTicket };
