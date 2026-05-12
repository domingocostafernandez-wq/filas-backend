'use strict';
const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');
const { broadcast, callNext, finishTicket } = require('../socket/events');

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

// Ejecutivo llama siguiente — notifica por WS a todos
router.post('/:branchId/call', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  const { service, box } = req.body;
  const next = callNext(branchId, service, box, null);
  if (!next) return res.status(404).json({ error: 'Sin tickets pendientes' });
  res.json({ calledTicket: next, box: box || 'Caja 1', remaining: db.getPending(branchId).length });
});

// Ejecutivo finaliza — notifica por WS a cliente
router.post('/:branchId/finish', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  finishTicket(req.body.ticketId, branchId);
  res.json({ success: true });
});

router.post('/:branchId/absent', (req, res) => {
  const branchId = parseInt(req.params.branchId);
  db.setStatus(req.body.ticketId, 'absent');
  broadcast(branchId, { type: 'TICKET_ABSENT', ticketId: req.body.ticketId });
  res.json({ success: true });
});

module.exports = router;
