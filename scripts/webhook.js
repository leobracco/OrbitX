// webhook.js — Recibe el push de GitHub y dispara el deploy.
//
// El secreto sale del .env (WEBHOOK_SECRET) y NO del código: antes estaba
// hardcodeado con el valor de ejemplo, o sea que cualquiera que leyera el
// repo podía reiniciar producción.
//
// Solo despliega los push a main. Antes no miraba la rama: un push a
// cualquier rama —hasta una de respaldo— corría deploy.sh y reiniciaba
// OrbitX para todos los establecimientos, sin traer un solo cambio.
require("dotenv").config({ path: "/opt/AgroParallel/OrbitX/.env" });

const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.WEBHOOK_PORT || 9001);
const RAMA = "refs/heads/" + (process.env.WEBHOOK_RAMA || "main");

// Sin secreto no se levanta: quedarse escuchando con un secreto vacío
// aceptaría cualquier firma y es peor que no tener webhook.
if (!SECRET || SECRET.length < 20) {
  console.error("[webhook] falta WEBHOOK_SECRET en el .env (o es muy corto). No arranco.");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Comparación en tiempo constante: con === se puede sacar la firma byte a
// byte midiendo cuánto tarda en responder.
function firmaValida(firmaRecibida, cuerpo) {
  const esperada = "sha256=" + crypto.createHmac("sha256", SECRET).update(cuerpo).digest("hex");
  const a = Buffer.from(String(firmaRecibida || ""));
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/deploy") {
    res.writeHead(404); res.end(); return;
  }

  let body = "";
  let excedido = false;
  req.on("data", (d) => {
    body += d;
    // Un payload de push de GitHub no llega a 1 MB; cortar acá evita que
    // alguien nos llene la memoria con un POST infinito.
    if (body.length > 1_000_000 && !excedido) {
      excedido = true;
      res.writeHead(413); res.end("Payload demasiado grande");
      req.destroy();
    }
  });

  req.on("end", () => {
    if (excedido) return;

    if (!firmaValida(req.headers["x-hub-signature-256"], body)) {
      log("[webhook] firma inválida — ignorado");
      res.writeHead(401); res.end("Unauthorized"); return;
    }

    const evento = req.headers["x-github-event"] || "";
    let ref = "";
    try { ref = JSON.parse(body).ref || ""; } catch { /* payload sin ref */ }

    // El ping de GitHub (el que manda al guardar la config) se contesta OK
    // pero no despliega nada.
    if (evento === "ping") {
      log("[webhook] ping de GitHub — todo bien, sin deploy");
      res.writeHead(200); res.end("pong"); return;
    }

    if (evento !== "push" || ref !== RAMA) {
      log(`[webhook] ${evento} en ${ref || "(sin ref)"} — no es ${RAMA}, sin deploy`);
      res.writeHead(200); res.end("Ignorado: no es " + RAMA); return;
    }

    res.writeHead(200); res.end("OK");
    log("[webhook] push a", RAMA, "— arranca el deploy");
    exec("/opt/AgroParallel/OrbitX/scripts/deploy.sh", (err, stdout, stderr) => {
      log("[deploy]", (stdout || "").trim() || (stderr || "").trim() || err?.message || "sin salida");
    });
  });
}).listen(PORT, () => log(`[webhook] escuchando en :${PORT}, desplegando solo ${RAMA}`));
