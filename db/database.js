'use strict';
const { v4: uuidv4 } = require('uuid');

const branches   = new Map();
const tickets    = new Map();
const queueState = new Map();
const callTimes  = new Map(); // ticketId -> timestamp cuando fue llamado (para calcular promedio)
const avgTimes   = new Map(); // branchId+service -> promedio en segundos

const PREFIXES = { caja: 'C', atencion: 'B', ejecutivo: 'A' };
const PRIORITY = { A: 1, B: 2, C: 3, E: 4 };

// Sucursal demo
branches.set(1, {
  id: 1, name: 'Chillán Centro', ciudad: 'Chillán',
  is_open: 1, avg_caja: 4, avg_atencion: 10, avg_ejecutivo: 6,
});
queueState.set(1, {
  branch_id: 1, current_ticket: null,
  current_service: null, current_box: null,
  last_updated: new Date().toISOString(),
});

// Tickets de demo
const DEMO = [
  { service: 'caja',      category: 'E', name: 'Juan P.'   },
  { service: 'caja',      category: 'C', name: 'María G.'  },
  { service: 'atencion',  category: 'B', name: 'Carlos R.' },
  { service: 'caja',      category: 'E', name: 'Ana M.'    },
  { service: 'ejecutivo', category: 'A', name: 'Pedro L.'  },
  { service: 'caja',      category: 'C', name: 'Sofía V.'  },
  { service: 'atencion',  category: 'E', name: 'Luis T.'   },
  { service: 'caja',      category: 'E', name: 'Carmen F.' },
  { service: 'atencion',  category: 'B', name: 'Diego A.'  },
  { service: 'caja',      category: 'C', name: 'Paula S.'  },
];

console.log(`✓ BD en memoria lista · cola vacía`);

function getPending(branchId) {
  return [...tickets.values()]
    .filter(t => t.branch_id === branchId && t.status === 'pending')
    .sort((a, b) => {
      const diff = (PRIORITY[a.category]||4) - (PRIORITY[b.category]||4);
      return diff !== 0 ? diff : new Date(a.created_at) - new Date(b.created_at);
    });
}

function nextNumber(branchId, service) {
  const prefix = PREFIXES[service] || 'E';
  const nums = [...tickets.values()]
    .filter(t => t.branch_id === branchId && t.prefix === prefix)
    .map(t => parseInt(t.number.split('-')[1]))
    .filter(n => !isNaN(n));
  return `${prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3,'0')}`;
}

// Calcular promedio real de atención en minutos
function getAvgMinutes(branchId, service) {
  const key = `${branchId}-${service}`;
  if (avgTimes.has(key)) return avgTimes.get(key);
  const branch = branches.get(branchId);
  if (!branch) return 4;
  return branch[`avg_${service}`] || 4;
}

// Registrar cuando se llama un ticket (para calcular promedio)
function recordCallTime(ticketId) {
  callTimes.set(ticketId, Date.now());
}

// Cuando se finaliza, actualizar el promedio
function recordFinishTime(ticketId) {
  const called = callTimes.get(ticketId);
  if (!called) return;
  const t = tickets.get(ticketId);
  if (!t) return;
  const durationMin = (Date.now() - called) / 60000;
  const key = `${t.branch_id}-${t.service}`;
  const current = avgTimes.get(key) || getAvgMinutes(t.branch_id, t.service);
  // Media móvil exponencial — pondera 30% el nuevo valor
  avgTimes.set(key, Math.round((current * 0.7 + durationMin * 0.3) * 10) / 10);
  callTimes.delete(ticketId);
}

const db = {
  getBranch:     (id)  => branches.get(id) || null,
  getAvg:        (id)  => {
    const b = branches.get(id);
    if (!b) return null;
    return {
      caja:      getAvgMinutes(id, 'caja'),
      atencion:  getAvgMinutes(id, 'atencion'),
      ejecutivo: getAvgMinutes(id, 'ejecutivo'),
    };
  },
  getPending,
  nextNumber,
  getTicket:    (id)  => tickets.get(id) || null,
  getByRut:     (rut) => [...tickets.values()]
    .find(t => t.rut === rut && ['pending','called'].includes(t.status)) || null,

  createTicket: (fields) => {
    const t = { ...fields, created_at: new Date().toISOString(), called_at: null, finished_at: null };
    tickets.set(t.id, t);
    return t;
  },

  setStatus: (id, status) => {
    const t = tickets.get(id);
    if (!t) return;
    t.status = status;
    if (status === 'called') {
      t.called_at = new Date().toISOString();
      recordCallTime(id);
    }
    if (['finished','absent','cancelled'].includes(status)) {
      t.finished_at = new Date().toISOString();
      if (status === 'finished') recordFinishTime(id);
    }
  },

  getQueueState: (branchId) => queueState.get(branchId) || null,
  setQueueState: (branchId, ticket, service, box) => {
    queueState.set(branchId, {
      branch_id: branchId, current_ticket: ticket,
      current_service: service, current_box: box,
      last_updated: new Date().toISOString(),
    });
  },

  countPending: (branchId) => {
    const map = {};
    getPending(branchId).forEach(t => { map[t.service] = (map[t.service]||0) + 1; });
    return map;
  },

  // Calcular posición y tiempo estimado para un ticket específico
  getTicketStatus: (ticketId) => {
    const t = tickets.get(ticketId);
    if (!t) return null;
    const pending  = getPending(t.branch_id);
    const position = pending.findIndex(x => x.id === ticketId);
    const avgMin   = getAvgMinutes(t.branch_id, t.service);
    return {
      ticket:       t,
      position:     position >= 0 ? position : null, // null = ya fue llamado
      turnsBefore:  position > 0 ? position : 0,
      estMinutes:   position > 0 ? Math.round(position * avgMin) : 0,
      currentTurn:  pending[0]?.number || null,
      totalPending: pending.length,
      avgPerTicket: avgMin,
    };
  },

  swap: (id1, id2) => {
    const t1 = tickets.get(id1);
    const t2 = tickets.get(id2);
    if (!t1 || !t2) return null;
    [t1.number, t2.number] = [t2.number, t1.number];
    return { id1, newNum1: t1.number, id2, newNum2: t2.number };
  },
};

module.exports = { db, uuidv4, PREFIXES };
