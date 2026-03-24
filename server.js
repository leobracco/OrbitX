require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cron = require("node-cron");
const cookieParser = require("cookie-parser");

const db = require("./services/couchdb");
const auth = require("./middleware/auth");
const agraria = require("./services/agraria");
const authSvc = require("./services/auth_service");

// Routes
const routeAuth = require("./routes/auth");
const routeSync = require("./routes/sync");
const routeLotes = require("./routes/lotes");
const routeAlertas = require("./routes/alertas");
const routeConfig = require("./routes/config");
const routeAdmin = require("./routes/admin");
const routePanel = require("./routes/panel"); // SSR panel
const routeAOG = require("./routes/aog");
const { router: routeDevices } = require("./routes/devices");
const routeVistaX = require("./routes/vistax");
const routeGrupos = require("./routes/grupos");
const routeAgrariaChat = require("./routes/agraria_chat");
const routeLotesMaestro = require("./routes/lotes_maestro");
const { router: integracionesRouter } = require('./routes/integraciones');
const ndviRouter = require('./routes/ndvi');



const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*", credentials: true },
});

// ── EJS config ────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── Helpers globales disponibles en todos los templates ───
const ROL_LABELS = {
  superadmin: "Super Admin",
  owner: "Dueño",
  admin_org: "Admin",
  agronomo: "Agrónomo",
  contratista: "Contratista",
  operador: "Operador",
  viewer: "Viewer",
  user: "Usuario",
};
const ROL_COLORS = {
  superadmin: "#B8FF3C",
  owner: "#3C9EFF",
  admin_org: "#3CFFCF",
  agronomo: "#A78BFA",
  contratista: "#FFB03C",
  operador: "#FB923C",
  viewer: "#94A3B8",
  user: "#94A3B8",
};

app.locals.rolLabel = (rol) => ROL_LABELS[rol] || rol || "–";
app.locals.rolBadge = (rol) => {
  const label = ROL_LABELS[rol] || rol || "–";
  const color = ROL_COLORS[rol] || "#94A3B8";
  return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;background:${color}18;color:${color};border:1px solid ${color}33;font-family:var(--font-m)">${label}</span>`;
};
app.locals.navItem = (href, icon, label, activeNav, badge = 0) => {
  const active = href === activeNav ? "active" : "";
  const badgeHtml = badge > 0 ? `<span class="nav-badge">${badge}</span>` : "";
  return `<a href="${href}" class="nav-item ${active}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${badgeHtml}</a>`;
};
app.locals.fmtDate = (ts) => {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use((req, _, next) => {
  req.io = io;
  next();
});

// ── Panel SSR (rutas HTML) ────────────────────────────────
app.use("/", routePanel);

// ── API JSON ──────────────────────────────────────────────
app.use("/api/auth", routeAuth);
app.use("/api/sync", auth.required, routeSync);
app.use("/api/lotes", auth.required, routeLotes);
app.use("/api/alertas", auth.required, routeAlertas);
app.use("/api/config", auth.required, routeConfig);
app.use("/api/admin", auth.required, auth.adminOnly, routeAdmin);
app.use("/api/vistax", auth.required, routeVistaX);
app.use("/api/grupos", auth.required, routeGrupos);
app.use("/api/agraria", auth.required, routeAgrariaChat);
app.use("/api/lotes-maestro", auth.required, routeLotesMaestro);
app.use('/api/integraciones', auth.required, routeIntegraciones);
app.use('/api/ndvi',          auth.required, routeNdvi);
// /api/aog: sync y descargas sin JWT (agente del tractor con deviceAuth interno)
// resto con JWT (panel web)
app.use(
  "/api/aog",
  (req, res, next) => {
    const sinJWT =
      (req.method === "POST" && req.path === "/sync") ||
      (req.method === "GET" && req.path.startsWith("/pendientes-descarga"));
    if (sinJWT) return next();
    return auth.required(req, res, next);
  },
  routeAOG,
);
// Rutas del agente (sin JWT — usan X-Auth-Token de dispositivo)
// /api/devices: heartbeat sin JWT, resto con JWT
// El router de devices maneja internamente deviceAuth para el heartbeat
app.use(
  "/api/devices",
  (req, res, next) => {
    // Heartbeat no requiere JWT — tiene su propio auth (deviceAuth) dentro del router
    if (req.method === "POST" && req.path === "/heartbeat") return next();
    // Sync AOG tampoco requiere JWT
    return auth.required(req, res, next);
  },
  routeDevices,
);

app.get("/health", async (req, res) => {
  const couchOk = await db.ping();
  res.json({ status: couchOk ? "ok" : "degraded", ts: Date.now() });
});

// ── Socket.IO ─────────────────────────────────────────────
io.use(auth.socketMiddleware);
io.on("connection", (socket) => {
  const { uid, estabSlug } = socket.user || {};
  socket.join(`estab:${estabSlug}`);
  socket.on("disconnect", () => {});
  socket.on("subscribe:maquina", (id) => socket.join(`maquina:${id}`));
});

// ── CRON ──────────────────────────────────────────────────
cron.schedule(
  "0 19 * * *",
  async () => {
    try {
      const estabs = await db.getEstablecimientos();
      for (const e of estabs) {
        const res = await db.getResumenDiario(e.slug);
        if (!res) continue;
        const analisis = await agraria.analizarDia(res);
        io.to(`estab:${e.slug}`).emit("agraria:resumen_diario", {
          estab: e.nombre,
          analisis,
          ts: Date.now(),
        });
      }
    } catch (e) {
      console.error("[CRON]", e.message);
    }
  },
  { timezone: "America/Argentina/Cordoba" },
);

// ── Bootstrap ─────────────────────────────────────────────
async function start() {
  console.log("\n🌍  OrbitX Cloud Server — Agro Parallel\n");
  try {
    await db.bootstrap();
    console.log("[DB] ✓ CouchDB conectado");
    authSvc.setDB(db);
    app.locals.globalDB = db.getDB("global");
  } catch (e) {
    console.error("[DB] ✗", e.message);
    process.exit(1);
  }
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () =>
    console.log(`[Server] ✓ http://localhost:${PORT}\n`),
  );
}

start();
module.exports = { app, io };
