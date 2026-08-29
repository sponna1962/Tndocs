const fs = require('fs');
const fetch = require('node-fetch');
const OCRProvider = require('./OCRProvider');
const config = require('../config');

let nextAllowedAt = 0;

async function waitForRateSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  nextAllowedAt =
    Date.now() + Math.max(0, config.ocrSpace.minIntervalMs || 0);
}

function compactError(text, limit = 800) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

class OCRSpaceProvider extends OCRProvider {
  get name() {
    return 'ocr-space';
  }

  async extract(filePath, mimeType) {
    if (!config.ocrSpace.apiKey) {
      throw new Error(
        'OCR_SPACE_API_KEY is not configured.'
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
      throw new Error(
        `OCR.space unsupported mime type: ${mimeType}`
      );
    }

    const form = new (require('form-data'))();

    form.append('apikey', config.ocrSpace.apiKey);

    // Engine 3 is used for mixed Tamil + English documents.
    form.append('language', 'auto');
    form.append('OCREngine', '3');

    form.append('isOverlayRequired', 'false');
    form.append('filetype', filetype);
    form.append('scale', 'true');

    form.append(
      'file',
      fs.createReadStream(filePath)
    );

    await waitForRateSlot();

    const controller = new AbortController();

    const timeoutMs =
      Number(config.ocrSpace.timeoutMs) || 120000;

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let res;

    try {
      console.log(
        `[OCR] OCR.space request start: ${filePath}`
      );

      res = await fetch(
        'https://api.ocr.space/parse/image',
        {
          method: 'POST',
          headers: form.getHeaders(),
          body: form,
          signal: controller.signal,
        }
      );
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(
          `OCR.space timeout after ${timeoutMs}ms`
        );
      }

      throw new Error(
        `OCR.space network error: ${compactError(
          err && err.message
        )}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text();

      throw new Error(
        `OCR.space HTTP ${res.status}: ${compactError(text)}`
      );
    }

    let data;

    try {
      data = await res.json();
    } catch (err) {
      throw new Error(
        `OCR.space invalid JSON: ${compactError(
          err && err.message
        )}`
      );
    }

    console.log(
      `[OCR] OCR.space response received for ${filePath}`
    );

    if (data.IsErroredOnProcessing) {
      const message = Array.isArray(data.ErrorMessage)
        ? data.ErrorMessage.join('; ')
        : data.ErrorMessage;

      throw new Error(
        `OCR.space processing error: ${compactError(
          message || 'unknown processing error'
        )}`
      );
    }

    if (
      data.ErrorMessage &&
      (!data.ParsedResults ||
        data.ParsedResults.length === 0)
    ) {
      const message = Array.isArray(data.ErrorMessage)
        ? data.ErrorMessage.join('; ')
        : data.ErrorMessage;

      throw new Error(
        `OCR.space returned no OCR result: ${compactError(
          message
        )}`
      );
    }

    const normalized = this._normalize(data);

    if (
      !normalized.pages.length ||
      !normalized.fullText.trim()
    ) {
      throw new Error(
        'OCR.space returned an empty OCR result.'
      );
    }

    return normalized;
  }

  async extractPage(
    filePath,
    mimeType,
    pageNumber = 1
  ) {
    const result = await this.extract(
      filePath,
      mimeType
    );

    const page =
      result.pages[0];

    if (
      !page ||
      !String(page.text || '').trim()
    ) {
      throw new Error(
        `OCR.space returned empty text for page ${pageNumber}.`
      );
    }

    return {
      ...page,
      pageNumber,
    };
  }

  _normalize(ocrSpaceResponse) {
    const results =
      Array.isArray(
        ocrSpaceResponse.ParsedResults
      )
        ? ocrSpaceResponse.ParsedResults
        : [];

    const pages = results
      .map((result, index) => {
        const text = String(
          result &&
          result.ParsedText
            ? result.ParsedText
            : ''
        ).trim();

        return {
          pageNumber: index + 1,
          text,
          blocks: [
            {
              text,
              confidence: null,
              boundingBox: null,
            },
          ],
        };
      })
      .filter((page) => page.text);

    const fullText = pages
      .map((page) => page.text)
      .join('\n\n');

    return {
      fullText,
      pages,
      averageConfidence: null,
      provider: this.name,
    };
  }
}

module.exports = OCRSpaceProvider;
