/**
 * TNPSC PDF -> CSV wizard.
 *
 * This file NEVER changes window.location, pushState, or the URL hash.
 * "Steps" are just <section class="step-panel"> elements whose visibility
 * this script toggles. That's deliberate: it's what lets this whole app
 * ship as one static index.html with zero server rewrite rules (see
 * README.md for the deployment story this avoids).
 *
 * All network calls go through api(path), which prefixes window.API_BASE
 * (set in config.js). The browser never talks to the OCR provider directly
 * and never sees an OCR API key - those live only in the backend's
 * environment variables.
 */

const STAGE_LABELS = {
  uploading: 'Uploading',
  queued: 'Queued',
  processing_ocr: 'Processing OCR',
  awaiting_text_review: 'Ready for review',
  extracting_questions: 'Extracting questions',
  structuring_csv: 'Structuring CSV',
  validating: 'Validating',
  completed: 'Completed',
  failed: 'Failed',
};

const STAGE1_DONE = new Set(['awaiting_text_review', 'failed']);
const STAGE2_DONE = new Set(['completed', 'failed']);

const state = {
  step: 1,
  jobs: [], // job records, in upload order - see mergeJob() for shape
  pollTimers: {}, // jobId -> setInterval handle
  selectedFiles: [], // File objects chosen in Step 1
  activeReviewJobId: null,
  activePreviewJobId: null,
  reviewPage: 1,
};

const el = (id) => document.getElementById(id);

function api(path) {
  return (window.API_BASE || '') + path;
}

async function apiFetch(path, options) {
  let res;
  try {
    res = await fetch(api(path), options);
  } catch (e) {
    // fetch() itself threw: DNS/connection failure, CORS block, offline, etc.
    // - never a JSON-shaped error from our own backend.
    throw new Error(
      `Could not reach the server at "${api(path)}". If you haven't set ` +
      `window.API_BASE in config.js to your deployed backend's URL yet, ` +
      `that's almost always why — see README.md "Deployment".`
    );
  }
  let data = null;
  let bodyText = '';
  try {
    bodyText = await res.clone().text();
    data = JSON.parse(bodyText);
  } catch (e) {
    // Body wasn't JSON. If API_BASE is blank, this request went to whatever
    // static host is serving the frontend itself (not the Node backend) -
    // that host has no /api route, so it replies with its own HTML error
    // page (or rejects large uploads outright) instead of real backend JSON.
    data = null;
  }
  if (!res.ok) {
    if (data && data.error) throw new Error(data.error);
    if (!window.API_BASE) {
      throw new Error(
        `Request failed (${res.status}) and got a non-JSON response - this ` +
        `usually means window.API_BASE in config.js is still blank, so the ` +
        `request went to the static frontend host instead of your backend. ` +
        `Set window.API_BASE to your deployed backend's URL (see README.md).`
      );
    }
    throw new Error(`Request failed (${res.status}): ${bodyText.slice(0, 200) || 'no details returned.'}`);
  }
  return data;
}

function mergeJob(serverJob) {
  let job = state.jobs.find((j) => j.id === serverJob.id);
  if (!job) {
    job = { rows: null, summary: null };
    state.jobs.push(job);
  }
  Object.assign(job, serverJob);
  return job;
}

function activeJobs() {
  return state.jobs.filter((j) => j.status !== 'failed');
}
function failedJobs() {
  return state.jobs.filter((j) => j.status === 'failed');
}

/* ================================================================== *
 * Step navigation
 * ================================================================== */

function goToStep(n) {
  state.step = n;
  document.querySelectorAll('.step-panel').forEach((panel) => {
    panel.classList.toggle('active', Number(panel.dataset.step) === n);
  });
  el('wizard-nav').hidden = n === 1;
  renderStepper();
  renderCurrentStep();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function renderStepper() {
  document.querySelectorAll('.stepper .step').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-active', n === state.step);
    li.classList.toggle('is-done', n < state.step);
    li.classList.remove('is-failed');
  });
  if (failedJobs().length && activeJobs().length === 0) {
    const li = document.querySelector(`.stepper .step[data-step="${state.step}"]`);
    if (li) li.classList.add('is-failed');
  }
}

function renderCurrentStep() {
  if (state.step === 2) renderStep2();
  if (state.step === 3) renderStep3();
  if (state.step === 4) renderStep4();
  if (state.step === 5) renderStep5();
  updateFooter();
}

function updateFooter() {
  const nextBtn = el('next-btn');
  const backBtn = el('back-btn');
  const hint = el('footer-hint');
  backBtn.hidden = state.step <= 2;
  nextBtn.hidden = state.step >= 5;
  hint.textContent = '';

  if (state.step === 2) {
    const pending = activeJobs().filter((j) => !STAGE1_DONE.has(j.status));
    nextBtn.disabled = activeJobs().length === 0 || pending.length > 0;
    if (pending.length) hint.textContent = `Waiting on OCR for ${pending.length} file(s)…`;
  } else if (state.step === 3) {
    const pending = activeJobs().filter((j) => !STAGE2_DONE.has(j.status));
    nextBtn.disabled = activeJobs().length === 0 || pending.length > 0;
    if (pending.length) hint.textContent = `Still structuring ${pending.length} file(s)…`;
  } else if (state.step === 4) {
    const completed = state.jobs.filter((j) => j.status === 'completed');
    nextBtn.disabled = completed.length === 0 || completed.some((j) => !j.rows);
  }
}

el('back-btn').addEventListener('click', () => goToStep(Math.max(2, state.step - 1)));
el('next-btn').addEventListener('click', onNextClicked);

async function onNextClicked() {
  if (state.step === 2) {
    await confirmAllReviewedText();
    goToStep(3);
  } else if (state.step === 3) {
    goToStep(4);
  } else if (state.step === 4) {
    goToStep(5);
  }
}

/* ================================================================== *
 * Step 1 - Upload
 * ================================================================== */

const dropzone = el('dropzone');
const fileInput = el('file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragover', 'dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.toggle('is-dragover', evt === 'dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  addFiles(Array.from(e.dataTransfer.files || []));
});
fileInput.addEventListener('change', (e) => {
  addFiles(Array.from(e.target.files || []));
  fileInput.value = '';
});

function addFiles(files) {
  const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];
  // Mirrors backend/.env.example's MAX_UPLOAD_MB default (1024MB / 1GB).
  // This is only a client-side heads-up so the user finds out before
  // waiting on an upload — the backend's own limit (whatever MAX_UPLOAD_MB
  // is actually set to on your deployed server) is still the real
  // enforcement point.
  const MAX_UPLOAD_MB = window.MAX_UPLOAD_MB || 1024;
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
  const rejected = [];
  const tooLarge = [];
  for (const f of files) {
    if (!ALLOWED.includes(f.type)) {
      rejected.push(f.name);
      continue;
    }
    if (f.size > maxBytes) {
      tooLarge.push(`${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    state.selectedFiles.push(f);
  }
  const messages = [];
  if (rejected.length) messages.push(`Skipped unsupported file type: ${rejected.join(', ')}`);
  if (tooLarge.length) {
    messages.push(
      `Skipped file(s) larger than ${MAX_UPLOAD_MB}MB: ${tooLarge.join(', ')}. ` +
      `Compress the PDF or raise MAX_UPLOAD_MB on the backend.`
    );
  }
  el('upload-error').textContent = messages.join(' ');
  renderFileList();
  validateStep1();
}

function renderFileList() {
  const list = el('file-list');
  list.hidden = state.selectedFiles.length === 0;
  list.innerHTML = '';
  state.selectedFiles.forEach((f, idx) => {
    const li = document.createElement('li');
    const sizeKb = Math.max(1, Math.round(f.size / 1024));
    li.innerHTML = `<span class="file-name">${escapeHtml(f.name)} <span style="color:var(--ink-faint)">(${sizeKb} KB)</span></span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      state.selectedFiles.splice(idx, 1);
      renderFileList();
      validateStep1();
    });
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
}

function validateStep1() {
  const hasFiles = state.selectedFiles.length > 0;
  el('start-btn').disabled = !hasFiles;
  return hasFiles;
}

el('start-btn').addEventListener('click', startProcessing);

async function startProcessing() {
  const errorEl = el('upload-error');
  errorEl.textContent = '';
  if (!validateStep1()) {
    errorEl.textContent = 'Choose at least one PDF or supported image.';
    return;
  }

  const form = new FormData();
  const multi = state.selectedFiles.length > 1;
  for (const f of state.selectedFiles) form.append(multi ? 'files' : 'file', f);

  el('start-btn').disabled = true;
  el('start-btn').textContent = 'Starting…';

  try {
    const data = await apiFetch(multi ? '/api/upload/batch' : '/api/upload', {
      method: 'POST',
      body: form,
    });

    if (multi) {
      data.jobs.forEach((j) =>
        mergeJob({
          id: j.jobId,
          originalFilename: j.filename,
          status: 'queued',
          metadata: {},
        })
      );
    } else {
      mergeJob({
        id: data.jobId,
        originalFilename: state.selectedFiles[0].name,
        status: data.status || 'queued',
        metadata: {},
      });
    }

    state.jobs.forEach((job) => startPolling(job, STAGE1_DONE, () => {
      if (state.step === 2) renderStep2();
      updateFooter();
    }));

    goToStep(2);
  } catch (err) {
    errorEl.textContent = err.message;
    el('start-btn').disabled = false;
    el('start-btn').textContent = 'Start Processing';
  }
}

/* ================================================================== *
 * Polling
 * ================================================================== */

function startPolling(job, doneStatuses, onUpdate) {
  if (state.pollTimers[job.id]) return;
  const tick = async () => {
    try {
      const data = await apiFetch(`/api/job/${job.id}`);
      mergeJob(data);
      onUpdate();
      if (doneStatuses.has(data.status)) stopPolling(job.id);
    } catch (err) {
      console.error(err);
    }
  };
  tick();
  state.pollTimers[job.id] = setInterval(tick, 2000);
}

function stopPolling(jobId) {
  if (state.pollTimers[jobId]) {
    clearInterval(state.pollTimers[jobId]);
    delete state.pollTimers[jobId];
  }
}

/* ================================================================== *
 * Step 2 - OCR Review
 * ================================================================== */

async function renderStep2() {
  const tabsEl = el('review-tabs');
  const bodyEl = el('review-body');

  if (!state.activeReviewJobId && state.jobs.length) state.activeReviewJobId = state.jobs[0].id;
  tabsEl.hidden = state.jobs.length <= 1; tabsEl.innerHTML = '';
  state.jobs.forEach((job) => {
    const tab = document.createElement('button'); tab.type = 'button';
    tab.className = 'job-tab' + (job.id === state.activeReviewJobId ? ' is-active' : '');
    const dotClass = job.status === 'failed' ? 'failed' : STAGE1_DONE.has(job.status) ? 'ready' : 'busy';
    tab.innerHTML = `<span class="dot ${dotClass}"></span>${escapeHtml(job.originalFilename)}`;
    tab.addEventListener('click', () => { state.activeReviewJobId = job.id; state.reviewPage = 1; renderStep2(); }); tabsEl.appendChild(tab);
  });

  const job = state.jobs.find((j) => j.id === state.activeReviewJobId); bodyEl.innerHTML = ''; if (!job) return;
  if (job.status === 'failed') { bodyEl.innerHTML = `<div class="error-box">OCR failed for <b>${escapeHtml(job.originalFilename)}</b>: ${escapeHtml(job.error || 'Unknown error.')}</div>`; return; }
  if (!STAGE1_DONE.has(job.status)) { const line=document.createElement('div'); line.className='stage-line'; line.innerHTML=`<span class="spinner"></span> ${STAGE_LABELS[job.status] || job.status}… Page ${job.currentPage || 0} / ${job.totalPages || '?'}`; bodyEl.appendChild(line); return; }

  if (!job.ocrPages) { try { const data=await apiFetch(`/api/job/${job.id}/text`); job.ocrPages=data.pages || []; } catch(err) { bodyEl.innerHTML=`<div class="error-box">Could not load OCR text: ${escapeHtml(err.message)}</div>`; return; } }

  // Never render a huge 100+ page OCR editor in one DOM pass. Empty/failed
  // pages are not shown as giant blank boxes and therefore cannot be exported.
  const pages = job.ocrPages.filter((p) => String(p.text || '').trim());
  const total = job.totalPages || pages.length; const done = job.processedPages || job.pagesProcessed || pages.length;
  const failed = Array.isArray(job.failedPages) ? job.failedPages.length : 0;
  const meta=document.createElement('p'); meta.className='stage-line'; meta.style.marginBottom='18px';
  meta.textContent=`Pages: ${done} / ${total} · Successful: ${job.successfulPages ?? pages.length} · Failed: ${failed} · Showing OCR pages with text: ${pages.length}`; bodyEl.appendChild(meta);
  if (failed) { const warn=document.createElement('div'); warn.className='error-box'; warn.textContent=`${failed} page(s) failed OCR and are excluded from question extraction/export instead of appearing as empty pages. Re-upload or retry only those pages if needed.`; bodyEl.appendChild(warn); }
  if (!pages.length) { const reasons=(Array.isArray(job.failedPages)?job.failedPages.slice(0,3):[]).map(f=>`Page ${f.pageNumber}: ${f.error||'OCR failed'}`).join('<br>'); bodyEl.innerHTML += `<div class="error-box">No usable OCR text was produced for this file.${reasons?'<br><br><strong>Failure details:</strong><br>'+reasons:''}</div>`; return; }

  const perPage=10; const pageCount=Math.ceil(pages.length/perPage); state.reviewPage=Math.min(Math.max(state.reviewPage||1,1),pageCount);
  const controls=document.createElement('div'); controls.className='review-pager';
  const prev=document.createElement('button'); prev.type='button'; prev.className='secondary-btn'; prev.textContent='← Previous'; prev.disabled=state.reviewPage<=1;
  const label=document.createElement('span'); label.textContent=`OCR pages ${((state.reviewPage-1)*perPage)+1}–${Math.min(state.reviewPage*perPage,pages.length)} of ${pages.length}`;
  const next=document.createElement('button'); next.type='button'; next.className='secondary-btn'; next.textContent='Next pages →'; next.disabled=state.reviewPage>=pageCount;
  prev.onclick=()=>{state.reviewPage--; renderStep2();}; next.onclick=()=>{state.reviewPage++; renderStep2();}; controls.append(prev,label,next); bodyEl.appendChild(controls);

  pages.slice((state.reviewPage-1)*perPage,state.reviewPage*perPage).forEach((page) => {
    const realIdx=job.ocrPages.findIndex((p)=>p.pageNumber===page.pageNumber);
    const block=document.createElement('div'); block.className='page-block';
    const head=document.createElement('div'); head.className='page-block-head';
    const title=document.createElement('h3'); title.textContent=`PDF Page ${page.pageNumber}`; head.appendChild(title);
    const del=document.createElement('button'); del.type='button'; del.className='danger-btn page-delete-btn'; del.textContent='Delete page';
    del.addEventListener('click',()=>{
      if(!confirm(`Delete PDF page ${page.pageNumber}? Its OCR text will not be sent to structuring.`)) return;
      job.ocrPages.splice(realIdx,1);
      const remaining=Math.max(1,Math.ceil(job.ocrPages.filter(p=>String(p.text||'').trim()).length/perPage));
      state.reviewPage=Math.min(state.reviewPage,remaining);
      renderStep2();
    });
    head.appendChild(del); block.appendChild(head);
    const textarea=document.createElement('textarea'); textarea.value=page.text; textarea.spellcheck=false; textarea.addEventListener('input',()=>{ job.ocrPages[realIdx].text=textarea.value; }); block.appendChild(textarea); bodyEl.appendChild(block);
  });
  bodyEl.appendChild(controls.cloneNode(true));
  const cloned=bodyEl.lastChild; const buttons=cloned.querySelectorAll('button'); buttons[0].disabled=state.reviewPage<=1; buttons[1].disabled=state.reviewPage>=pageCount; buttons[0].onclick=()=>{state.reviewPage--;renderStep2();}; buttons[1].onclick=()=>{state.reviewPage++;renderStep2();};
}

async function confirmAllReviewedText() {
  const toConfirm = state.jobs.filter((j) => j.status === 'awaiting_text_review');
  await Promise.all(
    toConfirm.map(async (job) => {
      try {
        const data = await apiFetch(`/api/job/${job.id}/confirm-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages: job.ocrPages }),
        });
        mergeJob({ id: job.id, status: data.status });
        startPolling(job, STAGE2_DONE, () => {
          if (state.step === 3) renderStep3();
          updateFooter();
        });
      } catch (err) {
        mergeJob({ id: job.id, status: 'failed', error: err.message });
      }
    })
  );
}

/* ================================================================== *
 * Step 3 - Structuring & Validation
 * ================================================================== */

function renderStep3() {
  const body = el('structuring-body');
  body.innerHTML = '';

  const completed = state.jobs.filter((j) => j.status === 'completed');
  if (completed.length) {
    const totals = completed.reduce(
      (acc, j) => ({
        detected: acc.detected + (j.questionsDetected || 0),
        review: acc.review + (j.questionsReviewRequired || 0),
        valid: acc.valid + (j.questionsValid || 0),
      }),
      { detected: 0, review: 0, valid: 0 }
    );
    const grid = document.createElement('div');
    grid.className = 'summary-grid';
    grid.innerHTML = `
      <div class="summary-tile"><div class="num">${totals.detected}</div><div class="lbl">Questions detected</div></div>
      <div class="summary-tile review"><div class="num">${totals.review}</div><div class="lbl">Need review</div></div>
      <div class="summary-tile valid"><div class="num">${totals.valid}</div><div class="lbl">Valid</div></div>
    `;
    body.appendChild(grid);
  }

  const list = document.createElement('div');
  state.jobs.forEach((job) => {
    const row = document.createElement('div');
    row.className = 'job-status-row';
    const stageText =
      job.status === 'failed'
        ? `Failed: ${job.error || 'unknown error'}`
        : job.status === 'completed'
        ? `Detected ${job.questionsDetected} · Review ${job.questionsReviewRequired} · Valid ${job.questionsValid}`
        : `${STAGE_LABELS[job.status] || job.status}…`;
    row.innerHTML = `<span>${escapeHtml(job.originalFilename)}</span><span class="stage">${escapeHtml(stageText)}</span>`;
    list.appendChild(row);
  });
  body.appendChild(list);
}

/* ================================================================== *
 * Step 4 - Preview & Edit
 * ================================================================== */

/* Renumber after manual deletion. Original OCR numbering is retained internally
 * as source_question_number, while exported numbering is always 1..N. */
function renumberRows(rows){
  rows.forEach((r,i)=>{ if(r.source_question_number==null) r.source_question_number=r.question_number; r.question_number=i+1; });
}

async function renderStep4() {
  const completed = state.jobs.filter((j) => j.status === 'completed');
  for (const job of completed) {
    if (!job.rows) {
      try {
        const data = await apiFetch(`/api/result/${job.id}`);
        job.rows = Array.isArray(data.rows) ? data.rows : [];
        job.summary = data.summary || { total: job.rows.length, review_required: 0, valid: job.rows.length };
      } catch (err) {
        job.rows = [];
        job.summary = { total: 0, review_required: 0, valid: 0 };
        job.loadError = err.message;
      }
      updateFooter();
    }
  }
  if (!state.activePreviewJobId && completed.length) state.activePreviewJobId = completed[0].id;

  const tabsEl = el('preview-tabs');
  tabsEl.hidden = completed.length <= 1;
  tabsEl.innerHTML = '';
  completed.forEach((job) => {
    const tab = document.createElement('button');
    tab.type = 'button'; tab.className = 'job-tab' + (job.id === state.activePreviewJobId ? ' is-active' : '');
    tab.textContent = job.originalFilename;
    tab.addEventListener('click', () => { state.activePreviewJobId = job.id; renderStep4(); });
    tabsEl.appendChild(tab);
  });

  const job = completed.find((j) => j.id === state.activePreviewJobId);
  const summaryEl = el('preview-summary');
  const tableWrap = document.querySelector('#preview-table')?.closest('.table-wrap');
  const tbody = el('preview-body');
  if (tableWrap) tableWrap.hidden = true;
  tbody.innerHTML = '';
  summaryEl.innerHTML = '';
  if (!job) { summaryEl.textContent = 'No completed files to preview yet.'; return; }

  summaryEl.innerHTML = `<span>Total: <b>${job.summary.total}</b></span><span>Needs review: <b>${job.summary.review_required}</b></span><span>Valid: <b>${job.summary.valid}</b></span>`;
  const rows = [...job.rows].sort((a, b) => (Number(a.question_number) || 999999) - (Number(b.question_number) || 999999));
  const container = document.createElement('div');
  container.className = 'question-cards';

  rows.forEach((row, idx) => {
    const card = document.createElement('article');
    card.className = `question-card${row._review ? ' needs-review' : ''}`;
    const issues = Array.isArray(row._issues) ? row._issues : [];
    const head=document.createElement('div'); head.className='question-card-head';
    head.innerHTML=`<span class="question-number">Question ${escapeHtml(row.question_number)}</span><span class="question-page">Page ${escapeHtml(row.source_page || '')}</span>`;
    const badge=document.createElement('span'); badge.className=row._review?'review-badge':'valid-badge'; badge.textContent=row._review?'Needs review':'Ready'; head.appendChild(badge);
    const delQ=document.createElement('button'); delQ.type='button'; delQ.className='danger-btn question-delete-btn'; delQ.textContent='Delete question';
    delQ.addEventListener('click',()=>{
      if(!confirm(`Delete Question ${row.question_number}? The following questions will be renumbered automatically.`)) return;
      const pos=job.rows.indexOf(row); if(pos>=0) job.rows.splice(pos,1);
      renumberRows(job.rows);
      renderStep4();
    });
    head.appendChild(delQ); card.appendChild(head);

    const editor = document.createElement('div');
    editor.className = 'bilingual-editor';

    const questionPair = document.createElement('div');
    questionPair.className = 'question-language-pair';
    questionPair.append(
      makeEditor('Question — English', 'question_en', true),
      makeEditor('Question — தமிழ்', 'question_ta', true)
    );
    editor.appendChild(questionPair);

    [['A','option_a_en','option_a_ta'],['B','option_b_en','option_b_ta'],['C','option_c_en','option_c_ta'],['D','option_d_en','option_d_ta']].forEach(([letter,enField,taField]) => {
      const pair = document.createElement('div');
      pair.className = 'option-language-pair';
      pair.append(
        makeEditor(`Option ${letter} — English`, enField, false),
        makeEditor(`Option ${letter} — தமிழ்`, taField, false)
      );
      editor.appendChild(pair);
    });

    card.appendChild(editor);

    const answerRow = document.createElement('div'); answerRow.className = 'answer-row';
    const answerLabel = document.createElement('label'); answerLabel.textContent = 'Correct answer';
    const select = document.createElement('select');
    [['','Select answer'],['A','A'],['B','B'],['C','C'],['D','D']].forEach(([v,t]) => { const o=document.createElement('option'); o.value=v; o.textContent=t; select.appendChild(o); });
    select.value = row.correct_answer || '';
    select.addEventListener('change', () => { row.correct_answer = select.value; });
    answerRow.append(answerLabel, select);
    if (issues.length) { const issue = document.createElement('div'); issue.className='issue-list'; issue.textContent = issues.join(' • '); answerRow.appendChild(issue); }
    card.appendChild(answerRow);
    container.appendChild(card);

    function makeEditor(labelText, field, large) {
      const wrap=document.createElement('div'); wrap.className='editor-field' + (large ? ' editor-question' : '');
      const label=document.createElement('label'); label.textContent=labelText;
      const input=document.createElement('textarea'); input.rows=large?4:2; input.value=row[field]||''; input.spellcheck=false;
      input.addEventListener('input',()=>{row[field]=input.value;});
      wrap.append(label,input); return wrap;
    }
  });
  el('preview-body').closest('.table-wrap')?.after(container);
  // Remove an older card container before rebuilding, while preserving the table
  // element in the DOM for compatibility with older CSS/markup.
  document.querySelectorAll('.question-cards').forEach((n) => { if (n !== container) n.remove(); });

  const oldCards = container;
  // Put the cards directly after the summary for a natural top-to-bottom review.
  summaryEl.after(oldCards);
}

el('save-edits-btn').addEventListener('click', async () => {
  const job = state.jobs.find((j) => j.id === state.activePreviewJobId);
  if (!job) return;
  const statusEl = el('save-status');
  statusEl.textContent = 'Saving…';
  try {
    const data = await apiFetch(`/api/result/${job.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: job.rows }),
    });
    job.summary = data.summary;
    if (data.rows) job.rows = data.rows;
    statusEl.textContent = 'Saved — validation updated.';
    renderStep4();
  } catch (err) {
    statusEl.textContent = `Save failed: ${err.message}`;
  }
});

/* ================================================================== *
 * Step 5 - Download
 * ================================================================== */

function renderStep5() {
  const body = el('download-body');
  body.innerHTML = '';

  state.jobs.forEach((job) => {
    const card = document.createElement('div');
    card.className = 'download-card' + (job.status === 'failed' ? ' failed' : '');
    if (job.status === 'failed') {
      card.innerHTML = `<div class="meta"><b>${escapeHtml(job.originalFilename)}</b><br>Failed: ${escapeHtml(job.error || 'unknown error')}</div>`;
    } else {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<b>${escapeHtml(job.originalFilename)}</b><div class="counts">Detected ${job.questionsDetected} · Review ${job.questionsReviewRequired} · Valid ${job.questionsValid}</div>`;
      const links = document.createElement('div'); links.style.display='flex'; links.style.gap='8px'; links.style.flexWrap='wrap';
      [['ta','Download Tamil CSV'],['en','Download English CSV'],['all','Download All CSV']].forEach(([lang,label])=>{ const link=document.createElement('a'); link.className=lang==='all'?'primary-btn':'secondary-btn'; link.textContent=label; link.href=api(`/api/export/${job.id}?lang=${lang}`); link.style.textDecoration='none'; links.appendChild(link); });
      card.appendChild(meta); card.appendChild(links);
    }
    body.appendChild(card);
  });

  const completed = state.jobs.filter((j) => j.status === 'completed');
  el('combine-btn').hidden = completed.length <= 1;
}

el('combine-btn').addEventListener('click', async () => {
  const jobIds = state.jobs.filter((j) => j.status === 'completed').map((j) => j.id);
  try {
    const res = await fetch(api('/api/export/combined'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Combined download failed.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tnpsc_combined.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message);
  }
});

el('restart-btn').addEventListener('click', () => {
  Object.keys(state.pollTimers).forEach(stopPolling);
  state.jobs = [];
  state.selectedFiles = [];
  state.activeReviewJobId = null;
  state.activePreviewJobId = null;
  el('file-list').innerHTML = '';
  el('file-list').hidden = true;
  el('upload-error').textContent = '';
  el('start-btn').disabled = true;
  el('start-btn').textContent = 'Start Processing';
  goToStep(1);
});

/* ================================================================== *
 * Utilities
 * ================================================================== */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ================================================================== *
 * Init
 * ================================================================== */

goToStep(1);
