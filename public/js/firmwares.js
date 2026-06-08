// public/js/firmwares.js
(function () {
  "use strict";

  const TOKEN = localStorage.getItem("orbitx_token");
  const headers = (extra) => Object.assign({
    "Authorization": `Bearer ${TOKEN || ""}`,
  }, extra || {});

  const PRODUCTOS = ["VistaX","SoilX","SignalX","CowX","QuantiX","LineX","SectionX","StormX","FlowX","PilotX","CoreX-ECU"];

  // Convención: <Producto>_v<X.Y.Z>.<ext>  (ej: FlowX_v1.9.1.bin)
  // Devuelve { producto, productoRaw, version } o null si no matchea.
  function detectarDesdeNombre(nombre) {
    const m = /^(.+)_v(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\.(bin|hex|zip)$/i.exec(nombre || "");
    if (!m) return null;
    const productoRaw = m[1];
    const producto = PRODUCTOS.find(p => p.toLowerCase() === productoRaw.toLowerCase()) || null;
    return { producto, productoRaw, version: m[2] };
  }
  let productoActivo = "VistaX";
  let firmwares = [];

  // ── Pintar selector de productos ────────────────────────
  function pintarChips() {
    const cont = document.getElementById("fw-prods");
    cont.innerHTML = PRODUCTOS.map(p => `
      <button class="btn ${p === productoActivo ? 'btn-primary' : ''}" onclick="fwSetProducto('${p}')">${p}</button>
    `).join("");
  }

  window.fwSetProducto = function (p) {
    productoActivo = p;
    pintarChips();
    cargar();
  };

  // ── Cargar catálogo de versiones del producto activo ────
  async function cargar() {
    document.getElementById("fw-titulo").textContent = `Versiones — ${productoActivo}`;
    const tbody = document.getElementById("fw-rows");
    tbody.innerHTML = '<tr><td colspan="6" class="loading"><span class="spinner"></span> Cargando…</td></tr>';
    try {
      const r = await fetch(`/api/ota/firmwares?producto=${productoActivo}`, { headers: headers() });
      const list = await r.json();
      firmwares = Array.isArray(list) ? list : [];
      pintarTabla();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${e.message}</td></tr>`;
    }
  }

  function pintarTabla() {
    const tbody = document.getElementById("fw-rows");
    if (!firmwares.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><p>No hay firmwares de ${productoActivo} todavía.</p></td></tr>`;
      return;
    }
    tbody.innerHTML = firmwares.map(f => `
      <tr>
        <td class="td-main">${f.version}</td>
        <td class="td-mono td-dim">${(f.hash_sha256 || '').slice(0, 12)}…</td>
        <td class="td-mono">${formatBytes(f.tamano_bytes || 0)}</td>
        <td class="td-dim">${formatDate(f.ts)}</td>
        <td class="td-dim" style="max-width:280px;white-space:normal">${escapeHtml(f.changelog || '—')}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" onclick="fwDescargar('${f.producto}','${f.version}')">⬇</button>
          <button class="btn btn-sm" onclick="fwDisparar('${f.producto}','${f.version}')">⚡ Aplicar</button>
          ${window.IS_SA ? `<button class="btn btn-sm btn-danger" onclick="fwBorrar('${f.producto}','${f.version}')">🗑</button>` : ""}
        </td>
      </tr>
    `).join("");
  }

  // ── Subir (solo SA) ─────────────────────────────────────
  window.abrirSubir = () => {
    // Reset del form para no arrastrar datos de una subida anterior.
    document.getElementById("up-version").value = "";
    document.getElementById("up-changelog").value = "";
    document.getElementById("up-archivo").value = "";
    document.getElementById("up-detectado").textContent = "";
    document.getElementById("modal-subir").classList.add("open");
  };
  window.cerrarSubir = () => {
    document.getElementById("modal-subir").classList.remove("open");
  };

  // Auto-detección al elegir el archivo: pre-llena producto + versión.
  window.fwArchivoElegido = function (input) {
    const hint = document.getElementById("up-detectado");
    const f = input.files && input.files[0];
    if (!f) { hint.textContent = ""; return; }

    const det = detectarDesdeNombre(f.name);
    if (det && det.producto) {
      document.getElementById("up-producto").value = det.producto;
      document.getElementById("up-version").value  = det.version;
      hint.style.color = "var(--lime, #7bd88f)";
      hint.textContent = `✓ Detectado: ${det.producto} · ${det.version}`;
    } else if (det) {
      document.getElementById("up-version").value = det.version;
      hint.style.color = "var(--amber, #e0b341)";
      hint.textContent = `Versión ${det.version} detectada, pero "${det.productoRaw}" no está en el catálogo. Elegí el producto a mano.`;
    } else {
      hint.style.color = "var(--amber, #e0b341)";
      hint.textContent = `No pude leer el nombre. Usá <Producto>_v<X.Y.Z>.<ext> (ej: FlowX_v1.9.1.bin). Completá producto y versión a mano.`;
    }
  };

  window.subirFirmware = async function () {
    const producto  = document.getElementById("up-producto").value;
    const version   = document.getElementById("up-version").value.trim();
    const changelog = document.getElementById("up-changelog").value.trim();
    const archivo   = document.getElementById("up-archivo").files[0];
    if (!version) return alerta("Pasá una versión semver", "error");
    if (!archivo) return alerta("Elegí el archivo .bin", "error");

    const fd = new FormData();
    fd.append("producto",  producto);
    fd.append("version",   version);
    fd.append("changelog", changelog);
    fd.append("archivo",   archivo);

    alerta("Subiendo…", "info");
    try {
      const r = await fetch("/api/ota/upload", { method: "POST", headers: headers(), body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Falló el upload");
      alerta(`✓ ${producto} ${version} subido`, "success");
      cerrarSubir();
      productoActivo = producto;
      pintarChips();
      cargar();
      cargarLogs();
    } catch (e) {
      alerta(e.message, "error");
    }
  };

  // ── Borrar (solo SA) ────────────────────────────────────
  window.fwBorrar = async function (producto, version) {
    if (!confirm(`¿Borrar firmware ${producto} ${version}?`)) return;
    try {
      const r = await fetch(`/api/ota/firmware/${producto}/${version}`, { method: "DELETE", headers: headers() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Falló");
      alerta("✓ Borrado", "success");
      cargar();
    } catch (e) { alerta(e.message, "error"); }
  };

  // ── Descargar manual ────────────────────────────────────
  window.fwDescargar = function (producto, version) {
    // El JWT no se puede pasar en GET de download estándar, así que abrimos en nueva tab
    // pasando token por query (alternativa: guardar en cookie). Por ahora redirect simple.
    const a = document.createElement("a");
    a.href = `/api/ota/firmware/${producto}/${version}?token=${encodeURIComponent(TOKEN || '')}`;
    a.target = "_blank";
    a.click();
  };

  // ── Disparar OTA a un device ────────────────────────────
  window.fwDisparar = async function (producto, version) {
    try {
      const devs = await fetch("/api/devices", { headers: headers() }).then(r => r.json());
      if (!Array.isArray(devs) || !devs.length) return alerta("No tenés dispositivos asignados", "info");
      const opciones = devs.map(d => `${d.device_id} — ${d.nombre || ''}`).join("\n");
      const elegido  = prompt(`Pegá el device_id del tractor a actualizar:\n\n${opciones}`);
      if (!elegido) return;
      const device_id = elegido.split(" ")[0].trim();

      const r = await fetch("/api/ota/disparar", {
        method:  "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body:    JSON.stringify({ device_id, producto, version }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Falló");
      alerta(`✓ OTA encolada para ${device_id}`, "success");
      cargarLogs();
    } catch (e) { alerta(e.message, "error"); }
  };

  // ── Logs ─────────────────────────────────────────────────
  async function cargarLogs() {
    const tbody = document.getElementById("fw-logs");
    tbody.innerHTML = '<tr><td colspan="6" class="loading"><span class="spinner"></span> Cargando…</td></tr>';
    try {
      const r = await fetch("/api/ota/logs?limit=50", { headers: headers() });
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>Todavía no hay actualizaciones registradas.</p></td></tr>';
        return;
      }
      tbody.innerHTML = list.map(l => `
        <tr>
          <td class="td-dim">${formatDate(l.ts)}</td>
          <td class="td-mono">${l.device_id}</td>
          <td>${l.producto}</td>
          <td class="td-mono">${l.version_anterior || '?'} → ${l.version_nueva}</td>
          <td>${badgeResultado(l.resultado)}</td>
          <td class="td-dim" style="max-width:280px;white-space:normal">${escapeHtml(l.error || '—')}</td>
        </tr>
      `).join("");
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${e.message}</td></tr>`;
    }
  }

  // ── Helpers ─────────────────────────────────────────────
  function alerta(msg, tipo) {
    const el = document.getElementById("fw-alert");
    el.textContent = msg;
    el.className = `alert show ${tipo === "error" ? "error" : tipo === "success" ? "success" : "info"}`;
    if (tipo !== "error") setTimeout(() => el.classList.remove("show"), 3500);
  }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
    return (n/1048576).toFixed(2) + " MB";
  }
  function formatDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" });
  }
  function badgeResultado(r) {
    if (r === "ok")      return '<span class="badge badge-lime">✓ Ok</span>';
    if (r === "timeout") return '<span class="badge badge-amber">⌛ Timeout</span>';
    return '<span class="badge badge-red">✗ Falla</span>';
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  document.addEventListener("DOMContentLoaded", () => {
    pintarChips();
    cargar();
    cargarLogs();
  });
})();
