const fs = require('fs');
const path = require('path');
const config = require('../config');

class JobStore {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this._writeQueue = Promise.resolve();
    this._ensureFile();
    // Perf: read the file once at startup and keep it in memory as the
    // source of truth from then on. Previously every single get()/update()
    // call — including the per-page progress update fired once per page
    // during OCR — re-read and JSON.parse'd the ENTIRE jobs file from disk,
    // which grows with job history and made large multi-page documents
    // (100+ pages) increasingly slow purely from I/O, unrelated to the
    // Gemini API call itself. Writes still happen on every mutation (same
    // durability as before, atomic tmp+rename) — only the redundant reads
    // are removed.
    this._cache = this._readAllFromDisk();
  }
  _ensureFile() {
    const dir = path.dirname(this.dbFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.dbFile)) fs.writeFileSync(this.dbFile, '{}', 'utf8');
  }
  _readAllFromDisk() {
    try { return JSON.parse(fs.readFileSync(this.dbFile, 'utf8') || '{}'); }
    catch { return {}; }
  }
  _readAll() {
    return this._cache;
  }
  _enqueue(mutator) {
    this._writeQueue = this._writeQueue.then(async () => {
      const data = this._cache;
      const result = await mutator(data);
      const tmp = `${this.dbFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.dbFile);
      return result;
    });
    return this._writeQueue;
  }
  async create(job) { return this._enqueue((all) => { all[job.id] = job; return job; }); }
  async get(id) { return this._readAll()[id] || null; }
  async update(id, patch) {
    return this._enqueue((all) => {
      if (!all[id]) throw new Error(`Job ${id} not found`);
      all[id] = { ...all[id], ...patch, updatedAt: new Date().toISOString() };
      return all[id];
    });
  }
  async list() {
    return Object.values(this._readAll()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async delete(id) { return this._enqueue((all) => { delete all[id]; }); }
}
module.exports = new JobStore(config.jobDbFile);
