/**
 * pageVisionExtractor.js
 *
 * Replaces the OCR-text + regex-parser pipeline (questionParser.js) with a
 * single vision-LLM call PER PAGE. Instead of extracting raw text and then
 * trying to regex-reassemble questions/options/answers from it (fragile —
 * TNPSC's two-column bilingual layout with tick-marked answers regularly
 * defeated the regex parser), this sends the page image straight to Gemini
 * and asks it to return the finished structured MCQ(s) directly, the same
 * way a human reviewer reads the page.
 *
 * Why this fixes the real bug:
 * - The old pipeline's OCR step sometimes returned only a tiny fragment of a
 *   page's text (e.g. just the page footer), and the regex parser would then
 *   silently manufacture a garbage "question" out of that fragment. Nothing
 *   in the pipeline ever looked at the actual page image again to check.
 * - This module never works from a lossy intermediate text representation.
 *   The model sees the page image itself, so it can also *see* which option
 *   letter is circled/ticked, instead of relying on a checkmark surviving
 *   OCR as a Unicode character.
 */

const fs = require('fs');
const fetch = require('node-fetch');
const config = require('../config');

const GEMINI_API_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are reading ONE PAGE (as an image/PDF) of a scanned TNPSC exam question paper.
The paper may be BILINGUAL (English + Tamil), ENGLISH-ONLY, or TAMIL-ONLY. Determine this from what is actually printed — do not assume.
Some papers print a THIRD language (commonly Hindi, in Devanagari script) alongside English. IGNORE Hindi (or any language other than English/Tamil) completely — never place Hindi text into question_ta or any Tamil field, and never place it into an English field either. Only English and Tamil are ever wanted in the output; treat any other language on the page as if it were not there.
The correct answer for each question is hand-marked on the page with a tick/checkmark or a hand-drawn circle around one of the option letters (A), (B), (C), (D), or occasionally (E) "Answer not known".

Extract every question that is FULLY visible on this page (full question text, all of its options, in whichever language(s) are actually printed).

For each complete question return an object with:
- question_number: the printed number (e.g. 39)
- question_en: the question in English, ONLY IF English text is printed on the page for this question. If this question is printed in Tamil only, leave question_en as an empty string "" — do NOT translate Tamil into English yourself.
- question_ta: the question in Tamil, ONLY IF Tamil text is printed on the page for this question. If this question is printed in English only, leave question_ta as an empty string "" — do NOT translate English into Tamil yourself.
  (If a question includes a "match the following" or lettered/numbered pairs, include that entire pairing inside question_en and/or question_ta as plain text on separate lines, in whichever language(s) are printed.)
- option_a_en, option_a_ta, option_b_en, option_b_ta, option_c_en, option_c_ta, option_d_en, option_d_ta: the four printed answer choices (A)-(D). Same rule: fill only the language(s) actually printed for each option; leave the other as "" rather than translating. Do not include the letter itself in the text.
- correct_answer: "A", "B", "C", or "D" — based on which option letter is visibly ticked/checked/circled by hand in the image. If the handwritten mark is on option (E) "Answer not known" or no mark is visible at all, use "REVIEW_REQUIRED".
- incomplete: true if this question's text, options, or answer mark are cut off by the top or bottom edge of the page (i.e. it clearly continues onto the previous or next page). Otherwise false.

Rules:
- NEVER invent, guess, or translate text into a language that is not actually printed on the page for that question. Faithfully transcribe only what is printed — one language, or both, exactly as the source has it.
- NEVER include Hindi or any third language anywhere in the output, even if it appears on the page. If a question is printed in English + Hindi (no Tamil), output only the English in question_en and leave question_ta as "".
- Never invent or guess a question that is not printed on the page.
- Never fabricate a correct_answer — only report a tick/circle you can actually see.
- If a fragment of a question appears at the very top of the page with no question number (continuing from the previous page), IGNORE that fragment entirely — do not return it, and do not attach it to another question. It will be handled from the previous page's own extraction.
- Keep English strictly English and Tamil strictly Tamil in each field — do not mix languages within one field.
- Do not include page footers (subject codes, page numbers, "[Turn over]") anywhere in the output.
- If the page has no complete questions at all, return an empty questions array.

Return ONLY JSON matching the response schema. No markdown, no commentary.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question_number: { type: 'INTEGER' },
          question_en: { type: 'STRING' },
          question_ta: { type: 'STRING' },
          option_a_en: { type: 'STRING' }, option_a_ta: { type: 'STRING' },
          option_b_en: { type: 'STRING' }, option_b_ta: { type: 'STRING' },
          option_c_en: { type: 'STRING' }, option_c_ta: { type: 'STRING' },
          option_d_en: { type: 'STRING' }, option_d_ta: { type: 'STRING' },
          correct_answer: { type: 'STRING' },
          incomplete: { type: 'BOOLEAN' },
        },
        required: [
          'question_number', 'question_en', 'question_ta',
          'option_a_en', 'option_a_ta', 'option_b_en', 'option_b_ta',
          'option_c_en', 'option_c_ta', 'option_d_en', 'option_d_ta',
          'correct_answer', 'incomplete',
        ],
      },
    },
  },
  required: ['questions'],
};

function stripCodeFences(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function getModelCandidates() {
  const configured = String(config.gemini.model || 'gemini-3.6-flash').trim().replace(/^models\//i, '');
  const fallback = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  return [...new Set([configured, ...fallback])];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts complete questions from a single page (PDF or image file).
 * Returns { questions: [...], pageNumber, raw }.
 * Throws on total failure (all model candidates / retries exhausted) so the
 * caller can flag the page as failed rather than silently return nothing.
 */
async function extractQuestionsFromPage(filePath, mimeType, pageNumber, { attempts = 2 } = {}) {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY is missing.');
  const bytes = fs.readFileSync(filePath);
  const base64 = bytes.toString('base64');
  const models = getModelCandidates();

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const model of models) {
      const url = `${GEMINI_API_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: mimeType || 'application/pdf', data: base64 } },
            { text: `This is page ${pageNumber} of the paper. Extract every complete question as instructed.` },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      };

      try {
        const controller = new AbortController();
        const timeoutMs = Math.max(15000, Number(process.env.GEMINI_TIMEOUT_MS || 90000));
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const errText = (await response.text()).slice(0, 700);
          lastError = new Error(`Gemini vision extraction failed with model ${model} (HTTP ${response.status}): ${errText}`);
          console.error(`[VISION] page ${pageNumber} attempt with model=${model} -> HTTP ${response.status}: ${errText.slice(0, 250)}`);
          if (response.status === 404) continue; // try next model candidate
          if (response.status === 429 || response.status >= 500) break; // retry whole attempt
          throw lastError;
        }

        console.log(`[VISION] page ${pageNumber} succeeded with model=${model}`);

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
        if (!text) { lastError = new Error(`Gemini vision extraction returned empty output for page ${pageNumber}.`); continue; }

        const parsed = JSON.parse(stripCodeFences(text));
        const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
        return { pageNumber, questions, raw: text };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < attempts) await sleep(4000 * attempt); // 503/429 are transient (Google-side overload/quota) — a few seconds' wait meaningfully improves the retry's chance of success
  }
  throw lastError || new Error(`Gemini vision extraction failed for page ${pageNumber}.`);
}

/**
 * Runs extraction across many single-page files with limited concurrency.
 * pages: [{ pageNumber, filePath, mimeType }]
 * Returns { rows, failedPages } where rows are ready for validateQuestions()
 * after contiguous renumbering (see mapToCsvRows below).
 */
async function extractAllPages(pages, { concurrency = 2, onProgress, maxConsecutiveFailures = 8, minIntervalMs = 0 } = {}) {
  const results = new Array(pages.length);
  const failed = [];
  let cursor = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let abortReason = '';

  // Rate-limit-safe pacing: on a free-tier API key (low requests-per-minute
  // quota), even concurrency=1 can exceed the limit if requests are dispatched
  // back-to-back. minIntervalMs enforces a minimum gap between the START of
  // one request and the next across ALL workers, so total throughput stays
  // under quota regardless of how fast Gemini responds.
  let nextDispatchAt = 0;
  async function waitForDispatchSlot() {
    if (!minIntervalMs) return;
    const wait = Math.max(0, nextDispatchAt - Date.now());
    if (wait) await sleep(wait);
    nextDispatchAt = Date.now() + minIntervalMs;
  }

  async function worker() {
    while (true) {
      if (aborted) return;
      const i = cursor++;
      if (i >= pages.length) return;
      const page = pages[i];

      // Circuit breaker: if the last N pages in a row have all failed, this is
      // almost certainly a systemic problem (server memory pressure, an
      // outage, a bad API key) rather than bad luck on individual pages.
      // Retrying page-by-page in that state just burns Gemini API cost for
      // guaranteed failures, so stop dispatching new pages entirely and let
      // the caller surface a clear error instead of a half-finished, very
      // expensive job.
      if (aborted) return;

      await waitForDispatchSlot();
      if (aborted) return;

      try {
        const result = await extractQuestionsFromPage(page.filePath, page.mimeType, page.pageNumber);
        results[i] = result;
        consecutiveFailures = 0;
      } catch (err) {
        const errMsg = String(err.message || err).slice(0, 500);
        console.error(`[VISION] page ${page.pageNumber} failed: ${errMsg}`);
        failed.push({ pageNumber: page.pageNumber, error: errMsg });
        results[i] = { pageNumber: page.pageNumber, questions: [], raw: '' };
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures && !aborted) {
          aborted = true;
          abortReason = `Stopped after ${consecutiveFailures} consecutive page failures — likely a server or API problem, not individual bad pages. Remaining pages were not sent to Gemini (no cost incurred for them). Check server health/logs and retry.`;
          console.error(`[VISION] circuit breaker tripped: ${abortReason}`);
        }
      }
      if (onProgress) await onProgress({ done: results.filter(Boolean).length, total: pages.length, pageNumber: page.pageNumber });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, worker));

  // Fill in any pages a worker never reached because of the circuit breaker.
  for (let i = 0; i < pages.length; i += 1) {
    if (!results[i]) {
      results[i] = { pageNumber: pages[i].pageNumber, questions: [], raw: '' };
      failed.push({ pageNumber: pages[i].pageNumber, error: 'Skipped: stopped after repeated consecutive failures elsewhere in this job.' });
    }
  }

  return { results, failedPages: failed, aborted, abortReason };
}

/**
 * Flattens per-page extraction results into CSV-ready rows.
 * Complete questions are kept in printed-number order; incomplete /
 * REVIEW_REQUIRED ones are kept too but flagged so the existing
 * validator + Preview & Edit UI surface them for manual review instead of
 * silently dropping or corrupting data.
 */
function mapToCsvRows(pageResults) {
  const all = [];
  for (const page of pageResults) {
    for (const q of page.questions || []) {
      all.push({
        source_page: page.pageNumber,
        source_question_number: q.question_number,
        question_en: q.question_en || '',
        question_ta: q.question_ta || '',
        option_a_en: q.option_a_en || '', option_a_ta: q.option_a_ta || '',
        option_b_en: q.option_b_en || '', option_b_ta: q.option_b_ta || '',
        option_c_en: q.option_c_en || '', option_c_ta: q.option_c_ta || '',
        option_d_en: q.option_d_en || '', option_d_ta: q.option_d_ta || '',
        correct_answer: ['A', 'B', 'C', 'D'].includes(q.correct_answer) ? q.correct_answer : '',
        _preReview: Boolean(q.incomplete) || !['A', 'B', 'C', 'D'].includes(q.correct_answer),
        _preIssues: q.incomplete ? ['Question appears cut off at a page boundary — verify manually.']
          : (!['A', 'B', 'C', 'D'].includes(q.correct_answer) ? ['No confident answer mark detected.'] : []),
      });
    }
  }
  all.sort((a, b) => (a.source_page - b.source_page) || (Number(a.source_question_number) - Number(b.source_question_number)));
  all.forEach((row, index) => { row.question_number = index + 1; });
  return all;
}

module.exports = { extractQuestionsFromPage, extractAllPages, mapToCsvRows };
