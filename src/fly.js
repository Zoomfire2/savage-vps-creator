"use strict";
// Fly.io Machines REST + GraphQL client: timeouts, retries, rate-limit handling.

class FlyError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "FlyError";
    this.status = status;
    this.body = body;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createFly(cfg) {
  const app = encodeURIComponent(cfg.app);
  const headers = () => ({ Authorization: `Bearer ${cfg.flyToken}`, "Content-Type": "application/json" });

  async function http(url, method, body, { retry } = {}) {
    const canRetry = retry ?? (method === "GET" || method === "DELETE");
    const max = canRetry ? 4 : 2; // POSTs only retry on 429/503 (request not processed)
    let lastErr;
    for (let attempt = 1; attempt <= max; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.flyTimeoutMs)
        });
      } catch (e) {
        lastErr = new FlyError(e.name === "TimeoutError" ? "Fly.io API timed out" : `Fly.io API unreachable (${e.cause?.code || e.message})`, 0);
        lastErr.network = true;
        if (canRetry && attempt < max) { await sleep(500 * 2 ** attempt); continue; }
        throw lastErr;
      }
      const raw = await res.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 300) }; }
      if (res.ok) return data;

      const msg = (data && (data.error || data.message || (Array.isArray(data.errors) && data.errors[0]?.message))) || `Fly.io API returned HTTP ${res.status}`;
      lastErr = new FlyError(typeof msg === "string" ? msg : JSON.stringify(msg), res.status, data);
      const transient = res.status === 429 || res.status === 503 || (canRetry && res.status >= 500);
      if (transient && attempt < max) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  const rest = (path, method = "GET", body, opts) => http(cfg.apiBase + path, method, body, opts);

  async function gql(query, variables) {
    const d = await http(cfg.graphqlUrl, "POST", { query, variables }, { retry: true });
    if (d.errors?.length) throw new FlyError(d.errors[0].message || "GraphQL error", 400, d);
    return d.data;
  }

  const m = `/apps/${app}/machines`;
  let regionCache = { at: 0, list: null };
  const ipCache = { at: 0, ips: null };

  return {
    listMachines: async () => {
      const d = await rest(m);
      return Array.isArray(d) ? d : [];
    },
    getMachine: async id => {
      try { return await rest(`${m}/${id}`); } catch (e) { if (e.status === 404) return null; throw e; }
    },
    createMachine: body => rest(m, "POST", body, { retry: false }),
    startMachine: id => rest(`${m}/${id}/start`, "POST", {}, { retry: true }),
    stopMachine: id => rest(`${m}/${id}/stop`, "POST", {}, { retry: true }),
    restartMachine: id => rest(`${m}/${id}/restart`, "POST", {}, { retry: true }),
    deleteMachine: id => rest(`${m}/${id}?force=true`, "DELETE"),

    createVolume: body => rest(`/apps/${app}/volumes`, "POST", body, { retry: false }),
    deleteVolume: id => rest(`/apps/${app}/volumes/${encodeURIComponent(id)}`, "DELETE"),

    async waitForState(id, states, timeoutMs, failStates = ["destroyed", "failed"]) {
      const want = Array.isArray(states) ? states : [states];
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        const mm = await this.getMachine(id);
        last = mm?.state || "missing";
        if (want.includes(last)) return mm;
        if (failStates.includes(last) || last === "missing") throw new FlyError(`Machine entered state "${last}"`, 0);
        await sleep(1500);
      }
      throw new FlyError(`Timed out waiting for state ${want.join("/")} (last: ${last})`, 0);
    },

    async regions() {
      if (regionCache.list && Date.now() - regionCache.at < 600000) return regionCache.list;
      const d = await rest("/platform/regions");
      const arr = d.Regions || d.regions || [];
      const list = arr
        .filter(r => r && r.code)
        .map(r => ({ code: String(r.code).toLowerCase(), name: r.name || r.code, paid: !!r.requires_paid_plan }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) throw new FlyError("Fly.io returned no regions", 0);
      regionCache = { at: Date.now(), list };
      return list;
    },

    async appIps(force = false) {
      if (!force && ipCache.ips && Date.now() - ipCache.at < 60000) return ipCache.ips;
      const d = await gql(
        "query($app:String!){app(name:$app){ipAddresses{nodes{address type}}}}",
        { app: cfg.app }
      );
      if (!d?.app) throw new FlyError(`App "${cfg.app}" not found via GraphQL`, 404);
      const ips = d.app.ipAddresses.nodes || [];
      ipCache.at = Date.now();
      ipCache.ips = ips;
      return ips;
    },

    async allocateIp(type) {
      const d = await gql(
        "mutation($input:AllocateIPAddressInput!){allocateIpAddress(input:$input){ipAddress{address type}}}",
        { input: { appId: cfg.app, type } }
      );
      ipCache.at = 0;
      const ip = d?.allocateIpAddress?.ipAddress;
      if (!ip?.address) throw new FlyError("IP allocation returned no address", 0);
      return ip;
    }
  };
}

function friendlyError(e) {
  const m = String(e?.message || e);
  const s = e?.status;
  if (s === 401 || s === 403) return `Fly.io rejected the API token (HTTP ${s}). Check FLY_API_TOKEN permissions.`;
  if (s === 429) return "Fly.io rate limit reached. Wait a minute and try again.";
  if (/capacity|insufficient|not enough|no (available )?host|unable to (place|allocate)/i.test(m))
    return `Fly.io has no capacity for this size in the chosen region: ${m}. Try another region or a smaller size.`;
  if (/quota|limit|exceed/i.test(m)) return `Fly.io account/organization limit: ${m}`;
  if (s === 422 || s === 400) return `Fly.io rejected this configuration: ${m}`;
  if (e?.network) return m;
  return m;
}

module.exports = { createFly, FlyError, friendlyError };
