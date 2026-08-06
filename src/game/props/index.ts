import { type Rng } from "../../util/rng.js";
import { drawAcacia } from "./acacia.js";
import { drawAstronaut } from "./astronaut.js";
import { drawBalloon } from "./balloon.js";
import { drawBaretree } from "./baretree.js";
import { drawBeachball } from "./beachball.js";
import { drawBench } from "./bench.js";
import { drawBuilding } from "./building.js";
import { drawBunny } from "./bunny.js";
import { drawCactus } from "./cactus.js";
import { drawCandycane } from "./candycane.js";
import { drawCar } from "./car.js";
import { drawCharredtree } from "./charredtree.js";
import { drawCow } from "./cow.js";
import { drawCrater } from "./crater.js";
import { drawCyclist } from "./cyclist.js";
import { drawDeadbush } from "./deadbush.js";
import { drawDeer } from "./deer.js";
import { drawEgg } from "./egg.js";
import { drawFirework } from "./firework.js";
import { drawFlag } from "./flag.js";
import { drawFog } from "./fog.js";
import { drawFrog } from "./frog.js";
import { drawFrozenlake } from "./frozenlake.js";
import { drawGrasstuft } from "./grasstuft.js";
import { drawGumdrop } from "./gumdrop.js";
import { drawHaybale } from "./haybale.js";
import { drawHouse } from "./house.js";
import { drawLavacrack } from "./lavacrack.js";
import { drawLeaves } from "./leaves.js";
import { drawLilypad } from "./lilypad.js";
import { drawLog } from "./log.js";
import { drawLollipop } from "./lollipop.js";
import { drawMushroom } from "./mushroom.js";
import { drawObsidian } from "./obsidian.js";
import { drawPalm } from "./palm.js";
import { drawPenguin } from "./penguin.js";
import { drawPine } from "./pine.js";
import { drawPumpkin } from "./pumpkin.js";
import { drawReeds } from "./reeds.js";
import { drawScarecrow } from "./scarecrow.js";
import type { PropDrawer } from "./shared.js";
import { drawShrub } from "./shrub.js";
import { drawSnowpine } from "./snowpine.js";
import { drawTermitemound } from "./termitemound.js";
import { drawTractor } from "./tractor.js";
import { drawTrafficlight } from "./trafficlight.js";
import { drawTree } from "./tree.js";
import { drawUmbrella } from "./umbrella.js";
import { drawWindmill } from "./windmill.js";

// Registry mapping a prop `kind` to its drawer. Each sprite lives in its own
// file; theme prop lists (level/themes.ts) reference these kinds by name.
const DRAWERS: Record<string, PropDrawer> = {
  acacia: drawAcacia,
  astronaut: drawAstronaut,
  balloon: drawBalloon,
  baretree: drawBaretree,
  beachball: drawBeachball,
  bench: drawBench,
  building: drawBuilding,
  bunny: drawBunny,
  cactus: drawCactus,
  candycane: drawCandycane,
  car: drawCar,
  charredtree: drawCharredtree,
  cow: drawCow,
  crater: drawCrater,
  cyclist: drawCyclist,
  deadbush: drawDeadbush,
  deer: drawDeer,
  egg: drawEgg,
  firework: drawFirework,
  flag: drawFlag,
  fog: drawFog,
  frog: drawFrog,
  frozenlake: drawFrozenlake,
  grasstuft: drawGrasstuft,
  gumdrop: drawGumdrop,
  haybale: drawHaybale,
  house: drawHouse,
  lavacrack: drawLavacrack,
  leaves: drawLeaves,
  lilypad: drawLilypad,
  log: drawLog,
  lollipop: drawLollipop,
  mushroom: drawMushroom,
  obsidian: drawObsidian,
  palm: (ctx, _variant, rng) => drawPalm(ctx, rng),
  penguin: drawPenguin,
  pine: drawPine,
  pumpkin: drawPumpkin,
  reeds: drawReeds,
  scarecrow: drawScarecrow,
  shrub: drawShrub,
  snowpine: drawSnowpine,
  termitemound: drawTermitemound,
  tractor: drawTractor,
  trafficlight: drawTrafficlight,
  tree: drawTree,
  umbrella: drawUmbrella,
  windmill: drawWindmill,
};

/** Draws one prop in local space (already translated/scaled by the caller).
 * `rng` is a deterministic per-instance stream for props with internal
 * randomness; simpler props ignore it and key off `variant`. Unknown kinds are
 * silently skipped. */
export function drawProp(ctx: CanvasRenderingContext2D, kind: string, variant: number, rng: Rng): void {
  DRAWERS[kind]?.(ctx, variant, rng);
}
