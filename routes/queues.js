'use strict';
const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');
const { broadcast } = require('../socket/events');

// GET /api/queues/:branchId
router.get('/:branchId', (req, res) => {
  const id = parseInt(req.params.branchId);
  const branch = db.getBranch(id);
  if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });
  res.json({
    branch,
    state:        db.getQueueState(id),
    pending:      db.getPending(id),
    counts:       db.countPending(id),
    totalPending: db.getPending(id).length,
    avgMinutes:   db.getAvg(id),
  });
});

// POST /api/queues/:branchId/call
router.post('/:branchId/call', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  const { service, box } = req.body;
  const pending = db.getPending(branchId);
  const next    = pending.find(t => !service || t.service === service);
  if (!next) return res.status(404).json({ error: 'Sin tickets pendientes' });

  db.setStatus(next.id, 'called');
  db.setQueueState(branchId, next.number, next.service, box || 'Caja 1');
  broadcast(branchId, { type: 'TICKET_CALLED', ticket: next, box: box || 'Caja 1', pending: db.getPending(branchId) });
  res.json({ calledTicket: next, box: box || 'Caja 1', remaining: db.getPending(branchId).length });
});

// POST /api/queues/:branchId/finish
router.post('/:branchId/finish', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  db.setStatus(req.body.ticketId, 'finished');
  broadcast(branchId, { type: 'TICKET_FINISHED', ticketId: req.body.ticketId, pending: db.getPending(branchId) });
  res.json({ success: true });
});

// POST /api/queues/:branchId/absent
router.post('/:branchId/absent', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  db.setStatus(req.body.ticketId, 'absent');
  broadcast(branchId, { type: 'TICKET_ABSENT', ticketId: req.body.ticketId });
  res.json({ success: true });
});

module.exports = router;
