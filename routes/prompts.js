const express = require('express');

module.exports = function(loadJSON, saveJSON) {
  const router = express.Router();
  const FILE = 'prompts.json';

  router.get('/', (req, res) => {
    res.json(loadJSON(FILE));
  });

  router.get('/:id', (req, res) => {
    const prompts = loadJSON(FILE);
    const p = prompts.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  });

  router.post('/', (req, res) => {
    const { name, vertical, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Name and content required' });

    const prompts = loadJSON(FILE);
    const prompt = {
      id: 'p_' + Date.now(),
      name,
      vertical: vertical || 'hotel',
      content,
      created: new Date().toISOString(),
      lastTested: null,
      rating: null
    };
    prompts.push(prompt);
    saveJSON(FILE, prompts);
    res.status(201).json(prompt);
  });

  router.put('/:id', (req, res) => {
    const prompts = loadJSON(FILE);
    const idx = prompts.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const { name, vertical, content, rating } = req.body;
    if (name) prompts[idx].name = name;
    if (vertical) prompts[idx].vertical = vertical;
    if (content) prompts[idx].content = content;
    if (rating !== undefined) prompts[idx].rating = rating;
    prompts[idx].updated = new Date().toISOString();
    saveJSON(FILE, prompts);
    res.json(prompts[idx]);
  });

  router.delete('/:id', (req, res) => {
    let prompts = loadJSON(FILE);
    prompts = prompts.filter(x => x.id !== req.params.id);
    saveJSON(FILE, prompts);
    res.json({ ok: true });
  });

  return router;
};
