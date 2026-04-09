const express = require('express');

module.exports = function(loadJSON, saveJSON) {
  const router = express.Router();
  const FILE = 'test-history.json';

  router.get('/', (req, res) => {
    const history = loadJSON(FILE);
    // Return sorted newest first
    res.json(history.sort((a, b) => new Date(b.created) - new Date(a.created)));
  });

  router.get('/:id', (req, res) => {
    const history = loadJSON(FILE);
    const h = history.find(x => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    res.json(h);
  });

  router.post('/', (req, res) => {
    const { promptUsed, configId, vertical, messages, duration, latencies } = req.body;

    const history = loadJSON(FILE);
    const entry = {
      id: 'test_' + Date.now(),
      promptUsed: promptUsed || '',
      configId: configId || null,
      vertical: vertical || 'hotel',
      messages: messages || [],
      duration: duration || 0,
      latencies: latencies || [],
      rating: null,
      notes: '',
      created: new Date().toISOString()
    };
    history.push(entry);
    saveJSON(FILE, history);
    res.status(201).json(entry);
  });

  router.put('/:id', (req, res) => {
    const history = loadJSON(FILE);
    const idx = history.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const { rating, notes } = req.body;
    if (rating !== undefined) history[idx].rating = rating;
    if (notes !== undefined) history[idx].notes = notes;
    saveJSON(FILE, history);
    res.json(history[idx]);
  });

  return router;
};
