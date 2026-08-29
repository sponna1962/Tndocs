const fs = require('fs');
const fetch = require('node-fetch');
const OCRProvider = require('./OCRProvider');
const config = require('../config');

/**
 * Uses Google Cloud Document AI's synchronous `process` REST endpoint, which
 * accepts a base64-encoded document (PDF or image) directly in the request
 * body - no GCS staging bucket required for documents under Document AI's
 * per-request page/size limits. Use a "Document OCR" processor, which
 * supports Tamil among other scripts.
 *
 * Docs: https://cloud.google.com/document-ai/docs/process-documents-ocr
 *
 * Auth: this implementation expects an OAuth2 access token to already be
 * available via `getAccessToken()`. In production, obtain this from a
 * service account using the `google-auth-library` package:
 *
 *   const { GoogleAuth } = require('google-auth-library');
 *   const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
 *   const client = await auth.getClient();
 *   const token = (await client.getAccessToken()).token;
 *
 * That package is intentionally not vendored here to keep this reference
 * implementation dependency-light; add `google-auth-library` to package.json
 * and wire it into getAccessToken() before deploying.
 */
class GoogleDocumentAIProvider extends OCRProvider {
  get name() {
    return 'google-document-ai';
  }

  async getAccessToken() {
    // Swap this for a real google-auth-library call in production.
    // Left as an explicit hook rather than a fake token so the app fails
    // loudly instead of pretending to succeed.
    if (!config.google.credentialsPath && !config.google.serviceAccountJson) {
      throw new Error(
        'Google OCR provider selected but no credentials configured. ' +
        'Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON, ' +
        'and wire google-auth-library into GoogleDocumentAIProvider.getAccessToken().'
      );
    }
    const { GoogleAuth } = require('google-auth-library'); // add to package.json
    const authOptions = { scopes: 'https://www.googleapis.com/auth/cloud-platform' };
    if (config.google.serviceAccountJson) {
      authOptions.credentials = JSON.parse(config.google.serviceAccountJson);
    }
    const auth = new GoogleAuth(authOptions);
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    return token;
  }

  async extract(filePath, mimeType) {
    const { projectId, location, processorId } = config.google;
    if (!projectId || !processorId) {
      throw new Error('GOOGLE_PROJECT_ID and GOOGLE_PROCESSOR_ID must be set.');
    }

    const token = await this.getAccessToken();
    const url = `https://${location}-documentai.googleapis.com/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process`;

    const content = fs.readFileSync(filePath).toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawDocument: {
          content,
          mimeType,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google Document AI request failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return this._normalize(data);
  }

  _normalize(docAiResponse) {
    const document = docAiResponse.document || {};
    const fullText = document.text || '';
    const pages = (document.pages || []).map((p, idx) => {
      const blocks = (p.paragraphs || p.blocks || []).map((b) => {
        const text = this._sliceText(fullText, b.layout && b.layout.textAnchor);
        const confidence =
          b.layout && typeof b.layout.confidence === 'number' ? b.layout.confidence : null;
        return { text, confidence, boundingBox: (b.layout && b.layout.boundingPoly) || null };
      });
      // Document AI can return paragraphs from multi-column scans in an order
      // that is not the visual reading order. When geometry is available,
      // rebuild the page text top-to-bottom and left-to-right. This prevents
      // question numbers/options from being interleaved across columns.
      const orderedBlocks = this._readingOrder(blocks);
      const pageText = orderedBlocks.map((b) => b.text).filter(Boolean).join('\n');
      // Never assign the entire document text to every page; that created
      // duplicate questions and broken CSV rows when paragraph extraction was
      // unavailable for a page.
      return { pageNumber: idx + 1, text: pageText, blocks };
    });

    const confidences = pages
      .flatMap((p) => p.blocks.map((b) => b.confidence))
      .filter((c) => typeof c === 'number');
    const averageConfidence = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;

    return { fullText, pages, averageConfidence, provider: this.name };
  }

  _readingOrder(blocks) {
    const getVertices = (poly) => poly?.normalizedVertices || poly?.vertices || [];
    const items = blocks.map((b, index) => {
      const vertices = getVertices(b.boundingBox);
      const xs = vertices.map((v) => Number(v.x || 0)).filter(Number.isFinite);
      const ys = vertices.map((v) => Number(v.y || 0)).filter(Number.isFinite);
      const x = xs.length ? Math.min(...xs) : index;
      const x2 = xs.length ? Math.max(...xs) : x;
      const y = ys.length ? Math.min(...ys) : index;
      const y2 = ys.length ? Math.max(...ys) : y;
      return { b, index, x, x2, y, y2, h: Math.max(0.001, y2 - y) };
    });
    if (items.length < 2 || items.some((i) => !i.b.boundingBox)) return blocks;

    // Many exam papers use two vertical columns. The old row-wise sorter
    // interleaved the columns (for example Q1, Q51, Q2, Q52). Detect a real
    // horizontal gutter and read the left column top-to-bottom, then the right
    // column top-to-bottom. Full-width blocks stay in their visual order.
    const sortedX = [...items].sort((a, b) => a.x - b.x);
    let bestGap = null;
    for (let i = 1; i < sortedX.length; i += 1) {
      const gap = sortedX[i].x - sortedX[i - 1].x2;
      if (!bestGap || gap > bestGap.gap) bestGap = { gap, at: i };
    }
    const xs = items.map((i) => i.x).sort((a, b) => a - b);
    const range = xs[xs.length - 1] - xs[0];
    const likelyTwoColumn = bestGap && range > 0 && bestGap.gap > range * 0.18;

    if (likelyTwoColumn) {
      const splitX = (sortedX[bestGap.at - 1].x2 + sortedX[bestGap.at].x) / 2;
      const left = items.filter((i) => i.x < splitX);
      const right = items.filter((i) => i.x >= splitX);
      // If a block spans the gutter, treat it as full-width and place it before
      // the columns when it occurs near the top, otherwise keep it by y.
      const full = items.filter((i) => i.x < splitX && i.x2 > splitX);
      if (left.length >= 2 && right.length >= 2 && full.length <= Math.max(2, Math.floor(items.length * 0.15))) {
        const fullSet = new Set(full.map((i) => i.index));
        const l = left.filter((i) => !fullSet.has(i.index)).sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
        const r = right.filter((i) => !fullSet.has(i.index)).sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
        const f = full.sort((a, b) => a.y - b.y || a.index - b.index);
        // Full-width header/instruction blocks normally occur before the columns.
        const firstColumnY = Math.min(l[0]?.y ?? Infinity, r[0]?.y ?? Infinity);
        const leading = f.filter((i) => i.y <= firstColumnY);
        const trailing = f.filter((i) => i.y > firstColumnY);
        return [...leading, ...l, ...r, ...trailing].map((i) => i.b);
      }
    }

    // Single-column fallback: group by baseline, then left-to-right.
    const heights = items.map((i) => i.h).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 0.02;
    const tolerance = Math.max(medianH * 0.65, 0.008);
    items.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
    const rows = [];
    for (const item of items) {
      let row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
      if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
      row.items.push(item);
      row.y = row.items.reduce((sum, x) => sum + x.y, 0) / row.items.length;
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x || a.index - b.index).map((x) => x.b));
  }

  _sliceText(fullText, textAnchor) {
    if (!textAnchor || !textAnchor.textSegments || !textAnchor.textSegments.length) return '';
    return textAnchor.textSegments
      .map((seg) => fullText.substring(Number(seg.startIndex || 0), Number(seg.endIndex || 0)))
      .join('');
  }
}

module.exports = GoogleDocumentAIProvider;
