'use strict';
const express = require('express');
const { getAllStats }          = require('../services/quotaTracker');
const { poolStatus }           = require('../services/geminiPool');
const { groqPoolStatus }       = require('../services/groqPool');
const { cerebrasPoolStatus }   = require('../services/cerebrasPool');
const { sambanovaPoolStatus }  = require('../services/sambanovaPool');

const router = express.Router();

router.get('/quota/status', (req, res) => {
  const stats = getAllStats();

  const geminiSlots    = poolStatus();
  const groqSlots      = groqPoolStatus();
  const cerebrasSlots  = cerebrasPoolStatus();
  const sambanovaSlots = sambanovaPoolStatus();

  // Enrich each model's usage stats with live slot cooling/dead state
  function enrichWithSlotStatus(providerStats, slots) {
    return providerStats.map(modelStat => {
      const matchingSlots = slots.filter(s => s.model === modelStat.model);
      const allDead    = matchingSlots.length > 0 && matchingSlots.every(s => s.dead);
      const allCooling = matchingSlots.length > 0 && matchingSlots.every(s => !s.dead && s.coolUntil);
      const coolUntil  = matchingSlots.length > 0
        ? Math.max(...matchingSlots.map(s => s.coolUntil ? new Date(s.coolUntil).getTime() : 0))
        : 0;
      const coolingSecondsLeft = coolUntil > Date.now()
        ? Math.ceil((coolUntil - Date.now()) / 1000)
        : 0;

      return {
        ...modelStat,
        slotStatus:         allDead ? 'dead' : allCooling ? 'cooling' : 'active',
        coolingSecondsLeft,
      };
    });
  }

  res.json({
    ...stats,
    providers: {
      gemini:    enrichWithSlotStatus(stats.providers.gemini,    geminiSlots),
      groq:      enrichWithSlotStatus(stats.providers.groq,      groqSlots),
      cerebras:  enrichWithSlotStatus(stats.providers.cerebras,  cerebrasSlots),
      sambanova: enrichWithSlotStatus(stats.providers.sambanova, sambanovaSlots),
    },
    configured: {
      gemini:    !!process.env.GEMINI_API_KEY,
      groq:      !!process.env.GROQ_API_KEY,
      cerebras:  !!process.env.CEREBRAS_API_KEY,
      sambanova: !!process.env.SAMBANOVA_API_KEY,
    },
  });
});

module.exports = router;
