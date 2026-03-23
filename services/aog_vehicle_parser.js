// services/aog_vehicle_parser.js
// Parsea los XML de configuración de AgOpenGPS (Vehicles/*.XML)
// Formato real: <setting name="setVehicle_wheelbase"><value>3.3</value>

function parseVehicleXML(contenido) {
  if (!contenido) return null;
  try {
    const result = {};

    // Formato principal AOG: <setting name="KEY"><value>VAL</value>
    const settingRe = /<setting name="([^"]+)"[^>]*>\s*<value>([^<]*)<\/value>/g;
    let m;
    while ((m = settingRe.exec(contenido)) !== null) {
      const key = m[1].trim();
      const raw = m[2].trim();
      result[key] = isNaN(raw) || raw === "" ? raw : parseFloat(raw);
    }

    // Formato alternativo: atributos directos <vehicle wheelbase="3.2" .../>
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    while ((m = attrRe.exec(contenido)) !== null) {
      const key = m[1];
      const val = m[2];
      if (["xmlns","type","name","version","serializeAs"].includes(key)) continue;
      if (!result[key]) result[key] = isNaN(val) || val === "" ? val : parseFloat(val);
    }

    return result;
  } catch(e) { return { _error: e.message }; }
}

// Mapeo: setting name → label legible + grupo
const CAMPOS = [
  { grupo:"Vehículo", campos:[
    { keys:["setVehicle_wheelbase","wheelbase","WheelBase"],         label:"Distancia entre ejes",    unidad:"m" },
    { keys:["setVehicle_trackWidth","trackWidth","TrackWidth"],       label:"Ancho de trocha",         unidad:"m" },
    { keys:["setVehicle_antennaHeight","antennaHeight"],              label:"Altura de antena",        unidad:"m" },
    { keys:["setVehicle_antennaPivot","antennaPivot"],                label:"Antena → pivot",          unidad:"m" },
    { keys:["setVehicle_antennaOffset","antennaOffset"],              label:"Offset antena",           unidad:"m" },
    { keys:["setVehicle_hitchLength","hitchLength"],                  label:"Largo del enganche",      unidad:"m" },
    { keys:["setVehicle_maxSteerAngle","maxSteerAngle"],              label:"Ángulo máx. dirección",   unidad:"°" },
    { keys:["setVehicle_maxAngularVelocity"],                         label:"Velocidad angular máx.",  unidad:"rad/s" },
    { keys:["setVehicle_slowSpeedCutoff"],                            label:"Vel. mínima autosteer",   unidad:"km/h" },
    { keys:["setVehicle_panicStopSpeed"],                             label:"Vel. parada de pánico",   unidad:"km/h" },
  ]},
  { grupo:"Dirección / Autosteer", campos:[
    { keys:["setAS_Kp","Kp","kp"],                                    label:"Kp (proporcional)",       unidad:"" },
    { keys:["setAS_ackerman","ackermanFix"],                          label:"Corrección Ackermann",    unidad:"%" },
    { keys:["setAS_countsPerDegree"],                                 label:"Cuentas por grado (WAS)", unidad:"" },
    { keys:["setAS_wasOffset"],                                       label:"Offset WAS",              unidad:"" },
    { keys:["setAS_lowSteerPWM","setAS_minSteerPWM"],                 label:"PWM mínimo steer",        unidad:"" },
    { keys:["setAS_highSteerPWM"],                                    label:"PWM máximo steer",        unidad:"" },
    { keys:["setAS_guidanceLookAheadTime"],                           label:"Look Ahead guidance",     unidad:"s" },
    { keys:["setVehicle_goalPointLookAheadMult"],                     label:"Look Ahead multiplicador",unidad:"" },
    { keys:["setArdSteer_maxPulseCounts"],                            label:"Pulsos máx. Ardsteer",    unidad:"" },
  ]},
  { grupo:"Herramienta / Sembradora", campos:[
    { keys:["setVehicle_toolWidth","toolWidth"],                      label:"Ancho de trabajo",        unidad:"m" },
    { keys:["setVehicle_toolOffset","toolOffset"],                    label:"Offset herramienta",      unidad:"m" },
    { keys:["setVehicle_toolOverlap","toolOverlap"],                  label:"Solapamiento",            unidad:"m" },
    { keys:["setVehicle_numSections","numSections"],                  label:"Número de secciones",     unidad:"" },
    { keys:["setTool_toolTrailingHitchLength"],                       label:"Largo enganche remolque", unidad:"m" },
    { keys:["setTool_defaultSectionWidth"],                           label:"Ancho secc. por defecto", unidad:"m" },
    { keys:["setTool_numSectionsMulti"],                              label:"Secciones múltiples",     unidad:"" },
    { keys:["setVehicle_hydraulicLiftLookAhead"],                     label:"Look Ahead hidráulico",   unidad:"m" },
  ]},
  { grupo:"IMU / GPS", campos:[
    { keys:["setIMU_rollZero"],                                       label:"Roll cero IMU",           unidad:"" },
    { keys:["setGPS_dualHeadingOffset"],                              label:"Offset heading dual GPS", unidad:"°" },
    { keys:["setVehicle_vehicleType"],                                label:"Tipo de vehículo",        unidad:"" },
  ]},
  { grupo:"Campo activo", campos:[
    { keys:["setF_CurrentDir"],                                       label:"Último lote usado",       unidad:"" },
    { keys:["setF_UserTotalArea"],                                    label:"Área total trabajada",    unidad:"m²" },
    { keys:["setTram_tramWidth"],                                     label:"Ancho tramline",          unidad:"m" },
  ]},
];

function formatearVehiculo(raw) {
  if (!raw) return [];
  const grupos = [];

  for (const g of CAMPOS) {
    const filas = [];
    for (const campo of g.campos) {
      let val = null, foundKey = null;
      for (const key of campo.keys) {
        const found = Object.keys(raw).find(k => k.toLowerCase() === key.toLowerCase());
        if (found && raw[found] !== null && raw[found] !== undefined && raw[found] !== "") {
          val = raw[found]; foundKey = found; break;
        }
      }
      if (val !== null) {
        let display = val;
        if (foundKey === "setF_UserTotalArea") display = (val/10000).toFixed(2) + " ha";
        filas.push({ label:campo.label, valor:display, unidad:campo.unidad });
      }
    }
    if (filas.length) grupos.push({ grupo:g.grupo, filas });
  }

  // Parámetros no mapeados relevantes (excluir los de display/color/window)
  const mapeados = new Set(CAMPOS.flatMap(g => g.campos.flatMap(c => c.keys.map(k=>k.toLowerCase()))));
  const ignorar  = /^set(window|display|color|sound|menu|tram_color|bnd_|section_position|section_is|tram_|ardsteer_setting)/i;
  const otros = Object.entries(raw).filter(([k,v]) =>
    !mapeados.has(k.toLowerCase()) &&
    !k.startsWith("_") &&
    !ignorar.test(k) &&
    v !== null && v !== undefined && v !== "" && v !== "False" && v !== "True"
  ).map(([k,v]) => ({ label:k.replace(/^set[A-Z_]+_/,""), valor:v, unidad:"" }));

  if (otros.length) grupos.push({ grupo:"Otros parámetros", filas:otros });
  return grupos;
}

// Extraer nombre del vehículo desde el nombre del archivo o contenido
function extraerNombreVehiculo(raw, nombreArchivo) {
  // AOG guarda el nombre en el nombre del archivo: "cr 6080.XML" → "CR 6080"
  if (nombreArchivo) {
    return nombreArchivo.replace(/\.XML$/i,"").replace(/\.xml$/i,"").trim();
  }
  return raw?.name || raw?.Name || "Vehículo";
}

module.exports = { parseVehicleXML, formatearVehiculo, extraerNombreVehiculo };
