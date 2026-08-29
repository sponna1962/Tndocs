const express = require('express');
const jobStore = require('../services/jobStore');
const { runStructuringStage, STAGES } = require('../pipeline/processJob');

const router = express.Router();

// Internal-only fields that must never be sent to the client: the on-disk
// upload path, and the raw OCR blocks kept around solely for stage-2
// confidence matching.
function toSafeJob(job) {
  const { filePath, _ocrRawPages, ...safeJob } = job;
  return safeJob;
}

/**
 * GET /api/job/:id
 * Returns the current honest processing state. No fake progress percentages -
 * the "status" field is one of the real pipeline stages (see pipeline/processJob.js).
 */
router.get('/job/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json(toSafeJob(job));
});

router.get('/jobs', async (req, res) => {
  const jobs = await jobStore.list();
  return res.json({ jobs: jobs.map(toSafeJob) });
});

/**
 * GET /api/job/:id/text
 * Returns the raw OCR text, split per page, for the Step 2 "OCR Review"
 * screen. Only available once the OCR stage has produced text (status is
 * "awaiting_text_review" or later).
 */
router.get('/job/:id/text', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  if (!job.ocrPages) {
    return res
      .status(409)
      .json({ error: `OCR text is not ready yet (current status: ${job.status}).` });
  }

  return res.json({ status: job.status, pages: job.ocrPages });
});

/**
 * POST /api/job/:id/confirm-text
 * Body: { pages: [{ pageNumber, text }, ...] }  (optional - omit to keep the
 * OCR text as-is)
 *
 * Called when the user clicks "Next" on the Step 2 OCR Review screen. Saves
 * the (possibly hand-corrected) per-page text and resumes the pipeline:
 * question/option detection -> CSV structuring -> validation. The job must
 * currently be in "awaiting_text_review" - this is the only way that stage
 * ever advances, by design (no auto-continue).
 */
router.post('/job/:id/confirm-text', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  if (job.status !== STAGES.AWAITING_TEXT_REVIEW) {
    return res
      .status(409)
      .json({ error: `Job is not awaiting text review (current status: ${job.status}).` });
  }

  const { pages } = req.body || {};
  if (pages !== undefined && !Array.isArray(pages)) {
    return res.status(400).json({ error: '"pages" must be an array of { pageNumber, text }.' });
  }
  if (Array.isArray(pages)) {
    for (const p of pages) {
      if (typeof p !== 'object' || p === null || typeof p.text !== 'string') {
        return res
          .status(400)
          .json({ error: 'Each entry in "pages" must be an object with a string "text" field.' });
      }
    }
  }

  // Fire-and-forget: resumes stage 2. The client learns progress by
  // continuing to poll GET /api/job/:id (status moves to
  // extracting_questions -> structuring_csv -> validating -> completed).
  runStructuringStage(job.id, pages);

  return res.status(202).json({ jobId: job.id, status: STAGES.EXTRACTING_QUESTIONS });
});

module.exports = router;
