const http = require("http");
const net = require("net");
function startMock() {
  const st = { machines: new Map(), volumes: new Map(), ips: [], n: 0, rejectMemAtLeast: Infinity, log: [] };
  const id = () => (++st.n).toString(16).padStart(14, "0");
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
      const body = b ? JSON.parse(b) : undefined;
      const u = new URL(req.url, "http://x");
      const send = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o ?? {})); };
      if (req.headers.authorization !== "Bearer FLYTOKEN") return send(401, { error: "bad token" });
      const p = u.pathname; st.log.push(`${req.method} ${p}`);
      if (p === "/graphql") {
        if (body.query.includes("allocateIpAddress")) { const ip = { address: "203.0.113.7", type: body.variables.input.type }; st.ips.push(ip); return send(200, { data: { allocateIpAddress: { ipAddress: ip } } }); }
        return send(200, { data: { app: { ipAddresses: { nodes: st.ips } } } });
      }
      if (p === "/v1/platform/regions") return send(200, { Regions: ["iad", "lhr", "ams", "fra", "sin", "syd", "nrt", "ord", "dfw", "lax", "sjc", "yyz", "cdg", "gru"].map(c => ({ code: c, name: c.toUpperCase() + " City" })) });
      let m;
      if (p === "/v1/apps/fleet/volumes" && req.method === "POST") { const v = { id: "vol_" + id(), ...body }; st.volumes.set(v.id, v); return send(200, v); }
      if ((m = p.match(/^\/v1\/apps\/fleet\/volumes\/(.+)$/)) && req.method === "DELETE") { return st.volumes.delete(m[1]) ? send(200, {}) : send(404, { error: "not found" }); }
      if (p === "/v1/apps/fleet/machines" && req.method === "GET") return send(200, [...st.machines.values()]);
      if (p === "/v1/apps/fleet/machines" && req.method === "POST") {
        if (body.config.guest.memory_mb >= st.rejectMemAtLeast) return send(422, { error: "insufficient resources to create new machine with existing volume" });
        const mm = { id: id(), name: body.name, region: body.region, state: "started", config: body.config };
        st.machines.set(mm.id, mm); return send(200, mm);
      }
      if ((m = p.match(/^\/v1\/apps\/fleet\/machines\/([0-9a-f]+)(\/(start|stop|restart))?$/))) {
        const mm = st.machines.get(m[1]); if (!mm) return send(404, { error: "machine not found" });
        if (!m[2] && req.method === "GET") return send(200, mm);
        if (!m[2] && req.method === "DELETE") { st.machines.delete(m[1]); return send(200, {}); }
        if (m[3] === "start" || m[3] === "restart") mm.state = "started"; if (m[3] === "stop") mm.state = "stopped";
        return send(200, {});
      }
      send(404, { error: "no route " + p });
    });
  });
  const banners = [];
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, close() { srv.close(); banners.forEach(s => s.close()); },
    banner(port) { return new Promise(ok => { const s = net.createServer(c => c.end("SSH-2.0-OpenSSH_mock\r\n")); s.listen(port, "127.0.0.1", ok); banners.push(s); }); } })));
}
module.exports = { startMock };
