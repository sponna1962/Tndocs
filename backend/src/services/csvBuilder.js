const { stringify } = require('csv-stringify/sync');

// Exact column set/order required by the PONNA Admin Questions Upload
// system. Do not reorder, rename, or add columns here - anything else
// (question_number, exam, year, subject, ...) stays in job metadata for
// internal bookkeeping (e.g. building the export filename) but must never
// appear in this CSV.
const COLUMNS = [
  'question_en',
  'question_ta',
  'option_a_en',
  'option_a_ta',
  'option_b_en',
  'option_b_ta',
  'option_c_en',
  'option_c_ta',
  'option_d_en',
  'option_d_ta',
  'correct_answer',
];

const TEXT_COLUMNS = COLUMNS.filter((c) => c !== 'correct_answer');

/**
 * Builds a UTF-8 CSV string (with BOM, so Excel opens Tamil text correctly)
 * from validated question rows. csv-stringify handles RFC 4180 escaping
 * (commas, quotes, embedded newlines) for us so we never hand-roll string
 * concatenation for CSV fields.
 */
function buildCSV(rows) {
  const records = rows.map((r) => {
    const record = {};
    for (const field of TEXT_COLUMNS) {
      record[field] = r[field] || '';
    }
    record.correct_answer = ['A', 'B', 'C', 'D'].includes(r.correct_answer)
      ? r.correct_answer
      : '';
    return record;
  });

  const csvBody = stringify(records, { header: true, columns: COLUMNS });
  const BOM = '\uFEFF'; // ensures Excel detects UTF-8 and renders Tamil correctly
  return BOM + csvBody;
}

module.exports = { buildCSV, COLUMNS };
