// Límite de descargas públicas por IP, en memoria (ventana deslizante).
// No persiste entre reinicios a propósito: es un freno anti-abuso, no un cupo
// contable. Las IPs sin descargas recientes se borran del Map (en cada
// barrido y cuando el Map se llena) para que no crezca sin límite con
// tráfico de muchas IPs distintas.
function crearLimite({ limite = 20, ventanaMs = 60 * 60 * 1000, maxIps = 5000, ahora = Date.now } = {}) {
  const porIp = new Map();

  function barrer(t = ahora()) {
    for (const [ip, ts] of porIp) {
      const vivos = ts.filter((x) => t - x < ventanaMs);
      if (vivos.length) porIp.set(ip, vivos); else porIp.delete(ip);
    }
  }

  function permitir(ip) {
    const t = ahora();
    const previas = (porIp.get(ip) || []).filter((x) => t - x < ventanaMs);
    if (previas.length >= limite) { porIp.set(ip, previas); return false; }
    if (!porIp.has(ip) && porIp.size >= maxIps) {
      barrer(t);
      if (porIp.size >= maxIps) return false; // lleno de IPs activas: se niega antes que crecer
    }
    previas.push(t);
    porIp.set(ip, previas);
    return true;
  }

  return { permitir, barrer, tamano: () => porIp.size };
}

// Sin `trust proxy`, req.ip es la IP de Nginx Proxy Manager. Nginx AGREGA la IP
// real al final de X-Forwarded-For ($proxy_add_x_forwarded_for): el último salto
// es el confiable; el primero lo puede inventar el cliente en cada request.
function ipCliente(req) {
  const saltos = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return saltos.length ? saltos[saltos.length - 1] : req.ip;
}

module.exports = { crearLimite, ipCliente };
