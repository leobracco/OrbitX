// ============================================================================
// stun-server.js - STUN server minimal RFC 5389 (UDP) sin dependencias.
//
// Soporta SOLO Binding Request → Binding Success Response con XOR-MAPPED-ADDRESS.
// Suficiente para que clientes WebRTC (browser/RTCPeerConnection) descubran su
// IP/puerto público a través del NAT.
//
// NO soporta TURN (relay). Para clientes detrás de CGNAT / 4G, además de STUN
// hace falta TURN — recomendado: coturn en otro contenedor / droplet.
//
// Uso:
//   const { startStun } = require('./lib/stun-server');
//   startStun({ port: 3478 });
//
// En DigitalOcean abrir UDP 3478 en el firewall (ufw + DO Cloud Firewall).
// ============================================================================

const dgram = require("dgram");

// Magic Cookie RFC 5389
const MAGIC_COOKIE = 0x2112a442;
const MAGIC_COOKIE_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

// Mensajes
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;

// Atributos
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS     = 0x0001;
const ATTR_SOFTWARE           = 0x8022;

const SOFTWARE = "OrbitX-STUN/1.0";

function ipv4ToBuf(ip) {
  const parts = ip.split(".").map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return Buffer.from(parts);
}

function ipv6ToBuf(ip) {
  // IPv6 mapping: separar "::ffff:1.2.3.4" si viene así
  if (ip.startsWith("::ffff:")) return ipv4ToBuf(ip.slice(7));
  // Soporte completo IPv6
  const buf = Buffer.alloc(16);
  const groups = ip.split(":");
  // expansión "::" simplificada
  let idx = 0;
  for (const g of groups) {
    if (g === "") continue;
    const v = parseInt(g, 16);
    buf.writeUInt16BE(v || 0, idx);
    idx += 2;
  }
  return buf;
}

// Construye atributo XOR-MAPPED-ADDRESS (RFC 5389 §15.2)
function buildXorMappedAddress(ip, port, transactionId) {
  const isV4 = ipv4ToBuf(ip) !== null || ip.startsWith("::ffff:");
  const family = isV4 ? 0x01 : 0x02;
  const addrBuf = isV4 ? ipv4ToBuf(ip.startsWith("::ffff:") ? ip.slice(7) : ip) : ipv6ToBuf(ip);

  const xPort = port ^ (MAGIC_COOKIE >>> 16);
  const xAddr = Buffer.alloc(addrBuf.length);
  for (let i = 0; i < addrBuf.length; i++) {
    if (i < 4) xAddr[i] = addrBuf[i] ^ MAGIC_COOKIE_BUF[i];
    else xAddr[i] = addrBuf[i] ^ transactionId[i - 4];
  }

  const valueLen = 4 + addrBuf.length;
  const attr = Buffer.alloc(4 + valueLen);
  attr.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(valueLen, 2);
  attr.writeUInt8(0, 4);            // reserved
  attr.writeUInt8(family, 5);
  attr.writeUInt16BE(xPort, 6);
  xAddr.copy(attr, 8);
  return attr;
}

// Atributo MAPPED-ADDRESS legacy (algunos clientes viejos lo prefieren)
function buildMappedAddress(ip, port) {
  const isV4 = ipv4ToBuf(ip) !== null || ip.startsWith("::ffff:");
  const family = isV4 ? 0x01 : 0x02;
  const addrBuf = isV4 ? ipv4ToBuf(ip.startsWith("::ffff:") ? ip.slice(7) : ip) : ipv6ToBuf(ip);
  const valueLen = 4 + addrBuf.length;
  const attr = Buffer.alloc(4 + valueLen);
  attr.writeUInt16BE(ATTR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(valueLen, 2);
  attr.writeUInt8(0, 4);
  attr.writeUInt8(family, 5);
  attr.writeUInt16BE(port, 6);
  addrBuf.copy(attr, 8);
  return attr;
}

function buildSoftwareAttr() {
  const text = Buffer.from(SOFTWARE, "utf8");
  // pad a múltiplo de 4
  const pad = (4 - (text.length % 4)) % 4;
  const valueLen = text.length;
  const attr = Buffer.alloc(4 + valueLen + pad);
  attr.writeUInt16BE(ATTR_SOFTWARE, 0);
  attr.writeUInt16BE(valueLen, 2);
  text.copy(attr, 4);
  return attr;
}

function buildBindingResponse(transactionId, clientIp, clientPort) {
  const xor = buildXorMappedAddress(clientIp, clientPort, transactionId);
  const mapped = buildMappedAddress(clientIp, clientPort);
  const sw = buildSoftwareAttr();
  const attrs = Buffer.concat([xor, mapped, sw]);

  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attrs.length, 2);
  MAGIC_COOKIE_BUF.copy(header, 4);
  transactionId.copy(header, 8);

  return Buffer.concat([header, attrs]);
}

// Parse y respuesta
function handleMessage(msg, rinfo, socket, log) {
  if (msg.length < 20) return; // header completo
  const msgType = msg.readUInt16BE(0);
  const msgLen  = msg.readUInt16BE(2);
  const cookie  = msg.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return;
  if (msg.length !== 20 + msgLen) return;

  // Solo Binding Request
  if (msgType !== BINDING_REQUEST) return;

  const transactionId = msg.slice(8, 20); // 12 bytes
  const resp = buildBindingResponse(transactionId, rinfo.address, rinfo.port);

  socket.send(resp, rinfo.port, rinfo.address, (err) => {
    if (err && log) log("[STUN] send error:", err.message);
  });
}

function startStun(opts = {}) {
  const port = opts.port || parseInt(process.env.STUN_PORT, 10) || 3478;
  const host = opts.host || process.env.STUN_HOST || "0.0.0.0";
  const log  = opts.log  || console.log;

  const sock4 = dgram.createSocket({ type: "udp4", reuseAddr: true });

  sock4.on("error", (err) => {
    log("[STUN] socket error:", err.message);
    try { sock4.close(); } catch {}
  });

  sock4.on("message", (msg, rinfo) => {
    try { handleMessage(msg, rinfo, sock4, log); }
    catch (e) { log("[STUN] handle error:", e.message); }
  });

  sock4.on("listening", () => {
    const a = sock4.address();
    log(`[STUN] escuchando en udp://${a.address}:${a.port}`);
  });

  sock4.bind(port, host);

  return {
    socket: sock4,
    stop: () => { try { sock4.close(); } catch {} },
  };
}

module.exports = { startStun };
