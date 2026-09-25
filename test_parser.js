const nano = require('nano')('http://admin:1564Santiago@127.0.0.1:5984');
const db = nano.db.use('orbitx_el_susto');
db.find({ selector:{ tipo:'aog_archivo', lote_nombre:'La Paloma' }, limit:20 })
  .then(r => {
    const { parseLote } = require('/opt/AgroParallel/OrbitX/services/aog_parser');
    const parsed = parseLote(r.docs);
    console.log('origen:', JSON.stringify(parsed.origen));
    console.log('boundary pts:', parsed.boundary?.length);
    console.log('sections:', parsed.sections?.length);
    const sec = r.docs.find(d => d.subtipo === 'sections_coverage');
    console.log('sections_coverage en DB:', !!sec);
    console.log('contenido primeras 100 chars:', sec?.contenido?.slice(0,100));
  })
  .catch(e => console.error(e.message));
