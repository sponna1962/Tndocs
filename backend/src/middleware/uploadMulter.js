const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const sanitizeFilename = require('../utils/sanitizeFilename');

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/tiff']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}__${safeName}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, PNG, JPEG, TIFF.`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

module.exports = upload;
