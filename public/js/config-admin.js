// public/js/config-admin.js — UI de /config (superadmin only)
(function () {
  "use strict";

  const TOKEN = localStorage.getItem("orbitx_token");
  const headers = () => ({
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${TOKEN || ""}`,
  });

  // ── Cargar estado actual ────────────────────────────────
  async function cargar() {
    try {
      const r = await fetch("/api/config-sistema", { headers: headers() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Error cargando configuración");
      pintar(j.data || {});
      pintarBadges(j.data || {});
    } catch (e) {
      mostrarAlerta(e.message || "Error al cargar", "error");
    }
  }

  function pintar(data) {
    document.querySelectorAll("input[data-key], select[data-key]").forEach(el => {
      const k = el.dataset.key;
      const info = data[k];
      if (!info) return;
      // Para secrets enmascarados, dejar el placeholder distinto pero NO el valor
      // (así si el usuario no toca el campo, el backend no lo pisa).
      if (info.secret && info.set) {
        el.placeholder = info.value || "•••• configurado ••••";
        el.value = "";
      } else {
        el.value = info.value || "";
      }
    });
  }

  function pintarBadges(data) {
    const tg = !!(data.TELEGRAM_ADMIN_BOT_TOKEN?.set && data.TELEGRAM_ADMIN_CHAT_ID?.set);
    const sm = !!(data.SMTP_HOST?.set && data.SMTP_USER?.set && data.SMTP_PASS?.set);
    const wa = !!(data.WHATSAPP_PHONE_NUMBER_ID?.set && data.WHATSAPP_ACCESS_TOKEN?.set);
    const an = !!data.ANTHROPIC_API_KEY?.set;
    const co = !!(data.COPERNICUS_CLIENT_ID?.set && data.COPERNICUS_CLIENT_SECRET?.set && data.COPERNICUS_INSTANCE_ID?.set);

    setBadge("telegram",   tg);
    setBadge("smtp",       sm);
    setBadge("whatsapp",   wa);
    setBadge("anthropic",  an);
    setBadge("copernicus", co);
  }

  function setBadge(canal, ok) {
    const el = document.querySelector(`[data-status="${canal}"]`);
    if (!el) return;
    el.textContent = ok ? "Configurado" : "Sin configurar";
    el.classList.remove("badge-lime","badge-gray","badge-amber");
    el.classList.add(ok ? "badge-lime" : "badge-amber");
  }

  // ── Guardar ─────────────────────────────────────────────
  window.cfgGuardar = async function (keys) {
    try {
      const values = {};
      keys.forEach(k => {
        const el = document.querySelector(`[data-key="${k}"]`);
        if (!el) return;
        // Solo enviar si el usuario tocó el campo o no es secret enmascarado.
        if (el.value !== "") values[k] = el.value;
      });
      if (!Object.keys(values).length) {
        mostrarAlerta("No hay cambios para guardar", "info");
        return;
      }
      const r = await fetch("/api/config-sistema", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ values }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Error al guardar");
      mostrarAlerta(`✓ Guardado: ${(j.guardadas || []).join(", ")}`, "success");
      await cargar();
    } catch (e) {
      mostrarAlerta(e.message || "Error al guardar", "error");
    }
  };

  // ── Probar canal ────────────────────────────────────────
  window.cfgProbar = async function (canal) {
    try {
      const body = {};
      if (canal === "smtp") {
        body.to = document.getElementById("smtp-test-to")?.value?.trim();
        if (!body.to) return mostrarAlerta("Pasá un email destino para el test", "error");
      }
      if (canal === "whatsapp") {
        body.to = document.getElementById("wa-test-to")?.value?.trim();
        if (!body.to) return mostrarAlerta("Pasá un número destino (ej: 5493510000000)", "error");
      }

      mostrarAlerta(`Probando ${canal}…`, "info");
      const r = await fetch(`/api/config-sistema/test/${canal}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const j = await r.json();

      // Diagnóstico extendido para Copernicus.
      if (canal === "copernicus") {
        let txt = "";
        if (j.layers) txt += `Layers en la configuration: ${j.layers.join(", ") || "ninguno"}. `;
        if (j.layer_usado) txt += `Probé con: ${j.layer_usado}. `;
        if (j.tile_status) txt += `Tile HTTP ${j.tile_status}. `;
        if (j.tile_error) txt += `Detalle: ${j.tile_error.slice(0, 200)} `;
        if (j.tip) txt += `→ ${j.tip}`;
        if (!r.ok || j.ok === false) {
          mostrarAlerta(`✗ Copernicus: ${txt || j.error || "falló"}`, "error");
          return;
        }
        mostrarAlerta(`✓ Copernicus OK. ${txt}`, "success");
        return;
      }

      if (!r.ok || j.ok === false) throw new Error(j.error || "Falló el envío");
      mostrarAlerta(`✓ Prueba de ${canal} enviada${j.message_id ? ` (id ${j.message_id})` : ""}`, "success");
    } catch (e) {
      mostrarAlerta(`✗ ${canal}: ${e.message}`, "error");
    }
  };

  // ── UI helpers ──────────────────────────────────────────
  function mostrarAlerta(msg, tipo) {
    const el = document.getElementById("cfg-alert");
    if (!el) { console.log(msg); return; }
    el.textContent = msg;
    el.className = `alert show ${tipo === "error" ? "error" : tipo === "success" ? "success" : "info"}`;
    if (tipo !== "error") {
      clearTimeout(window._cfgAlertTimer);
      window._cfgAlertTimer = setTimeout(() => el.classList.remove("show"), 4000);
    }
  }

  document.addEventListener("DOMContentLoaded", cargar);
})();
