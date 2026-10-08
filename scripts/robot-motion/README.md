# Robot motion

Each robot SVG in `apps/desktop/web/public/robots` carries its own motion. The map inlines the SVG and, between
rests, sets `data-act="<action>"` on its root; the action is the CSS animation that attribute triggers, and the
attribute goes away when all of it has finished. Idle robots rest 2–5s between actions, working ones 1–3s, so most
of the time a robot is still. As an `<img>` (fleet list, pickers) the file stays a still picture.

## What the motion should feel like
- Short single events, never loops. Each action 0.4–2s, starting and ending on the still pose.
- Readable on the card: the robot shows ~55px tall there (~8 units per pixel), so an action that only moves fingers,
  pupils, a screw or a thin line does not exist on the card. Every action moves a big part, or pairs a small part
  with a big one: the head tilts while the eyes glance, the forearm swings while the claw opens.
- Calm, not wild: damped swings (10° → −6° → 3° → 0), ease-in-out. Too small read as "too minimal", far bigger as
  "too aggressive". `check.mjs` prints each action's card-size peak: aim for ≥ ~80 px, ~150–350 for the signature.
  Blinks and lamp glows are exempt.
- Varied: 3–5 distinct actions per robot and one signature the others don't share. `data-idle` gets calmer ones,
  `data-work` busier ones; repeat a name to make it likelier. A lamp or diode glow at most once, as a gentle tint.

## A palette to draw from
- Whole body: weight shift from foot to foot (rock on a foot's outer edge), upper body sways over the hips while the
  arms counter-swing, a knee dip (body sinks 4–6 units and rises), a small hop, leaning in to look.
- Arms: dangle from the shoulder, fold in toward the body and settle back, a shrug, one arm raised in a wave or
  salute, a hand to the head (scratch, visor), a stretch up or out, a reach and pinch, tapping or typing.
- Head: tilt or cock, nod, look left then right, a double take, looking down at its own chest gauge.
- Machine parts: a wheel rolls or spins, a fan or rotor spins up and coasts, a needle swings, an antenna wobbles,
  a dish or lamp sweeps, a screen's wave swells, a drawer or hatch opens, reels turn, a carriage returns.
- Working robots: typing, hammering, cranking, ratcheting, scanning, pumping — the machine's own job.
- Make it alive: overlap (forearm lags the upper arm, antenna lags the head, left and right 0.1–0.2s apart),
  follow-through (a damped settle after the stop), a small anticipation before a big move, and weight that suits the
  robot (heavy ones slower and smaller, light ones quicker).

## File format
- Root `<svg>`: keep width, height and viewBox; add `class="rNN"`, `data-idle="…"` and `data-work="…"`.
- One `<style>` as the root's first child. Every selector starts `.rNN[data-act=NAME]`, every keyframes name starts
  `rNN-`. Only `transform` and `fill` animate (no opacity, filter, clip-path, mask, will-change; no SMIL or script):
  WebKit lifts opacity and filter into layers, which blur the card. Finite animations only; a spin may end on a full
  turn, which is the still pose.
- Moving parts sit in `<g class="…">` with the pivot inline, `style="transform-origin:Xpx Ypx"` in viewBox units
  (the default transform-box is the view box); `transform-box:fill-box;transform-origin:center` suits eyes. A part
  may be several `<g>`s with the same class, which keeps the original paint order.
- The still picture never changes. Split a `<path>` only where a moving piece shares it with still ones, at a cut a
  joint ring covers; keep a hole in the same path as its outline. The map lets the robot draw a little past its
  viewBox, so a claw may swing slightly beyond the frame.

## Joints that hold
- Pivot at the joint's centre (shoulder ring, elbow disc, neck). A flat shoulder against the body opens a wedge when
  the arm turns: pivot at the elbow instead, or slide the arm toward the body by angle × half its width.
- An arm drawn over the body shows a wedge past ~4°: keep it small or turn it below the overlap.
- A head tilt pivots on the neck corner on the side it dips, so no gap opens; a whole-body rock pivots on a foot's
  outer edge, a wheel robot's on its hub, and the body sinks a little so hips never part from legs.

## Tools
- `node scripts/robot-motion/shapes.mjs FILE [I [groups…]]` lists shapes with subpath bboxes (to find joints) and
  splits a path into groups of subpaths.
- `node scripts/robot-motion/check.mjs NN …` checks a robot against `origin/main` in headless Chromium and WebKit:
  the still picture pixel-identical, the format, every action starting and ending on the still pose, both engines
  agreeing; prints card-size peaks and writes frame sheets (the still pose, then start → end). Read the sheets: parts
  turn at their joints, nothing detaches or opens a gap. Exits non-zero on a problem.
- `node scripts/robot-motion/preview.mjs [port]` serves a page of every robot with motion, large and on map cards,
  with buttons per action and a frequency slider. Robots 01–20 and 38 are licensed art that stays on this machine:
  never publish the page or the sheets.
