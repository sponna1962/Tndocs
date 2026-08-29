const express = require('express');
const jobStore = require('../services/jobStore');
const { validateQuestions } = require('../services/validator');

const router = express.Router();

/**
 * GET /api/result/:id
 * Returns the structured question rows for the editable preview table.
 */
router.get('/result/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'completed') {
    return res.status(409).json({ error: `Job is not completed yet (status: ${job.status}).` });
  }
  return res.json({ metadata: job.metadata, ...job.result });
});

/**
 * PUT /api/result/:id
 * Body: { rows: [...] } - the full, user-edited row set from the preview grid.
 * Re-runs validation server-side so the review/valid counts stay accurate
 * after manual corrections, then persists the corrected rows.
 *
 * Returns { summary, rows } - the wizard's Step 4 preview table uses the
 * returned `rows` to re-highlight which rows still need review without a
 * second round-trip.
 */
router.put('/result/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const { rows } = req.body;
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: '"rows" must be an array.' });
  }

  // Re-number the editable result in its current order. This guarantees that
  // deleting Question 1 makes the old Question 2 become Question 1, even if
  // the browser was opened before the latest parser changes.
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    source_question_number: row.source_question_number ?? row.question_number,
    question_number: index + 1,
  }));
  const { rows: revalidated, summary } = validateQuestions(normalizedRows);

  await jobStore.update(job.id, {
    result: { rows: revalidated, summary },
    questionsDetected: summary.total,
    questionsReviewRequired: summary.review_required,
    questionsValid: summary.valid,
  });

  return res.json({ summary, rows: revalidated });
});

module.exports = router;
