"use strict";
const net = require("net");
const crypto = require("crypto");
const { validate } = require("./limits");
const { friendlyError } = require("./fly");
const { generatePassword, hashPassword, encrypt } = require("./secure");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serialises IP allocation + port choice so concurrent users never collide.
let chain = Promise.resolve();
const exclusive = fn => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};
const reservedPorts = new Set();

class ProvisionError extends Error {}

function portsInUse(machines) {
  const s = new Set(reservedPorts);
  for (const mm of machines) {
    for (const svc of mm.config?.services || []) for (const p of svc.ports || []) if (p.port) s.add(p.port);
    const mp = Number(mm.config?.metadata?.savage_port);
    if (mp) s.add(mp);
  }
  return s;
}

async function ensurePublicIp(fly, cfg) {
  const ips = await fly.appIps(true);
  const pick = t => ips.find(i => i.type === t);
  const have = pick(cfg.ipType === "v6" ? "v6" : "v4");
  if (have) return have.address;
  const ip = await fly.allocateIp(cfg.ipType === "v6" ? "v6" : "v4");
  // Verify the allocation is really visible on the app.
  const after = await fly.appIps(true);
  if (!after.some(i => i.address === ip.address)) throw new ProvisionError("Allocated IP did not appear on the app");
  return ip.address;
}

function sshBanner(host, port, timeoutMs) {
  return new Promise(resolve => {
    let done = false, buf = "";
    const s = net.connect({ host, port });
    const fin = (ok, err) => { if (done) return; done = true; s.destroy(); resolve({ ok, err }); };
    s.setTimeout(timeoutMs, () => fin(false, "timeout"));
    s.on("data", d => { buf += d.toString("latin1"); if (buf.includes("\n") || buf.length > 255) fin(/^SSH-/.test(buf), "unexpected banner"); });
    s.on("error", e => fin(false, e.code || e.message));
    s.on("close", () => fin(false, "closed"));
  });
}

async function verifySsh(cfg, ip, port) {
  const host = cfg.sshVerifyHost || ip;
  const end = Date.now() + cfg.sshTimeoutMs;
  let last = "unknown";
  while (Date.now() < end) {
    const r = await sshBanner(host, port, 5000);
    if (r.ok) return;
    last = r.err;
    await sleep(3000);
  }
  throw new ProvisionError(`SSH did not become reachable on ${ip}:${port} (${last})`);
}

/**
 * Real provisioning: IP → port → volume → machine → running → SSH banner check.
 * Any failure rolls back everything created and throws.
 */
async function provision({ fly, cfg, userId, input, os, region, progress = () => {} }) {
  const v = validate(input);
  if (!v.ok) throw new ProvisionError(v.errors.join("\n"));
  const spec = v.spec;
  const image = cfg.images[os];
  if (!image) throw new ProvisionError(`No VPS image is configured for Ubuntu ${os}.`);
  const regions = await fly.regions();
  if (!regions.some(r => r.code === region)) throw new ProvisionError(`Region "${region}" is not available on Fly.io.`);

  const id6 = crypto.randomBytes(3).toString("hex");
  const name = `savage-${id6}`;
  const created = { volumeId: null, machineId: null };
  let port = null;

  try {
    progress(10, "Checking account limits");
    const machines = await fly.listMachines();
    const mine = machines.filter(mm => mm.config?.metadata?.savage_owner === String(userId)).length;
    if (mine >= cfg.maxPerUser) throw new ProvisionError(`VPS limit reached (${cfg.maxPerUser} per user). Delete one first.`);

    progress(20, "Allocating public IP");
    const ip = await ensurePublicIp(fly, cfg);

    progress(30, "Reserving SSH port");
    port = await exclusive(async () => {
      const used = portsInUse(await fly.listMachines());
      const span = cfg.portMax - cfg.portMin + 1;
      for (let i = 0; i < 200; i++) {
        const p = cfg.portMin + crypto.randomInt(span);
        if (!used.has(p)) { reservedPorts.add(p); return p; }
      }
      throw new ProvisionError("No free SSH port available.");
    });

    progress(40, `Creating ${spec.volumeGb} GB persistent volume`);
    const vol = await fly.createVolume({ name: `savage_${id6}`, region, size_gb: spec.volumeGb, encrypted: true });
    created.volumeId = vol.id;

    progress(55, "Creating machine");
    const password = generatePassword(24);
    const hash = await hashPassword(password);
    const body = {
      name,
      region,
      config: {
        image,
        env: {
          VPS_HOSTNAME: name,
          VPS_ROOT_PASSWORD_HASH: hash,
          SSH_AUTHORIZED_KEY: cfg.ownerKey,
          VPS_DATA_DIR: cfg.volumePath
        },
        guest: { cpu_kind: spec.cpuKind, cpus: spec.cpus, memory_mb: spec.memoryMb },
        mounts: [{ volume: vol.id, path: cfg.volumePath, size_gb: spec.volumeGb }],
        services: [{
          protocol: "tcp",
          internal_port: 22,
          autostop: "off",
          autostart: false,
          ports: [{ port }]
        }],
        restart: { policy: "on-failure", max_retries: 5 },
        metadata: {
          savage_owner: String(userId),
          savage_os: os,
          savage_port: String(port),
          savage_disk: String(spec.volumeGb),
          savage_cpu_kind: spec.cpuKind,
          savage_created: new Date().toISOString(),
          savage_cred: encrypt(password, cfg.credSecret)
        }
      }
    };
    let machine;
    try {
      machine = await fly.createMachine(body);
    } catch (e) {
      // A timed-out create may still have succeeded: look it up by its unique name.
      if (e.network) machine = (await fly.listMachines()).find(x => x.name === name);
      if (!machine) throw e;
    }
    created.machineId = machine.id;

    progress(70, "Waiting for machine to start");
    const running = await fly.waitForState(machine.id, "started", cfg.startTimeoutMs);

    progress(85, "Verifying SSH access");
    if (cfg.sshVerify) await verifySsh(cfg, ip, port);

    progress(100, "Done");
    return {
      id: machine.id,
      name,
      ip,
      port,
      username: "root",
      password,
      os,
      region: running.region || region,
      spec,
      state: running.state
    };
  } catch (e) {
    const cleanup = [];
    if (created.machineId) {
      try { await fly.deleteMachine(created.machineId); cleanup.push("machine removed"); } catch { cleanup.push("machine removal FAILED — check Fly dashboard"); }
    }
    if (created.volumeId) {
      for (let i = 0; i < 6; i++) {
        try { await fly.deleteVolume(created.volumeId); cleanup.push("volume removed"); break; }
        catch { if (i === 5) cleanup.push("volume removal FAILED — check Fly dashboard"); else await sleep(2000); }
      }
    }
    const err = new ProvisionError(e instanceof ProvisionError ? e.message : friendlyError(e));
    err.cleanup = cleanup;
    throw err;
  } finally {
    if (port) setTimeout(() => reservedPorts.delete(port), 15000).unref();
  }
}

// Delete a machine and its volume. Caller must have verified ownership.
async function destroy(fly, machine) {
  const vols = (machine.config?.mounts || []).map(x => x.volume).filter(Boolean);
  await fly.deleteMachine(machine.id);
  const failed = [];
  for (const vid of vols) {
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      try { await fly.deleteVolume(vid); ok = true; } catch (e) { if (e.status === 404) ok = true; else await sleep(2000); }
    }
    if (!ok) failed.push(vid);
  }
  return { failedVolumes: failed };
}

module.exports = { provision, destroy, ProvisionError, sshBanner, ensurePublicIp };
