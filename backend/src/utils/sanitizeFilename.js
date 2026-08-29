const path = require('path');

/**
 * Strips directory components and any character outside a safe allowlist,
 * to prevent path traversal or injection via crafted filenames.
 */
function sanitizeFilename(originalName) {
  const base = path.basename(originalName || 'upload');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 150) || 'upload';
}

module.exports = sanitizeFilename;
