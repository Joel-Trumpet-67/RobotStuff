// Tunables for the REBUILT sim. Sources: 2026 Game Manual (§5, §6, R104, R405) and the field CAD.

export const CONFIG = {
  physicsHz: 120,
  teamNumber: '3603',

  field: { halfX: 8.27, halfZ: 4.035, guardrailH: 0.508, allianceWallH: 1.98 }, // 651.2 x 317.7 in

  robot: {
    // Generic swerve: 27x27 in frame (108 in perimeter <= 110 per R104), 3.25 in bumpers
    frame: 0.6858,
    bumperThick: 0.0826,
    bumperBottom: 0.051, // BUMPER ZONE is 2.5–5.75 in off the carpet (R405)
    bumperHeight: 0.127,
    moduleInset: 0.0635, // module centre from frame edge
    wheelRadius: 0.0508, // 4 in wheels
    mass: 58, // ~115 lb robot + bumpers
    maxSpeed: 4.5, // m/s — typical L2-ish swerve
    maxTurn: 2 * Math.PI, // rad/s
    accel: 9, // m/s^2, arcade feel
    turnAccel: 30,
  },

  // Open-top FUEL box on the chassis. Top kept under the 22.25 in TRENCH clearance.
  hopper: { size: 0.68, floorY: 0.235, top: 0.55, wall: 0.02 },
  // Net on top of the box: short and only flared out a little. 0.55 + 0.10 = 0.65 m (< 30 in, R107).
  net: { height: 0.10, flare: 0.03 },

  // Over-the-bumper slide intake, from the team's CAD notes (positions from robot centre,
  // toward the intake end; slide in motor rotations: 0 = in, 60 = extended, 65.75 = max).
  intake: {
    extended: 60,
    rollerOutAt60: 0.589, // roller axle, m from robot centre
    rollerUpAt60: 0.175,
    outPerRot: 0.004633, // 278 mm over 60 rot
    risePerRot: -0.0004, // rack is tilted 5° nose-down: rises 24 mm coming in
    rollerRadius: 0.028, // FUEL (150 mm) under the roller is pressed ~3 mm
    width: 0.597, // 23.5 in bars between the scoop plates
    speed: 220, // rot/s (full stroke ~0.27 s) — a guess
    transferTime: 0.25, // s for a FUEL to travel up over the bumper into the box
    minGap: 0.05, // s between grabs (~20 FUEL/s max)
  },

  fuel: { radius: 0.075, mass: 0.215, restitution: 0.25, friction: 0.8, color: 0xf4980e }, // 5.91 in, 0.45-0.5 lb

  hub: {
    // Blue HUB from CAD; red is mirrored in X
    box: { x: [3.048, 4.242], z: [-0.597, 0.597], top: 1.273 },
    funnelTop: 1.829, // 72 in front edge
    opening: 0.53, // half-width of the scoring opening (41.7 in hex ~ 1.06 m)
    exitY: 0.85,
    exitZ: [-0.42, -0.14, 0.14, 0.42],
    exitSpeed: [1.5, 3.0],
    processDelay: 0.6, // s from entering the top to leaving an exit
  },

  match: {
    countdown: 3, auto: 20, delay: 3, teleop: 140,
    transition: 10, shift: 25, endgame: 30, grace: 3, // §6.4, §6.5
  },

  points: { fuel: 1, rp: { energized: 100, supercharged: 360, traversal: 50 } },
};
