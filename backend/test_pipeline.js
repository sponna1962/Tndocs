/**
 * Offline integration test (not part of the shipped app) exercising the
 * split two-stage pipeline with a fake OCR provider, so we can verify the
 * awaiting_text_review pause + confirm-text resume logic without hitting a
 * real Google/Azure endpoint or needing npm-installed deps beyond the
 * lightweight test shims created alongside this file.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Isolate config's file paths to a scratch dir so this test never touches
// the real backend/src/data directory.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnpsc-test-'));
process.env.UPLOAD_DIR = path.join(scratchDir, 'uploads');
process.env.JOB_DB_FILE = path.join(scratchDir, 'jobs.json');
process.env.OCR_PROVIDER = 'google'; // irrelevant - we monkey-patch the factory below

const jobStore = require('./src/services/jobStore');
const providerFactory = require('./src/providers/providerFactory');
const { parseQuestions } = require('./src/services/questionParser');
const llmStructurer = require('./src/services/llmStructurer');
const { buildCSV } = require('./src/services/csvBuilder');

// --- Monkey-patch the LLM structurer with a fake, deterministic translator
// so this test never makes a network call or requires ANTHROPIC_API_KEY.
// It does the same job the real one does (translate + confirm the answer),
// just with a tiny hardcoded Tamil<->English dictionary instead of a model.
const FAKE_TRANSLATIONS = {
  'Tamil Nadu தலைநகரம் எது?': { ta: 'தமிழ்நாட்டின் தலைநகரம் எது?', en: 'What is the capital of Tamil Nadu?' },
  'Chennai (corrected)': { ta: 'சென்னை', en: 'Chennai (corrected)' },
  'Chennai': { ta: 'சென்னை', en: 'Chennai' },
  'Madurai': { ta: 'மதுரை', en: 'Madurai' },
  'Coimbatore': { ta: 'கோயம்புத்தூர்', en: 'Coimbatore' },
  'Salem': { ta: 'சேலம்', en: 'Salem' },
  'What is 2+2?': { ta: '2+2 என்ன?', en: 'What is 2+2?' },
  '3': { ta: '3', en: '3' },
  '4': { ta: '4', en: '4' },
  '5': { ta: '5', en: '5' },
  '6': { ta: '6', en: '6' },
};
llmStructurer.structureQuestionsBatch = async (rows) => rows.map((row) => {
  const tr = (s) => FAKE_TRANSLATIONS[s] || { ta: s, en: s };
  const q = tr(row.question);
  const a = tr(row.option_a);
  const b = tr(row.option_b);
  const c = tr(row.option_c);
  const d = tr(row.option_d);
  return {
    fields: {
      question_ta: q.ta,
      question_en: q.en,
      option_a_ta: a.ta,
      option_a_en: a.en,
      option_b_ta: b.ta,
      option_b_en: b.en,
      option_c_ta: c.ta,
      option_c_en: c.en,
      option_d_ta: d.ta,
      option_d_en: d.en,
      correct_answer: row.answer_hint_letter || 'A',
    },
    review: false,
    issues: [],
  };
});

// --- Monkey-patch the OCR provider factory with a fake, deterministic
// provider so this test never makes a network call. ---
const FAKE_OCR_TEXT = [
  '1. Tamil Nadu தலைநகரம் எது?',
  '(A) Chennai',
  '(B) Madurai',
  '(C) Coimbatore',
  '(D) Salem',
  '2. What is 2+2?',
  '(A) 3',
  '(B) 4',
  '(C) 5',
  '(D) 6',
].join('\n');

providerFactory.getOCRProvider = () => ({
  async extract() {
    return {
      fullText: FAKE_OCR_TEXT,
      pages: [
        {
          pageNumber: 1,
          text: FAKE_OCR_TEXT,
          blocks: FAKE_OCR_TEXT.split('\n').map((text) => ({ text, confidence: 0.92 })),
        },
      ],
      averageConfidence: 0.92,
      provider: 'fake-test-provider',
    };
  },
});

// pipeline/processJob.js captures getOCRProvider via destructuring at
// require-time, so we must patch the module's export *before* requiring
// pipeline/processJob.js the first time, OR patch after require but before
// use if it calls providerFactory.getOCRProvider() dynamically each time.
// Looking at pipeline/processJob.js: it calls getOCRProvider() (imported by
// destructuring) - Node caches the module object, and destructuring copies
// the function reference at require time. So we must re-require after
// patching, which works because we haven't required pipeline yet.
const { runOcrStage, runStructuringStage, STAGES } = require('./src/pipeline/processJob');

async function main() {
  const jobId = 'test-job-1';
  await jobStore.create({
    id: jobId,
    status: STAGES.UPLOADING,
    originalFilename: 'sample.pdf',
    filePath: '/dev/null', // fake provider never reads this
    mimeType: 'application/pdf',
    metadata: { exam: 'TNPSC Group 2', year: '2024', subject: 'General Studies' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pagesProcessed: null,
    questionsDetected: null,
    questionsReviewRequired: null,
    questionsValid: null,
    ocrProvider: null,
    ocrAverageConfidence: null,
    result: null,
    error: null,
  });

  // --- Stage 1: OCR ---
  await runOcrStage(jobId);
  let job = await jobStore.get(jobId);
  assert.strictEqual(job.status, STAGES.AWAITING_TEXT_REVIEW, 'job should pause at awaiting_text_review');
  assert.ok(Array.isArray(job.ocrPages) && job.ocrPages.length === 1, 'ocrPages should be populated');
  assert.ok(job.ocrPages[0].text.includes('தலைநகரம்'), 'Tamil OCR text should round-trip intact');
  assert.strictEqual(job.result, null, 'result must NOT exist yet - pipeline must not auto-continue');
  console.log('[PASS] Stage 1 (OCR) pauses at awaiting_text_review with no auto-continue.');

  // Simulate the user editing the OCR text in Step 2 before confirming
  // (fixing a hypothetical OCR mistake: "Chennai" -> corrected spelling).
  const editedPages = job.ocrPages.map((p) => ({
    ...p,
    text: p.text.replace('Chennai', 'Chennai (corrected)'),
  }));

  // --- Stage 2: confirm-text resumes the pipeline ---
  await runStructuringStage(jobId, editedPages);
  job = await jobStore.get(jobId);
  assert.strictEqual(job.status, STAGES.COMPLETED, 'job should complete after confirm-text');
  assert.strictEqual(job.questionsDetected, 2, 'should detect 2 questions');
  assert.ok(job.result && Array.isArray(job.result.rows), 'result rows should exist');
  assert.strictEqual(
    job.result.rows[0].option_a_en,
    'Chennai (corrected)',
    'edited text from Step 2 review must flow into the final structured row'
  );
  assert.strictEqual(
    job.result.rows[0].option_a_ta,
    'சென்னை',
    'the Tamil column must be a real translation, not a copy of the English text'
  );
  assert.strictEqual(
    job.result.rows[0].correct_answer,
    'A',
    'correct_answer must be a bare letter, produced by the (fake) structuring step'
  );
  console.log('[PASS] Stage 2 (confirm-text) resumes pipeline and honors user edits from Step 2.');

  // --- Guard: confirm-text cannot be called twice / out of order ---
  let threw = false;
  try {
    await runStructuringStage(jobId, editedPages);
  } catch (e) {
    threw = true;
  }
  // runStructuringStage catches its own errors and writes status=failed
  // rather than throwing, so check the resulting status instead.
  job = await jobStore.get(jobId);
  assert.strictEqual(job.status, STAGES.FAILED, 'calling confirm-text again after completion must fail loudly, not silently reprocess');
  console.log('[PASS] Re-confirming an already-completed job fails safely (no double-processing).');

  // --- CSV export sanity check (BOM + UTF-8 + Tamil + column order) ---
  const csv = buildCSV([
    {
      question_ta: 'தமிழ்நாட்டின் தலைநகரம் எது?',
      question_en: 'What is the capital of Tamil Nadu?',
      option_a_ta: 'சென்னை',
      option_a_en: 'Chennai (corrected)',
      option_b_ta: 'மதுரை',
      option_b_en: 'Madurai',
      option_c_ta: 'கோயம்புத்தூர்',
      option_c_en: 'Coimbatore',
      option_d_ta: 'சேலம்',
      option_d_en: 'Salem',
      correct_answer: 'A',
      _review: false,
    },
  ]);
  assert.ok(csv.charCodeAt(0) === 0xfeff, 'CSV must start with a UTF-8 BOM for Excel');
  assert.ok(csv.includes('தலைநகரம்'), 'Tamil text must be preserved untouched in the CSV');
  assert.ok(!csv.includes('Answer:') && !csv.includes('✓'), 'answer-key text/tick marks must never leak into the CSV');
  const headerLine = csv.slice(1).split('\n')[0];
  assert.strictEqual(
    headerLine,
    'question_en,question_ta,option_a_en,option_a_ta,option_b_en,option_b_ta,option_c_en,option_c_ta,option_d_en,option_d_ta,correct_answer',
    'CSV column order must exactly match the PONNA-compatible spec'
  );
  console.log('[PASS] CSV export: BOM present, Tamil intact, column order correct, correct_answer is a bare letter.');

  // --- Parser sanity check on Tamil digit numbering ---
  const tamilNumbered = parseQuestions('௧. What is this?\n(A) one\n(B) two\n(C) three\n(D) four');
  assert.strictEqual(tamilNumbered[0].question_number, 1, 'Tamil digit ௧ should parse as question 1');
  console.log('[PASS] Tamil-numeral question numbering parses correctly.');

  // --- Answer detection + cleanup sanity checks (questionParser.js only,
  // no LLM involved - these must work purely from regex) ---
  const tickParsed = parseQuestions(
    '1. Which city?\nA. Chennai\nB. Madurai ✓\nC. Salem\nD. Trichy'
  );
  assert.strictEqual(tickParsed[0].option_b, 'Madurai', 'tick mark must be stripped from the option text');
  assert.strictEqual(tickParsed[0].answer_hint_letter, 'B', 'a tick mark must resolve to the correct option letter');
  console.log('[PASS] Tick-mark answer detection strips the mark and resolves the letter.');

  const answerLineParsed = parseQuestions(
    '1. Capital of Australia?\nA. Sydney\nB. Melbourne\nC. Canberra\nD. Perth\nAnswer: Canberra'
  );
  assert.strictEqual(
    answerLineParsed[0].question,
    'Capital of Australia?',
    'an "Answer:" line must never be glued onto the question/option text'
  );
  assert.strictEqual(answerLineParsed[0].option_d, 'Perth', 'the last option must not absorb the answer line');
  assert.strictEqual(
    answerLineParsed[0].answer_hint_letter,
    'C',
    'an answer stated as text ("Canberra") must resolve to the matching option letter'
  );
  console.log('[PASS] "Answer: <text>" lines are detected, removed, and resolved to the right option letter.');

  const letterAnswerParsed = parseQuestions(
    '1. 2+2 is?\nA. 3\nB. 4\nC. 5\nD. 6\nAns: B'
  );
  assert.strictEqual(letterAnswerParsed[0].answer_hint_letter, 'B', '"Ans: B" must resolve directly to letter B');
  console.log('[PASS] "Ans: <letter>" lines resolve directly.');

  const noAnswerParsed = parseQuestions('1. No answer given here?\nA. one\nB. two\nC. three\nD. four');
  assert.strictEqual(
    noAnswerParsed[0].needs_llm_answer_resolution,
    true,
    'with no tick mark and no answer line, the parser must not guess - it defers to LLM structuring, which itself must fall back to REVIEW REQUIRED rather than guess'
  );
  console.log('[PASS] Questions with no stated answer are correctly left unresolved (never guessed).');

  console.log('\nALL TESTS PASSED');
}

main()
  .then(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
