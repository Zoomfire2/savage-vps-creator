"use strict";
// Fly.io Machine sizing rules, plans and cost estimates.
// shared-cpu:      1/2/4/8/16 vCPU, 256 MB per vCPU minimum .. 2 GB per vCPU
// performance-cpu: 1/2/4/8/16 vCPU, 2 GB per vCPU minimum .. 8 GB per vCPU
// Volumes: 1..500 GB. Memory must be a multiple of 256 MB.

const CPU_OPTIONS = [1, 2, 4, 8, 16];
const MAX_RAM_GB = 128;
const MAX_VOLUME_GB = 500;

const PLANS = [
  { id: 1, ram: 4, cpu: 2, disk: 40, icon: "🟢" },
  { id: 2, ram: 8, cpu: 4, disk: 80, icon: "🔵" },
  { id: 3, ram: 16, cpu: 8, disk: 120, icon: "🟣" },
  { id: 4, ram: 32, cpu: 12, disk: 180, icon: "🔴" },
  { id: 5, ram: 64, cpu: 12, disk: 256, icon: "🟡" },
  { id: 6, ram: 512, cpu: 96, disk: 720, icon: "💎" }
];

const gb = n => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));

function pickKind(cpus, memoryMb) {
  if (memoryMb >= 256 * cpus && memoryMb <= 2048 * cpus) return "shared";
  if (memoryMb >= 2048 * cpus && memoryMb <= 8192 * cpus) return "performance";
  return null;
}

function cpusSupportingRam(memoryMb) {
  return CPU_OPTIONS.filter(c => pickKind(c, memoryMb));
}

function validate({ ramGb, cpus, diskGb }, _depth = 0) {
  const errors = [];
  const ok = n => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!ok(ramGb) || !ok(cpus) || !ok(diskGb)) {
    return { ok: false, errors: ["RAM, CPU and storage must all be positive numbers."], suggestion: null };
  }
  const memoryMb = Math.round(ramGb * 1024);
  let cpuProblem = false;

  if (!Number.isInteger(cpus) || !CPU_OPTIONS.includes(cpus)) {
    cpuProblem = true;
    errors.push(
      cpus > 16
        ? `${cpus} vCPU exceeds the Fly.io maximum of 16 vCPU per Machine.`
        : `${gb(cpus)} vCPU is not a size Fly.io offers. Valid vCPU counts: ${CPU_OPTIONS.join(", ")}.`
    );
  }
  if (ramGb > MAX_RAM_GB) errors.push(`${gb(ramGb)} GB RAM exceeds the Fly.io maximum of ${MAX_RAM_GB} GB per Machine.`);
  if (memoryMb % 256 !== 0) errors.push("RAM must be a multiple of 0.25 GB (256 MB).");
  if (diskGb > MAX_VOLUME_GB) errors.push(`${gb(diskGb)} GB storage exceeds the Fly.io volume maximum of ${MAX_VOLUME_GB} GB.`);
  if (!Number.isInteger(diskGb)) errors.push("Storage must be a whole number of GB.");

  let cpuKind = null;
  if (!cpuProblem && ramGb <= MAX_RAM_GB && memoryMb % 256 === 0) {
    cpuKind = pickKind(cpus, memoryMb);
    if (!cpuKind) {
      const valid = cpusSupportingRam(memoryMb);
      errors.push(
        `${gb(cpus)} vCPU supports only ${gb((256 * cpus) / 1024)}–${gb((8192 * cpus) / 1024)} GB RAM, so ${gb(ramGb)} GB is not possible. ` +
        (valid.length ? `For ${gb(ramGb)} GB use ${valid.join(" / ")} vCPU.` : "That RAM size is not available.")
      );
    }
  }

  if (errors.length) {
    let suggestion = null;
    // Only suggest a fix (never apply it silently) for the "odd CPU count" case.
    if (_depth === 0 && cpuProblem && cpus > 0 && cpus < 16 && Number.isInteger(cpus)) {
      const next = CPU_OPTIONS.find(c => c >= cpus);
      const s = { ramGb, cpus: next, diskGb };
      if (validate(s, 1).ok) suggestion = s;
    }
    return { ok: false, errors, suggestion };
  }
  return {
    ok: true,
    errors: [],
    suggestion: null,
    spec: { ramGb, cpus, diskGb, memoryMb, cpuKind, volumeGb: diskGb }
  };
}

// Approximate list prices (USD/month). Override with env if Fly changes them.
const RATES = {
  sharedCpu: 2.02, // per shared vCPU (includes 256 MB)
  perfCpu: 22.19, // per performance vCPU (excl. memory)
  ramGb: 5.0, // per GB (above the included amount for shared)
  volumeGb: 0.15,
  ipv4: 2.0
};

function estimate(spec) {
  const memGb = spec.memoryMb / 1024;
  const compute =
    spec.cpuKind === "shared"
      ? spec.cpus * RATES.sharedCpu + Math.max(0, memGb - 0.25 * spec.cpus) * RATES.ramGb
      : spec.cpus * RATES.perfCpu + memGb * RATES.ramGb;
  const storage = spec.volumeGb * RATES.volumeGb;
  return { compute, storage, total: compute + storage, hourly: (compute + storage) / 730 };
}

module.exports = { CPU_OPTIONS, MAX_RAM_GB, MAX_VOLUME_GB, PLANS, validate, estimate, pickKind, cpusSupportingRam, gb, RATES };
