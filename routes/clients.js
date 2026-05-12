'use strict';
const express = require('express');
const router  = express.Router();

const MOCK = {
  '12345678': { name: 'Domingo González', category: 'C', label: 'Silver' },
  '11111111': { name: 'Roberto Fernández', category: 'A', label: 'Black'  },
  '22222222': { name: 'Carlos Rodríguez',  category: 'B', label: 'Gold'   },
  '33333333': { name: 'Ana Martínez',      category: 'C', label: 'Silver' },
  '44444444': { name: 'Pedro López',       category: 'E', label: 'Base'   },
  '55555555': { name: 'María García',      category: 'B', label: 'Gold'   },
};

router.get('/:rut', (req, res) => {
  const digits = req.params.rut.replace(/\D/g, '').slice(0, -1);
  const client = MOCK[digits];
  if (client) return res.json({ found: true, ...client });
  res.json({ found: false, name: 'Cliente', category: 'E', label: 'Base' });
});

module.exports = router;
