// routes/agraria_chat.js — agrarIA + soporte completo de adjuntos geoespaciales
const router = require("express").Router();
const crypto = require("crypto");
const db     = require("../services/couchdb");

// ── Persistencia de sesiones de chat en orbitx_global ─────
// Doc: chat_<uid>_<sesionId> (tipo: "agraria_chat")
async function getSesion(uid, sesionId) {
  const gdb = db.getDB("global");
  return gdb.get(`chat_${uid}_${sesionId}`).catch(() => null);
}

async function listSesiones(uid, limit = 50) {
  const gdb = db.getDB("global");
  try {
    const r = await gdb.find({
      selector: { tipo: "agraria_chat", uid },
      fields:   ["_id", "sesionId", "titulo", "orgSlug", "mensajes_count", "updated_at", "created_at"],
      limit,
    });
    return r.docs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  } catch {
    const all = await gdb.list({ include_docs: true });
    return all.rows.map(r => r.doc)
      .filter(d => d?.tipo === "agraria_chat" && d?.uid === uid)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .slice(0, limit);
  }
}

async function appendMensaje(uid, sesionId, orgSlug, mensajeUser, respuestaIA) {
  const gdb = db.getDB("global");
  const _id = `chat_${uid}_${sesionId}`;
  const now = Date.now();

  const mensajesNuevos = [
    { rol: "user",      texto: mensajeUser, ts: now },
    { rol: "assistant", texto: respuestaIA, ts: now + 1 },
  ];

  // O11c — retry 409: dos mensajes rápidos (doble-click/reconexión) hacían
  // get+insert sobre el mismo doc y el segundo se perdía silencioso. Releemos
  // el _rev fresco en cada intento y appendeamos sobre lo último.
  let lastErr;
  for (let intento = 0; intento < 3; intento++) {
    let doc = await getSesion(uid, sesionId);
    if (!doc) {
      // Título: primeras 8 palabras del primer mensaje.
      const titulo = (mensajeUser || "Sin título").split(/\s+/).slice(0, 8).join(" ").slice(0, 80);
      doc = {
        _id,
        tipo:      "agraria_chat",
        sesionId,
        uid,
        orgSlug:   orgSlug || null,
        titulo,
        mensajes:  mensajesNuevos,
        mensajes_count: mensajesNuevos.length,
        created_at: now,
        updated_at: now,
      };
    } else {
      doc.mensajes = [...(doc.mensajes || []), ...mensajesNuevos];
      doc.mensajes_count = doc.mensajes.length;
      doc.updated_at = now;
    }
    try {
      await gdb.insert(doc);
      return doc;
    } catch (e) {
      if ((e.statusCode === 409 || e.error === "conflict") && intento < 2) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error("appendMensaje: conflict tras 3 reintentos");
}

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL   = "claude-sonnet-4-20250514";

const SYSTEM_BASE = `Sos agrarIA, el asistente agronómico de OrbitX de Agro Parallel.
Respondés en español rioplatense. Tono directo, práctico y técnico pero accesible para productores y maquinistas.
Cuando analizás datos de siembra, mapas de rendimiento, prescripciones o archivos geoespaciales, sos preciso con los números y das recomendaciones concretas.
Cuando te mandan fotos del campo, cultivos, maquinaria o documentos, los analizás en detalle.
No usás markdown ni asteriscos. Máximo 6 oraciones por respuesta salvo que te pidan más detalle.`;

async function callClaude(system, messages, max_tokens = 1000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");
  const r = await fetch(API_URL, {
    method: "POST",
    // O5 — sin timeout, una respuesta colgada de la API deja el handler
    // pendiente para siempre y agota el pool bajo concurrencia. 60s cubre
    // análisis de visión / respuestas largas.
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API ${r.status}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text?.trim() || "";
}

// ══════════════════════════════════════════════════════════
//  PARSERS de archivos geoespaciales y datos
// ══════════════════════════════════════════════════════════

// ── DBF reader ───────────────────────────────────────────
function parseDBF(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'base64');
  const numRecords  = data.readUInt32LE(4);
  const headerSize  = data.readUInt16LE(8);
  const recordSize  = data.readUInt16LE(10);

  const fields = [];
  let pos = 32;
  while (pos < headerSize - 1 && data[pos] !== 0x0D) {
    const name = data.slice(pos, pos+11).toString('ascii').replace(/\0/g,'').trim();
    const type = String.fromCharCode(data[pos+11]);
    const len  = data[pos+16];
    const dec  = data[pos+17];
    fields.push({ name, type, len, dec });
    pos += 32;
  }

  const records = [];
  for (let i = 0; i < Math.min(numRecords, 5000); i++) {
    const recStart = headerSize + i * recordSize;
    if (recStart + recordSize > data.length) break;
    const rec = data.slice(recStart, recStart + recordSize);
    if (rec[0] === 0x2A) continue; // deleted
    const obj = {};
    let offset = 1;
    for (const f of fields) {
      obj[f.name] = rec.slice(offset, offset + f.len).toString('latin1').trim();
      offset += f.len;
    }
    records.push(obj);
  }

  return { fields, records, numRecords };
}

// ── SHX reader ────────────────────────────────────────────
function parseSHX(buffer) {
  const data    = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'base64');
  const fileLen = data.readInt32BE(24) * 2;
  const n       = (fileLen - 100) / 8;
  const offsets = [];
  for (let i = 0; i < n; i++) {
    offsets.push(data.readInt32BE(100 + i*8) * 2);
  }
  return offsets;
}

// ── SHP + DBF → resumen textual para Claude ───────────────
function parseShapefile(shpB64, shxB64, dbfB64, prjText) {
  try {
    const shp = Buffer.from(shpB64, 'base64');
    const shx = shxB64 ? Buffer.from(shxB64, 'base64') : null;
    const dbf = dbfB64 ? parseDBF(Buffer.from(dbfB64, 'base64')) : null;

    // Header SHP
    const shapeType = shp.readInt32LE(32);
    const TYPES = {0:'Null',1:'Point',3:'Polyline',5:'Polygon',8:'MultiPoint',
                   11:'PointZ',13:'PolylineZ',15:'PolygonZ',18:'MultiPointZ',
                   21:'PointM',23:'PolylineM',25:'PolygonM'};

    const bboxXmin = shp.readDoubleLE(36);
    const bboxYmin = shp.readDoubleLE(44);
    const bboxXmax = shp.readDoubleLE(52);
    const bboxYmax = shp.readDoubleLE(60);

    // Detectar si las coordenadas son UTM o WGS84
    const isUTM = Math.abs(bboxXmin) > 1000;
    let coordInfo = "";
    if (isUTM) {
      coordInfo = `Coordenadas en metros (proyección UTM). Bbox: E${bboxXmin.toFixed(0)}-${bboxXmax.toFixed(0)}, N${bboxYmin.toFixed(0)}-${bboxYmax.toFixed(0)}`;
    } else {
      coordInfo = `Coordenadas WGS84. Bbox: lon(${bboxXmin.toFixed(4)},${bboxXmax.toFixed(4)}) lat(${bboxYmin.toFixed(4)},${bboxYmax.toFixed(4)})`;
    }

    // Contar registros desde SHX
    const nRecords = shx ? (shx.readInt32BE(24)*2 - 100)/8 : "desconocido";

    // Resumen de atributos DBF
    let attrSummary = "";
    if (dbf && dbf.fields.length) {
      attrSummary = `\nAtributos (${dbf.fields.length} campos): ${dbf.fields.map(f => `${f.name}(${f.type})`).join(', ')}`;

      // Stats de campos numéricos
      for (const field of dbf.fields.slice(0, 5)) {
        if (field.type === 'N' || field.type === 'F') {
          const nums = dbf.records
            .map(r => parseFloat(r[field.name]))
            .filter(n => !isNaN(n));
          if (nums.length) {
            const mn  = Math.min(...nums).toFixed(4);
            const mx  = Math.max(...nums).toFixed(4);
            const avg = (nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(4);
            attrSummary += `\n  ${field.name}: min=${mn} max=${mx} promedio=${avg} (${nums.length} valores)`;
          }
        }
      }

      // Primeras 3 filas como muestra
      if (dbf.records.length) {
        attrSummary += `\nMuestra (primeros 3 registros):`;
        dbf.records.slice(0,3).forEach((r,i) => {
          attrSummary += `\n  [${i+1}] ${JSON.stringify(r)}`;
        });
      }
    }

    return `=== SHAPEFILE ===
Tipo de geometría: ${TYPES[shapeType] || shapeType}
Total registros: ${nRecords}
${coordInfo}
${prjText ? `Proyección: ${prjText.slice(0,120)}...` : ""}
${attrSummary}`;

  } catch(e) {
    return `Error parseando shapefile: ${e.message}`;
  }
}

// ── GeoJSON → resumen ─────────────────────────────────────
function parseGeoJSON(text) {
  try {
    const gj = JSON.parse(text);
    const type = gj.type;
    let features = [];

    if (type === 'FeatureCollection') {
      features = gj.features || [];
    } else if (type === 'Feature') {
      features = [gj];
    } else {
      return `GeoJSON tipo "${type}" — sin features individuales.`;
    }

    const geomTypes = {};
    const propKeys  = new Set();
    const numFields = {};

    features.slice(0, 200).forEach(f => {
      const gt = f.geometry?.type || 'null';
      geomTypes[gt] = (geomTypes[gt]||0) + 1;
      if (f.properties) {
        Object.keys(f.properties).forEach(k => {
          propKeys.add(k);
          const v = parseFloat(f.properties[k]);
          if (!isNaN(v)) {
            if (!numFields[k]) numFields[k] = [];
            numFields[k].push(v);
          }
        });
      }
    });

    let summary = `=== GEOJSON ===
Features totales: ${features.length}
Tipos de geometría: ${Object.entries(geomTypes).map(([k,v])=>`${k}(${v})`).join(', ')}
Propiedades: ${[...propKeys].join(', ')}`;

    Object.entries(numFields).slice(0,5).forEach(([k,vals]) => {
      const mn  = Math.min(...vals).toFixed(4);
      const mx  = Math.max(...vals).toFixed(4);
      const avg = (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(4);
      summary += `\n  ${k}: min=${mn} max=${mx} avg=${avg}`;
    });

    // Muestra
    if (features.length) {
      summary += `\nMuestra (primer feature):`;
      summary += `\n  Geometría: ${features[0].geometry?.type}`;
      summary += `\n  Props: ${JSON.stringify(features[0].properties).slice(0,200)}`;
    }

    return summary;
  } catch(e) {
    return `Error parseando GeoJSON: ${e.message}`;
  }
}

// ── CSV → resumen ─────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return "CSV vacío";

  const sep   = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g,'').trim());
  const rows  = lines.slice(1, 201).map(l => l.split(sep).map(v => v.replace(/^"|"$/g,'').trim()));

  // Stats numéricas
  let stats = `=== CSV ===\nColumnas: ${headers.join(', ')}\nFilas totales: ~${lines.length-1}`;
  headers.forEach((h, ci) => {
    const nums = rows.map(r => parseFloat(r[ci])).filter(n => !isNaN(n));
    if (nums.length > rows.length * 0.5) {
      const mn  = Math.min(...nums).toFixed(4);
      const mx  = Math.max(...nums).toFixed(4);
      const avg = (nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(4);
      stats += `\n  ${h}: min=${mn} max=${mx} avg=${avg}`;
    }
  });

  stats += `\nMuestra (primeras 3 filas):`;
  rows.slice(0,3).forEach((r,i) => {
    const obj = Object.fromEntries(headers.map((h,ci) => [h, r[ci]]));
    stats += `\n  [${i+1}] ${JSON.stringify(obj)}`;
  });

  return stats;
}

// ── KML → resumen ─────────────────────────────────────────
function parseKML(text) {
  const placemarks = (text.match(/<Placemark/gi)||[]).length;
  const nameMatch  = text.match(/<name>([^<]+)<\/name>/i);
  const name       = nameMatch ? nameMatch[1] : '(sin nombre)';
  const coords     = text.match(/<coordinates>[\s\S]*?<\/coordinates>/gi)||[];

  let info = `=== KML ===\nNombre: ${name}\nPlacemarks: ${placemarks}\nBloques de coordenadas: ${coords.length}`;

  if (coords.length) {
    const firstCoords = coords[0].replace(/<\/?coordinates>/gi,'').trim().split(/\s+/).slice(0,3);
    info += `\nPrimeras coordenadas: ${firstCoords.join(' | ')}`;
  }
  return info;
}

// ── Determinar tipo y parsear ─────────────────────────────
function parsearArchivo(adj) {
  const { categoria, nombre, base64, texto } = adj;
  const ext = (nombre||'').split('.').pop().toLowerCase();
  // Texto directo o decodificar base64; nunca pasar null a Buffer.from
  let contenido = '';
  if (texto) {
    contenido = texto;
  } else if (base64) {
    try { contenido = Buffer.from(base64, 'base64').toString('utf-8'); } catch {}
  }

  try {
    if (ext === 'geojson' || ext === 'json') return parseGeoJSON(contenido);
    if (ext === 'csv')                        return parseCSV(contenido);
    if (ext === 'kml' || ext === 'kmz')       return parseKML(contenido);
    if (ext === 'txt')                        return `=== TXT: ${nombre} ===\n${contenido.slice(0,2000)}`;
    if (ext === 'dbf' && base64)              return `=== DBF: ${nombre} ===\n${JSON.stringify(parseDBF(Buffer.from(base64,'base64')).fields)}`;
    // SHP solo se procesa cuando viene junto con DBF (ver endpoint)
    return null;
  } catch(e) {
    return `Error procesando ${nombre}: ${e.message}`;
  }
}

// ── Contexto del establecimiento ─────────────────────────
async function getContextoEstab(estabSlug) {
  if (!estabSlug || estabSlug === "null") return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector:{ tipo:"aog_archivo", es_lote:true }, limit:500 });
      docs = r.docs;
    } catch {
      const all = await estabDB.list({ include_docs:true });
      docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo"&&d.es_lote);
    }
    const lotes = {};
    docs.forEach(d => {
      const n = d.lote_nombre||"?";
      if (!lotes[n]) lotes[n] = { nombre:n, archivos:[] };
      lotes[n].archivos.push(d.subtipo);
    });
    return {
      estab:       estabSlug,
      lotes_count: Object.keys(lotes).length,
      lotes:       Object.values(lotes).map(l => ({
        nombre:         l.nombre,
        tiene_sections: l.archivos.includes("sections_coverage"),
        tiene_boundary: l.archivos.includes("boundary")||l.archivos.includes("boundary_kml"),
        tiene_field:    l.archivos.includes("field_origin"),
      })),
    };
  } catch { return null; }
}

async function getDatosLote(estabSlug, loteNombre) {
  if (!estabSlug||!loteNombre) return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector:{ tipo:"aog_archivo", es_lote:true, lote_nombre:loteNombre }, limit:20 });
      docs = r.docs;
    } catch {}
    const { parseLote } = require("../services/aog_parser");
    const parsed = parseLote(docs);

    // Boundary como GeoJSON Polygon (lon/lat) — útil para Sentinel Hub.
    let geometry = null;
    if (parsed.boundary?.length > 2) {
      const ring = parsed.boundary.map(p => [p[1], p[0]]); // [lat,lon] → [lon,lat]
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      geometry = { type: "Polygon", coordinates: [ring] };
    }

    return {
      nombre:         loteNombre,
      tiene_boundary: !!parsed.boundary,
      tiene_origen:   !!parsed.origen,
      pasadas:        parsed.sections?.length || 0,
      geometry,
    };
  } catch { return null; }
}

// Pide stats de TODOS los índices del catálogo a Sentinel Hub para el polígono del lote.
// Devuelve un texto resumen para meter en el prompt.
const INTERPRETACION = {
  ndvi:  "vigor general de la vegetación",
  ndre:  "nitrógeno / clorofila profunda — útil para fertilización variable",
  ndmi:  "humedad foliar — detecta estrés hídrico antes de que se vea a ojo",
  evi:   "vigor sin saturar (mejor que NDVI en cultivos densos como maíz V12+ o soja R5+)",
  msavi: "vigor sin efecto del suelo — útil en cultivos chicos (V1-V4)",
  gndvi: "clorofila / verde — más sensible a estrés temprano que NDVI",
  bsi:   "índice de suelo desnudo — alto = baja cobertura",
};

// Valida un GeoJSON Polygon antes de mandarlo a Sentinel Hub.
// Devuelve null si está OK, o un código de error.
function validarPoligono(geom) {
  if (!geom || geom.type !== "Polygon") return "GEOM_001";  // tipo inválido
  const ring = geom.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return "GEOM_002";  // muy pocos puntos (cerrado)
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return "GEOM_003";  // punto inválido
    const [lon, lat] = p;
    if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon))
      return "GEOM_004";  // NaN
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return "GEOM_005";  // fuera de rango
  }
  // Verificar que esté cerrado (primer = último).
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return "GEOM_006";
  return null;
}

// Pide stats de TODOS los índices a Sentinel Hub.
// Retorno: { texto, error_code, indices_ok }.
// El texto va al prompt SOLO si tiene contenido. Los errores nunca van al prompt.
async function ndviResumen(geometry) {
  if (!geometry) return { texto: null, error_code: "NDVI_NO_GEOM" };

  const errGeom = validarPoligono(geometry);
  if (errGeom) {
    console.warn(`[ERR-${errGeom}] polígono inválido`, JSON.stringify(geometry).slice(0, 300));
    return { texto: null, error_code: errGeom };
  }

  try {
    const ndvi = require("./ndvi");
    const indicesLib = require("../lib/indices_satelitales");
    if (typeof ndvi.statsAPI !== "function") return { texto: null, error_code: "NDVI_NO_LIB" };

    const claves = Object.keys(indicesLib.INDICES);

    // Estrategia: 1ª vuelta con ventana 30 días y nubes <=30%.
    // Si no hay datos, 2ª vuelta con 90 días y nubes <=70% (típicamente en
    // otoño/invierno hay menos imágenes limpias).
    async function intentar(diasAtras, maxCloudCoverage) {
      const hasta = new Date().toISOString().slice(0, 10);
      const desde = new Date(Date.now() - diasAtras * 86400000).toISOString().slice(0, 10);
      return Promise.all(claves.map(async clave => {
        try {
          const data = await ndvi.statsAPI({ geometry, desde, hasta, indice: clave, maxCloudCoverage });
          // Buscamos el último intervalo con datos. La estructura SH:
          // data.data[i].outputs.data.bands.<clave>.stats = { min, max, mean, stDev }
          const intervalos = (data.data || []).filter(d => d.outputs?.data?.bands?.[clave]?.stats);
          const ult = intervalos[intervalos.length - 1];
          if (!ult) {
            // Log para diagnosticar respuestas vacías o inesperadas.
            if (data.data?.length === 0) {
              console.log(`[NDVI ${clave}] respuesta sin intervalos`);
            } else if (data.data?.[0]) {
              console.log(`[NDVI ${clave}] estructura inesperada:`, JSON.stringify(data.data[0]).slice(0, 400));
            }
            return { clave, mean: null };
          }
          const stats = ult.outputs.data.bands[clave].stats;
          return {
            clave,
            fecha: ult.interval?.from?.slice(0, 10),
            mean:  stats.mean,
            min:   stats.min,
            max:   stats.max,
            stDev: stats.stDev,
            ventana: `${diasAtras}d/${maxCloudCoverage}%nubes`,
          };
        } catch (e) {
          const code = e.status === 400 ? "NDVI_BAD_REQUEST" : e.status === 401 ? "NDVI_AUTH" : "NDVI_API";
          console.warn(`[ERR-${code}] ${clave} (${diasAtras}d): ${e.message?.slice(0, 200)}`);
          return { clave, mean: null };
        }
      }));
    }

    let resultados = await intentar(30, 30);
    let conDatos = resultados.filter(r => r.mean != null);

    if (!conDatos.length) {
      console.log("[NDVI] sin datos en 30d/30%, reintentando con 90d/70%…");
      resultados = await intentar(90, 70);
      conDatos = resultados.filter(r => r.mean != null);
    }

    if (!conDatos.length) {
      // Sin datos en toda la ventana extendida — info, no error grave.
      const meta = JSON.stringify(geometry).slice(0, 300);
      console.log(`[INFO-NDVI_SIN_IMAGEN] polígono sin imagen útil en 90d. Geometría: ${meta}`);
      return { texto: null, error_code: "NDVI_SIN_IMAGEN", indices_ok: 0 };
    }

    const lineas = [];
    for (const r of resultados) {
      if (r.mean == null) continue;  // omitimos los que fallaron
      const meta = indicesLib.INDICES[r.clave];
      const nom  = (meta?.nombre || r.clave).padEnd(6);
      lineas.push(`${nom} medio ${r.mean.toFixed(3)} · rango ${r.min?.toFixed(2)}…${r.max?.toFixed(2)} · σ=${r.stDev?.toFixed(3)} · ${INTERPRETACION[r.clave] || ""}${r.fecha ? ` (${r.fecha})` : ""}`);
    }

    return { texto: lineas.join("\n"), error_code: null, indices_ok: conDatos.length };
  } catch (e) {
    console.warn(`[ERR-NDVI_FATAL] ${e.message}`);
    return { texto: null, error_code: "NDVI_FATAL" };
  }
}

async function getDatosVistaX(estabSlug, loteId) {
  if (!estabSlug||!loteId) return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector:{ tipo:"vistax_archivo", lote_id:loteId }, limit:10 });
      docs = r.docs;
    } catch {}
    const meta = docs.find(d=>d.subtipo==="vistax_meta");
    if (!meta) return null;
    let m = {};
    try { m = JSON.parse(meta.contenido); } catch {}
    return { lote_id:loteId, nombre:m.nombre, cultivo:m.cultivo, totalSemillas:m.totalSemillas, duracionMin:m.duracionMin, densidad_obj:m.densidadObjetivo };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/chat
// ══════════════════════════════════════════════════════════
router.post("/chat", async (req, res) => {
  const { mensaje = "", historial = [], adjuntos = [], sesionId: sesionIdIn } = req.body;
  if (!mensaje && !adjuntos.length)
    return res.status(400).json({ error: "mensaje o adjunto requerido" });

  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const contexto  = await getContextoEstab(estabSlug);

    let system = SYSTEM_BASE;
    if (contexto) {
      system += `\n\nContexto del establecimiento "${estabSlug}":
- Lotes sincronizados: ${contexto.lotes_count}
- Lotes: ${contexto.lotes.map(l=>l.nombre+(l.tiene_sections?" (con cobertura)":"")).join(", ")}`;
    }

    // ── Armar mensajes ──
    const messages = [
      ...historial.slice(-10).map(h => ({ role:h.rol, content:h.texto })),
    ];

    const contentBlocks = [];
    const textosExtra   = [];
    const audiosNombres = [];

    // ── Procesar adjuntos por tipo ──
    // Agrupar SHP+DBF+SHX+PRJ del mismo lote
    const shpGroup = {};
    const restantes = [];

    for (const adj of adjuntos) {
      const ext = (adj.nombre||'').split('.').pop().toLowerCase();
      const base = adj.nombre.replace(/\.[^.]+$/, '');
      if (['shp','dbf','shx','prj'].includes(ext)) {
        if (!shpGroup[base]) shpGroup[base] = {};
        shpGroup[base][ext] = adj;
      } else {
        restantes.push(adj);
      }
    }

    // Procesar grupos SHP
    for (const [base, grp] of Object.entries(shpGroup)) {
      if (grp.shp && grp.shp.base64) {
        // SHP es binario → siempre base64; DBF/SHX también binarios
        const shxData = grp.shx?.base64 || null;
        const dbfData = grp.dbf?.base64 || null;
        // PRJ es texto plano — puede llegar como texto directo o base64
        const prjText = grp.prj
          ? (grp.prj.texto || (grp.prj.base64 ? Buffer.from(grp.prj.base64,'base64').toString('utf-8') : null))
          : null;
        const resumen = parseShapefile(grp.shp.base64, shxData, dbfData, prjText);
        textosExtra.push(resumen);
      } else if (grp.dbf && grp.dbf.base64) {
        // DBF solo sin SHP
        try {
          const parsed = parseDBF(Buffer.from(grp.dbf.base64,'base64'));
          textosExtra.push(`=== DBF: ${base}.dbf ===\nCampos: ${parsed.fields.map(f=>f.name).join(', ')}\nRegistros: ${parsed.numRecords}`);
        } catch(e) { console.error('[agrarIA/dbf]', e.message); }
      }
    }

    // Procesar resto
    for (const adj of restantes) {
      const ext = (adj.nombre||'').split('.').pop().toLowerCase();

      if (adj.categoria === 'imagen') {
        const mt = adj.mediaType?.includes('png')  ? 'image/png'
                 : adj.mediaType?.includes('gif')  ? 'image/gif'
                 : adj.mediaType?.includes('webp') ? 'image/webp'
                 : 'image/jpeg';
        contentBlocks.push({ type:"image", source:{ type:"base64", media_type:mt, data:adj.base64 }});
        continue;
      }

      if (adj.categoria === 'pdf') {
        contentBlocks.push({ type:"document", source:{ type:"base64", media_type:"application/pdf", data:adj.base64 }, title:adj.nombre });
        continue;
      }

      if (adj.categoria === 'audio') {
        audiosNombres.push(adj.nombre);
        continue;
      }

      // Geoespaciales y datos (texto)
      const resumen = parsearArchivo(adj);
      if (resumen) textosExtra.push(resumen);
    }

    // ── Armar texto final ──
    let textoFinal = mensaje || "";

    if (textosExtra.length) {
      textoFinal += textoFinal ? "\n\n" : "";
      textoFinal += "Archivos adjuntos para analizar:\n\n" + textosExtra.join("\n\n");
    }

    if (audiosNombres.length) {
      textoFinal += `\n\n[Nota: recibí ${audiosNombres.length} archivo(s) de audio (${audiosNombres.join(', ')}) pero no puedo procesarlos directamente. Indicale al usuario que transcriba el audio y pegue el texto.]`;
    }

    // Sin texto pero con imagen → prompt implícito
    if (!textoFinal && contentBlocks.length) {
      textoFinal = "Analizá lo que te mandé desde el punto de vista agronómico.";
    }

    if (textoFinal) contentBlocks.push({ type:"text", text:textoFinal });

    messages.push({
      role:    "user",
      content: contentBlocks.length === 1 && contentBlocks[0].type === "text"
        ? contentBlocks[0].text
        : contentBlocks,
    });

    const respuesta = await callClaude(system, messages, 1000);

    // Persistir la sesión en CouchDB (no bloqueante si falla).
    let sesionId = sesionIdIn;
    let titulo   = null;
    try {
      const uid = req.user?.uid ? `usr_${req.user.uid}` : null;
      if (uid) {
        if (!sesionId) sesionId = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
        const doc = await appendMensaje(uid, sesionId, estabSlug, textoFinal || mensaje, respuesta);
        titulo = doc.titulo;
      }
    } catch (e) {
      console.warn("[agrarIA/chat] no se pudo persistir:", e.message);
    }

    res.json({ respuesta, sesionId, titulo });

  } catch(e) {
    console.error("[agrarIA/chat]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/agraria/chat/sesiones — lista del usuario actual.
// ══════════════════════════════════════════════════════════
router.get("/chat/sesiones", async (req, res) => {
  try {
    const uid = req.user?.uid ? `usr_${req.user.uid}` : null;
    if (!uid) return res.status(401).json({ error: "Auth requerida" });
    const sesiones = await listSesiones(uid);
    res.json({ sesiones });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/agraria/chat/sesion/:id — recuperar conversación completa.
// ══════════════════════════════════════════════════════════
router.get("/chat/sesion/:id", async (req, res) => {
  try {
    const uid = req.user?.uid ? `usr_${req.user.uid}` : null;
    if (!uid) return res.status(401).json({ error: "Auth requerida" });
    const doc = await getSesion(uid, req.params.id);
    if (!doc) return res.status(404).json({ error: "Sesión no encontrada" });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/agraria/chat/sesion/:id — borrar una conversación.
// ══════════════════════════════════════════════════════════
router.delete("/chat/sesion/:id", async (req, res) => {
  try {
    const uid = req.user?.uid ? `usr_${req.user.uid}` : null;
    if (!uid) return res.status(401).json({ error: "Auth requerida" });
    const doc = await getSesion(uid, req.params.id);
    if (!doc) return res.status(404).json({ error: "Sesión no encontrada" });
    const gdb = db.getDB("global");
    await gdb.destroy(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  Resto de endpoints (sin cambios)
// ══════════════════════════════════════════════════════════
router.post("/analizar-lote", async (req, res) => {
  const { lote_nombre } = req.body;
  if (!lote_nombre) return res.status(400).json({ error: "lote_nombre requerido" });
  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const datos     = await getDatosLote(estabSlug, lote_nombre);
    if (!datos) return res.status(404).json({ error: "Lote no encontrado" });

    // Pedir stats Sentinel Hub si tenemos polígono — no bloqueante si falla.
    let sat = { texto: null, error_code: null };
    if (datos.geometry) sat = await ndviResumen(datos.geometry);

    const partes = [
      `Analizá este lote del establecimiento "${estabSlug}":`,
      `Nombre: ${datos.nombre}`,
      `Boundary: ${datos.tiene_boundary ? "Sí" : "No"}`,
      `GPS: ${datos.tiene_origen ? "Sí" : "No"}`,
      `Pasadas registradas: ${datos.pasadas}`,
    ];

    // Solo agregamos info satelital si la tenemos. Si falló, NO mencionamos nada
    // al modelo — los códigos de error van al cliente vía response, no al prompt.
    if (sat.texto) {
      partes.push("");
      partes.push("Datos satelitales Sentinel-2 (últimos 30 días, imagen con menor nubosidad):");
      partes.push(sat.texto);
      partes.push("");
      partes.push("Cómo interpretar los índices:");
      partes.push("- NDVI <0.3 = baja biomasa; 0.3–0.6 cultivo en desarrollo; >0.6 vigoroso.");
      partes.push("- NDRE bajo con NDVI alto = posible deficiencia de N.");
      partes.push("- NDMI <0 = estrés hídrico; >0.2 = humedad foliar OK.");
      partes.push("- EVI complementa NDVI en cultivos densos. MSAVI es mejor en cultivos chicos.");
      partes.push("- GNDVI más sensible a estrés temprano que NDVI.");
      partes.push("- BSI alto (>0.2) = suelo desnudo dominante; <0 = buena cobertura.");
      partes.push("Cruces útiles: NDVI vs NDRE para N · NDVI vs NDMI para diferenciar estrés hídrico de enfermedad.");
      partes.push("Hacé el análisis con estos números reales del lote y proponé acciones concretas.");
    }
    // IMPORTANTE: si no hay sat data, NO le decimos al modelo nada de errores.
    // Que analice con la info AOG que tenga; si es muy poca, que lo diga sin
    // inventar problemas técnicos.

    const prompt = partes.join("\n");
    const analisis = await callClaude(SYSTEM_BASE, [{ role: "user", content: prompt }], 700);
    res.json({
      analisis,
      datos:      { ...datos, geometry: undefined },
      sat:        !!sat.texto,
      sat_error:  sat.error_code || null,
      indices_ok: sat.indices_ok || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/analizar-vistax", async (req, res) => {
  const { lote_id } = req.body;
  if (!lote_id) return res.status(400).json({ error:"lote_id requerido" });
  try {
    const estabSlug = req.user?.estabSlug||req.jwtUser?.estabSlug;
    const datos     = await getDatosVistaX(estabSlug, lote_id);
    if (!datos) return res.status(404).json({ error:"Lote VistaX no encontrado" });
    const durHs = datos.duracionMin ? (datos.duracionMin/60).toFixed(1) : "desconocida";
    const prompt = `Analizá este lote VistaX:\nLote: ${datos.nombre||lote_id}\nCultivo: ${datos.cultivo||"no especificado"}\nSemillas: ${datos.totalSemillas?.toLocaleString("es-AR")||"N/D"}\nDuración: ${durHs}hs\n${datos.densidad_obj?`Densidad obj: ${datos.densidad_obj} sem/ha`:""}\nDá 2-3 recomendaciones.`;
    const analisis = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 600);
    res.json({ analisis, datos });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post("/comparar-lotes", async (req, res) => {
  const { lote_a, lote_b } = req.body;
  if (!lote_a||!lote_b) return res.status(400).json({ error:"lote_a y lote_b requeridos" });
  try {
    const estabSlug = req.user?.estabSlug||req.jwtUser?.estabSlug;
    const [dA,dB]  = await Promise.all([getDatosLote(estabSlug,lote_a), getDatosLote(estabSlug,lote_b)]);
    const prompt = `Comparé estos lotes:\nA: ${lote_a} — pasadas:${dA?.pasadas||0}, boundary:${dA?.tiene_boundary?"Sí":"No"}, GPS:${dA?.tiene_origen?"Sí":"No"}\nB: ${lote_b} — pasadas:${dB?.pasadas||0}, boundary:${dB?.tiene_boundary?"Sí":"No"}, GPS:${dB?.tiene_origen?"Sí":"No"}\n¿Cuál tiene mejor cobertura?`;
    const analisis = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 500);
    res.json({ analisis, lote_a:dA, lote_b:dB });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post("/resumen-dia", async (req, res) => {
  try {
    const estabSlug = req.user?.estabSlug||req.jwtUser?.estabSlug;
    if (!estabSlug) return res.status(400).json({ error:"Sin establecimiento activo" });
    const contexto = await getContextoEstab(estabSlug);
    const hoy      = new Date().toLocaleDateString("es-AR",{ weekday:"long", day:"2-digit", month:"long" });
    let alertasCount = 0;
    try {
      const r = await db.getDB(estabSlug).find({ selector:{ tipo:"alerta", resuelta:{ $ne:true } }, limit:100 });
      alertasCount = r.docs.length;
    } catch {}
    const prompt = `Resumen del día ${hoy} para "${estabSlug}":\n- Lotes: ${contexto?.lotes_count||0}\n- Con cobertura: ${contexto?.lotes.filter(l=>l.tiene_sections).length||0}\n- Alertas: ${alertasCount}\nMáximo 4 oraciones para el dueño del campo.`;
    const resumen = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 400);
    res.json({ resumen, fecha:hoy, alertas:alertasCount, lotes:contexto?.lotes_count||0 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

module.exports = router;
