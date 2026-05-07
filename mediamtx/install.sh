#!/usr/bin/env bash
# ============================================================================
# install.sh — Instala MediaMTX en el droplet OrbitX (Ubuntu) de punta a punta.
#
# Hace:
#   1. Descarga binario MediaMTX a /opt/mediamtx
#   2. Copia mediamtx.yml a /etc/mediamtx
#   3. Genera secretos (MEDIAMTX_WEBHOOK_SECRET, CAMARAS_SIGN_SECRET)
#      — si ya existen, NO los regenera (idempotente)
#   4. Detecta IP pública del droplet
#   5. Crea/actualiza /etc/systemd/system/mediamtx.service
#   6. Abre puertos en UFW
#   7. Sincroniza .env de OrbitX (sin duplicar claves)
#   8. systemctl daemon-reload + enable + (re)start
#   9. pm2 reload OrbitX
#
# Uso:
#     cd /opt/AgroParallel/OrbitX
#     sudo bash mediamtx/install.sh
#
# Variables que podés sobreescribir antes de invocar:
#     MEDIAMTX_VERSION   default v1.13.1
#     PUBLIC_HOST        default = IP pública detectada (podés pasar cam.ejemplo.com)
#     ORBITX_DIR         default /opt/AgroParallel/OrbitX
#     HLS_SCHEME         default http   (cuando pongas nginx+TLS, poné https)
#     HLS_PORT           default 8888
# ============================================================================

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────
MEDIAMTX_VERSION="${MEDIAMTX_VERSION:-v1.13.1}"
ORBITX_DIR="${ORBITX_DIR:-/opt/AgroParallel/OrbitX}"
HLS_SCHEME="${HLS_SCHEME:-http}"
HLS_PORT="${HLS_PORT:-8888}"

INSTALL_DIR="/opt/mediamtx"
CONF_DIR="/etc/mediamtx"
CONF_FILE="$CONF_DIR/mediamtx.yml"
UNIT_FILE="/etc/systemd/system/mediamtx.service"
SECRETS_FILE="/etc/mediamtx/secrets.env"   # 600, root:root
ENV_FILE="$ORBITX_DIR/.env"

ARCH="linux_amd64"
case "$(uname -m)" in
  x86_64|amd64)  ARCH="linux_amd64" ;;
  aarch64|arm64) ARCH="linux_arm64v8" ;;
  armv7l)        ARCH="linux_armv7" ;;
  *) echo "Arquitectura no soportada: $(uname -m)"; exit 1 ;;
esac

# ─── Sanity ─────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "Este script tiene que correr como root (sudo bash mediamtx/install.sh)"
  exit 1
fi

if [[ ! -f "$ORBITX_DIR/mediamtx/mediamtx.yml" ]]; then
  echo "No encuentro $ORBITX_DIR/mediamtx/mediamtx.yml"
  echo "¿ORBITX_DIR está bien? Actual: $ORBITX_DIR"
  exit 1
fi

log() { echo -e "\033[1;36m[mediamtx-install]\033[0m $*"; }

# ─── 1. Detectar IP pública ─────────────────────────────────────────────────
detect_ip() {
  # DigitalOcean metadata primero, después fallback a servicios públicos
  local ip
  ip="$(curl -s --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)"
  [[ -z "$ip" ]] && ip="$(curl -s --max-time 3 https://api.ipify.org || true)"
  [[ -z "$ip" ]] && ip="$(curl -s --max-time 3 https://ifconfig.me || true)"
  echo "$ip"
}

PUBLIC_IP="$(detect_ip)"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "No pude detectar IP pública. Pasala manual: PUBLIC_IP=1.2.3.4 sudo bash $0"
  exit 1
fi
PUBLIC_HOST="${PUBLIC_HOST:-$PUBLIC_IP}"
log "IP pública: $PUBLIC_IP"
log "Hostname público (HLS): $PUBLIC_HOST"

# ─── 2. Generar / cargar secretos ───────────────────────────────────────────
mkdir -p "$CONF_DIR"
if [[ -f "$SECRETS_FILE" ]]; then
  log "Reutilizando secretos existentes ($SECRETS_FILE)"
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
else
  log "Generando secretos nuevos…"
  MEDIAMTX_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  CAMARAS_SIGN_SECRET="$(openssl rand -hex 32)"
  cat > "$SECRETS_FILE" <<EOF
# Generado por mediamtx/install.sh — NO COMMITEAR
MEDIAMTX_WEBHOOK_SECRET=$MEDIAMTX_WEBHOOK_SECRET
CAMARAS_SIGN_SECRET=$CAMARAS_SIGN_SECRET
EOF
  chmod 600 "$SECRETS_FILE"
fi

# ─── 3. Bajar binario MediaMTX ──────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
NEED_DOWNLOAD=1
if [[ -x "$INSTALL_DIR/mediamtx" ]]; then
  CURRENT_VER="$("$INSTALL_DIR/mediamtx" --version 2>&1 | head -n1 | awk '{print $NF}' || echo "")"
  if [[ "$CURRENT_VER" == "$MEDIAMTX_VERSION" ]]; then
    log "MediaMTX $MEDIAMTX_VERSION ya instalado, skip download"
    NEED_DOWNLOAD=0
  fi
fi

if [[ $NEED_DOWNLOAD -eq 1 ]]; then
  log "Descargando MediaMTX $MEDIAMTX_VERSION ($ARCH)…"
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
  URL="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_${ARCH}.tar.gz"
  curl -fL -o "$TMPDIR/mediamtx.tgz" "$URL"
  tar -xzf "$TMPDIR/mediamtx.tgz" -C "$INSTALL_DIR"
  chmod +x "$INSTALL_DIR/mediamtx"
fi

# ─── 4. Copiar config ───────────────────────────────────────────────────────
log "Copiando $ORBITX_DIR/mediamtx/mediamtx.yml → $CONF_FILE"
cp -f "$ORBITX_DIR/mediamtx/mediamtx.yml" "$CONF_FILE"

# ─── 5. Crear unit systemd ──────────────────────────────────────────────────
log "Escribiendo $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=MediaMTX - camaras OrbitX
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$SECRETS_FILE
Environment=PUBLIC_IP=$PUBLIC_IP
ExecStart=$INSTALL_DIR/mediamtx $CONF_FILE
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# ─── 6. Firewall (UFW) ──────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -q "Status: active"; then
    log "Abriendo puertos en UFW"
    ufw allow 8554/tcp       || true
    ufw allow 8554:8555/udp  || true
    ufw allow 8888/tcp       || true
    ufw allow 8889/tcp       || true
    ufw allow 8189/udp       || true
  else
    log "UFW inactivo, no toco firewall (revisá DigitalOcean Cloud Firewall)"
  fi
fi

# ─── 7. Sincronizar .env de OrbitX ──────────────────────────────────────────
upsert_env() {
  local key="$1" val="$2" file="$3"
  if [[ ! -f "$file" ]]; then
    echo "$key=$val" > "$file"
    return
  fi
  if grep -qE "^${key}=" "$file"; then
    # reemplazar in-place (escape de slashes y &)
    local esc; esc="$(printf '%s\n' "$val" | sed -e 's/[\/&]/\\&/g')"
    sed -i "s/^${key}=.*/${key}=${esc}/" "$file"
  else
    echo "$key=$val" >> "$file"
  fi
}

if [[ -f "$ENV_FILE" ]]; then
  log "Actualizando $ENV_FILE"
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  upsert_env "MEDIAMTX_WEBHOOK_SECRET" "$MEDIAMTX_WEBHOOK_SECRET" "$ENV_FILE"
  upsert_env "CAMARAS_SIGN_SECRET"     "$CAMARAS_SIGN_SECRET"     "$ENV_FILE"
  upsert_env "CAMARAS_PUBLIC_HOST"     "$PUBLIC_HOST"             "$ENV_FILE"
  upsert_env "CAMARAS_HLS_PORT"        "$HLS_PORT"                "$ENV_FILE"
  upsert_env "CAMARAS_HLS_SCHEME"      "$HLS_SCHEME"              "$ENV_FILE"
else
  log "OJO: $ENV_FILE no existe — se creará"
  cat > "$ENV_FILE" <<EOF
MEDIAMTX_WEBHOOK_SECRET=$MEDIAMTX_WEBHOOK_SECRET
CAMARAS_SIGN_SECRET=$CAMARAS_SIGN_SECRET
CAMARAS_PUBLIC_HOST=$PUBLIC_HOST
CAMARAS_HLS_PORT=$HLS_PORT
CAMARAS_HLS_SCHEME=$HLS_SCHEME
EOF
fi

# ─── 8. systemd start ───────────────────────────────────────────────────────
log "systemctl daemon-reload + enable + restart"
systemctl daemon-reload
systemctl enable mediamtx >/dev/null
systemctl restart mediamtx
sleep 2
systemctl --no-pager status mediamtx | head -n 12 || true

# ─── 9. pm2 reload OrbitX (si está corriendo) ───────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | grep -q '"name":"OrbitX"'; then
    log "Recargando OrbitX en pm2"
    (cd "$ORBITX_DIR" && pm2 reload ecosystem.json --update-env || pm2 restart OrbitX --update-env || true)
  else
    log "OrbitX no está en pm2 — arrancalo manualmente cuando quieras"
  fi
fi

# ─── Resumen ────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════════"
echo " MediaMTX instalado y corriendo"
echo "════════════════════════════════════════════════════════════════════"
echo " Binario   : $INSTALL_DIR/mediamtx"
echo " Config    : $CONF_FILE"
echo " Unit      : $UNIT_FILE"
echo " Secretos  : $SECRETS_FILE   (chmod 600)"
echo " IP pública: $PUBLIC_IP"
echo " Host HLS  : $HLS_SCHEME://$PUBLIC_HOST:$HLS_PORT"
echo
echo " Próximos pasos:"
echo "   1) Verificá puertos abiertos en DigitalOcean Cloud Firewall:"
echo "        TCP 8554, 8888, 8889    UDP 8554-8555, 8189"
echo "   2) (Recomendado) nginx + LetsEncrypt para HLS por HTTPS"
echo "   3) Probá un push de prueba:"
echo "        ffmpeg -re -i sample.mp4 -c copy -f rtsp \\"
echo "          rtsp://test-id:test-token@$PUBLIC_IP:8554/test-id_cam1"
echo
echo " Logs:"
echo "   journalctl -u mediamtx -f"
echo "   pm2 logs OrbitX | grep camaras"
echo "════════════════════════════════════════════════════════════════════"
