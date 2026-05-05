// UI: shows/hides DOM overlays and wires buttons to game actions.
export class UI {
  constructor({ engine, game, audio, save, levels }) {
    this.engine = engine;
    this.game = game;
    this.audio = audio;
    this.save = save;
    this.levels = levels;

    this.el = {
      menu:    document.getElementById("overlay-menu"),
      levels:  document.getElementById("overlay-levels"),
      how:     document.getElementById("overlay-how"),
      win:     document.getElementById("overlay-win"),
      hud:     document.getElementById("hud"),
      touch:   document.getElementById("touch"),
      grid:    document.getElementById("level-grid"),
      name:    document.getElementById("level-name"),
      stats:   document.getElementById("win-stats"),
    };
    this._wire();

    // Hook game callbacks
    this.game.onWin = (info) => this.showWin(info);

    // Restart and back buttons via input events
    this.engine.input.on("escape", () => {
      if (this.currentOverlay === this.el.menu) return;
      this.showMenu();
    });
  }

  _wire() {
    const tap = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => { this.audio.resume(); this.audio.click(); fn(); });
    };
    tap("btn-play", () => {
      // Play first uncleared level, else first level
      const next = this._firstUncleared() || this.levels[0];
      this.startLevel(next);
    });
    tap("btn-levels", () => this.showLevels());
    tap("btn-how", () => this.showHow());
    tap("btn-levels-back", () => this.showMenu());
    tap("btn-how-back", () => this.showMenu());
    tap("btn-menu", () => this.showMenu());
    tap("btn-restart", () => this.game.restart());
    tap("btn-next", () => {
      const idx = this.levels.findIndex(l => l.id === this.game.def.id);
      const next = this.levels[idx + 1];
      if (next) this.startLevel(next);
      else this.showLevels();
    });
    tap("btn-replay", () => {
      this._hideAll();
      this.el.hud.classList.remove("hidden");
      this.el.touch.classList.remove("hidden");
      this.engine.input.setEnabled(true);
      this.game.restart();
    });
    tap("btn-win-menu", () => this.showLevels());
  }

  _firstUncleared() {
    for (const l of this.levels) {
      if (!this.save.isCleared(l.id)) return l;
    }
    return null;
  }

  _hideAll() {
    this.el.menu.classList.add("hidden");
    this.el.levels.classList.add("hidden");
    this.el.how.classList.add("hidden");
    this.el.win.classList.add("hidden");
    this.el.hud.classList.add("hidden");
    this.el.touch.classList.add("hidden");
    this.currentOverlay = null;
  }

  showMenu() {
    this._hideAll();
    this.el.menu.classList.remove("hidden");
    this.engine.input.setEnabled(false);
    this.game.state = "menu";
    this.currentOverlay = this.el.menu;
  }

  showHow() {
    this._hideAll();
    this.el.how.classList.remove("hidden");
    this.currentOverlay = this.el.how;
  }

  showLevels() {
    this._hideAll();
    this.el.levels.classList.remove("hidden");
    this._populateLevels();
    this.currentOverlay = this.el.levels;
  }

  _populateLevels() {
    const grid = this.el.grid;
    grid.innerHTML = "";
    let curWorld = -1;
    let prevCleared = true; // first level always unlocked
    for (let i = 0; i < this.levels.length; i++) {
      const lvl = this.levels[i];
      if (lvl.world !== curWorld) {
        curWorld = lvl.world;
        const h = document.createElement("div");
        h.className = "world-header";
        h.textContent = `World ${lvl.world} — ${lvl.worldName || ""}`;
        grid.appendChild(h);
      }
      const cleared = this.save.isCleared(lvl.id);
      const unlocked = i === 0 || prevCleared || cleared;
      const cell = document.createElement("div");
      cell.className = "level-cell " + (cleared ? "cleared" : (unlocked ? "unlocked" : "locked"));
      cell.textContent = lvl.shortName || (i + 1);
      if (unlocked) {
        cell.addEventListener("click", () => {
          this.audio.resume(); this.audio.click();
          this.startLevel(lvl);
        });
      }
      grid.appendChild(cell);
      prevCleared = cleared;
    }
  }

  startLevel(def) {
    this._hideAll();
    this.el.hud.classList.remove("hidden");
    this.el.touch.classList.remove("hidden");
    this.el.name.textContent = def.name;
    this.engine.input.setEnabled(true);
    this.game.load(def);
  }

  showWin(info) {
    setTimeout(() => {
      this._hideAll();
      this.el.hud.classList.add("hidden");
      this.el.touch.classList.add("hidden");
      this.el.win.classList.remove("hidden");
      this.engine.input.setEnabled(false);
      const best = this.save.getBest(info.id);
      this.el.stats.textContent =
        `Time ${info.time.toFixed(2)}s · Best ${best ? best.toFixed(2) : "—"}s`;
      this.currentOverlay = this.el.win;
    }, 600);
  }
}
