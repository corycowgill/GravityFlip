// Gravity Flip Lab - entry point
import { Engine } from "./engine.js";
import { Game } from "./game.js";
import { UI } from "./ui.js";
import { AudioFx } from "./audio.js";
import { LEVELS } from "./levels.js";
import { Save } from "./save.js";

const canvas = document.getElementById("game");
const engine = new Engine(canvas);
const audio = new AudioFx();
const save = new Save("gflab.v1");
const game = new Game(engine, audio, save);
const ui = new UI({ engine, game, audio, save, levels: LEVELS });

ui.showMenu();

engine.start({
  update: (dt) => game.update(dt),
  render: (alpha) => {
    game.render(engine.ctx, alpha);
    if (engine.debug) game.renderDebug(engine.ctx, engine);
  },
});

// Pause when tab hidden / window loses focus
document.addEventListener("visibilitychange", () => {
  if (document.hidden) engine.pause();
  else engine.resume();
});
window.addEventListener("blur", () => engine.pause());
window.addEventListener("focus", () => engine.resume());

// Expose for debugging
window.__gf = { engine, game, ui, save };
