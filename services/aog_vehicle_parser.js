// services/aog_vehicle_parser.js
// Parsea vehicle.xml / cr 6080.XML de AgOpenGPS sin dependencias externas

function parseVehicleXML(contenido) {
  if (!contenido) return null;
  try {
    // Extraer todos los atributos y elementos del XML con regex
    // AOG guarda la config como atributos: <vehicle wheelbase="3.2" trackWidth="2.0" .../>
    // o como elementos: <wheelbase>3.2</wheelbase>
    const result = {};

    // Atributos en cualquier tag: name="value"
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(contenido)) !== null) {
      const key = m[1];
      const val = m[2];
      if (key === "xmlns" || key.startsWith("xmlns:") || key === "xsi:noNamespaceSchemaLocation") continue;
      result[key] = isNaN(val) || val === "" ? val : parseFloat(val);
    }

    // Elementos simples: <key>value</key>
    const elemRe = /<(\w+)>([^<]+)<\/\1>/g;
    while ((m = elemRe.exec(contenido)) !== null) {
      const key = m[1];
      const val = m[2].trim();
      if (!result[key]) result[key] = isNaN(val) || val === "" ? val : parseFloat(val);
    }

    return result;
  } catch(e) {
    return { _error: e.message };
  }
}

// Mapea los campos crudos del XML a etiquetas legibles
const CAMPOS = [
  // Geometría del vehículo
  { grupo:"Vehículo", campos:[
    { keys:["wheelbase","WheelBase"],           label:"Distancia entre ejes",    unidad:"m"  },
    { keys:["trackWidth","TrackWidth","track"],  label:"Ancho de trocha",         unidad:"m"  },
    { keys:["antennaHeight","AntennaHeight"],    label:"Altura de antena",        unidad:"m"  },
    { keys:["antennaPivot","AntennaPivot"],      label:"Antena → pivot",          unidad:"m"  },
    { keys:["antennaOffset","AntennaOffset"],    label:"Offset antena",           unidad:"m"  },
    { keys:["hitchLength","HitchLength"],        label:"Largo del enganche",      unidad:"m"  },
  ]},
  // Dirección
  { grupo:"Dirección / Autosteer", campos:[
    { keys:["maxSteerAngle","MaxSteerAngle"],    label:"Ángulo máx. dirección",   unidad:"°"  },
    { keys:["minTurningRadius","MinRadius"],     label:"Radio mínimo de giro",    unidad:"m"  },
    { keys:["ackermanFix","AckermanFix"],        label:"Corrección Ackermann",    unidad:"%"  },
    { keys:["steerRatio","SteerRatio"],          label:"Relación de dirección",   unidad:""   },
  ]},
  // Herramienta
  { grupo:"Herramienta / Sembradora", campos:[
    { keys:["toolWidth","ToolWidth"],            label:"Ancho de trabajo",        unidad:"m"  },
    { keys:["toolOffset","ToolOffset"],          label:"Offset herramienta",      unidad:"m"  },
    { keys:["toolOverlap","ToolOverlap"],        label:"Solapamiento",            unidad:"m"  },
    { keys:["numSections","NumSections"],        label:"Número de secciones",     unidad:""   },
    { keys:["lookAhead","LookAhead"],            label:"Look Ahead",              unidad:"m"  },
  ]},
  // PID
  { grupo:"Ganancias PID", campos:[
    { keys:["Kp","kp","gainP"],                  label:"Kp (proporcional)",       unidad:""   },
    { keys:["Ki","ki","gainI"],                  label:"Ki (integral)",           unidad:""   },
    { keys:["Kd","kd","gainD"],                  label:"Kd (derivativo)",         unidad:""   },
    { keys:["lowPass","LowPass"],                label:"Low Pass Filter",         unidad:""   },
    { keys:["minPWM","MinPWM"],                  label:"PWM mínimo",              unidad:""   },
    { keys:["highPWM","HighPWM"],                label:"PWM máximo",              unidad:""   },
  ]},
];

function formatearVehiculo(raw) {
  if (!raw) return [];
  const grupos = [];
  for (const g of CAMPOS) {
    const filas = [];
    for (const campo of g.campos) {
      let val = null;
      for (const key of campo.keys) {
        // buscar insensitive
        const found = Object.keys(raw).find(k => k.toLowerCase() === key.toLowerCase());
        if (found && raw[found] !== null && raw[found] !== undefined && raw[found] !== "") {
          val = raw[found];
          break;
        }
      }
      if (val !== null) {
        filas.push({ label:campo.label, valor:val, unidad:campo.unidad });
      }
    }
    if (filas.length) grupos.push({ grupo:g.grupo, filas });
  }

  // Campos no mapeados (mostrar el resto)
  const mapeados = new Set(CAMPOS.flatMap(g => g.campos.flatMap(c => c.keys.map(k=>k.toLowerCase()))));
  const otros = Object.entries(raw).filter(([k,v]) =>
    !mapeados.has(k.toLowerCase()) &&
    !k.startsWith("_") &&
    v !== null && v !== undefined && v !== ""
  ).map(([k,v]) => ({ label:k, valor:v, unidad:"" }));

  if (otros.length) grupos.push({ grupo:"Otros parámetros", filas:otros });

  return grupos;
}

module.exports = { parseVehicleXML, formatearVehiculo };
