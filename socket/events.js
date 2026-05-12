'use strict';
const { db } = require('../db/database');

const rooms         = new Map(); // branchId -> Set<ws>
const clientSockets = new Map(); // ticketId -> ws

function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    ws.isAlive   = true;
    ws.branchId  = null;
    ws.ticketId  = null;

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

  // Keepalive
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
      if (msg.ticketId) { ws.ticketId = msg.ticketId; clientSockets.set(msg.ticketId, ws); }
      if (!rooms.has(msg.branchId)) rooms.set(msg.branchId, new Set());
      rooms.get(msg.branchId).add(ws);

      const state   = db.getQueueState(msg.branchId);
      const pending = db.getPending(msg.branchId);
      const counts  = db.countPending(msg.branchId);
      send(ws, { type: 'QUEUE_STATE', state, pending, counts });
      break;
    }

    case 'CALL_NEXT': {
      const { branchId, service, box } = msg;
      const pending = db.getPending(branchId);
      const next    = pending.find(t => !service || t.service === service);
      if (!next) { send(ws, { type: 'NO_TICKETS' }); break; }

      db.setStatus(next.id, 'called');
      db.setQueueState(branchId, next.number, next.service, box || 'Caja 1');

      broadcast(branchId, { type: 'TICKET_CALLED', ticket: next, box: box || 'Caja 1' });

      // Notificar al cliente directamente
      sendTo(next.id, { type: 'YOUR_TURN', ticket: next, box: box || 'Caja 1' });

      // Avisar a los 3 siguientes
      const after = db.getPending(branchId);
      after.slice(0, 3).forEach((t, i) => sendTo(t.id, { type: 'ALMOST_YOUR_TURN', position: i + 1 }));
      break;
    }

    case 'FINISH_TICKET': {
      db.setStatus(msg.ticketId, 'finished');
      broadcast(msg.branchId, {
        type: 'TICKET_FINISHED',
        ticketId: msg.ticketId,
        pending: db.getPending(msg.branchId),
        counts:  db.countPending(msg.branchId),
      });
      break;
    }

    case 'MARK_ABSENT': {
      db.setStatus(msg.ticketId, 'absent');
      broadcast(msg.branchId, { type: 'TICKET_ABSENT', ticketId: msg.ticketId });
      break;
    }

    case 'CANCEL_TICKET': {
      db.setStatus(msg.ticketId, 'cancelled');
      broadcast(msg.branchId, {
        type: 'TICKET_CANCELLED',
        ticketId: msg.ticketId,
        pending: db.getPending(msg.branchId),
      });
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

function send(ws, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(data));
}

function sendTo(ticketId, data) {
  const ws = clientSockets.get(ticketId);
  send(ws, data);
}

function broadcast(branchId, data) {
  const payload = JSON.stringify(data);
  rooms.get(branchId)?.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
}

module.exports = { setupWebSocket, broadcast, send, sendTo, clientSockets };
