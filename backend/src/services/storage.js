const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureUploadDir() {
  if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
  }
}

function uploadPathFor(jobId, filename) {
  return path.join(config.uploadDir, `${jobId}__${filename}`);
}

/**
 * Deletes uploaded source files older than FILE_RETENTION_HOURS.
 * Call this on a schedule (see server.js) - it never touches exported CSVs,
 * which are generated on demand and not persisted separately.
 */
function cleanupExpiredUploads() {
  ensureUploadDir();
  const cutoff = Date.now() - config.fileRetentionHours * 60 * 60 * 1000;
  const files = fs.readdirSync(config.uploadDir);
  let removed = 0;
  for (const file of files) {
    const fullPath = path.join(config.uploadDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed += 1;
    }
  }
  return removed;
}

module.exports = { ensureUploadDir, uploadPathFor, cleanupExpiredUploads };
