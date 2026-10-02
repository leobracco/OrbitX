// CouchDB mínimo en memoria con la misma forma que nano (get/insert/find)
// para testear lib/ sin servidor.
export function fakeDb(docs = []) {
  const m = new Map(docs.map(d => [d._id, { ...d, _rev: d._rev || "1-a" }]));
  let n = 1;
  return {
    _m: m,
    async get(id) {
      if (!m.has(id)) { const e = new Error("missing"); e.statusCode = 404; throw e; }
      return structuredClone(m.get(id));
    },
    async insert(doc) {
      const actual = m.get(doc._id);
      if (actual && actual._rev !== doc._rev) { const e = new Error("conflict"); e.statusCode = 409; throw e; }
      const nuevo = { ...structuredClone(doc), _rev: `${++n}-x` };
      m.set(doc._id, nuevo);
      return { ok: true, id: doc._id, rev: nuevo._rev };
    },
    async find({ selector }) {
      const ok = d => Object.entries(selector).every(([k, v]) => d[k] === v);
      return { docs: [...m.values()].filter(ok).map(d => structuredClone(d)) };
    },
  };
}
