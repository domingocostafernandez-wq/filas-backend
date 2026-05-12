'use strict';
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const cors     = require('cors');

const { setupWebSocket } = require('./socket/events');
const ticketsRouter = require('./routes/tickets');
const queuesRouter  = require('./routes/queues');
const clientsRouter = require('./routes/clients');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const PORT   = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/tickets', ticketsRouter);
app.use('/api/queues',  queuesRouter);
app.use('/api/clients', clientsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/',       (_req, res) => res.json({ name: 'Banco de Chile — Filas API', version: '1.0.0' }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

setupWebSocket(wss);

server.listen(PORT, () => console.log(`✓ Servidor en puerto ${PORT}`));
