const express = require('express');
const { v4: uuidv4 } = require('uuid');
const upload = require('../middleware/uploadMulter');
const jobStore = require('../services/jobStore');
const { runOcrStage, STAGES } = require('../pipeline/processJob');

const router = express.Router();

/**
 * POST /api/upload
 * multipart/form-data: file, exam, year, subject
 *
 * Creates a job, stores the uploaded file, and kicks off async processing.
 * Responds immediately with the job id - the client polls GET /api/job/:id.
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Field name must be "file".' });
    }

    const { exam = '', year = '', subject = '' } = req.body;
    const jobId = uuidv4();

    const job = {
      id: jobId,
      status: STAGES.UPLOADING,
      originalFilename: req.file.originalname,
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      metadata: { exam, year, subject },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pagesProcessed: null,
      questionsDetected: null,
      questionsReviewRequired: null,
      questionsValid: null,
      ocrProvider: null,
      ocrAverageConfidence: null,
      result: null,
      error: null,
    };

    await jobStore.create(job);
    await jobStore.update(jobId, { status: STAGES.QUEUED });

    // Fire-and-forget: the pipeline updates job status as it progresses.
    // Errors inside runOcrStage are caught internally and written to the job record.
    // The job pauses at "awaiting_text_review" - it will NOT proceed to
    // question parsing until POST /api/job/:id/confirm-text is called.
    runOcrStage(jobId);

    return res.status(202).json({ jobId, status: STAGES.QUEUED });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

/**
 * POST /api/upload/batch
 * multipart/form-data: files[] (multiple), exam, year, subject
 * Each file gets its own independent job id.
 */
// 200 files per batch: high enough for real bulk use (a year's worth of
// papers across every subject) without letting one request hold an
// unbounded number of file handles open at once.
router.post('/upload/batch', upload.array('files', 200), async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No files uploaded. Field name must be "files".' });
    }
    const { exam = '', year = '', subject = '' } = req.body;
    const jobs = [];

    for (const file of req.files) {
      const jobId = uuidv4();
      const job = {
        id: jobId,
        status: STAGES.QUEUED,
        originalFilename: file.originalname,
        filePath: file.path,
        mimeType: file.mimetype,
        metadata: { exam, year, subject },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalPages: null,
        processedPages: 0,
        successfulPages: 0,
        failedPages: [],
        currentPage: 0,
        pagesProcessed: 0,
        questionsDetected: null,
        questionsReviewRequired: null,
        questionsValid: null,
        ocrProvider: null,
        ocrAverageConfidence: null,
        result: null,
        error: null,
      };
      // eslint-disable-next-line no-await-in-loop
      await jobStore.create(job);
      runOcrStage(jobId);
      jobs.push({ jobId, filename: file.originalname });
    }

    return res.status(202).json({ jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch upload failed.' });
  }
});

module.exports = router;
