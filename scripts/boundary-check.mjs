// Framework-free checks for the biome map-boundary config and the out-of-bounds
// fill colour, run the same way as the other checks:
//   npm run build:client && node scripts/boundary-check.mjs
//
// The boundary decoration itself is canvas-only, but two pure parts drive it:
// every theme must map to a boundary style, and beyondFill() must return the
// right out-of-bounds material per biome (sea/space/chasm vs. ordinary grass).
import { BOUNDARY_STYLES, beyondFill } from "../dist/game/boundary.js";
import { THEMES } from "../dist/level/themes.js";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

const KINDS = new Set(["hedge", "fence", "shore", "cliff", "crater", "barrier", "snowbank", "candy", "festive"]);

// --- Every theme has a valid boundary style ---------------------------------
for (const id of Object.keys(THEMES)) {
  const style = BOUNDARY_STYLES[id];
  check(`theme ${id} has a boundary style`, !!style && KINDS.has(style.kind));
}
check(
  "no boundary styles for unknown themes",
  Object.keys(BOUNDARY_STYLES).every((id) => id in THEMES),
);

// Shore styles must carry a water + foam colour (drawShoreEdge dereferences both).
for (const [id, style] of Object.entries(BOUNDARY_STYLES)) {
  if (style.kind === "shore") {
    check(`shore theme ${id} has water + foam colours`, !!style.water && !!style.foam);
  }
}

// --- beyondFill picks the right out-of-bounds material ----------------------
const lvl = (theme, grass, rock) => ({ theme, palette: { grass, rock } });
const lightnessOf = (c) => Number(c.match(/(\d+)%\)/)[1]);

const grass = "hsl(115 36% 77%)";
check("hedge biome -> grass beyond", beyondFill(lvl("grassland", grass, "hsl(115 14% 28%)")) === grass);
check("fence biome -> grass beyond", beyondFill(lvl("farmland", grass, "hsl(85 14% 28%)")) === grass);
check("beach -> its sea colour beyond", beyondFill(lvl("beach", grass, "hsl(40 30% 55%)")) === BOUNDARY_STYLES.beach.water);
check("swamp -> its bog colour beyond", beyondFill(lvl("swamp", grass, "hsl(80 30% 40%)")) === BOUNDARY_STYLES.swamp.water);

const space = beyondFill(lvl("moon", grass, "hsl(230 4% 60%)"));
check("moon -> dark space beyond", lightnessOf(space) < 20 && space !== grass);

// Cliff chasm is derived from the rock colour and much darker than it.
const rock = "hsl(20 40% 44%)";
const chasm = beyondFill(lvl("desert", grass, rock));
check("desert cliff -> chasm darker than its rock", lightnessOf(chasm) < 44 && chasm !== grass);
check("volcanic is a lava cliff", BOUNDARY_STYLES.volcanic.kind === "cliff" && BOUNDARY_STYLES.volcanic.lava === true);

if (failures > 0) {
  console.error(`\n${failures} boundary check(s) failed`);
  process.exit(1);
}
console.log("\nall boundary checks passed");
