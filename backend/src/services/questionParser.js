const TAMIL_DIGITS = '௦௧௨௩௪௫௬௭௮௯';
const TMAP = { 'அ': 'A', 'ஆ': 'B', 'இ': 'C', 'ஈ': 'D' };
const LETTERS = ['A', 'B', 'C', 'D'];

function tamilDigitsToArabic(value) {
  return String(value || '').replace(/[௦-௯]/g, (d) => String(TAMIL_DIGITS.indexOf(d)));
}
function normalizeSpace(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
function normLetter(value) {
  const x = normalizeSpace(value);
  if (TMAP[x]) return TMAP[x];
  const m = x.match(/^(?:option\s*)?\(?\s*([A-D])\s*\)?[.)]?$/i);
  return m ? m[1].toUpperCase() : null;
}
function cleanOption(text) {
  let s = normalizeSpace(text);
  const marked = /[✓✔☑☒✗✘🗸🗹]|\(\s*(?:correct|right)\s*\)/i.test(s);
  s = s.replace(/[✓✔☑☒✗✘🗸🗹]/g, ' ').replace(/\(\s*(?:correct|right)\s*\)/ig, ' ');
  return { text: normalizeSpace(s), marked };
}
function extractAnswerHint(raw) {
  const value = normalizeSpace(raw).replace(/[✓✔☑🗸🗹]/g, '').trim();
  const letter = normLetter(value);
  if (letter) return { letter, raw: value };
  const numbered = value.match(/^(?:option\s*)?([1-4])(?:\b|[.)])/i);
  if (numbered) return { letter: LETTERS[Number(numbered[1]) - 1], raw: value };
  return { letter: null, raw: value };
}
function questionMarker(line) {
  const m = normalizeSpace(line).match(/^\s*(?:Q(?:uestion)?\.?\s*|வினா\s*|கேள்வி\s*)?(\d{1,4})\s*[.)\-:]\s*(.+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const text = normalizeSpace(m[2]);
  if (!Number.isFinite(n) || n < 1 || n > 5000 || text.length < 2) return null;
  return { number: n, text };
}
function questionNumberOnly(line) {
  const m = normalizeSpace(line).match(/^(?:Q(?:uestion)?\.?\s*|வினா\s*|கேள்வி\s*)?(\d{1,4})\s*[.)\-:]?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 5000 ? n : null;
}
function optionMarker(line) {
  const m = normalizeSpace(line).match(/^(?:\(|\[)?\s*([A-Da-dஅஆஇஈ])\s*(?:\)|\]|[.:\-])\s*(.*)$/);
  return m ? { letter: normLetter(m[1]), text: normalizeSpace(m[2]) } : null;
}
function splitInlineQuestionMarkers(line) {
  const s = normalizeSpace(line);
  if (!s) return [];
  const out = [];
  let start = 0;
  const re = /(?:^|\s)(?:(?:Q(?:uestion)?\.?\s*)|(?:வினா\s*)|(?:கேள்வி\s*))?(\d{1,4})\s*[.)\-:]\s+/gi;
  let m;
  while ((m = re.exec(s))) {
    const idx = m.index === 0 ? 0 : m.index + 1;
    if (idx > start) out.push(s.slice(start, idx).trim());
    start = idx;
  }
  if (start === 0) return [s];
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}
function splitInlineOptions(line) {
  const s = normalizeSpace(line);
  if (!s) return [];
  const matches = [];
  const re = /(?:^|\s)(?:\(|\[)?\s*([A-Da-dஅஆஇஈ])\s*(?:\)|\]|[.:\-])\s+/g;
  let m;
  while ((m = re.exec(s))) matches.push({ index: m.index === 0 ? 0 : m.index + 1, end: re.lastIndex, letter: normLetter(m[1]) });
  if (!matches.length) return [{ letter: null, text: s }];
  const parts = [];
  const prefix = s.slice(0, matches[0].index).trim();
  if (prefix) parts.push({ letter: null, text: prefix });
  for (let i = 0; i < matches.length; i += 1) {
    const end = i + 1 < matches.length ? matches[i + 1].index : s.length;
    parts.push({ letter: matches[i].letter, text: s.slice(matches[i].end, end).trim() });
  }
  return parts;
}

function parsePages(pages) {
  const out = [];
  let cur = null;
  let activeOption = null;
  let pendingQuestionNumber = null;
  let sourceIndex = 0;

  function finish(force = false) {
    if (!cur) return;
    cur.question = normalizeSpace(cur.question);
    for (const k of ['a', 'b', 'c', 'd']) cur[`option_${k}`] = normalizeSpace(cur[`option_${k}`]);
    const optionCount = LETTERS.filter((l) => cur[`option_${l.toLowerCase()}`]).length;

    // Keep incomplete MCQs so Gemini can reconstruct them from page context.
    // Only discard obvious page/header fragments.
    const plausible = cur.question.length >= 3 && (optionCount >= 1 || cur.question.length >= 18 || force);
    if (!plausible) { cur = null; activeOption = null; return; }

    if (cur.answer_hint_raw && !cur.answer_hint_letter) {
      const resolved = extractAnswerHint(cur.answer_hint_raw);
      if (resolved.letter) cur.answer_hint_letter = resolved.letter;
      if (!cur.answer_hint_letter) {
        const target = normalizeSpace(cur.answer_hint_raw).toLowerCase();
        for (const l of LETTERS) {
          if (normalizeSpace(cur[`option_${l.toLowerCase()}`]).toLowerCase() === target) {
            cur.answer_hint_letter = l;
            break;
          }
        }
      }
    }
    cur.needs_llm_answer_resolution = !cur.answer_hint_letter;
    cur._source_index = sourceIndex++;
    out.push(cur);
    cur = null;
    activeOption = null;
  }

  function startQuestion(number, textValue, pageNumber) {
    if (cur) finish();
    cur = {
      question_number: Number(number),
      question: normalizeSpace(textValue),
      option_a: '', option_b: '', option_c: '', option_d: '',
      answer_hint_letter: '', answer_hint_raw: '',
      source_page: pageNumber,
    };
    activeOption = null;
    pendingQuestionNumber = null;
  }

  for (const page of pages) {
    const pageNumber = page.pageNumber;
    const rawLines = tamilDigitsToArabic(page.text || '')
      .replace(/\r/g, '')
      .split('\n')
      .flatMap(splitInlineQuestionMarkers)
      .map(normalizeSpace)
      .filter(Boolean);

    for (const original of rawLines) {
      const leadingTick = original.match(/^[✓✔☑☒✗✘🗸🗹]+\s*([A-Da-dஅஆஇஈ])(?:\s*[.)\]:-])?/);
      const line = original.replace(/^[✓✔☑☒✗✘🗸🗹]+\s*/, '');
      if (/^page\s*\d+\s*(?:of\s*\d+)?$/i.test(line)) continue;
      if (/^(?:answer\s*key|answers?\s*key|விடைக்குறிப்பு)\b/i.test(line)) { pendingQuestionNumber = null; activeOption = null; continue; }

      const numberOnly = questionNumberOnly(line);
      if (numberOnly !== null) {
        if (cur && (LETTERS.filter((l) => String(cur[`option_${l.toLowerCase()}`] || '').trim()).length >= 1 || cur.question.length >= 18)) finish();
        pendingQuestionNumber = numberOnly;
        continue;
      }

      const qm = questionMarker(line);
      if (qm) {
        startQuestion(qm.number, '', pageNumber);
        const parts = splitInlineOptions(qm.text);
        for (const part of parts) {
          if (part.letter) {
            const c = cleanOption(part.text);
            cur[`option_${part.letter.toLowerCase()}`] = c.text;
            if (c.marked) cur.answer_hint_letter = part.letter;
            activeOption = part.letter;
          } else if (part.text) cur.question = normalizeSpace(`${cur.question} ${part.text}`);
        }
        continue;
      }

      if (!cur && pendingQuestionNumber !== null) {
        const maybeOption = optionMarker(line);
        if (!maybeOption) { startQuestion(pendingQuestionNumber, line, pageNumber); continue; }
      }
      if (!cur) continue;

      const inline = splitInlineOptions(line);
      if (inline.length > 1 || (inline[0] && inline[0].letter)) {
        for (const part of inline) {
          if (part.letter) {
            const c = cleanOption(part.text);
            const key = `option_${part.letter.toLowerCase()}`;
            cur[key] = normalizeSpace(`${cur[key]} ${c.text}`);
            if (c.marked || (leadingTick && normLetter(leadingTick[1]) === part.letter)) cur.answer_hint_letter = part.letter;
            activeOption = part.letter;
          } else if (part.text) cur.question = normalizeSpace(`${cur.question} ${part.text}`);
        }
        continue;
      }

      const om = optionMarker(line);
      if (om && om.letter) {
        const c = cleanOption(om.text);
        const key = `option_${om.letter.toLowerCase()}`;
        cur[key] = normalizeSpace(`${cur[key]} ${c.text}`);
        if (c.marked || (leadingTick && normLetter(leadingTick[1]) === om.letter)) cur.answer_hint_letter = om.letter;
        activeOption = om.letter;
        continue;
      }

      const answerMatch = line.match(/^\s*(?:correct\s*answer|correct\s*option|answer|ans(?:wer)?|விடை|சரியான\s*விடை|பதில்)\s*[:\-–.]?\s*(.+?)\s*$/i);
      if (answerMatch) {
        const resolved = extractAnswerHint(answerMatch[1]);
        cur.answer_hint_raw = resolved.raw || normalizeSpace(answerMatch[1]);
        if (resolved.letter) cur.answer_hint_letter = resolved.letter;
        activeOption = null;
        continue;
      }

      if (activeOption) {
        const key = `option_${activeOption.toLowerCase()}`;
        const cleaned = cleanOption(line);
        cur[key] = normalizeSpace(`${cur[key]} ${cleaned.text}`);
        if (cleaned.marked) cur.answer_hint_letter = activeOption;
      } else {
        cur.question = normalizeSpace(`${cur.question} ${line}`);
      }
    }

    // A question that continues to the next page remains open until a new
    // question marker appears. Its source_page stays at the first page.
  }

  finish(true);
  return out;
}

function extractAnswerKeyMap(input) {
  const pages = Array.isArray(input) ? input : [{ text: String(input || ''), pageNumber: 1 }];
  const map = new Map();
  let inKey = false;
  for (const page of pages) {
    for (const raw of tamilDigitsToArabic(page.text || '').replace(/\r/g, '').split('\n')) {
      const line = normalizeSpace(raw);
      if (/^(?:answer\s*key|answers?\s*key|correct\s*answers?|விடைக்குறிப்பு|விடைகள்?)\b/i.test(line)) { inKey = true; continue; }
      if (!inKey) continue;
      if (/^(?:explanation|solution|question\s*paper|part\s*[a-z])/i.test(line)) { inKey = false; continue; }
      const pairRe = /(?:^|[\s,;|])(?:Q(?:uestion)?\s*)?(\d{1,4})\s*[.)\-:]?\s*(?:\(|\[)?\s*([ABCD])\s*(?:\)|\])?/gi;
      let m;
      while ((m = pairRe.exec(line))) map.set(Number(m[1]), m[2].toUpperCase());
    }
  }
  return map;
}

function parseQuestions(input) {
  const pages = (Array.isArray(input) ? input : [{ text: input || '', pageNumber: 1 }])
    .filter(Boolean)
    .sort((a, b) => (Number(a.pageNumber) || 0) - (Number(b.pageNumber) || 0));

  const all = parsePages(pages);
  const answerKey = extractAnswerKeyMap(pages);
  for (const row of all) {
    if (!row.answer_hint_letter && answerKey.has(Number(row.question_number))) {
      row.answer_hint_letter = answerKey.get(Number(row.question_number));
      row.needs_llm_answer_resolution = false;
    }
  }

  // Keep printed numbers as evidence. The AI stage is responsible for the
  // final logical order and the pipeline renumbers only after that stage.
  const numbered = all.filter((r) => Number.isFinite(Number(r.question_number)) && Number(r.question_number) > 0);
  const uniqueCount = new Set(numbered.map((r) => Number(r.question_number))).size;
  const sane = all.length > 0 && uniqueCount >= Math.max(1, Math.floor(all.length * 0.7));
  const ordered = sane
    ? [...all].sort((a, b) => Number(a.question_number) - Number(b.question_number) || a._source_index - b._source_index)
    : [...all].sort((a, b) => (Number(a.source_page) || 0) - (Number(b.source_page) || 0) || a._source_index - b._source_index);

  return ordered.map((row) => ({ ...row, source_question_number: row.question_number }));
}

module.exports = { parseQuestions, tamilDigitsToArabic, normLetter, cleanOption, extractAnswerHint };
