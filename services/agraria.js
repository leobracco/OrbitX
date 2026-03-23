// services/agraria.js — OrbitX Cloud
const API = "https://api.anthropic.com/v1/messages";

async function call(system, user, max_tokens=500) {
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens,
        system,
        messages: [{ role:"user", content:user }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.error("[agrarIA]", e.message);
    return null;
  }
}

const BASE_SYSTEM = `Sos agrarIA, el asistente agronómico de OrbitX, plataforma de Agro Parallel.
Respondé en español rioplatense. Tono directo, práctico, campero. Sin markdown ni asteriscos.`;

async function analizarLote(resumen) {
  if (!resumen) return null;
  return call(BASE_SYSTEM,
    `Análisis post-lote:
Nombre: ${resumen.nombre}
Duración: ${resumen.dur_min} minutos
Hectáreas: ${resumen.ha_sembradas || 0} ha
Densidad promedio: ${resumen.resumen?.densidad_avg?.toLocaleString() || "N/D"} sem/ha
Densidad mínima: ${resumen.resumen?.densidad_min?.toLocaleString() || "N/D"} sem/ha
Alertas registradas: ${resumen.alertas_count || 0}
Eficiencia operativa: ${resumen.resumen?.eficiencia_pct || "N/D"}%

Generá un reporte conciso para el dueño del campo. Máximo 5 oraciones.`
  );
}

async function analizarDia(resumen) {
  if (!resumen) return null;
  return call(BASE_SYSTEM,
    `Resumen del día para el establecimiento:
Lotes trabajados hoy: ${resumen.lotes_hoy}
Alertas activas: ${resumen.alertas_activas}
Fecha: ${resumen.fecha}

Generá un resumen ejecutivo del día. Máximo 3 oraciones.`, 300
  );
}

async function tipMantenimiento(historialAlertas) {
  if (!historialAlertas?.length) return null;
  const por_bajada = {};
  historialAlertas.forEach(a => {
    const k = `Bajada ${a.bajada_id}`;
    por_bajada[k] = (por_bajada[k]||0) + 1;
  });
  const resumen = Object.entries(por_bajada).map(([k,n])=>`${k}: ${n} fallas`).join(", ");
  return call(BASE_SYSTEM,
    `Historial de fallas: ${resumen}
Dá 2-3 recomendaciones de mantenimiento preventivo concretas. Máximo 4 oraciones.`, 350
  );
}

module.exports = { analizarLote, analizarDia, tipMantenimiento };
