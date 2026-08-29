const fetch = require('node-fetch');
const config = require('../config');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_API_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are the AI engine for a TNPSC scanned-question-paper to CSV converter.

Your job is to RECONSTRUCT the supplied question blocks into clean bilingual MCQs.
The OCR can be badly ordered, incomplete, duplicated, mixed-language, or split across lines/pages.

For every input item_id return exactly one object with:
item_id, question_ta, question_en,
option_a_ta, option_a_en, option_b_ta, option_b_en,
option_c_ta, option_c_en, option_d_ta, option_d_en,
correct_answer.

STRICT RULES:
1. Preserve the meaning and facts of the source. Do not invent a new question.
2. You MAY repair obvious OCR corruption, missing punctuation, broken words, and broken line order when the surrounding source context makes the intended text clear.
3. If the paper is bilingual, create TWO complete language versions of the SAME question.
4. question_en must be English only. question_ta must be Tamil only.
5. Every option A-D must also have a complete English version and a complete Tamil version.
6. Do NOT copy the same mixed Tamil/English source into both language fields.
7. Do NOT put English sentences in the Tamil field or Tamil sentences in the English field.
8. Proper names, scientific symbols and unavoidable abbreviations may remain unchanged when translation would damage meaning.
9. Never put option labels, answer labels, ticks, or OCR answer markers inside question/option text.
10. Keep each option attached to the correct question.
11. Reconstruct logical exam order using question number, page number, surrounding text, option continuity, and source context. OCR order is not authoritative.
12. Do not merge two different questions.
13. Do not split one question into two questions.
14. If a question is incomplete in the OCR but the missing wording is clearly recoverable from the supplied page context or the parallel Tamil/English version, reconstruct it.
15. If the source is genuinely too damaged to recover a required field, return the best faithful reconstruction and let the application flag it for review.
16. correct_answer must be A, B, C, D, or REVIEW_REQUIRED.
17. If locked_answer_hint is A/B/C/D, it is authoritative.
18. If no locked hint exists, determine the answer from an explicit answer key/tick when present.
19. If there is no printed answer, solve a standard academic MCQ from the supplied question and options. Do not leave it REVIEW_REQUIRED merely because the paper has no answer key.
20. Never fabricate an answer when the question/options are genuinely unreadable.
21. Return exactly one object for every input item_id. Objects may be reordered to restore logical exam order.

Return ONLY JSON matching the supplied response schema. No markdown and no explanation.`;

const REQUIRED_FIELDS = [
  'item_id', 'question_ta', 'question_en',
  'option_a_ta', 'option_a_en', 'option_b_ta', 'option_b_en',
  'option_c_ta', 'option_c_en', 'option_d_ta', 'option_d_en',
  'correct_answer',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripCodeFences(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function hasTamil(value) { return /[\u0B80-\u0BFF]/.test(String(value || '')); }
function hasEnglish(value) { return /[A-Za-z]/.test(String(value || '')); }
function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function sameMeaningCopy(a, b) {
  const x = normalizeText(a).toLowerCase();
  const y = normalizeText(b).toLowerCase();
  return !!x && !!y && x === y;
}

function languageProblem(fields) {
  const pairs = [
    ['question_en', 'question_ta'],
    ['option_a_en', 'option_a_ta'],
    ['option_b_en', 'option_b_ta'],
    ['option_c_en', 'option_c_ta'],
    ['option_d_en', 'option_d_ta'],
  ];
  const problems = [];
  for (const [en, ta] of pairs) {
    const ev = normalizeText(fields[en]);
    const tv = normalizeText(fields[ta]);
    if (!ev || !tv) problems.push(`Missing bilingual pair: ${en}/${ta}`);
    if (sameMeaningCopy(ev, tv)) problems.push(`Duplicated bilingual pair: ${en}/${ta}`);
    if (hasTamil(ev) && !/^[A-Za-z0-9\s.,;:!?()\[\]{}%+\-=/&'"°×÷√≤≥<>]+$/.test(ev)) {
      problems.push(`Tamil text detected in ${en}`);
    }
    if (hasEnglish(tv)) problems.push(`English text detected in ${ta}`);
  }
  return problems;
}

function localFields(row) {
  const fields = {};
  const sources = [
    ['question', 'question_ta', 'question_en'],
    ['option_a', 'option_a_ta', 'option_a_en'],
    ['option_b', 'option_b_ta', 'option_b_en'],
    ['option_c', 'option_c_ta', 'option_c_en'],
    ['option_d', 'option_d_ta', 'option_d_en'],
  ];
  for (const [source, ta, en] of sources) {
    const value = normalizeText(row[source]);
    if (!value) { fields[ta] = ''; fields[en] = ''; continue; }
    const tamil = hasTamil(value);
    const english = hasEnglish(value);
    if (tamil && !english) { fields[ta] = value; fields[en] = ''; }
    else if (english && !tamil) { fields[ta] = ''; fields[en] = value; }
    else { fields[ta] = ''; fields[en] = ''; }
  }
  fields.correct_answer = row.answer_hint_letter || 'REVIEW_REQUIRED';
  return fields;
}

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      item_id: { type: 'STRING' },
      question_ta: { type: 'STRING' },
      question_en: { type: 'STRING' },
      option_a_ta: { type: 'STRING' }, option_a_en: { type: 'STRING' },
      option_b_ta: { type: 'STRING' }, option_b_en: { type: 'STRING' },
      option_c_ta: { type: 'STRING' }, option_c_en: { type: 'STRING' },
      option_d_ta: { type: 'STRING' }, option_d_en: { type: 'STRING' },
      correct_answer: { type: 'STRING' },
    },
    required: REQUIRED_FIELDS,
  },
};

function getModelCandidates() {
  const configured = String(config.gemini.model || 'gemini-2.5-flash').trim().replace(/^models\//i, '');
  const fallback = ['gemini-2.5-flash-lite', 'gemini-3.5-flash'];
  return [...new Set([configured, ...fallback])];
}

async function callGemini(prompt, options = {}) {
  const { useGoogleSearch = false, attempt = 1 } = options;
  let lastError;
  const models = getModelCandidates();

  for (const model of models) {
    const url = `${GEMINI_API_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    };
    if (useGoogleSearch) body.tools = [{ googleSearch: {} }];

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
        const responseBody = await response.text().catch(() => '');
        const error = new Error(`Gemini model ${model} failed (HTTP ${response.status}): ${responseBody.slice(0, 900)}`);
        lastError = error;
        if (response.status === 404) continue;
        if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
          await sleep(1500 * attempt);
          return callGemini(prompt, { useGoogleSearch, attempt: attempt + 1 });
        }
        throw error;
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.length) {
        throw new Error(`Gemini returned no usable content (${candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
      }
      return candidate.content.parts.map((part) => part.text || '').join('');
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError' && attempt < 3) {
        await sleep(1500 * attempt);
        return callGemini(prompt, { useGoogleSearch, attempt: attempt + 1 });
      }
      if (model === models[models.length - 1]) throw error;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

async function callAnthropic(prompt) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.anthropic.model, max_tokens: 8192, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic request failed (HTTP ${response.status}): ${body.slice(0, 900)}`);
  }
  const data = await response.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function normalizeAnswer(value, row) {
  const x = normalizeText(value);
  if (!x) return '';
  const m = x.match(/^(?:option\s*)?\(?([A-Da-d])\)?[.)]?$/i);
  if (m) return m[1].toUpperCase();
  const n = x.match(/^(?:option\s*)?([1-4])(?:[.)]|\s|$)/i);
  if (n) return 'ABCD'[Number(n[1]) - 1];
  const lower = x.toLowerCase();
  for (const l of ['A', 'B', 'C', 'D']) {
    const text = normalizeText(row[`option_${l.toLowerCase()}`]).toLowerCase();
    if (text && lower === text) return l;
  }
  return '';
}

function buildBatchPrompt(rows, mode = 'structure') {
  const header = mode === 'answer'
    ? `Resolve the correct answer for each item. Use the supplied question/options first. If the answer is not explicit, use Google Search grounding when useful. Return the SAME item_id for every item and set correct_answer to A/B/C/D.`
    : `Reconstruct these scanned TNPSC MCQs. Return exactly ${rows.length} objects. The source page context is evidence for repairing broken OCR and bilingual alignment.`;

  return [header, '', ...rows.map((row, index) => [
    `ITEM ${index + 1}`,
    `item_id: ${row._source_index ?? index}`,
    `question_number: ${row.question_number ?? ''}`,
    `source_page: ${row.source_page ?? ''}`,
    `locked_answer_hint: ${row.answer_hint_letter || '(none)'}`,
    `question: ${row.question || ''}`,
    `option_a: ${row.option_a || ''}`,
    `option_b: ${row.option_b || ''}`,
    `option_c: ${row.option_c || ''}`,
    `option_d: ${row.option_d || ''}`,
    `source_page_context: ${String(row._source_page_context || '').slice(0, 6000)}`,
    '',
  ].join('\n'))].join('\n');
}

function normalizeParsed(parsed, rows) {
  if (!Array.isArray(parsed)) throw new Error('LLM response was not a JSON array.');
  if (parsed.length !== rows.length) throw new Error(`LLM returned ${parsed.length} rows for ${rows.length} inputs.`);
  const byId = new Map(rows.map((row, i) => [String(row._source_index ?? i), { row, i }]));
  const used = new Set();
  const ordered = [];
  for (const item of parsed) {
    const p = item && typeof item === 'object' ? item : {};
    const id = normalizeText(p.item_id);
    const hit = byId.get(id);
    if (!hit || used.has(id)) throw new Error(`LLM returned invalid/duplicate item_id "${id}".`);
    used.add(id);
    const fields = {};
    for (const f of REQUIRED_FIELDS) fields[f] = normalizeText(p[f]);
    const hint = hit.row.answer_hint_letter;
    if (hint) fields.correct_answer = hint;
    else fields.correct_answer = normalizeAnswer(fields.correct_answer, hit.row) || 'REVIEW_REQUIRED';
    ordered.push({ fields, sourceRowIndex: hit.i });
  }
  return ordered;
}

function assess(fields, row) {
  const issues = [];
  for (const f of REQUIRED_FIELDS) {
    if (f !== 'correct_answer' && !normalizeText(fields[f])) issues.push(`Missing ${f}`);
  }
  issues.push(...languageProblem(fields));
  if (!['A', 'B', 'C', 'D'].includes(fields.correct_answer)) issues.push('Answer could not be confidently detected.');
  if (row.answer_hint_letter) fields.correct_answer = row.answer_hint_letter;
  return { review: issues.length > 0, issues: [...new Set(issues)] };
}

async function repairLanguageAndAnswers(rows, results) {
  const broken = results.filter((r) => {
    const row = rows[r.sourceRowIndex];
    const problems = languageProblem(r.fields);
    return problems.length || !['A', 'B', 'C', 'D'].includes(r.fields.correct_answer) || row?.answer_hint_letter;
  });
  if (!broken.length) return results;

  const batchSize = Math.max(2, Math.min(8, Number(process.env.LLM_REPAIR_BATCH_SIZE || 6)));
  for (let start = 0; start < broken.length; start += batchSize) {
    const slice = broken.slice(start, start + batchSize);
    const repairRows = slice.map((r) => rows[r.sourceRowIndex]);
    try {
      const prompt = buildBatchPrompt(repairRows, 'structure') + `\n\nRepair pass requirements:\n- Fix bilingual separation.\n- Preserve question/option meaning.\n- Resolve correct_answer.\n- Use the source page context.\n- Do not duplicate English into Tamil or Tamil into English.`;
      const text = await callGemini(prompt);
      const parsed = normalizeParsed(JSON.parse(stripCodeFences(text)), repairRows);
      parsed.forEach((item) => {
        const target = slice[item.sourceRowIndex];
        if (target) target.fields = item.fields;
      });
    } catch (error) {
      console.warn(`[LLM] bilingual repair batch ${start}-${start + slice.length - 1} failed:`, error.message);
    }
    if (start + batchSize < broken.length) await sleep(Number(process.env.LLM_MIN_INTERVAL_MS || 500));
  }
  return results;
}

async function resolveMissingAnswers(rows, results) {
  const pending = results.filter((r) => !['A', 'B', 'C', 'D'].includes(r.fields.correct_answer) && !rows[r.sourceRowIndex]?.answer_hint_letter);
  if (!pending.length || config.llm.provider !== 'gemini') return results;

  const batchSize = Math.max(2, Math.min(8, Number(process.env.LLM_ANSWER_BATCH_SIZE || 6)));
  for (let start = 0; start < pending.length; start += batchSize) {
    const slice = pending.slice(start, start + batchSize);
    const answerRows = slice.map((r) => rows[r.sourceRowIndex]);
    try {
      const prompt = buildBatchPrompt(answerRows, 'answer');
      const text = await callGemini(prompt, { useGoogleSearch: String(process.env.GEMINI_GOOGLE_SEARCH || 'true').toLowerCase() === 'true' });
      const parsed = normalizeParsed(JSON.parse(stripCodeFences(text)), answerRows);
      parsed.forEach((item) => {
        const target = slice[item.sourceRowIndex];
        if (target) target.fields.correct_answer = item.fields.correct_answer;
      });
    } catch (error) {
      console.warn('[LLM] answer-resolution/search pass failed:', error.message);
    }
  }
  return results;
}

async function structureQuestionsBatch(rows) {
  if (!rows.length) return [];
  const provider = String(config.llm.provider || 'gemini').toLowerCase();
  const keyMissing = provider === 'gemini' ? !config.gemini.apiKey : provider === 'anthropic' ? !config.anthropic.apiKey : true;
  if (keyMissing) {
    const name = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    return rows.map((row, index) => ({ fields: localFields(row), review: true, issues: [`LLM structuring is not configured: ${name} is missing/empty.`], sourceRowIndex: index }));
  }
  if (!['gemini', 'anthropic'].includes(provider)) return rows.map((row, index) => ({ fields: localFields(row), review: true, issues: [`Unknown LLM_PROVIDER "${provider}".`], sourceRowIndex: index }));

  const batchSize = Math.max(2, Math.min(8, Number(process.env.LLM_BATCH_SIZE || 6)));
  const results = [];

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    try {
      const prompt = buildBatchPrompt(batch);
      const text = provider === 'gemini' ? await callGemini(prompt) : await callAnthropic(prompt);
      const parsed = normalizeParsed(JSON.parse(stripCodeFences(text)), batch);
      parsed.forEach(({ fields, sourceRowIndex }) => {
        const assessed = assess(fields, batch[sourceRowIndex]);
        results.push({ fields, review: assessed.review, issues: assessed.issues, sourceRowIndex: start + sourceRowIndex });
      });
    } catch (batchError) {
      console.warn(`[LLM] batch ${start}-${start + batch.length - 1} failed: ${batchError.message}`);
      for (let localIndex = 0; localIndex < batch.length; localIndex += 1) {
        const row = batch[localIndex];
        try {
          const text = provider === 'gemini' ? await callGemini(buildBatchPrompt([row])) : await callAnthropic(buildBatchPrompt([row]));
          const parsed = normalizeParsed(JSON.parse(stripCodeFences(text)), [row]);
          const fields = parsed[0].fields;
          const assessed = assess(fields, row);
          results.push({ fields, review: assessed.review, issues: assessed.issues, sourceRowIndex: start + localIndex });
        } catch (singleError) {
          results.push({ fields: localFields(row), review: true, issues: [`LLM batch failed: ${batchError.message}`, `LLM single-item retry failed: ${singleError.message}`], sourceRowIndex: start + localIndex });
        }
      }
    }
    if (start + batchSize < rows.length) await sleep(Number(process.env.LLM_MIN_INTERVAL_MS || 500));
  }

  if (provider === 'gemini') {
    await repairLanguageAndAnswers(rows, results);
    await resolveMissingAnswers(rows, results);
  }

  // Re-assess after all repair/answer passes.
  for (const result of results) {
    const assessed = assess(result.fields, rows[result.sourceRowIndex]);
    result.review = assessed.review;
    result.issues = assessed.issues;
  }

  // Keep the LLM's logical order. The pipeline assigns final contiguous numbers.
  return results;
}

async function structureQuestion(row) {
  const result = await structureQuestionsBatch([row]);
  return result[0];
}

let nextGeminiOcrAt = 0;
async function waitForGeminiOcrSlot() {
  const wait = Math.max(0, nextGeminiOcrAt - Date.now());
  if (wait) await sleep(wait);
  nextGeminiOcrAt = Date.now() + Number(process.env.GEMINI_OCR_MIN_INTERVAL_MS || 1200);
}

async function recoverOcrFromPdf(filePath) {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY is missing for OCR fallback.');
  const fs = require('fs');
  const base64 = fs.readFileSync(filePath).toString('base64');
  const prompt = 'Extract ALL visible text from this PDF page exactly. Preserve Tamil and English Unicode, question numbers, options and answer keys. Do not summarize or translate. Return plain text only.';
  const models = getModelCandidates();
  let lastError;
  for (const model of models) {
    try {
      const url = `${GEMINI_API_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: base64 } }, { text: prompt }] }], generationConfig: { temperature: 0 } }),
      });
      if (!response.ok) { lastError = new Error(`Gemini OCR fallback failed with model ${model} (HTTP ${response.status}): ${(await response.text()).slice(0, 700)}`); if (response.status === 404) continue; throw lastError; }
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
      if (!text) throw new Error('Gemini OCR fallback returned no text.');
      await waitForGeminiOcrSlot();
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Gemini OCR fallback failed.');
}

module.exports = { structureQuestion, structureQuestionsBatch, recoverOcrFromPdf };
