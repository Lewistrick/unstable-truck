// Framework-free checks for the off-screen edge-arrow geometry, run the same way
// as the other checks:
//   npm run build:client && node scripts/edge-arrow-check.mjs
//
// The in-game render pins an arrow to the viewport border in the direction of
// each off-screen objective, sized inversely by distance. The border-crossing
// math (intersectBorder) and the distance->size curve (edgeArrowScale) are the
// only non-canvas parts, so they're unit-tested here.
import { intersectBorder, edgeArrowScale } from "../dist/game/render.js";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;

// A 400x300 viewport, truck at its centre, margin 16 -> inset rect is
// [16..384] x [16..284].
const W = 400;
const H = 300;
const M = 16;
const cx = W / 2; // 200
const cy = H / 2; // 150

// --- Straight cardinal directions land on the expected border, centred -------
const north = intersectBorder(cx, cy, cx, -100, M, W, H);
check("north target -> top border", north && near(north.y, M) && near(north.x, cx));

const south = intersectBorder(cx, cy, cx, 999, M, W, H);
check("south target -> bottom border", south && near(south.y, H - M) && near(south.x, cx));

const east = intersectBorder(cx, cy, 999, cy, M, W, H);
check("east target -> right border", east && near(east.x, W - M) && near(east.y, cy));

const west = intersectBorder(cx, cy, -100, cy, M, W, H);
check("west target -> left border", west && near(west.x, M) && near(west.y, cy));

// --- ENE lands on the right border, above centre (near its top) --------------
// Ray from centre toward (500, 50): dx=300, dy=-100. It exits the right border
// (x=384) before the top, at y = 150 + (184/300)*(-100) ~= 88.7.
const ene = intersectBorder(cx, cy, 500, 50, M, W, H);
check("ENE target -> right border", ene && near(ene.x, W - M));
check("ENE target -> upper half of that border", ene && ene.y < cy && near(ene.y, 88.6667, 0.01));

// --- A target inside the inset rect never reaches a border (segment stays in) -
// The caller skips on-screen targets anyway, but this documents that the
// truck->target segment yields no crossing when the target is on screen.
const onscreen = intersectBorder(cx, cy, 250, 150, M, W, H);
check("on-screen target -> no border crossing (null)", onscreen === null);

// --- A degenerate ray (target on the origin) returns null, not a throw --------
check("zero-length ray -> null", intersectBorder(cx, cy, cx, cy, M, W, H) === null);

// --- Size scales inversely with distance -------------------------------------
const diag = Math.hypot(2000, 1300); // daily map diagonal
const sClose = edgeArrowScale(100, diag);
const sMid = edgeArrowScale(800, diag);
const sFar = edgeArrowScale(5000, diag);
check("closer target -> bigger arrow than mid", sClose > sMid);
check("mid target -> bigger arrow than far", sMid > sFar);
check("nearest arrow clamped to max scale (1.35)", near(edgeArrowScale(0, diag), 1.35));
check("very far arrow clamped to min scale (0.325)", near(sFar, 0.325));

if (failures > 0) {
  console.error(`\n${failures} edge-arrow check(s) failed`);
  process.exit(1);
}
console.log("\nall edge-arrow checks passed");
