const CONFIDENCE_REVIEW_THRESHOLD = 0.75;

// Each pair is checked together: a question paper may be bilingual, English-only,
// or Tamil-only. It is only an error if BOTH sides of a pair are empty — one side
// filled and the other blank is the expected, correct shape for a monolingual paper.
const TEXT_FIELD_PAIRS = [
  ['question_en', 'question_ta'],
  ['option_a_en', 'option_a_ta'],
  ['option_b_en', 'option_b_ta'],
  ['option_c_en', 'option_c_ta'],
  ['option_d_en', 'option_d_ta'],
];
const TEXT_FIELDS = TEXT_FIELD_PAIRS.flat();

function validateQuestions(rows, { confidenceByNumber = {} } = {}) {
  const seenNumbers = new Map();
  const checked = rows.map((row) => {
    const issues = Array.isArray(row._preIssues) ? [...row._preIssues] : [];
    if (row.question_number === null || row.question_number === undefined) issues.push('Missing question number');
    for (const [enField, taField] of TEXT_FIELD_PAIRS) {
      const hasEn = String(row[enField] || '').trim();
      const hasTa = String(row[taField] || '').trim();
      if (!hasEn && !hasTa) issues.push(`Missing ${enField}/${taField} (both languages empty)`);
    }
    if (row.correct_answer && !['A','B','C','D'].includes(row.correct_answer)) issues.push('correct_answer must be A/B/C/D when present');
    if (row.question_number !== null && row.question_number !== undefined) {
      seenNumbers.set(row.question_number, (seenNumbers.get(row.question_number) || 0) + 1);
    }
    const invalidCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    for (const field of TEXT_FIELDS) if (invalidCharPattern.test(String(row[field] || ''))) issues.push(`Invalid control characters in ${field}`);
    const confidence = row.question_number != null ? confidenceByNumber[row.question_number] : undefined;
    if (typeof confidence === 'number' && confidence < CONFIDENCE_REVIEW_THRESHOLD) issues.push(`Low OCR confidence (${(confidence * 100).toFixed(0)}%)`);

    const { _preReview, _preIssues, ...cleanRow } = row;
    return {
      ...cleanRow,
      confidence: typeof confidence === 'number' ? confidence : null,
      _review: issues.length > 0,
      _issues: [...new Set(issues)],
    };
  });

  for (const row of checked) {
    if (row.question_number != null && seenNumbers.get(row.question_number) > 1) {
      row._issues.push(`Duplicate question number ${row.question_number}`);
      row._review = true;
    }
  }

  // Never let a row with all required data become invalid merely because the
  // parser assigned a source page. Empty rows are removed before this stage.
  checked.sort((a, b) => {
    const an = Number(a.question_number) || Number.MAX_SAFE_INTEGER;
    const bn = Number(b.question_number) || Number.MAX_SAFE_INTEGER;
    return an - bn || (Number(a.source_page) || 0) - (Number(b.source_page) || 0);
  });

  return {
    rows: checked,
    summary: {
      total: checked.length,
      review_required: checked.filter((r) => r._review).length,
      valid: checked.filter((r) => !r._review).length,
    },
  };
}

module.exports = { validateQuestions, CONFIDENCE_REVIEW_THRESHOLD };
