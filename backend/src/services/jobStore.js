const fs = require('fs');
const path = require('path');
const config = require('../config');

class JobStore {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this._writeQueue = Promise.resolve();
    this._ensureFile();
  }
  _ensureFile() {
    const dir = path.dirname(this.dbFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.dbFile)) fs.writeFileSync(this.dbFile, '{}', 'utf8');
  }
  _readAll() {
    try { return JSON.parse(fs.readFileSync(this.dbFile, 'utf8') || '{}'); }
    catch { return {}; }
  }
  _enqueue(mutator) {
    this._writeQueue = this._writeQueue.then(async () => {
      const data = this._readAll();
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
