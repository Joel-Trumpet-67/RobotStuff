// Every tunable number lives here. Sources noted where they come from the
// manual (TU10), the Event Field Setup Guide, or the CAD.

export const CONFIG = {
  physicsHz: 120,

  robot: {
    // goBILDA 5203 19.2:1 Yellow Jacket = 312 RPM, 104 mm mecanum (from CAD)
    motorRpm: 312,
    wheelDiameter: 0.104,
    mass: 15, // kg, guess for the kit robot; not in the CAD
    accel: 8, // m/s^2 — arcade feel
    turnAccel: 40, // rad/s^2
    hopperSize: 4, // G407: control at most 4 SCORING ELEMENTS
  },

  // Launch presets. NOTE: a 96 mm flywheel at 312 RPM only has ~1.6 m/s surface
  // speed, which can't reach the HIVE. These are what the shot needs in the sim.
  shooter: {
    hive: { speed: 6.2, angleDeg: 62 },
    flower: { speed: 2.6, angleDeg: 55 },
    fireInterval: 0.25, // s between shots
    exitLocal: [0, 0.36, -0.12], // above the robot, slightly forward
  },

  // Roller intake capture box, robot-local (robot faces -Z)
  intake: { x: [-0.19, 0.19], y: [0, 0.14], z: [-0.31, -0.18] },
  ejectSpeed: 1.2,

  // Field Setup Guide §12.3: 7 POLLEN no tip, 8 tip; 3 NECTAR+2 POLLEN no tip, +3 tip.
  // Weights in POLLEN units; 7 < 7.5 <= 8 and 3*1.67+2 < 7.5 <= 3*1.67+3.
  hive: { pollenWeight: 1, nectarWeight: 1.67, tipAt: 7.5, tipSeconds: 2.0, restSpeed: 1.5 },

  humanPlayer: { radius: 0.9144, interval: 1.0 }, // 3 ft from the LOADING ZONE

  pieces: {
    pollen: { radius: 0.0355, mass: 0.03, color: 0xffd21a }, // 2.8 in
    nectar: { radius: 0.0455, mass: 0.05 }, // 3.6 in
    red: 0xd8261c,
    blue: 0x1e56d8,
    restitution: 0.35,
    friction: 0.6,
  },

  match: { countdown: 3, auto: 30, transition: 8, teleop: 120, flowerUnlock: 60, settle: 3 },

  points: {
    leave: 3, park: 5, tip: 20, cell: 2, bottomNectar: 5, flower: 2, garden: 1,
    rp: { swarm: 16, pollinator1: 4, pollinator2: 7 },
  },
};

export const MAX_SPEED = (CONFIG.robot.motorRpm / 60) * Math.PI * CONFIG.robot.wheelDiameter; // ≈1.70 m/s
