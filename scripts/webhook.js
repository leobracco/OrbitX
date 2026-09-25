const http   = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const SECRET = "orbitx-webhook-secret-cambiar";
const PORT   = 9001;

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/deploy") {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    const sig  = req.headers["x-hub-signature-256"] || "";
    const hmac = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    if (sig !== hmac) { res.writeHead(401); res.end("Unauthorized"); return; }
    res.writeHead(200); res.end("OK");
    exec("/opt/AgroParallel/OrbitX/scripts/deploy.sh", (err, stdout, stderr) => {
      console.log(stdout || stderr || err?.message);
    });
  });
}).listen(PORT, () => console.log(`Webhook escuchando en :${PORT}`));
