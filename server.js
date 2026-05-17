// ========================================================
//  SISTEMA DE FACTURACIÓN - SERVIDOR
//  v3 - Código de barras, traducciones, AM/PM, listo para Render
// ========================================================
const express = require('express');
const PDFDocument = require('pdfkit');
const Database = require("better-sqlite3");
const db = new Database("sistema_facturas.db");
const { open } = require('sqlite');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
//  TRADUCCIONES (PDF)
// ---------------------------------------------------------
const TR = {
  es: { factura:'FACTURA', numero:'N°', facturarA:'FACTURAR A', fecha:'FECHA',
    moneda:'MONEDA DE PAGO', monedaXG:'Florines (XG)', monedaUSD:'Dólares (USD)',
    descripcion:'DESCRIPCIÓN', cantidad:'CANT.', precio:'PRECIO', subtotal:'SUBTOTAL',
    totalPagar:'TOTAL A PAGAR', equivalente:'Equivalente',
    totalItems:'Total de ítems', cantidadTotal:'Cantidad total',
    notas:'NOTAS', codigo:'Cód', cliente:'Cliente',
    telefono:'Tel', email:'Email', direccion:'Dir',
    gracias:'¡Gracias por su preferencia!', generado:'Documento generado el',
    sinDescripcion:'(sin descripción)' },
  en: { factura:'INVOICE', numero:'N°', facturarA:'BILL TO', fecha:'DATE',
    moneda:'PAYMENT CURRENCY', monedaXG:'Florins (XG)', monedaUSD:'Dollars (USD)',
    descripcion:'DESCRIPTION', cantidad:'QTY', precio:'PRICE', subtotal:'SUBTOTAL',
    totalPagar:'TOTAL DUE', equivalente:'Equivalent',
    totalItems:'Total items', cantidadTotal:'Total quantity',
    notas:'NOTES', codigo:'Code', cliente:'Customer',
    telefono:'Phone', email:'Email', direccion:'Address',
    gracias:'Thank you for your business!', generado:'Document generated on',
    sinDescripcion:'(no description)' },
  nl: { factura:'FACTUUR', numero:'Nr.', facturarA:'FACTUREREN AAN', fecha:'DATUM',
    moneda:'BETAALMUNT', monedaXG:'Florijnen (XG)', monedaUSD:'Dollars (USD)',
    descripcion:'OMSCHRIJVING', cantidad:'AANT.', precio:'PRIJS', subtotal:'SUBTOTAAL',
    totalPagar:'TE BETALEN', equivalente:'Gelijkwaardig',
    totalItems:'Totaal artikelen', cantidadTotal:'Totale hoeveelheid',
    notas:'OPMERKINGEN', codigo:'Code', cliente:'Klant',
    telefono:'Tel', email:'Email', direccion:'Adres',
    gracias:'Bedankt voor uw bestelling!', generado:'Document gegenereerd op',
    sinDescripcion:'(geen omschrijving)' },
  pap: { factura:'FAKTURA', numero:'No.', facturarA:'FAKTURÁ NA', fecha:'FECHA',
    moneda:'MONEDA DI PAGO', monedaXG:'Florin (XG)', monedaUSD:'Dòler (USD)',
    descripcion:'DESKRIPSHON', cantidad:'KANT.', precio:'PRESIO', subtotal:'SUBTOTAL',
    totalPagar:'TOTAL PA PAGA', equivalente:'Ekivalente',
    totalItems:'Total di artíkulo', cantidadTotal:'Kantidat total',
    notas:'NOTANAN', codigo:'Kódigo', cliente:'Kliente',
    telefono:'Telefon', email:'Email', direccion:'Direkshon',
    gracias:'Danki pa bo prefershi!', generado:'Dokumento generá riba',
    sinDescripcion:'(sin deskripshon)' }
};

// Formato AM/PM
function fechaAMPM(d) {
  d = d || new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${h}:${m} ${ampm}`;
}

// ---------------------------------------------------------
//  BASE DE DATOS
// ---------------------------------------------------------
let db;
(async () => {
  try {
    db = await open({ filename: './sistema_facturas.db', driver: sqlite3.Database });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS productos (
        id TEXT PRIMARY KEY,
        descripcion TEXT,
        precio REAL,
        codigo_barra TEXT
      );
      CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT UNIQUE,
        telefono TEXT,
        email TEXT,
        direccion TEXT
      );
      CREATE TABLE IF NOT EXISTS facturas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        numero TEXT,
        cliente_id INTEGER,
        cliente_nombre TEXT,
        fecha TEXT,
        total_xg REAL,
        total_usd REAL,
        tasa_cambio REAL,
        moneda TEXT,
        idioma TEXT,
        notas TEXT,
        detalles TEXT
      );
      CREATE TABLE IF NOT EXISTS config (
        clave TEXT PRIMARY KEY,
        valor TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prod_barra ON productos(codigo_barra);
    `);

    // Migraciones suaves
    const safeAlter = async (sql) => { try { await db.exec(sql); } catch (e) {} };
    await safeAlter("ALTER TABLE productos ADD COLUMN codigo_barra TEXT");
    await safeAlter("ALTER TABLE clientes ADD COLUMN direccion TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN numero TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN cliente_nombre TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN tasa_cambio REAL");
    await safeAlter("ALTER TABLE facturas ADD COLUMN moneda TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN idioma TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN notas TEXT");

    const defaults = {
      empresa_nombre: 'Mi Empresa',
      empresa_subtitulo: 'Productos y servicios de calidad',
      empresa_contacto: 'Tel: --- | Email: ---',
      empresa_direccion: '',
      tasa_cambio: '1.82',
      idioma_default: 'es'
    };
    for (const [k, v] of Object.entries(defaults)) {
      await db.run("INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)", [k, v]);
    }

    console.log("-> Base de datos lista.");
  } catch (err) {
    console.error("Error inicializando base de datos:", err);
  }
})();

// ---------------------------------------------------------
//  CONFIGURACIÓN
// ---------------------------------------------------------
async function getConfig() {
  const rows = await db.all("SELECT clave, valor FROM config");
  const obj = {};
  rows.forEach(r => obj[r.clave] = r.valor);
  obj.tasa_cambio = parseFloat(obj.tasa_cambio) || 1.82;
  return obj;
}

app.get('/api/config', async (req, res) => res.json(await getConfig()));

app.post('/api/config', async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    await db.run("INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)", [k, String(v)]);
  }
  res.json({ success: true });
});

// ---------------------------------------------------------
//  PRODUCTOS  (con código de barras)
// ---------------------------------------------------------
app.get('/api/productos', async (req, res) => {
  res.json(await db.all("SELECT * FROM productos ORDER BY id"));
});

// Búsqueda exacta por id o código de barras (para escáner)
app.get('/api/producto/:item', async (req, res) => {
  const t = req.params.item;
  let p = await db.get("SELECT * FROM productos WHERE id = ?", t);
  if (!p) p = await db.get("SELECT * FROM productos WHERE codigo_barra = ?", t);
  if (p) res.json({ encontrado: true, ...p });
  else res.json({ encontrado: false });
});

// Búsqueda inteligente (LIKE) por id, código de barras o descripción
app.get('/api/producto-buscar', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const pat = `%${q}%`;
  const rows = await db.all(
    `SELECT * FROM productos
     WHERE id LIKE ? OR codigo_barra LIKE ? OR descripcion LIKE ?
     ORDER BY id LIMIT 20`,
    [pat, pat, pat]
  );
  res.json(rows);
});

app.post('/api/producto/guardar', async (req, res) => {
  const { id, descripcion, precio, codigo_barra } = req.body;
  await db.run(
    `INSERT OR REPLACE INTO productos (id, descripcion, precio, codigo_barra)
     VALUES (?, ?, ?, ?)`,
    [id, descripcion, precio, codigo_barra || null]
  );
  res.json({ success: true });
});

app.delete('/api/producto/eliminar/:id', async (req, res) => {
  await db.run("DELETE FROM productos WHERE id = ?", req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------
//  CLIENTES
// ---------------------------------------------------------
app.get('/api/clientes', async (req, res) => {
  res.json(await db.all("SELECT * FROM clientes ORDER BY nombre"));
});

app.post('/api/cliente/guardar', async (req, res) => {
  const { id, nombre, telefono, email, direccion } = req.body;
  if (id) {
    await db.run(
      "UPDATE clientes SET nombre=?, telefono=?, email=?, direccion=? WHERE id=?",
      [nombre, telefono, email, direccion, id]
    );
  } else {
    await db.run(
      `INSERT INTO clientes (nombre, telefono, email, direccion) VALUES (?, ?, ?, ?)
       ON CONFLICT(nombre) DO UPDATE SET telefono=excluded.telefono,
       email=excluded.email, direccion=excluded.direccion`,
      [nombre, telefono, email, direccion]
    );
  }
  res.json({ success: true });
});

app.delete('/api/cliente/eliminar/:id', async (req, res) => {
  await db.run("DELETE FROM clientes WHERE id = ?", req.params.id);
  await db.run("DELETE FROM facturas WHERE cliente_id = ?", req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------
//  FACTURAS
// ---------------------------------------------------------
app.get('/api/facturas', async (req, res) => {
  res.json(await db.all(
    "SELECT id, numero, cliente_id, cliente_nombre, fecha, total_xg, total_usd FROM facturas ORDER BY id DESC"
  ));
});

app.get('/api/facturas/cliente/:clienteId', async (req, res) => {
  res.json(await db.all(
    "SELECT * FROM facturas WHERE cliente_id = ? ORDER BY id DESC",
    req.params.clienteId
  ));
});

app.get('/api/factura/:id', async (req, res) => {
  const f = await db.get("SELECT * FROM facturas WHERE id = ?", req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  f.detalles = JSON.parse(f.detalles || '[]');
  res.json(f);
});

app.delete('/api/factura/eliminar/:id', async (req, res) => {
  await db.run("DELETE FROM facturas WHERE id = ?", req.params.id);
  res.json({ success: true });
});

app.post('/api/factura-guardar', async (req, res) => {
  const { clienteNombre, items, tasaCambio, totalXG, totalUSD, moneda, idioma, notas } = req.body;
  await db.run("INSERT OR IGNORE INTO clientes (nombre, telefono, email) VALUES (?, '', '')", [clienteNombre]);
  const cliente = await db.get("SELECT id FROM clientes WHERE nombre = ?", [clienteNombre]);
  const fecha = fechaAMPM();
  const r = await db.run(
    `INSERT INTO facturas (cliente_id, cliente_nombre, fecha, total_xg, total_usd,
     tasa_cambio, moneda, idioma, notas, detalles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cliente.id, clienteNombre, fecha, totalXG, totalUSD, tasaCambio,
     moneda || 'XG', idioma || 'es', notas || '', JSON.stringify(items)]
  );
  const numero = 'F-' + String(r.lastID).padStart(6, '0');
  await db.run("UPDATE facturas SET numero = ? WHERE id = ?", [numero, r.lastID]);
  res.json({ success: true, id: r.lastID, numero });
});

app.post('/api/factura/editar/:id', async (req, res) => {
  const { items, totalXG, totalUSD, tasaCambio, moneda, idioma, notas } = req.body;
  await db.run(
    `UPDATE facturas SET total_xg=?, total_usd=?, tasa_cambio=?, moneda=?,
     idioma=?, notas=?, detalles=? WHERE id=?`,
    [totalXG, totalUSD, tasaCambio, moneda, idioma, notas || '',
     JSON.stringify(items), req.params.id]
  );
  res.json({ success: true });
});

// ---------------------------------------------------------
//  GENERACIÓN DE PDF PROFESIONAL (multi-idioma)
// ---------------------------------------------------------
async function generarPDFFactura(doc, datos) {
  const config = await getConfig();
  const idioma = datos.idioma && TR[datos.idioma] ? datos.idioma : 'es';
  const t = TR[idioma];

  const {
    numero = 'BORRADOR',
    fecha = fechaAMPM(),
    clienteNombre,
    clienteInfo = {},
    items,
    tasaCambio,
    totalXG,
    totalUSD,
    mostrarEnUSD,
    notas
  } = datos;

  const PRIMARY = '#1e293b';
  const ACCENT  = '#0ea5e9';
  const DARK    = '#0f172a';
  const MUTED   = '#64748b';
  const LIGHT   = '#f1f5f9';
  const BORDER  = '#e2e8f0';
  const WHITE   = '#ffffff';

  // ====== ENCABEZADO ======
  doc.rect(0, 0, doc.page.width, 130).fill(PRIMARY);
  doc.rect(0, 130, doc.page.width, 6).fill(ACCENT);

  doc.fillColor(WHITE).fontSize(24).font('Helvetica-Bold')
     .text(config.empresa_nombre || 'Mi Empresa', 50, 38, { width: 350 });
  doc.fontSize(10).font('Helvetica').fillColor('#cbd5e1')
     .text(config.empresa_subtitulo || '', 50, 70, { width: 350 });
  doc.fontSize(9).text(config.empresa_contacto || '', 50, 88, { width: 350 });
  if (config.empresa_direccion) {
    doc.text(config.empresa_direccion, 50, 102, { width: 350 });
  }

  doc.fillColor(WHITE).fontSize(30).font('Helvetica-Bold')
     .text(t.factura, 400, 40, { width: 150, align: 'right' });
  doc.fontSize(11).font('Helvetica')
     .text(`${t.numero} ${numero}`, 400, 78, { width: 150, align: 'right' });
  doc.fontSize(9).fillColor('#cbd5e1')
     .text(fecha, 400, 95, { width: 150, align: 'right' });

  // ====== DATOS DEL CLIENTE Y MONEDA ======
  let y = 165;

  doc.roundedRect(50, y, 290, 95, 6).fillAndStroke(LIGHT, BORDER);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
     .text(t.facturarA, 62, y + 12);
  doc.fillColor(DARK).fontSize(14).font('Helvetica-Bold')
     .text(clienteNombre || t.cliente, 62, y + 26, { width: 270 });

  doc.fontSize(9).font('Helvetica').fillColor(DARK);
  let yc = y + 50;
  if (clienteInfo.telefono) { doc.text(`${t.telefono}: ${clienteInfo.telefono}`, 62, yc, { width: 270 }); yc += 13; }
  if (clienteInfo.email)    { doc.text(`${t.email}: ${clienteInfo.email}`, 62, yc, { width: 270 }); yc += 13; }
  if (clienteInfo.direccion){ doc.text(`${t.direccion}: ${clienteInfo.direccion}`, 62, yc, { width: 270 }); }

  doc.roundedRect(355, y, 195, 95, 6).fillAndStroke(LIGHT, BORDER);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text(t.fecha, 367, y + 14);
  doc.fillColor(DARK).fontSize(10).font('Helvetica').text(fecha, 367, y + 28, { width: 175 });

  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text(t.moneda, 367, y + 56);
  doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold')
     .text(mostrarEnUSD ? t.monedaUSD : t.monedaXG, 367, y + 70);

  // ====== TABLA ======
  y = 290;
  const tableW = 500;

  doc.rect(50, y, tableW, 26).fill(DARK);
  doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold');
  doc.text(t.descripcion, 60, y + 9, { width: 240 });
  doc.text(t.cantidad,    300, y + 9, { width: 50, align: 'center' });
  doc.text(t.precio,      355, y + 9, { width: 85, align: 'right' });
  doc.text(t.subtotal,    445, y + 9, { width: 95, align: 'right' });
  y += 26;

  doc.font('Helvetica').fontSize(10);
  items.forEach((item, idx) => {
    const descripcion = item.descripcion || t.sinDescripcion;
    const hasCode = !!item.id;
    const descHeight = doc.heightOfString(descripcion, { width: 230 });
    const rowH = Math.max(28, descHeight + (hasCode ? 14 : 0) + 12);

    if (y + rowH > doc.page.height - 180) {
      doc.addPage();
      y = 50;
      doc.rect(50, y, tableW, 26).fill(DARK);
      doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold');
      doc.text(t.descripcion, 60, y + 9, { width: 240 });
      doc.text(t.cantidad,    300, y + 9, { width: 50, align: 'center' });
      doc.text(t.precio,      355, y + 9, { width: 85, align: 'right' });
      doc.text(t.subtotal,    445, y + 9, { width: 95, align: 'right' });
      y += 26;
    }

    if (idx % 2 === 0) doc.rect(50, y, tableW, rowH).fill(LIGHT);

    const subtotal  = item.cantidad * item.precio;
    const precioVis = mostrarEnUSD ? (item.precio / tasaCambio)  : item.precio;
    const subVis    = mostrarEnUSD ? (subtotal    / tasaCambio)  : subtotal;
    const m         = mostrarEnUSD ? '$' : 'XG ';

    doc.fillColor(DARK).font('Helvetica').fontSize(10);
    doc.text(descripcion, 60, y + 7, { width: 230 });
    if (hasCode) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text(`${t.codigo}: ${item.id}`, 60, y + 7 + descHeight + 2, { width: 230 });
    }
    doc.fillColor(DARK).fontSize(10).font('Helvetica');
    doc.text(String(item.cantidad), 300, y + 7, { width: 50, align: 'center' });
    doc.text(`${m}${precioVis.toFixed(2)}`, 355, y + 7, { width: 85, align: 'right' });
    doc.font('Helvetica-Bold').text(`${m}${subVis.toFixed(2)}`, 445, y + 7, { width: 95, align: 'right' });

    y += rowH;
  });

  doc.moveTo(50, y).lineTo(550, y).strokeColor(BORDER).lineWidth(1).stroke();

  // ====== TOTALES ======
  y += 20;
  const totalP = mostrarEnUSD ? totalUSD : totalXG;
  const totalR = mostrarEnUSD ? totalXG  : totalUSD;
  const mP     = mostrarEnUSD ? '$ '     : 'XG ';
  const mR     = mostrarEnUSD ? 'XG '    : '$ ';

  if (y + 100 > doc.page.height - 80) { doc.addPage(); y = 50; }

  doc.roundedRect(330, y, 220, 70, 6).fill(PRIMARY);
  doc.fillColor('#cbd5e1').fontSize(10).font('Helvetica').text(t.totalPagar, 345, y + 12);
  doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold')
     .text(`${mP}${totalP.toFixed(2)}`, 345, y + 28, { width: 195, align: 'right' });
  doc.fillColor('#cbd5e1').fontSize(8).font('Helvetica')
     .text(`${t.equivalente}: ${mR}${totalR.toFixed(2)}`, 345, y + 56, { width: 195, align: 'right' });

  doc.fillColor(MUTED).fontSize(9).font('Helvetica');
  doc.text(`${t.totalItems}: ${items.length}`, 50, y + 12);
  doc.text(`${t.cantidadTotal}: ${items.reduce((a, b) => a + (parseInt(b.cantidad) || 0), 0)}`, 50, y + 28);

  y += 90;

  // ====== NOTAS ======
  if (notas && notas.trim()) {
    if (y + 60 > doc.page.height - 100) { doc.addPage(); y = 50; }
    doc.roundedRect(50, y, 500, 50, 6).fillAndStroke('#fef9c3', '#fde68a');
    doc.fillColor('#854d0e').fontSize(8).font('Helvetica-Bold').text(t.notas, 60, y + 8);
    doc.fillColor(DARK).fontSize(9).font('Helvetica').text(notas, 60, y + 20, { width: 480 });
  }

  // ====== PIE DE PÁGINA ======
  const yPie = doc.page.height - 90;
  doc.moveTo(50, yPie).lineTo(550, yPie).strokeColor(BORDER).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(9).font('Helvetica-Oblique')
     .text(t.gracias, 50, yPie + 8, { align: 'center', width: 500, lineBreak: false });
  doc.fontSize(7).font('Helvetica')
     .text(`${config.empresa_nombre || ''} - ${t.generado} ${fechaAMPM()}`,
           50, yPie + 24, { align: 'center', width: 500, lineBreak: false });
}

// Endpoint: PDF de factura nueva (sin guardar)
app.post('/api/factura-pdf', async (req, res) => {
  const { items, tasaCambio, clienteNombre, mostrarEnUSD, notas, numero, idioma } = req.body;

  let clienteInfo = {};
  if (clienteNombre) {
    const c = await db.get("SELECT telefono, email, direccion FROM clientes WHERE nombre = ?", [clienteNombre]);
    if (c) clienteInfo = c;
  }
  let totalXG = 0;
  items.forEach(i => totalXG += (i.precio * i.cantidad));
  const totalUSD = totalXG / tasaCambio;

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename=Factura_${(clienteNombre || 'cliente').replace(/\s+/g, '_')}.pdf`);
  doc.pipe(res);

  await generarPDFFactura(doc, {
    numero: numero || 'NUEVA',
    clienteNombre, clienteInfo, items, tasaCambio, totalXG, totalUSD,
    mostrarEnUSD, notas, idioma
  });
  doc.end();
});

// Endpoint: Reimprimir factura guardada
app.get('/api/factura/:id/pdf', async (req, res) => {
  const f = await db.get("SELECT * FROM facturas WHERE id = ?", req.params.id);
  if (!f) return res.status(404).send('Factura no encontrada');

  const items = JSON.parse(f.detalles || '[]');
  let clienteInfo = {};
  if (f.cliente_id) {
    const c = await db.get("SELECT telefono, email, direccion FROM clientes WHERE id = ?", [f.cliente_id]);
    if (c) clienteInfo = c;
  }

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename=${f.numero || 'Factura_' + f.id}.pdf`);
  doc.pipe(res);

  await generarPDFFactura(doc, {
    numero: f.numero || ('F-' + String(f.id).padStart(6, '0')),
    fecha: f.fecha, clienteNombre: f.cliente_nombre, clienteInfo, items,
    tasaCambio: f.tasa_cambio || 1.82,
    totalXG: f.total_xg, totalUSD: f.total_usd,
    mostrarEnUSD: f.moneda === 'USD',
    notas: f.notas, idioma: f.idioma || 'es'
  });
  doc.end();
});

// ---------------------------------------------------------
//  ARRANQUE (compatible con Render: usa process.env.PORT)
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`==============================================================`);
  console.log(`  SISTEMA DE FACTURACIÓN ENCENDIDO EN PUERTO ${PORT}`);
  console.log(`  Local: http://localhost:${PORT}`);
  console.log(`==============================================================`);
});