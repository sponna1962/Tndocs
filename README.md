# TNPSC PDF → CSV Converter

Converts scanned TNPSC question papers (PDF/images, Tamil + English) into a
structured, human-reviewed, Excel-ready CSV — using a real external OCR API.
There is no client-side/browser OCR and no simulated/invented results
anywhere in this codebase.

```
Upload → OCR (real API) → YOU review/fix the raw text → question/option
parsing → structuring → validation → YOU preview/edit rows → UTF-8 (BOM) CSV
```

The frontend is a **5-step wizard** (Upload → OCR Review → Structuring →
Preview & Edit → Download). The app supports bulk upload, per-page OCR review, robust question/option ordering, automatic answer hints from ticks/answer lines, bilingual Tamil/English structuring, and separate/combined CSV downloads., implemented as **one static HTML file** whose
JavaScript switches between full-screen steps. See "Why the old version said
Page Not Found" below for why that matters.

## Honest disclaimer

This codebase was written without live internet access to actually call
Google/Azure's OCR endpoints, install npm dependencies, or deploy to a real
host, so **it has not been run end-to-end against a real document or a real
OCR API**. What *has* been verified, offline, without any invented output:

- Every backend file passes `node -c` (syntax check).
- `backend/test_pipeline.js` is a real, runnable integration test that
  exercises the full two-stage pipeline (OCR stage → pause →
  `confirm-text` → structuring/validation stage → CSV export) against a
  **fake, deterministic OCR provider** standing in for Google/Azure, so it
  never makes a network call. It asserts that: the job actually pauses at
  `awaiting_text_review` and does not auto-continue; an edit made during
  the review step flows through into the final structured row; a second
  `confirm-text` call after completion fails loudly instead of silently
  reprocessing; the exported CSV has a UTF-8 BOM, keeps Tamil text intact,
  and has the exact required column order; and Tamil-numeral question
  numbering (`௧`, `௨`, …) parses correctly. Run it yourself with
  `cd backend && npm install && npm test`.

Before relying on this in production:

1. `npm install` in `backend/` and fix any dependency drift.
2. Create real OCR credentials (see below) and run one real PDF through it.
3. Skim each vendor's current API reference in case a field name changed.

Nothing in the pipeline fabricates OCR text, question data, or progress — if
the OCR call fails, the job is marked `failed` with the real error message;
if a provider doesn't return confidence, that field is `null` rather than a
made-up number; there is no fake progress percentage anywhere, only the
honest stage name.

## Why the old version said "Page Not Found" (and how this version avoids it)

The single most common cause of "Page Not Found" on a static host (Vercel,
Netlify, GitHub Pages, S3) is **client-side routing without server rewrite
rules**: the app changes the URL (e.g. `/upload` → `/review` via
`pushState`, or separate `.html` pages), the user refreshes or shares a
link, and the static host looks for a file at that path that doesn't
exist — because that "page" was never a real file, it was JavaScript
pretending the URL changed.

This version **cannot hit that bug, structurally**: there is exactly one
HTML file (`frontend/index.html`), the wizard's 5 steps are just
`<section>` elements that `app.js` shows and hides with `hidden`/`active`
classes, and **nothing in this app ever calls `pushState`, changes
`location.hash`, or renders a second HTML page.** The URL the browser shows
never changes, no matter which step you're on, so a refresh always reloads
the same one file the host already knows how to serve — there is nothing
left for the host to 404 on.

The other common cause — and the one worth double-checking if you still see
"Page Not Found" or a failed upload after deploying — is **the frontend
calling a relative `/api/...` URL while hosted separately from the
backend.** If you deploy `frontend/` as static files on one host and
`backend/` as a Node server on another, a relative fetch to `/api/upload`
hits *the static host's own domain*, which has no `/api` route and returns
its own generic 404/"Page Not Found" page — it never reaches your backend
at all. This version fixes that by moving the backend URL into
`frontend/config.js` (`window.API_BASE`), which every fetch in `app.js`
goes through. See **Deployment** below.

## Wizard flow (frontend)

| Step | What happens |
|---|---|
| 1. Upload | Choose file(s) (PDF/image, multi-file for batch) + Exam/Year/Subject. "Start Processing" calls `POST /api/upload` (or `/api/upload/batch`). |
| 2. OCR Review | Polls `GET /api/job/:id` showing only real stage labels (`Uploading` → `Processing OCR`) — never a fake percentage. The backend automatically **pauses** each job at `awaiting_text_review` and does **not** proceed on its own. Once paused, the wizard fetches `GET /api/job/:id/text` and shows the raw per-page OCR text (Tamil + English) in editable boxes. Clicking **Next** calls `POST /api/job/:id/confirm-text` with the (possibly corrected) text, which is the *only* thing that resumes the pipeline. |
| 3. Structuring & Validation | Polls until each job reaches `completed`, showing honest stages (`Extracting questions` → `Structuring CSV` → `Validating`) and a summary (detected / needs review / valid). |
| 4. Preview & Edit | Large, readable bilingual question cards. Tamil and English are separated into their own boxes; A-D options and the correct-answer selector are editable. Rows needing review are highlighted. "Save Edits & Re-validate" calls `PUT /api/result/:id`. |
| 5. Download | "Download CSV" streams the UTF-8 (BOM) CSV from `GET /api/export/:id`. For batch uploads, "Download Combined CSV" merges every completed job via `POST /api/export/combined`. |

A file that fails OCR is flagged and excluded from later steps rather than
blocking your other files.

## Architecture

```
backend/
  src/
    providers/
      OCRProvider.js                 # abstract base class every provider implements
      GoogleDocumentAIProvider.js    # calls Google Document AI's process endpoint
      AzureDocumentIntelligenceProvider.js  # calls Azure Doc Intelligence analyze/poll
      providerFactory.js             # picks a provider by OCR_PROVIDER env var
    services/
      jobStore.js                    # durable job records (JSON file; swap for Postgres later)
      storage.js                     # upload dir + retention cleanup
      questionParser.js              # OCR text -> question/option rows (English + Tamil)
      validator.js                   # missing fields, duplicates, low-confidence flags
      csvBuilder.js                  # RFC4180-correct, UTF-8 + BOM CSV output
    pipeline/
      processJob.js                  # STAGE 1: OCR -> pause at awaiting_text_review
                                      # STAGE 2 (confirm-text triggers this): parse -> structure -> validate
    routes/
      upload.js   # POST /api/upload, POST /api/upload/batch
      job.js      # GET /api/job/:id, GET /api/jobs, GET /api/job/:id/text, POST /api/job/:id/confirm-text
      result.js   # GET /api/result/:id, PUT /api/result/:id (save edited rows)
      export.js   # GET /api/export/:id, POST /api/export/combined
    server.js
  test_pipeline.js                   # offline integration test, see "Honest disclaimer" above
frontend/
  index.html   # the ONE html file - 5 <section> "steps", no other routes/pages
  config.js    # <- the ONE file to edit when hosting frontend/backend separately (sets window.API_BASE)
  app.js       # wizard state machine + all API calls (all go through api(path), which reads window.API_BASE)
  styles.css
```

Adding a new OCR vendor later means writing one new class that implements
`OCRProvider.extract()` and registering it in `providerFactory.js` — nothing
in routes, the pipeline, or the frontend needs to change.

## Setup (local, single origin — simplest way to try it)

```bash
cd backend
cp .env.example .env    # fill in real values, see below
npm install
npm test                 # optional: run the offline pipeline test
npm start                 # serves API + static frontend on http://localhost:8080
```

Open `http://localhost:8080` — the backend also serves `frontend/` as static
files (see the `express.static` line in `server.js`), so `frontend/config.js`
can be left as `window.API_BASE = ''` (same-origin) for local use.

### Choosing an OCR provider

Set `OCR_PROVIDER=google`, `OCR_PROVIDER=azure`, or `OCR_PROVIDER=ocrspace` in `.env`. The supplied Render blueprint uses Google Document AI by default.

**OCR.space** (`OCR_PROVIDER=ocrspace`) — the only option here that does **not**
require a credit card.
- Get a free API key at https://ocr.space/ocrapi/freekey (email only, no
  card). Free tier: 25,000 requests/month, 1MB file size limit, 3 PDF pages
  per request.
- Set `OCR_SPACE_API_KEY` to that key.
- Uses OCR.space's Engine 3 with language auto-detection, which the vendor
  documents as supporting 200+ languages. **Tamil accuracy has not been
  independently verified in this codebase** — there was no network access
  available while writing this to test a real Tamil document end-to-end.
  Run a real bilingual TNPSC paper through Step 2 (OCR Review) after
  deploying and visually check the Tamil text before trusting it in
  production. If accuracy is poor, fall back to Google or Azure below.
- The 1MB/3-page free-tier caps are much lower than this project's 1GB
  upload limit — large scans will need the $30/month PRO plan, or splitting
  large PDFs into smaller pieces before upload.

**Google Document AI** (`OCR_PROVIDER=google`)
- Create a "Document OCR" processor in Cloud Console → Document AI.
- Create a service account with the `Document AI API User` role, download
  its JSON key.
- Set `GOOGLE_PROJECT_ID`, `GOOGLE_LOCATION`, `GOOGLE_PROCESSOR_ID`, and
  either `GOOGLE_APPLICATION_CREDENTIALS` (path to the JSON key) or
  `GOOGLE_SERVICE_ACCOUNT_JSON` (the JSON contents, e.g. as a platform secret).
- Add `google-auth-library` to `backend/package.json` dependencies (left out
  of the base install to keep the reference implementation lean) — it's
  required by `GoogleDocumentAIProvider.getAccessToken()`.

**Azure AI Document Intelligence** (`OCR_PROVIDER=azure`)
- Create a Document Intelligence resource in the Azure portal.
- Set `AZURE_DOCINTEL_ENDPOINT` and `AZURE_DOCINTEL_KEY` from that resource.
- Confirm in current Azure docs which model (`AZURE_DOCINTEL_MODEL`) covers
  Tamil for your API version.

Credentials are read only from backend environment variables — never from
frontend code, and never sent to the browser (`routes/job.js` explicitly
strips the on-disk file path and internal OCR block data before returning
job JSON).

## Deployment (recommended: one host, same origin)

The simplest, most reliable way to deploy this project is as **one Node
service**, because `server.js` already serves both the API (`/api/...`) and
the static frontend (`frontend/index.html`) from the same Express app. This
avoids CORS entirely and means you never have to touch `frontend/config.js`
(`window.API_BASE` stays `''`).

- **Render**: this repo includes `render.yaml` at the project root. In
  Render, choose **New → Blueprint**, point it at this repo, and Render
  reads `render.yaml` automatically — it builds/starts `backend/` with
  `npm install` / `npm start`, serves the frontend from the same service,
  and attaches a persistent disk for `backend/src/data/` (uploads + the job
  store), which would otherwise be wiped on every redeploy. Fill in the
  OCR provider secrets (`GOOGLE_*` / `AZURE_*`) in the Render dashboard —
  they're intentionally left blank in `render.yaml`.
- **Railway / Heroku-style platforms**: this repo includes a `Procfile`
  (`web: cd backend && npm start`) at the project root for platforms that
  read a `Procfile` instead of `render.yaml`. Set the same environment
  variables from `backend/.env.example` in that host's dashboard.

## Deployment (frontend and backend on separate hosts)

This is the normal way to deploy this project: a static host for
`frontend/`, a Node process host for `backend/`.

**1. Deploy the backend** (Render, Railway, Fly.io, an EC2 box, etc.)
   - Point it at `backend/`, build command `npm install`, start command
     `npm start`.
   - Set every variable from `.env.example` in that host's environment
     variable settings (never commit a real `.env` file).
   - Set `ALLOWED_ORIGIN` to your frontend's exact URL once you know it,
     e.g. `https://tnpsc-csv.vercel.app` (no trailing slash). This is the
     CORS allowlist — the backend rejects browser requests from any other
     origin.
   - Note the backend's public URL, e.g. `https://tnpsc-backend.onrender.com`.

**2. Point the frontend at the backend**
   - Edit `frontend/config.js`:
     ```js
     window.API_BASE = 'https://tnpsc-backend.onrender.com';
     ```
   - This is a plain static file, not a build step — no bundler, no
     environment variable injection required. Edit it, save it, redeploy
     the static files.

**3. Deploy the frontend** (Vercel, Netlify, GitHub Pages, S3 + CloudFront,
   etc.)
   - Point it at `frontend/` as a static site. No build command needed —
     it's plain HTML/CSS/JS.
   - No rewrite rules / SPA fallback configuration needed. This is the fix
     for the original bug: because this app only ever serves one real
     file, there's no route pattern for the host to rewrite.

**4. Verify CORS and the API base are both correct**
   - Open the deployed frontend, open the browser console, upload a file.
   - A CORS error in the console means `ALLOWED_ORIGIN` on the backend
     doesn't match the frontend's exact origin.
   - A 404 on the upload request, or the request going to the *frontend's*
     own domain instead of the backend's, means `window.API_BASE` in
     `frontend/config.js` is still blank or wrong.

## API

| Method | Path                          | Purpose                                                  |
|--------|-------------------------------|-----------------------------------------------------------|
| POST   | `/api/upload`                 | Upload one file, starts a job                              |
| POST   | `/api/upload/batch`           | Upload multiple files, one job each                        |
| GET    | `/api/job/:id`                | Poll honest processing status                               |
| GET    | `/api/jobs`                   | List all jobs                                               |
| GET    | `/api/job/:id/text`           | Get the raw per-page OCR text for Step 2 review (NEW)       |
| POST   | `/api/job/:id/confirm-text`   | Submit reviewed/edited text, resume the pipeline (NEW)      |
| GET    | `/api/result/:id`             | Get structured rows for the editable preview                |
| PUT    | `/api/result/:id`             | Save user-edited rows, re-run validation, returns rows too  |
| GET    | `/api/export/:id`             | Download UTF-8 (BOM) CSV for one job                        |
| POST   | `/api/export/combined`        | Download a merged CSV across several jobs                   |

Status values returned by `/api/job/:id` are exactly:
`uploading, queued, processing_ocr, awaiting_text_review,
extracting_questions, structuring_csv, validating, completed, failed` — no
fake percentages. `awaiting_text_review` is a deliberate, human-gated pause:
the job sits there until `confirm-text` is called; nothing times it out or
auto-advances it.

## CSV format

```
question_ta,question_en,option_a_ta,option_a_en,option_b_ta,option_b_en,option_c_ta,option_c_en,option_d_ta,option_d_en,correct_answer
```

This is the exact column set/order the PONNA Admin Questions Upload system
expects — do not reorder, rename, or add columns. `correct_answer` is always
a bare `A`/`B`/`C`/`D`, never the answer text itself. UTF-8 with a BOM (so
Excel renders Tamil correctly), RFC 4180 escaping via `csv-stringify` for
commas/quotes/newlines. Any field that couldn't be confidently produced is
written as `REVIEW REQUIRED` rather than being left silently blank or
invented.

### Automatic answer detection & bilingual structuring (Stage 2)

Stage 2 (`extracting_questions` → `structuring_csv`) does two things per
question, in `services/questionParser.js` and `services/llmStructurer.js`:

1. **Answer detection.** `questionParser.js` deterministically looks for a
   trailing tick/check mark (`✓ ✔ ✅ ☑`), a `(correct)`/`*` annotation, or a
   standalone `Answer:`/`Ans:`/`Correct Answer:`/`Answer key:` line, and
   strips it out of the question/option text so it never leaks into the
   CSV. If it resolves to an unambiguous letter, that becomes a **locked**
   hint; nothing downstream is allowed to override it.
2. **Bilingual structuring.** Every question — including ones that mix
   Tamil and English mid-sentence — is sent to an LLM
   (`services/llmStructurer.js`) to produce complete, natural
   `question_ta`/`question_en` (and per-option `_ta`/`_en`) pairs with the
   same meaning in both languages, and to confirm the locked answer hint or,
   if none was found, determine it **only** when the source text makes it
   unambiguous. It is explicitly instructed never to guess from general
   knowledge — anything less than full confidence becomes `REVIEW REQUIRED`.

This step requires an LLM API key (see `config.js` / `services/llmStructurer.js`).
Without one, every row is marked `REVIEW REQUIRED` rather than silently
skipping translation. Two providers are supported, switched by
`LLM_PROVIDER`:

```
LLM_PROVIDER=gemini            # default - Google AI Studio has a free tier, no billing required
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash  # optional, this is the default

# or:
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6   # optional, this is the default
```

Only the variables for the selected `LLM_PROVIDER` need to be set. Setting
`LLM_PROVIDER=gemini` while leaving `GEMINI_API_KEY` empty (or vice versa)
produces a clear, self-explanatory `REVIEW REQUIRED` reason per row rather
than a silent failure — check the `PUT /api/result/:id` payload's `_issues`
field, or hover a highlighted row in the Preview & Edit screen, if every row
is failing for the same reason.

## Known gaps to close before real production use

- **Job queue**: `jobStore.js` is a single JSON file for simplicity. Fine for
  a handful of concurrent conversions; swap in Postgres/SQLite + BullMQ+Redis
  for real batch volume so jobs survive process restarts cleanly and can run
  on multiple workers. Note that the `awaiting_text_review` pause currently
  relies on the reviewed text being submitted to the *same* running backend
  process that produced it — fine for one server, but confirm this still
  holds once you run multiple backend instances behind a load balancer.
- **Google auth**: wire up `google-auth-library` as noted above — the file
  throws a clear error until you do, rather than silently no-opping.
- **Question parser**: `questionParser.js` uses tolerant regexes for common
  TNPSC layouts (numbered questions, `(A)/(B)/(C)/(D)` or Tamil அ/ஆ/இ/ஈ
  option markers). Papers with very unusual layouts may need parser tuning —
  that's exactly what the Step 2 text review and Step 4 editable preview are
  for.
- **Answer key extraction**: automatic detection (tick marks, `Answer: X`
  lines) only works when the answer is stated inline, per question, in the
  source document. Many TNPSC papers instead publish the answer key on a
  separate page/PDF; those rows will come back `REVIEW REQUIRED` by design
  (never guessed). Wiring in a second "answer key PDF" upload that gets
  matched by question number would be a natural follow-up.
- **LLM structuring cost/latency**: `llmStructurer.js` makes one Claude API
  call per question, sequentially. Fine for typical paper sizes; for very
  large batch uploads consider adding bounded concurrency and/or batching
  several questions per call.
- **File-size/page limits**: Document AI and Azure Document Intelligence
  both cap request size/page count for synchronous calls; very large scanned
  papers may need provider-specific batch/async endpoints (Document AI's
  `batchProcess` to GCS, Azure's async is already used here). Check current
  vendor limits for your paper sizes.
- **Large OCR text payloads**: `confirm-text` round-trips the full per-page
  OCR text back to the server as JSON; `server.js` raises the body-size
  limit to 15mb for this, which comfortably covers typical scanned papers,
  but re-check this limit if you expect unusually long documents.

## Current OCR pipeline behavior

The production pipeline now counts PDF pages before OCR, splits PDFs into individual pages, tracks `totalPages`, `processedPages`, `successfulPages`, `failedPages`, and `currentPage`, and never treats a partial OCR response as a complete document. OCR.space is retried once per page; suspicious or failed pages can use Gemini as a page-level fallback when `GEMINI_API_KEY` is configured. Question parsing keeps `source_page` and accepts page-aware OCR input. For very large papers, Gemini translation is only required for mixed-script content; single-language OCR is kept available for review instead of turning the whole job into empty rows when the free LLM quota is exhausted.

## Large PDF reliability settings (latest fix)
For large TNPSC PDFs, the backend now processes a small number of pages concurrently, uses a longer OCR timeout, avoids treating short-but-real OCR text as a failure, and does **not** call Gemini as a fallback for every failed OCR page by default. Recommended free-tier settings:

- `OCR_TIMEOUT_MS=120000`
- `OCR_MAX_ATTEMPTS=2`
- `OCR_CONCURRENCY=2`
- `OCR_GEMINI_FALLBACK=false`
- `LLM_CONCURRENCY=2`

The OCR Review UI is paginated in groups of 10 OCR pages. Pages that genuinely failed OCR are reported separately and are not inserted as empty review boxes or exported as empty CSV rows.

## OCR reliability settings (free OCR.space)
For large PDFs on the free OCR.space API, use conservative settings to avoid burst/rate-limit failures:

```env
OCR_MAX_ATTEMPTS=3
OCR_CONCURRENCY=1
OCR_MIN_INTERVAL_MS=2500
OCR_RETRY_BASE_MS=2000
```

The backend now logs every attempt and HTTP/API failure. If a page fails, processing continues and the exact failure reason is stored with that page.
