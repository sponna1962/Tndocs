const express = require('express');
const jobStore = require('../services/jobStore');
const { buildCSV } = require('../services/csvBuilder');

const router = express.Router();

function csvFilenameFor(job) {
  const { exam, year, subject } = job.metadata || {};
  const parts = [exam, year, subject].filter(Boolean).map((s) => String(s).replace(/[^a-zA-Z0-9]+/g, '_'));
  return `${parts.join('_') || 'tnpsc'}_${job.id.slice(0, 8)}.csv`;
}

function languageRows(rows, language) {
  if (language !== 'ta' && language !== 'en') return rows;
  return rows.map((r) => {
    const out = { ...r };
    if (language === 'ta') { out.question_en=''; out.option_a_en=''; out.option_b_en=''; out.option_c_en=''; out.option_d_en=''; }
    else { out.question_ta=''; out.option_a_ta=''; out.option_b_ta=''; out.option_c_ta=''; out.option_d_ta=''; }
    return out;
  });
}

/**
 * GET /api/export/:id
 * Streams a UTF-8 CSV (with BOM for Excel) of the current, possibly
 * user-edited, question rows for a single job.
 */
router.get('/export/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'completed' || !job.result) {
    return res.status(409).json({ error: `Job is not completed yet (status: ${job.status}).` });
  }

  const language = String(req.query.lang || 'all').toLowerCase();
  const usableRows = (job.result.rows || []).filter((r) => String(r.question_ta || r.question_en || '').trim());
  const csv = buildCSV(languageRows(usableRows, language));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const prefix = language === 'ta' ? 'TNPSC_Tamil' : language === 'en' ? 'TNPSC_English' : 'TNPSC_All';
  res.setHeader('Content-Disposition', `attachment; filename="${prefix}_${job.id.slice(0, 8)}.csv"`);
  return res.send(csv);
});

/**
 * POST /api/export/combined
 * Body: { jobIds: [...] } - merges rows from multiple completed jobs into
 * one CSV, e.g. for "Combine Results" across a batch upload.
 */
router.post('/export/combined', async (req, res) => {
  const { jobIds } = req.body;
  if (!Array.isArray(jobIds) || !jobIds.length) {
    return res.status(400).json({ error: '"jobIds" must be a non-empty array.' });
  }

  const jobs = await Promise.all(jobIds.map((id) => jobStore.get(id)));
  const missing = jobIds.filter((id, i) => !jobs[i]);
  if (missing.length) {
    return res.status(404).json({ error: `Jobs not found: ${missing.join(', ')}` });
  }
  const notReady = jobs.filter((j) => j.status !== 'completed' || !j.result);
  if (notReady.length) {
    return res.status(409).json({
      error: `Some jobs are not completed yet: ${notReady.map((j) => j.id).join(', ')}`,
    });
  }

  const allRows = jobs.flatMap((j) => (j.result.rows || []).filter((r) => String(r.question_ta || r.question_en || '').trim()));
  const csv = buildCSV(allRows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tnpsc_combined.csv"');
  return res.send(csv);
});

module.exports = router;
