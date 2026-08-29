const jobStore = require('../services/jobStore');
const { getOCRProvider } = require('../providers/providerFactory');
const { parseQuestions } = require('../services/questionParser');
const { structureQuestionsBatch, recoverOcrFromPdf } = require('../services/llmStructurer');
const { extractAllPages, mapToCsvRows } = require('../services/pageVisionExtractor');
const { validateQuestions } = require('../services/validator');
const { splitPdfIntoPages, cleanupSplitPdf } = require('../services/pdfPages');
const config = require('../config');

// Vision mode reads each page IMAGE directly with Gemini and returns
// finished structured questions in one call per page, instead of running
// OCR text-extraction and then a regex parser over that text. This avoids
// the failure mode where OCR returns a truncated page and the regex parser
// silently manufactures a garbage "question" from the leftover fragment.
// It requires GEMINI_API_KEY. Falls back to the legacy OCR+regex pipeline
// if no Gemini key is configured, or if explicitly disabled.
function visionModeEnabled() {
  if (String(process.env.EXTRACTION_MODE || '').toLowerCase() === 'ocr') return false;
  return Boolean(config.gemini.apiKey);
}

function renderPageReview(pageResult) {
  const lines = [];
  for (const q of pageResult.questions || []) {
    lines.push(`${q.question_number}. ${q.question_en}`);
    lines.push(q.question_ta);
    lines.push(`(A) ${q.option_a_en} / ${q.option_a_ta}`);
    lines.push(`(B) ${q.option_b_en} / ${q.option_b_ta}`);
    lines.push(`(C) ${q.option_c_en} / ${q.option_c_ta}`);
    lines.push(`(D) ${q.option_d_en} / ${q.option_d_ta}`);
    lines.push(`Detected answer: ${q.correct_answer}${q.incomplete ? '  [INCOMPLETE — verify against original page]' : ''}`);
    lines.push('');
  }
  if (!lines.length) lines.push('(No complete question detected on this page.)');
  return lines.join('\n');
}

async function runVisionOcrStage(jobId) {
  let tempDir;
  try {
    await jobStore.update(jobId, { status: STAGES.OCR_PROCESSING, processedPages: 0, successfulPages: 0, failedPages: [], currentPage: 0 });
    const job = await jobStore.get(jobId);
    const split = await splitPdfIntoPages(job.filePath);
    tempDir = split.tempDir;
    await jobStore.update(jobId, { totalPages: split.totalPages, pagesProcessed: 0 });

    const concurrency = Math.max(1, Number(process.env.GEMINI_VISION_CONCURRENCY || config.gemini.concurrency || 2));
    const minIntervalMs = Math.max(0, Number(process.env.GEMINI_VISION_MIN_INTERVAL_MS || 0));
    const { results, failedPages, aborted, abortReason } = await extractAllPages(split.pages, {
      concurrency,
      minIntervalMs,
      onProgress: async ({ done, pageNumber }) => {
        await jobStore.update(jobId, { pagesProcessed: done, processedPages: done, currentPage: pageNumber });
      },
    });

    const ocrPages = results.map((r) => ({ pageNumber: r.pageNumber, text: renderPageReview(r), blocks: [] }));
    await jobStore.update(jobId, {
      status: STAGES.AWAITING_TEXT_REVIEW,
      ocrProvider: 'gemini-vision',
      ocrAverageConfidence: null,
      ocrPages,
      _visionPages: results,
      visionMode: true,
      successfulPages: results.length - failedPages.length,
      failedPages,
      processingComplete: failedPages.length === 0,
      ...(aborted ? { circuitBreakerTripped: true, error: abortReason } : {}),
    });
  } catch (err) {
    console.error(`[VISION] Job ${jobId} fatal failure:`, err);
    await jobStore.update(jobId, { status: STAGES.FAILED, error: err.message || 'Vision extraction failed.' });
  } finally {
    await cleanupSplitPdf(tempDir).catch(() => {});
  }
}

const STAGES = { UPLOADING:'uploading', QUEUED:'queued', OCR_PROCESSING:'processing_ocr', AWAITING_TEXT_REVIEW:'awaiting_text_review', EXTRACTING_QUESTIONS:'extracting_questions', STRUCTURING_CSV:'structuring_csv', VALIDATING:'validating', COMPLETED:'completed', FAILED:'failed' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shouldRetryOcrError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (/missing|not set|invalid api key|unauthorized|forbidden|processing error|file size|unsupported|bad request/.test(m)) return false;
  if (/http 4(00|01|03|04|22)/.test(m)) return false;
  return /timeout|network|socket|econn|fetch|http 429|http 5|empty ocr output/.test(m);
}

async function ocrOne(provider, page) {
  let last;
  const attempts = Math.max(1, Number(config.ocrSpace?.attempts || 2));
  const retryBaseMs = Math.max(250, Number(config.ocrSpace?.retryBaseMs || 1000));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      console.log(`[OCR] page ${page.pageNumber}: attempt ${attempt}/${attempts}`);
      const result = provider.extractPage
        ? await provider.extractPage(page.filePath, page.mimeType, page.pageNumber)
        : await provider.extract(page.filePath, page.mimeType);
      const actual = result.pages ? result.pages[0] : result;
      const text = actual.text || '';
      if (text.trim()) {
        return { pageNumber: page.pageNumber, text, blocks: actual.blocks || [], recoveredBy: provider.name };
      }
      last = new Error('empty OCR output');
    } catch (err) {
      last = err;
      console.error(`[OCR] page ${page.pageNumber}: attempt ${attempt} failed: ${err.message}`);
    }

    // Do not waste minutes retrying errors that cannot be fixed by retrying.
    if (attempt < attempts && shouldRetryOcrError(last)) {
      const delay = retryBaseMs * (2 ** (attempt - 1));
      console.log(`[OCR] page ${page.pageNumber}: retrying after ${delay}ms`);
      await sleep(delay);
    } else {
      break;
    }
  }

  // If a free Gemini key is configured, use it only for pages OCR.space could
  // not read. This keeps the fast/cheap provider as the primary path while
  // preventing failed pages from becoming empty boxes or disappearing.
  if (config.ocrSpace?.geminiFallback && config.gemini?.apiKey) {
    try {
      console.log(`[OCR] page ${page.pageNumber}: OCR.space failed; trying Gemini fallback`);
      const text = await recoverOcrFromPdf(page.filePath);
      if (String(text || '').trim()) {
        return {
          pageNumber: page.pageNumber,
          text,
          blocks: [{ text, confidence: null, boundingBox: null }],
          recoveredBy: 'gemini-fallback',
        };
      }
      last = new Error('Gemini fallback returned empty OCR output');
    } catch (err) {
      console.error(`[OCR] page ${page.pageNumber}: Gemini fallback failed: ${err.message}`);
      last = err;
    }
  }
  throw last || new Error('OCR failed');
}
async function runOcrStage(jobId) {
  if (visionModeEnabled()) return runVisionOcrStage(jobId);
  let tempDir;
  try {
    await jobStore.update(jobId, { status: STAGES.OCR_PROCESSING, processedPages:0, successfulPages:0, failedPages:[], currentPage:0 });
    const job = await jobStore.get(jobId); const provider = getOCRProvider();
    // Google Document AI already understands multi-page documents. Sending a
    // whole PDF in one request avoids 100+ individual API calls and is much
    // faster/less likely to hit per-minute quotas. If the document exceeds
    // the processor's synchronous limit, fall back to the existing splitter.
    if (job.mimeType === 'application/pdf' && provider.name === 'google-document-ai') {
      try {
        const whole = await provider.extract(job.filePath, job.mimeType);
        const usable = (whole.pages || []).map((p, i) => ({ pageNumber: p.pageNumber || i + 1, text: p.text || '', blocks: p.blocks || [] })).filter((p) => p.text.trim());
        const failed = (whole.pages || []).filter((p) => !String(p.text || '').trim()).map((p, i) => ({ pageNumber: p.pageNumber || i + 1, error: 'Empty OCR output' }));
        const totalPages = Math.max((whole.pages || []).length, usable.length + failed.length, 1);
        await jobStore.update(jobId, { status: STAGES.AWAITING_TEXT_REVIEW, totalPages, pagesProcessed: totalPages, processedPages: totalPages, successfulPages: usable.length, currentPage: totalPages, ocrProvider: provider.name, ocrAverageConfidence: whole.averageConfidence ?? null, ocrPages: usable, _ocrRawPages: whole.pages || [], failedPages: failed, processingComplete: failed.length === 0 });
        return;
      } catch (googleErr) {
        console.error(`[OCR] whole-document Google OCR failed; falling back to page mode: ${googleErr.message}`);
      }
    }
    let pages;
    if (job.mimeType === 'application/pdf') {
      const split = await splitPdfIntoPages(job.filePath); pages = split.pages; tempDir = split.tempDir;
      await jobStore.update(jobId, { totalPages: split.totalPages, pagesProcessed:0 });
    } else { pages=[{pageNumber:1,filePath:job.filePath,mimeType:job.mimeType}]; await jobStore.update(jobId,{totalPages:1,pagesProcessed:0}); }
    const ocrPages=[]; const raw=[]; const failed=[];
    const configuredConcurrency = Number(process.env.OCR_CONCURRENCY || config.ocrSpace?.concurrency || 1);
    const providerConcurrency = provider.name === 'ocr-space' ? Math.min(1, configuredConcurrency) : configuredConcurrency;
    const concurrency = Math.max(1, providerConcurrency);
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++; if (i >= pages.length) return;
        const page = pages[i];
        console.log(`[OCR] Job ${jobId}: starting page ${page.pageNumber}/${pages.length}`);
        await jobStore.update(jobId, { currentPage: page.pageNumber });
        try {
          const result = await ocrOne(provider, page);
          console.log(`[OCR] Job ${jobId}: page ${page.pageNumber} completed via ${result.recoveredBy}`);
          ocrPages.push({ pageNumber: page.pageNumber, text: result.text, blocks: result.blocks || [] }); raw.push(result);
        } catch (err) {
          console.error(`[OCR] Job ${jobId}: page ${page.pageNumber} permanently failed: ${err.message}`);
          failed.push({ pageNumber: page.pageNumber, error: String(err.message || err).slice(0, 500) });
        }
        const done = ocrPages.length + failed.length;
        await jobStore.update(jobId,{ pagesProcessed:done, processedPages:done, successfulPages:ocrPages.length, failedPages:[...failed], currentPage:page.pageNumber, ocrPages:[...ocrPages].sort((a,b)=>a.pageNumber-b.pageNumber) });
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, pages.length)}, worker));
    ocrPages.sort((a,b)=>a.pageNumber-b.pageNumber);
    await jobStore.update(jobId,{ status:STAGES.AWAITING_TEXT_REVIEW, ocrProvider:provider.name, ocrAverageConfidence:null, ocrPages, _ocrRawPages:raw, failedPages:failed, processingComplete:ocrPages.length===pages.length });
  } catch(err) { console.error(`[OCR] Job ${jobId} fatal failure:`, err); await jobStore.update(jobId,{status:STAGES.FAILED,error:err.message||'OCR processing failed.'}); }
  finally { await cleanupSplitPdf(tempDir).catch(()=>{}); }
}

async function runStructuringStage(jobId, editedPages) {
  try {
    const job = await jobStore.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);
    if (job.status !== STAGES.AWAITING_TEXT_REVIEW) throw new Error(`Job is not awaiting text review (current status: ${job.status}).`);

    let structuredRows;

    if (job.visionMode && Array.isArray(job._visionPages) && job._visionPages.length) {
      // Vision mode: pages were already fully structured (question + options
      // + tick-marked answer) in one Gemini call per page during the OCR
      // stage. There is no separate text-parsing/LLM-structuring pass here —
      // we just flatten and renumber. This is what keeps vision mode from
      // reintroducing the old regex-parser failure mode.
      await jobStore.update(jobId, { status: STAGES.STRUCTURING_CSV });
      structuredRows = mapToCsvRows(job._visionPages);
      await jobStore.update(jobId, { questionsDetected: structuredRows.length });
    } else {
      const pages = (Array.isArray(editedPages) && editedPages.length ? editedPages : job.ocrPages || [])
        .filter((p) => String(p?.text || '').trim())
        .sort((a, b) => (Number(a.pageNumber) || 0) - (Number(b.pageNumber) || 0));

      await jobStore.update(jobId, { status: STAGES.EXTRACTING_QUESTIONS, ocrPages: pages });
      const parsedRows = parseQuestions(pages);

      // Give Gemini the original page text as repair context. OCR frequently
      // breaks a bilingual question across lines/columns, and some questions
      // continue onto the next PDF page. The parser extracts a candidate block,
      // while Gemini gets the surrounding page evidence needed to reconstruct it.
      const pageContext = new Map(
        pages.map((p) => [Number(p.pageNumber), String(p.text || '')])
      );
      parsedRows.forEach((row) => {
        const pageText = pageContext.get(Number(row.source_page)) || '';
        row._source_page_context = pageText.slice(0, 12000);
      });

      await jobStore.update(jobId, { status: STAGES.STRUCTURING_CSV, questionsDetected: parsedRows.length });

      const structured = await structureQuestionsBatch(parsedRows);
      structuredRows = structured.map((result, i) => {
        const sourceIndex = Number.isInteger(result.sourceRowIndex) ? result.sourceRowIndex : i;
        const row = parsedRows[sourceIndex] || parsedRows[i];
        const fields = result.fields || {};
        return {
          question_number: row.question_number,
          source_question_number: row.source_question_number ?? row.question_number,
          source_page: row.source_page,
          question_ta: fields.question_ta || '',
          question_en: fields.question_en || '',
          option_a_ta: fields.option_a_ta || '', option_a_en: fields.option_a_en || '',
          option_b_ta: fields.option_b_ta || '', option_b_en: fields.option_b_en || '',
          option_c_ta: fields.option_c_ta || '', option_c_en: fields.option_c_en || '',
          option_d_ta: fields.option_d_ta || '', option_d_en: fields.option_d_en || '',
          correct_answer: ['A','B','C','D'].includes(fields.correct_answer) ? fields.correct_answer : '',
          _preReview: Boolean(result.review),
          _preIssues: Array.isArray(result.issues) ? result.issues : [],
        };
      });
    }

    // Export numbering is always contiguous, assigned only after
    // reconstruction, so deleting a question later can safely renumber.
    structuredRows.forEach((row, index) => { row.question_number = index + 1; });

    await jobStore.update(jobId, { status: STAGES.VALIDATING });
    const { rows, summary } = validateQuestions(structuredRows, { confidenceByNumber: {} });
    await jobStore.update(jobId, {
      status: STAGES.COMPLETED,
      questionsDetected: summary.total,
      questionsReviewRequired: summary.review_required,
      questionsValid: summary.valid,
      result: { rows, summary },
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[STRUCTURE] Job ${jobId} failed:`, err);
    await jobStore.update(jobId, { status: STAGES.FAILED, error: err.message || 'Question structuring/validation failed.' });
  }
}
module.exports={runOcrStage,runStructuringStage,STAGES};
