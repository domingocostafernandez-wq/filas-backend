'use strict';
const { v4: uuidv4 } = require('uuid');

// ── Datos en memoria ──────────────────────────────────────────────────────
const branches  = new Map();
const tickets   = new Map();
const queueState = new Map();

const PREFIXES  = { caja: 'C', atencion: 'B', ejecutivo: 'A' };
const PRIORITY  = { A: 1, B: 2, C: 3, E: 4 };

// ── Sucursal de demo ──────────────────────────────────────────────────────
branches.set(1, {
  id: 1, name: 'Chillán Centro', ciudad: 'Chillán',
  is_open: 1, avg_caja: 4, avg_atencion: 10, avg_ejecutivo: 6,
});

queueState.set(1, {
  branch_id: 1,
  current_ticket: null,
  current_service: null,
  current_box: null,
  last_updated: new Date().toISOString(),
});

// ── Tickets de demo ───────────────────────────────────────────────────────
const DEMO = [
  { service: 'caja',      category: 'E', name: 'Juan P.'    },
  { service: 'caja',      category: 'C', name: 'María G.'   },
  { service: 'atencion',  category: 'B', name: 'Carlos R.'  },
  { service: 'caja',      category: 'E', name: 'Ana M.'     },
  { service: 'ejecutivo', category: 'A', name: 'Pedro L.'   },
  { service: 'caja',      category: 'C', name: 'Sofía V.'   },
  { service: 'atencion',  category: 'E', name: 'Luis T.'    },
  { service: 'caja',      category: 'E', name: 'Carmen F.'  },
  { service: 'atencion',  category: 'B', name: 'Diego A.'   },
  { service: 'caja',      category: 'C', name: 'Paula S.'   },
];

const cnt = { C: 0, B: 0, A: 0, E: 0 };
DEMO.forEach(d => {
  const prefix = PREFIXES[d.service] || 'E';
  cnt[prefix]++;
  const id = uuidv4();
  tickets.set(id, {
    id,
    number:      `${prefix}-${String(cnt[prefix]).padStart(3, '0')}`,
    prefix,
    branch_id:   1,
    service:     d.service,
    rut:         null,
    client_name: d.name,
    category:    d.category,
    status:      'pending',
    push_token:  null,
    created_at:  new Date().toISOString(),
    called_at:   null,
    finished_at: null,
  });
});

console.log(`✓ BD en memoria · ${tickets.size} tickets de demo`);

// ── Helpers ───────────────────────────────────────────────────────────────
function getPending(branchId) {
  return [...tickets.values()]
    .filter(t => t.branch_id === branchId && t.status === 'pending')
    .sort((a, b) => {
      const diff = (PRIORITY[a.category] || 4) - (PRIORITY[b.category] || 4);
      return diff !== 0 ? diff : new Date(a.created_at) - new Date(b.created_at);
    });
}

function nextNumber(branchId, service) {
  const prefix = PREFIXES[service] || 'E';
  const nums = [...tickets.values()]
    .filter(t => t.branch_id === branchId && t.prefix === prefix)
    .map(t => parseInt(t.number.split('-')[1]))
    .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ── API ───────────────────────────────────────────────────────────────────
const db = {
  // Sucursales
  getBranch:   (id) => branches.get(id) || null,
  getAvg:      (id) => {
    const b = branches.get(id);
    return b ? { caja: b.avg_caja, atencion: b.avg_atencion, ejecutivo: b.avg_ejecutivo } : null;
  },

  // Tickets
  getPending,
  nextNumber,
  getTicket:   (id)  => tickets.get(id) || null,
  getByRut:    (rut) => [...tickets.values()]
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
    if (status === 'called') t.called_at = new Date().toISOString();
    if (['finished','absent','cancelled'].includes(status)) t.finished_at = new Date().toISOString();
  },

  // Cola
  getQueueState:    (branchId) => queueState.get(branchId) || null,
  setQueueState:    (branchId, ticket, service, box) => {
    queueState.set(branchId, {
      branch_id: branchId,
      current_ticket: ticket,
      current_service: service,
      current_box: box,
      last_updated: new Date().toISOString(),
    });
  },

  countPending: (branchId) => {
    const map = {};
    getPending(branchId).forEach(t => { map[t.service] = (map[t.service] || 0) + 1; });
    return map;
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
