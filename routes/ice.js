// ============================================================================
// routes/ice.js - Endpoint para obtener configuración de ICE servers (STUN/TURN)
//
// Devuelve la lista que un cliente WebRTC (browser, OrbitTV, app móvil) tiene
// que pasar a `new RTCPeerConnection({ iceServers: [...] })`.
//
// Estrategia: priorizamos nuestro STUN propio, y caemos a Google como backup.
// Si en el futuro montamos un TURN (coturn), agregamos sus credenciales aquí.
//
// Configurable por ENV:
//   STUN_HOSTNAME     → hostname público del STUN propio (ej: stun.agroparallel.com)
//   STUN_PUBLIC_PORT  → puerto UDP expuesto (default 3478)
//   TURN_HOSTNAME     → hostname público del TURN (vacío = sin TURN)
//   TURN_PORT         → puerto TURN (default 3478)
//   TURN_USER         → user TURN
//   TURN_PASS         → pass TURN
// ============================================================================

const express = require("express");
const router = express.Router();

router.get("/api/ice/servers", (req, res) => {
  const stunHost = process.env.STUN_HOSTNAME || "";
  const stunPort = process.env.STUN_PUBLIC_PORT || "3478";
  const turnHost = process.env.TURN_HOSTNAME || "";
  const turnPort = process.env.TURN_PORT || "3478";
  const turnUser = process.env.TURN_USER || "";
  const turnPass = process.env.TURN_PASS || "";

  const iceServers = [];

  // 1) STUN propio (si está configurado)
  if (stunHost) {
    iceServers.push({ urls: `stun:${stunHost}:${stunPort}` });
  }

  // 2) STUN Google (fallback público)
  iceServers.push({ urls: "stun:stun.l.google.com:19302" });
  iceServers.push({ urls: "stun:stun1.l.google.com:19302" });

  // 3) TURN propio (si está configurado)
  if (turnHost && turnUser && turnPass) {
    iceServers.push({
      urls: [
        `turn:${turnHost}:${turnPort}?transport=udp`,
        `turn:${turnHost}:${turnPort}?transport=tcp`,
      ],
      username: turnUser,
      credential: turnPass,
    });
  }

  res.json({
    ok: true,
    iceServers,
    // Hints para el cliente
    iceTransportPolicy: turnHost ? "all" : "all", // forzar relay sería "relay"
  });
});

module.exports = router;
