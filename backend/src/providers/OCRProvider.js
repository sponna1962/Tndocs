/**
 * OCRProvider - abstract base class.
 *
 * Every concrete provider (GoogleDocumentAIProvider, AzureDocumentIntelligenceProvider,
 * or any future CustomProvider) must implement `extract(filePath, mimeType)` and
 * resolve with a normalized OCRResult so the rest of the pipeline never has to
 * know which vendor produced the text.
 *
 * Normalized shape returned by extract():
 * {
 *   fullText: string,               // full UTF-8 text, reading order preserved
 *   pages: [
 *     {
 *       pageNumber: number,
 *       text: string,
 *       blocks: [                   // paragraph/line-level blocks, top-to-bottom
 *         { text: string, confidence: number|null, boundingBox: object|null }
 *       ]
 *     }
 *   ],
 *   averageConfidence: number|null, // 0-1, null if provider does not report confidence
 *   provider: string,               // provider name, for auditing/debugging
 * }
 */
class OCRProvider {
  /**
   * @param {string} filePath - absolute path to the uploaded PDF/image on disk
   * @param {string} mimeType - e.g. "application/pdf", "image/png"
   * @returns {Promise<object>} normalized OCRResult (see above)
   */
  // eslint-disable-next-line no-unused-vars
  async extract(filePath, mimeType) {
    throw new Error(`${this.constructor.name} must implement extract()`);
  }

  /** Human readable provider name, used in job metadata and error messages. */
  get name() {
    return 'AbstractOCRProvider';
  }
}

module.exports = OCRProvider;
