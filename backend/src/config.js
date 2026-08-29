require('dotenv').config();
const path = require('path');

function required(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

module.exports = {
  port: Number(required('PORT', 8080)),
  nodeEnv: required('NODE_ENV', 'development'),
  allowedOrigin: required('ALLOWED_ORIGIN', '*'),

  ocrProvider: required('OCR_PROVIDER', 'ocrspace'),

  ocrApiKey: required('OCR_API_KEY', ''),
  ocrApiEndpoint: required('OCR_API_ENDPOINT', ''),

  google: {
    projectId: required('GOOGLE_PROJECT_ID', ''),
    location: required('GOOGLE_LOCATION', 'us'),
    processorId: required('GOOGLE_PROCESSOR_ID', ''),
    serviceAccountJson: required('GOOGLE_SERVICE_ACCOUNT_JSON', ''),
    credentialsPath: required('GOOGLE_APPLICATION_CREDENTIALS', ''),
  },

  azure: {
    endpoint: required('AZURE_DOCINTEL_ENDPOINT', ''),
    key: required('AZURE_DOCINTEL_KEY', ''),
    model: required('AZURE_DOCINTEL_MODEL', 'prebuilt-read'),
  },

  ocrSpace: {
    apiKey: required('OCR_SPACE_API_KEY', ''),
    timeoutMs: Number(required('OCR_TIMEOUT_MS', 120000)),
    attempts: Math.max(1, Number(required('OCR_MAX_ATTEMPTS', 2))),
    concurrency: Math.max(1, Number(required('OCR_CONCURRENCY', 1))),
    minIntervalMs: Math.max(0, Number(required('OCR_MIN_INTERVAL_MS', 1250))),
    retryBaseMs: Math.max(250, Number(required('OCR_RETRY_BASE_MS', 1000))),
    geminiFallback: required('OCR_GEMINI_FALLBACK', 'true').toLowerCase() === 'true',
  },

  // Used by services/llmStructurer.js for two things regexes can't do
  // reliably: translating mixed Tamil/English questions into complete,
  // natural question_ta/question_en (+ option) pairs, and confirming/
  // resolving the correct_answer letter from context. Required for stage 2
  // to produce anything other than REVIEW REQUIRED rows.
  //
  // LLM_PROVIDER picks which API llmStructurer.js calls: 'gemini' (uses
  // GEMINI_API_KEY) or 'anthropic' (uses ANTHROPIC_API_KEY). Defaults to
  // 'gemini' since Google AI Studio issues a free-tier key with no billing
  // required, which is the lower-friction default for most users of this
  // project.
  llm: {
    provider: required('LLM_PROVIDER', 'gemini').toLowerCase(),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY', ''),
    model: required('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
  },
  gemini: {
    apiKey: required('GEMINI_API_KEY', ''),
    model: required('GEMINI_MODEL', 'gemini-2.5-flash'),
    concurrency: Math.max(1, Number(required('LLM_CONCURRENCY', 2))),
  },

  uploadDir: path.resolve(required('UPLOAD_DIR', './src/data/uploads')),
  jobDbFile: path.resolve(required('JOB_DB_FILE', './src/data/jobs.json')),
  maxUploadMb: Number(required('MAX_UPLOAD_MB', 1024)),
  fileRetentionHours: Number(required('FILE_RETENTION_HOURS', 24)),
};
