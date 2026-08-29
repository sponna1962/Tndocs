const fs = require('fs');
const fetch = require('node-fetch');
const OCRProvider = require('./OCRProvider');
const config = require('../config');


// OCR.space free endpoints can reject bursts even when requests are below the
// monthly quota. Keep one process-wide request gate so multiple workers/jobs do
// not accidentally hammer the API.
let nextAllowedAt = 0;
async function waitForRateSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextAllowedAt = Date.now() + Math.max(0, config.ocrSpace.minIntervalMs || 0);
}

function compactError(text, limit = 500) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Uses the OCR.space REST API (https://ocr.space/ocrapi) - chosen specifically
 * because it offers a genuinely free tier (25,000 requests/month for Engine
 * 1/2, plus a separate 2,500/month allowance for Engine 3) that requires NO
 * credit card, unlike Google Document AI or Azure Document Intelligence.
 *
 * We use OCREngine=3 by default: it supports 200+ languages via
 * auto-detection (language=auto) and is OCR.space's most accurate engine for
 * mixed-script documents. As of this writing OCR.space's own docs describe
 * broad Indic-script coverage under Engine 3's 200+ language expansion, but
 * this has NOT been independently verified against a real Tamil TNPSC paper
 * in this codebase - there is no live network access here to test it. Run
 * one real bilingual paper through Step 2 (OCR Review) after deploying and
 * check the Tamil text renders correctly before relying on this in
 * production. If Tamil accuracy is poor, Google Document AI (which
 * explicitly documents Tamil support) or Azure Document Intelligence remain
 * the more proven options, at the cost of requiring a credit card.
 *
 * Trade-offs vs Google/Azure (see README.md "Known gaps"):
 * - Free tier caps: 25,000 req/month (Engine 1/2), 1MB file size, 3 PDF pages
 *   per request. A single large multi-page scanned paper may need splitting
 *   or the PRO plan ($30/month) to raise these limits.
 * - No official Tamil-specific accuracy guarantee (see above) - Google
 *   Document AI's "Document OCR" processor explicitly documents Tamil
 *   support, OCR.space does not call out Tamil by name anywhere in its docs.
 *
 * Docs: https://ocr.space/ocrapi
 */
class OCRSpaceProvider extends OCRProvider {
  get name() {
    return 'ocr-space';
  }

  async extract(filePath, mimeType) {
    if (!config.ocrSpace.apiKey) {
      throw new Error(
        'OCR_PROVIDER=ocrspace selected but OCR_SPACE_API_KEY is not set. ' +
        'Get a free key (no credit card) at https://ocr.space/ocrapi/freekey'
      );
    }

    const EXT_BY_MIME = {
      'application/pdf': 'PDF',
      'image/png': 'PNG',
      'image/jpeg': 'JPG',
      'image/tiff': 'TIF',
    };
    const filetype = EXT_BY_MIME[mimeType];
    if (!filetype) {
      throw new Error(`OCR.space provider: unsupported mime type "${mimeType}".`);
    }

    const form = new (require('form-data'))();
    form.append('apikey', config.ocrSpace.apiKey);
    form.append('language', 'auto'); // Engine 3 auto-detects Tamil/English mix
    form.append('OCREngine', '3');
    form.append('isOverlayRequired', 'false');
    form.append('filetype', filetype);
    form.append('scale', 'true'); // improves accuracy on lower-res scans
    form.append('file', fs.createReadStream(filePath));

    await waitForRateSlot();
    const controller = new AbortController();
    const timeoutMs = config.ocrSpace.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      console.log(`[OCR] OCR.space request start: ${filePath}`);
      res = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`OCR.space timed out after ${timeoutMs}ms`);
      }
      throw new Error(`OCR.space network error: ${err.message || err}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OCR.space HTTP ${res.status}: ${compactError(errText)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`OCR.space returned invalid JSON: ${err.message}`);
    }

    if (data.IsErroredOnProcessing) {
      const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : data.ErrorMessage;
      throw new Error(`OCR.space processing error: ${compactError(msg || 'unknown error')}`);
    }

    return this._normalize(data);
  }

  async extractPage(filePath, mimeType, pageNumber = 1) {
    const result = await this.extract(filePath, mimeType);
    const page = result.pages[0] || { pageNumber, text: '', blocks: [] };
    return { ...page, pageNumber };
  }

  _normalize(ocrSpaceResponse) {
    const results = ocrSpaceResponse.ParsedResults || [];

    const pages = results.map((r, idx) => ({
      pageNumber: idx + 1,
      // OCR.space doesn't return paragraph/block-level structure like
      // Google/Azure do, only one text blob per page - so this is
      // represented as a single block per page rather than invented
      // sub-blocks, to avoid fabricating structure that wasn't returned.
      text: r.ParsedText || '',
      blocks: [{ text: r.ParsedText || '', confidence: null, boundingBox: null }],
    }));

    const fullText = pages.map((p) => p.text).join('\n\n');

    // OCR.space's free/PRO tiers do not return a confidence score at all
    // (unlike Google/Azure), so this is honestly null rather than invented -
    // consistent with this project's "no fabricated numbers" rule.
    return { fullText, pages, averageConfidence: null, provider: this.name };
  }
}

module.exports = OCRSpaceProvider;
