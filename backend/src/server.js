const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { ensureUploadDir, cleanupExpiredUploads } = require('./services/storage');

const uploadRoutes = require('./routes/upload');
const jobRoutes = require('./routes/job');
const resultRoutes = require('./routes/result');
const exportRoutes = require('./routes/export');

ensureUploadDir();

const app = express();
app.use(cors({ origin: config.allowedOrigin }));
// Larger limit than the original 2mb: Step 2 of the wizard round-trips the
// full per-page OCR text (potentially many scanned pages of Tamil + English)
// back to the server as JSON when the user confirms/edits it.
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, provider: config.ocrProvider }));

app.use('/api', uploadRoutes);
app.use('/api', jobRoutes);
app.use('/api', resultRoutes);
app.use('/api', exportRoutes);

// Multer / generic error handler - never leaks stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 400;
  res.status(status).json({ error: err.message || 'Request failed.' });
});

// Optionally serve the static frontend build from the same origin.
const frontendDist = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDist));

app.listen(config.port, () => {
  console.log(`TNPSC PDF->CSV backend listening on port ${config.port} (OCR provider: ${config.ocrProvider})`);
});

// Periodic cleanup of expired uploaded source files (retention policy).
setInterval(() => {
  try {
    const removed = cleanupExpiredUploads();
    if (removed > 0) console.log(`Cleaned up ${removed} expired uploaded file(s).`);
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }
}, 60 * 60 * 1000); // hourly
