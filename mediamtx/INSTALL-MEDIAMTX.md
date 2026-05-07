# Instalación de MediaMTX en el droplet OrbitX (DigitalOcean)

MediaMTX recibe RTSP de los tractores y lo distribuye en HLS/WebRTC/RTSP a
browsers, Smart TVs y apps móviles. Auth delegada a OrbitX (Node) por webhook.

## 1. Bajar el binario

```bash
ssh root@<droplet>

cd /opt
VERSION=v1.13.1
ARCH=linux_amd64
curl -L -o mediamtx.tgz "https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${ARCH}.tar.gz"
mkdir -p /opt/mediamtx
tar -xzf mediamtx.tgz -C /opt/mediamtx
rm mediamtx.tgz
chmod +x /opt/mediamtx/mediamtx
```

## 2. Copiar config

```bash
mkdir -p /etc/mediamtx
cp /var/www/orbitx/mediamtx/mediamtx.yml /etc/mediamtx/mediamtx.yml
# Editar y reemplazar ${PUBLIC_IP} y ${MEDIAMTX_WEBHOOK_SECRET} si no usás envsubst
```

Si preferís variables de entorno, MediaMTX las expande automáticamente.

## 3. Servicio systemd

```bash
cat > /etc/systemd/system/mediamtx.service <<'EOF'
[Unit]
Description=MediaMTX - cámaras OrbitX
After=network-online.target

[Service]
ExecStart=/opt/mediamtx/mediamtx /etc/mediamtx/mediamtx.yml
Restart=always
RestartSec=5
Environment=PUBLIC_IP=<TU_IP_PUBLICA_DEL_DROPLET>
Environment=MEDIAMTX_WEBHOOK_SECRET=<UN_SECRETO_LARGO>
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mediamtx
systemctl start mediamtx
systemctl status mediamtx
```

## 4. Sincronizar el secret con OrbitX

En el `.env` de OrbitX:

```
MEDIAMTX_WEBHOOK_SECRET=<EL_MISMO_SECRETO>
CAMARAS_PUBLIC_HOST=cam.agroparallel.com
CAMARAS_HLS_PORT=8888
CAMARAS_HLS_SCHEME=https
CAMARAS_SIGN_SECRET=<OTRO_SECRETO_LARGO_solo_para_firmar_URLs>
```

Reload PM2:
```bash
pm2 reload ecosystem.json --update-env
```

## 5. Firewall (DO Cloud Firewall + UFW)

Abrir:
- **TCP 8554**  ← RTSP push desde tractores y RTSP read para apps
- **UDP 8554-8555** ← RTSP/RTP (opcional, si usás transport=udp)
- **TCP 8888** ← HLS (browsers, TVs)
- **TCP 8889** ← WebRTC HTTP signaling
- **UDP 8189** ← WebRTC media (default ICE port de MediaMTX)

```bash
ufw allow 8554/tcp
ufw allow 8554:8555/udp
ufw allow 8888/tcp
ufw allow 8889/tcp
ufw allow 8189/udp
ufw reload
```

## 6. Reverse proxy HTTPS para HLS (recomendado)

Servir HLS por HTTPS (necesario para reproductores web modernos y apps de TV).
Con nginx:

```nginx
server {
    server_name cam.agroparallel.com;
    listen 443 ssl http2;
    # ... (certificado letsencrypt) ...

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;        # importante para LL-HLS
        proxy_request_buffering off;
        chunked_transfer_encoding on;
    }
}
```

Después en `.env`:
```
CAMARAS_PUBLIC_HOST=cam.agroparallel.com
CAMARAS_HLS_PORT=443
CAMARAS_HLS_SCHEME=https
```

## 7. Verificar

Desde otro server, simulando un tractor:

```bash
# Pull de un test stream y push a MediaMTX (usá las creds del device de prueba)
ffmpeg -re -i sample.mp4 \
  -c copy -f rtsp \
  rtsp://test-device-id:test-token@<PUBLIC_IP>:8554/test-device-id_cam1
```

Después en el browser:
- HLS:    `https://cam.agroparallel.com/test-device-id_cam1/index.m3u8?exp=...&sig=...`
- WebRTC: `https://cam.agroparallel.com:8889/test-device-id_cam1/whep`
- RTSP:   `rtsp://<PUBLIC_IP>:8554/test-device-id_cam1?exp=...&sig=...`

Las URLs firmadas las genera OrbitX en `/api/camaras/playback/:devId/:cam`.

## 8. Logs y troubleshooting

```bash
journalctl -u mediamtx -f               # logs MediaMTX
pm2 logs OrbitX | grep camaras          # logs auth-webhook
ss -ulnp | grep 8554                    # ¿está escuchando?
```

Errores comunes:
- `auth: 401 from 127.0.0.1:5005` → revisá que MEDIAMTX_WEBHOOK_SECRET coincida en ambos lados
- WebRTC no conecta desde celular → revisá que UDP 8189 esté abierto y `webrtcAdditionalHosts` tenga la IP pública
- HLS arranca pero corta → suele ser ancho de banda del tractor; bajar bitrate en Hikvision o subir `hlsSegmentCount` a 10
