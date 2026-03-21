// ============================================================
//  OrbitX Cloud Server  — server.js
//  Agro Parallel · Express · CouchDB · Socket.IO · JWT
// ============================================================
require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const cron       = require("node-cron");

const db       = require("./services/couchdb");
const auth     = require("./middleware/auth");
const agraria  = require("./services/agraria");
const authSvc  = require("./services/auth_service");

// Routes
const routeAuth    = require("./routes/auth");
const routeSync    = require("./routes/sync");
const routeLotes   = require("./routes/lotes");
const routeAlertas = require("./routes/alertas");
const routeConfig  = require("./routes/config");
const routeAdmin   = require("./routes/admin");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*", credentials: true }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use((req, _, next) => { req.io = io; next(); });

app.use("/api/auth",    routeAuth);
app.use("/api/sync",    auth.required, routeSync);
app.use("/api/lotes",   auth.required, routeLotes);
app.use("/api/alertas", auth.required, routeAlertas);
app.use("/api/config",  auth.required, routeConfig);
app.use("/api/admin",   auth.required, auth.adminOnly, routeAdmin);

app.get("/health", async (req, res) => {
  const couchOk = await db.ping();
  res.json({ status: couchOk ? "ok" : "degraded", version: "1.0.0", ts: Date.now(), couch: couchOk ? "up" : "down" });
});

app.get("/version", (req, res) => {
  res.json({ version: "1.0.0", updated: process.env.DEPLOY_DATE || new Date().toISOString() });
});

app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.use(auth.socketMiddleware);
io.on("connection", (socket) => {
  const { uid, estabSlug } = socket.user || {};
  console.log(`[WS] ${uid} conectado (${estabSlug})`);
  socket.join(`estab:${estabSlug}`);
  socket.on("disconnect", () => console.log(`[WS] ${uid} desconectado`));
  socket.on("subscribe:maquina", (id) => socket.join(`maquina:${id}`));
});

cron.schedule("0 19 * * *", async () => {
  try {
    const estabs = await db.getEstablecimientos();
    for (const e of estabs) {
      const res = await db.getResumenDiario(e.slug);
      if (!res) continue;
      const analisis = await agraria.analizarDia(res);
      io.to(`estab:${e.slug}`).emit("agraria:resumen_diario", { estab: e.nombre, analisis, ts: Date.now() });
    }
  } catch (e) { console.error("[CRON]", e.message); }
}, { timezone: "America/Argentina/Cordoba" });

async function start() {
  console.log("\n🌍  OrbitX Cloud Server — Agro Parallel\n");
  try {
    await db.bootstrap();
    console.log("[DB] ✓ CouchDB conectado");
    authSvc.setDB(db);
    app.locals.globalDB = db.getDB("global");
  } catch (e) {
    console.error("[DB] ✗ CouchDB error:", e.message);
    process.exit(1);
  }
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => console.log(`[Server] ✓ http://localhost:${PORT}\n`));
}

start();
module.exports = { app, io };
