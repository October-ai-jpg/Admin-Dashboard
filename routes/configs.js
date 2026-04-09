const express = require('express');

module.exports = function(loadJSON, saveJSON) {
  const router = express.Router();
  const FILE = 'configurations.json';

  router.get('/', (req, res) => {
    res.json(loadJSON(FILE));
  });

  router.get('/:id', (req, res) => {
    const configs = loadJSON(FILE);
    const c = configs.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  });

  router.post('/', (req, res) => {
    const { name, vertical, systemPrompt, temperature, propertyData, roomMappings, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const configs = loadJSON(FILE);
    const config = {
      id: 'cfg_' + Date.now(),
      name,
      vertical: vertical || 'hotel',
      systemPrompt: systemPrompt || '',
      temperature: temperature || 0.7,
      propertyData: propertyData || '',
      roomMappings: roomMappings || '{}',
      notes: notes || '',
      testSessions: 0,
      created: new Date().toISOString()
    };
    configs.push(config);
    saveJSON(FILE, configs);
    res.status(201).json(config);
  });

  router.put('/:id', (req, res) => {
    const configs = loadJSON(FILE);
    const idx = configs.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    Object.assign(configs[idx], req.body, { updated: new Date().toISOString() });
    configs[idx].id = req.params.id; // preserve ID
    saveJSON(FILE, configs);
    res.json(configs[idx]);
  });

  router.delete('/:id', (req, res) => {
    let configs = loadJSON(FILE);
    configs = configs.filter(x => x.id !== req.params.id);
    saveJSON(FILE, configs);
    res.json({ ok: true });
  });

  return router;
};
