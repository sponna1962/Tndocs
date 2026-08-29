const fs = require('fs');
const fetch = require('node-fetch');
const OCRProvider = require('./OCRProvider');
const config = require('../config');

/**
 * Azure AI Document Intelligence ("Read" / prebuilt-read model) supports a
 * long list of languages/scripts for OCR. This uses the async
 * analyze -> poll operation-location pattern documented at:
 * https://learn.microsoft.com/azure/ai-services/document-intelligence/
 *
 * NOTE: verify in current Azure documentation that the model you select
 * supports Tamil for your API version - Azure updates language coverage
 * independently of this codebase, and this file deliberately does not
 * hard-code an assumption about which languages are supported today.
 */
class AzureDocumentIntelligenceProvider extends OCRProvider {
  get name() {
    return 'azure-document-intelligence';
  }

  async extract(filePath, mimeType) {
    const { endpoint, key, model } = config.azure;
    if (!endpoint || !key) {
      throw new Error('AZURE_DOCINTEL_ENDPOINT and AZURE_DOCINTEL_KEY must be set.');
    }

    const analyzeUrl = `${endpoint.replace(/\/+$/, '')}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30`;

    const fileBuffer = fs.readFileSync(filePath);
    const submitRes = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': mimeType,
      },
      body: fileBuffer,
    });

    if (submitRes.status !== 202) {
      const errText = await submitRes.text();
      throw new Error(`Azure Document Intelligence submit failed (${submitRes.status}): ${errText}`);
    }

    const operationLocation = submitRes.headers.get('operation-location');
    if (!operationLocation) {
      throw new Error('Azure Document Intelligence did not return an operation-location header.');
    }

    const result = await this._poll(operationLocation, key);
    return this._normalize(result);
  }

  async _poll(operationLocation, key, { intervalMs = 2000, maxAttempts = 60 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await fetch(operationLocation, {
        headers: { 'Ocp-Apim-Subscription-Key': key },
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Azure Document Intelligence polling failed (${res.status}): ${errText}`);
      }
      const data = await res.json();
      if (data.status === 'succeeded') return data;
      if (data.status === 'failed') {
        throw new Error(`Azure Document Intelligence analysis failed: ${JSON.stringify(data.error || data)}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Azure Document Intelligence analysis timed out.');
  }

  _normalize(azureResult) {
    const analyzeResult = azureResult.analyzeResult || {};
    const fullText = analyzeResult.content || '';
    const pages = (analyzeResult.pages || []).map((p) => {
      const blocks = (p.lines || []).map((line) => ({
        text: line.content || '',
        confidence:
          typeof line.confidence === 'number'
            ? line.confidence
            : this._averageWordConfidence(p.words, line),
        boundingBox: line.polygon || null,
      }));
      const pageText = blocks.map((b) => b.text).join('\n');
      return { pageNumber: p.pageNumber, text: pageText, blocks };
    });

    const confidences = pages
      .flatMap((p) => p.blocks.map((b) => b.confidence))
      .filter((c) => typeof c === 'number');
    const averageConfidence = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;

    return { fullText, pages, averageConfidence, provider: this.name };
  }

  _averageWordConfidence(words, line) {
    if (!words || !words.length) return null;
    const relevant = words.filter((w) => line.content && line.content.includes(w.content));
    const withConf = relevant.filter((w) => typeof w.confidence === 'number');
    if (!withConf.length) return null;
    return withConf.reduce((a, w) => a + w.confidence, 0) / withConf.length;
  }
}

module.exports = AzureDocumentIntelligenceProvider;
