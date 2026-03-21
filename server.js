// ============================================================
//  OrbitX Cloud Server  — server.js
//  Agro Parallel · Express · CouchDB · Socket.IO · JWT
// ============================================================
require("dotenv").config();
const express   = require("express");
const http      = require("http");
const { Server }= require("socket.io");
const path      = require("path");
const cron      = require("node-cron");

const db        = require("./services/couchdb");
const auth      = require("./middleware/auth");
const agraria   = require("./services/agraria");

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

// ── Middleware global ────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));   // AOG backups pueden ser grandes
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Inyectar io en req para que las rutas puedan emitir eventos
app.use((req, _, next) => { req.io = io; next(); });

// ── API Routes ───────────────────────────────────────────────
app.use("/api/auth",    routeAuth);
app.use("/api/sync",    auth.required, routeSync);
app.use("/api/lotes",   auth.required, routeLotes);
app.use("/api/alertas", auth.required, routeAlertas);
app.use("/api/config",  auth.required, routeConfig);
app.use("/api/admin",   auth.required, auth.adminOnly, routeAdmin);

// ── Health check ────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const couchOk = await db.ping();
  res.json({
    status: couchOk ? "ok" : "degraded",
    version: process.env.npm_package_version || "1.0.0",
    ts: Date.now(),
    couch: couchOk ? "up" : "down"
  });
});

// ── Version endpoint (PWA auto-update) ──────────────────────
app.get("/version", (req, res) => {
  res.json({
    version: process.env.npm_package_version || "1.0.0",
    updated: process.env.DEPLOY_DATE || new Date().toISOString()
  });
});

// ── Servir SPA para cualquier ruta no-API ───────────────────
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.IO ───────────────────────────────────────────────
io.use(auth.socketMiddleware);

io.on("connection", (socket) => {
  const { uid, estabSlug } = socket.user;
  console.log(`[WS] ${uid} conectado (${estabSlug})`);

  // Unir al room del establecimiento para recibir updates en tiempo real
  socket.join(`estab:${estabSlug}`);

  socket.on("disconnect", () => {
    console.log(`[WS] ${uid} desconectado`);
  });

  // El cliente puede suscribirse a alertas de una máquina específica
  socket.on("subscribe:maquina", (maquinaId) => {
    socket.join(`maquina:${maquinaId}`);
  });
});

// ── CRON Jobs ────────────────────────────────────────────────
// Resumen diario agrarIA a las 19:00
cron.schedule("0 19 * * *", async () => {
  console.log("[CRON] Generando resúmenes diarios agrarIA...");
  try {
    const establecimientos = await db.getEstablecimientos();
    for (const estab of establecimientos) {
      const resumen = await db.getResumenDiario(estab.slug);
      if (!resumen) continue;
      const analisis = await agraria.analizarDia(resumen);
      io.to(`estab:${estab.slug}`).emit("agraria:resumen_diario", {
        estab: estab.nombre, analisis, ts: Date.now()
      });
    }
  } catch (e) {
    console.error("[CRON] Error resumen diario:", e.message);
  }
}, { timezone: "America/Argentina/Cordoba" });

// Limpiar alertas resueltas > 30 días
cron.schedule("0 3 * * 0", async () => {
  console.log("[CRON] Limpiando alertas antiguas...");
  // await db.purgeOldAlertas(30);
});

// ── Bootstrap y arranque ────────────────────────────────────
async function start() {
  console.log("\n🌍  OrbitX Cloud Server");
  console.log("    Agro Parallel · v1.0.0\n");

  try {
    await db.bootstrap();
    console.log("[DB] ✓ CouchDB conectado y listo");
  } catch (e) {
    console.error("[DB] ✗ No se pudo conectar a CouchDB:", e.message);
    console.error("    Verificá que CouchDB esté corriendo en", process.env.COUCHDB_URL);
    process.exit(1);
  }

  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => {
    console.log(`[Server] ✓ Escuchando en http://localhost:${PORT}`);
    console.log(`[Server]   Panel admin: http://localhost:${PORT}/admin\n`);
  });
}

start();
module.exports = { app, io };
