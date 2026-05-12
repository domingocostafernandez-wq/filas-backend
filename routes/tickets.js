'use strict';
const express = require('express');
const router  = express.Router();
const { db, uuidv4, PREFIXES } = require('../db/database');
const { broadcast } = require('../socket/events');

function categoryByRut(rut) {
  if (!rut) return 'E';
  const n = parseInt(rut.replace(/\D/g, '').slice(0, -1).slice(-1));
  if (n === 1) return 'A';
  if (n <= 3)  return 'B';
  if (n <= 5)  return 'C';
  return 'E';
}

// POST /api/tickets
router.post('/', (req, res) => {
  try {
    const { branch_id, service, rut, client_name, push_token } = req.body;
    if (!branch_id || !service) return res.status(400).json({ error: 'Faltan branch_id o service' });

    const branch = db.getBranch(branch_id);
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });

    const category = categoryByRut(rut);
    const id       = uuidv4();
    const number   = db.nextNumber(branch_id, service);
    const prefix   = PREFIXES[service] || 'E';

    const ticket = db.createTicket({
      id, number, prefix, branch_id, service,
      rut: rut || null,
      client_name: client_name || 'Cliente',
      category,
      status: 'pending',
      push_token: push_token || null,
    });

    const pending  = db.getPending(branch_id);
    const position = pending.findIndex(t => t.id === id) + 1;
    const avgs     = db.getAvg(branch_id);
    const avgMin   = avgs?.[service] || 4;

    broadcast(branch_id, { type: 'NEW_TICKET', ticket, pending });

    res.json({ ticket, position, estMinutes: (position - 1) * avgMin, totalPending: pending.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tickets/rut/:rut
router.get('/rut/:rut', (req, res) => {
  const ticket = db.getByRut(req.params.rut);
  if (!ticket) return res.status(404).json({ error: 'Sin ticket activo para este RUT' });
  const pending  = db.getPending(ticket.branch_id);
  const position = pending.findIndex(t => t.id === ticket.id) + 1;
  res.json({ ticket, position, totalPending: pending.length });
});

// GET /api/tickets/:id
router.get('/:id', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  const pending  = db.getPending(ticket.branch_id);
  const position = pending.findIndex(t => t.id === ticket.id) + 1;
  const avgs     = db.getAvg(ticket.branch_id);
  res.json({ ticket, position: position > 0 ? position : null, estMinutes: position > 0 ? (position - 1) * (avgs?.[ticket.service] || 4) : 0, totalPending: pending.length });
});

// DELETE /api/tickets/:id
router.delete('/:id', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  db.setStatus(req.params.id, 'cancelled');
  broadcast(ticket.branch_id, { type: 'TICKET_CANCELLED', ticketId: req.params.id, pending: db.getPending(ticket.branch_id) });
  res.json({ success: true });
});

module.exports = router;
