// Persistent save (localStorage)
export class Save {
  constructor(key) {
    this.key = key;
    this.data = this._load();
  }
  _load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return { cleared: {}, best: {} };
      const obj = JSON.parse(raw);
      return { cleared: obj.cleared || {}, best: obj.best || {} };
    } catch {
      return { cleared: {}, best: {} };
    }
  }
  _save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch {}
  }
  isCleared(id) { return !!this.data.cleared[id]; }
  setCleared(id) { this.data.cleared[id] = true; this._save(); }
  getBest(id) { return this.data.best[id] || null; }
  setBest(id, time) {
    const cur = this.data.best[id];
    if (cur == null || time < cur) {
      this.data.best[id] = time;
      this._save();
    }
  }
  clearedCount() { return Object.keys(this.data.cleared).length; }
}
