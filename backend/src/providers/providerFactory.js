const config = require('../config');
const GoogleDocumentAIProvider = require('./GoogleDocumentAIProvider');
const AzureDocumentIntelligenceProvider = require('./AzureDocumentIntelligenceProvider');
const OCRSpaceProvider = require('./OCRSpaceProvider');

/**
 * Central place that decides which OCRProvider implementation to instantiate,
 * based on the OCR_PROVIDER environment variable. Add new vendors by
 * implementing OCRProvider and registering them here - nothing else in the
 * pipeline needs to change.
 */
const registry = {
  google: () => new GoogleDocumentAIProvider(),
  azure: () => new AzureDocumentIntelligenceProvider(),
  ocrspace: () => new OCRSpaceProvider(), // no-credit-card free tier, see OCRSpaceProvider.js
  // custom: () => new CustomProvider(), // plug in another vendor here
};

function getOCRProvider(providerName = config.ocrProvider) {
  const factory = registry[providerName];
  if (!factory) {
    throw new Error(
      `Unknown OCR_PROVIDER "${providerName}". Valid options: ${Object.keys(registry).join(', ')}`
    );
  }
  return factory();
}

module.exports = { getOCRProvider };
