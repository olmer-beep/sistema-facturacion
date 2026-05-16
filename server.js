// ========================================================
//  SISTEMA DE FACTURACIÓN - SERVIDOR PRINCIPAL
//  Versión mejorada con PDFs profesionales y más opciones
// ========================================================
const express = require('express');
const PDFDocument = require('pdfkit');
const Database = require("better-sqlite3");
const db = new Database("facturacion.db");


const app = express();
app.use(express.json());
app.use(express.static('public'));

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
        precio REAL
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
        notas TEXT,
        detalles TEXT
      );
      CREATE TABLE IF NOT EXISTS config (
        clave TEXT PRIMARY KEY,
        valor TEXT
      );
    `);

    // Migraciones suaves (ignora si la columna ya existe)
    const safeAlter = async (sql) => { try { await db.exec(sql); } catch (e) {} };
    await safeAlter("ALTER TABLE clientes ADD COLUMN direccion TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN numero TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN cliente_nombre TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN tasa_cambio REAL");
    await safeAlter("ALTER TABLE facturas ADD COLUMN moneda TEXT");
    await safeAlter("ALTER TABLE facturas ADD COLUMN notas TEXT");

    // Configuración por defecto de la empresa y tasa
    const defaults = {
      empresa_nombre: 'Mi Empresa',
      empresa_subtitulo: 'Productos y servicios de calidad',
      empresa_contacto: 'Teléfono: --- | Email: ---',
      empresa_direccion: '',
      tasa_cambio: '1.82'
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
//  CONFIGURACIÓN DE EMPRESA
// ---------------------------------------------------------
async function getConfig() {
  const rows = await db.all("SELECT clave, valor FROM config");
  const obj = {};
  rows.forEach(r => obj[r.clave] = r.valor);
  obj.tasa_cambio = parseFloat(obj.tasa_cambio) || 1.82;
  return obj;
}

app.get('/api/config', async (req, res) => {
  res.json(await getConfig());
});

app.post('/api/config', async (req, res) => {
  const datos = req.body || {};
  for (const [clave, valor] of Object.entries(datos)) {
    await db.run("INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)", [clave, String(valor)]);
  }
  res.json({ success: true });
});

// ---------------------------------------------------------
//  PRODUCTOS
// ---------------------------------------------------------
app.get('/api/productos', async (req, res) => {
  res.json(await db.all("SELECT * FROM productos ORDER BY id"));
});

app.get('/api/producto/:item', async (req, res) => {
  const producto = await db.get("SELECT * FROM productos WHERE id = ?", req.params.item);
  if (producto) res.json({ encontrado: true, ...producto });
  else res.json({ encontrado: false });
});

app.post('/api/producto/guardar', async (req, res) => {
  const { id, descripcion, precio } = req.body;
  await db.run(
    "INSERT OR REPLACE INTO productos (id, descripcion, precio) VALUES (?, ?, ?)",
    [id, descripcion, precio]
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
       ON CONFLICT(nombre) DO UPDATE SET telefono=excluded.telefono, email=excluded.email, direccion=excluded.direccion`,
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

// Listar todas las facturas (para búsqueda global)
app.get('/api/facturas', async (req, res) => {
  const facturas = await db.all(
    "SELECT id, numero, cliente_id, cliente_nombre, fecha, total_xg, total_usd FROM facturas ORDER BY id DESC"
  );
  res.json(facturas);
});

// Facturas de un cliente
app.get('/api/facturas/cliente/:clienteId', async (req, res) => {
  const facturas = await db.all(
    "SELECT * FROM facturas WHERE cliente_id = ? ORDER BY id DESC",
    req.params.clienteId
  );
  res.json(facturas);
});

// Detalle de una factura individual
app.get('/api/factura/:id', async (req, res) => {
  const f = await db.get("SELECT * FROM facturas WHERE id = ?", req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  f.detalles = JSON.parse(f.detalles || '[]');
  res.json(f);
});

// Eliminar factura
app.delete('/api/factura/eliminar/:id', async (req, res) => {
  await db.run("DELETE FROM facturas WHERE id = ?", req.params.id);
  res.json({ success: true });
});

// Guardar nueva factura (con número secuencial)
app.post('/api/factura-guardar', async (req, res) => {
  const { clienteNombre, items, tasaCambio, totalXG, totalUSD, moneda, notas } = req.body;

  // Garantiza que el cliente existe y obtiene su ID
  await db.run("INSERT OR IGNORE INTO clientes (nombre, telefono, email) VALUES (?, '', '')", [clienteNombre]);
  const cliente = await db.get("SELECT id FROM clientes WHERE nombre = ?", [clienteNombre]);

  const fecha = new Date().toLocaleString('es-ES');
  const result = await db.run(
    `INSERT INTO facturas (cliente_id, cliente_nombre, fecha, total_xg, total_usd, tasa_cambio, moneda, notas, detalles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cliente.id, clienteNombre, fecha, totalXG, totalUSD, tasaCambio, moneda || 'XG', notas || '', JSON.stringify(items)]
  );

  const numero = 'F-' + String(result.lastID).padStart(6, '0');
  await db.run("UPDATE facturas SET numero = ? WHERE id = ?", [numero, result.lastID]);

  res.json({ success: true, id: result.lastID, numero });
});

// Editar factura existente (precios, cantidades, notas)
app.post('/api/factura/editar/:id', async (req, res) => {
  const { items, totalXG, totalUSD, tasaCambio, moneda, notas } = req.body;
  await db.run(
    `UPDATE facturas SET total_xg=?, total_usd=?, tasa_cambio=?, moneda=?, notas=?, detalles=? WHERE id=?`,
    [totalXG, totalUSD, tasaCambio, moneda, notas || '', JSON.stringify(items), req.params.id]
  );
  res.json({ success: true });
});

// ---------------------------------------------------------
//  GENERACIÓN DE PDF PROFESIONAL
// ---------------------------------------------------------
async function generarPDFFactura(doc, datos) {
  const config = await getConfig();
  const {
    numero = 'BORRADOR',
    fecha = new Date().toLocaleString('es-ES'),
    clienteNombre,
    clienteInfo = {},
    items,
    tasaCambio,
    totalXG,
    totalUSD,
    mostrarEnUSD,
    notas
  } = datos;

  // Paleta de colores
  const PRIMARY = '#1e40af';      // azul profundo
  const ACCENT  = '#0ea5e9';      // celeste
  const DARK    = '#0f172a';
  const MUTED   = '#64748b';
  const LIGHT   = '#f1f5f9';
  const BORDER  = '#e2e8f0';
  const WHITE   = '#ffffff';

  // ====== ENCABEZADO ======
  doc.rect(0, 0, doc.page.width, 130).fill(PRIMARY);
  doc.rect(0, 130, doc.page.width, 6).fill(ACCENT);

  // Nombre de la empresa
  doc.fillColor(WHITE).fontSize(24).font('Helvetica-Bold')
     .text(config.empresa_nombre || 'Mi Empresa', 50, 38, { width: 350 });
  doc.fontSize(10).font('Helvetica')
     .fillColor('#cbd5e1')
     .text(config.empresa_subtitulo || '', 50, 70, { width: 350 });
  doc.fontSize(9)
     .text(config.empresa_contacto || '', 50, 88, { width: 350 });
  if (config.empresa_direccion) {
     doc.text(config.empresa_direccion, 50, 102, { width: 350 });
  }

  // Bloque "FACTURA" a la derecha
  doc.fillColor(WHITE).fontSize(30).font('Helvetica-Bold')
     .text('FACTURA', 400, 40, { width: 150, align: 'right' });
  doc.fontSize(11).font('Helvetica')
     .text(`N° ${numero}`, 400, 78, { width: 150, align: 'right' });
  doc.fontSize(9).fillColor('#cbd5e1')
     .text(fecha, 400, 95, { width: 150, align: 'right' });

  // ====== DATOS DEL CLIENTE Y MONEDA ======
  let y = 165;

  // Caja Cliente
  doc.roundedRect(50, y, 290, 95, 6).fillAndStroke(LIGHT, BORDER);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
     .text('FACTURAR A', 62, y + 12);
  doc.fillColor(DARK).fontSize(14).font('Helvetica-Bold')
     .text(clienteNombre || 'Cliente General', 62, y + 26, { width: 270 });

  doc.fontSize(9).font('Helvetica').fillColor(DARK);
  let yc = y + 50;
  if (clienteInfo.telefono) { doc.text(`☎  ${clienteInfo.telefono}`, 62, yc, { width: 270 }); yc += 13; }
  if (clienteInfo.email)    { doc.text(`✉  ${clienteInfo.email}`, 62, yc, { width: 270 }); yc += 13; }
  if (clienteInfo.direccion){ doc.text(`📍 ${clienteInfo.direccion}`, 62, yc, { width: 270 }); }

  // Caja Detalles
  doc.roundedRect(355, y, 195, 95, 6).fillAndStroke(LIGHT, BORDER);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('FECHA', 367, y + 12);
  doc.fillColor(DARK).fontSize(10).font('Helvetica').text(fecha, 367, y + 25, { width: 175 });

  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('MONEDA DE PAGO', 367, y + 48);
  doc.fillColor(DARK).fontSize(10).font('Helvetica')
     .text(mostrarEnUSD ? 'Dólares (USD)' : 'Florines (XG)', 367, y + 61);

  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('TASA DE CAMBIO', 367, y + 78);
  doc.fillColor(DARK).fontSize(9).font('Helvetica')
     .text(`1 USD = ${Number(tasaCambio).toFixed(2)} XG`, 460, y + 78);

  // ====== TABLA DE ITEMS ======
  y = 290;
  const tableW = 500;

  // Encabezado tabla
  doc.rect(50, y, tableW, 26).fill(DARK);
  doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold');
  doc.text('DESCRIPCIÓN', 60, y + 9, { width: 240 });
  doc.text('CANT.',       300, y + 9, { width: 50, align: 'center' });
  doc.text('PRECIO',      355, y + 9, { width: 85, align: 'right' });
  doc.text('SUBTOTAL',    445, y + 9, { width: 95, align: 'right' });
  y += 26;

  // Filas
  doc.font('Helvetica').fontSize(10);
  items.forEach((item, idx) => {
    const descripcion = item.descripcion || '(sin descripción)';
    const hasCode = !!item.id;
    const descHeight = doc.heightOfString(descripcion, { width: 230 });
    // Reservamos espacio para el código (si existe) DEBAJO de la descripción
    const rowH = Math.max(28, descHeight + (hasCode ? 14 : 0) + 12);

    // Salto de página si no cabe
    if (y + rowH > doc.page.height - 180) {
      doc.addPage();
      y = 50;
      doc.rect(50, y, tableW, 26).fill(DARK);
      doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPCIÓN', 60, y + 9, { width: 240 });
      doc.text('CANT.', 300, y + 9, { width: 50, align: 'center' });
      doc.text('PRECIO', 355, y + 9, { width: 85, align: 'right' });
      doc.text('SUBTOTAL', 445, y + 9, { width: 95, align: 'right' });
      y += 26;
    }

    // Fondo alterno
    if (idx % 2 === 0) doc.rect(50, y, tableW, rowH).fill(LIGHT);

    const subtotal  = item.cantidad * item.precio;
    const precioVis = mostrarEnUSD ? (item.precio / tasaCambio)  : item.precio;
    const subVis    = mostrarEnUSD ? (subtotal    / tasaCambio)  : subtotal;
    const m         = mostrarEnUSD ? '$' : 'XG ';

    // Descripción
    doc.fillColor(DARK).font('Helvetica').fontSize(10);
    doc.text(descripcion, 60, y + 7, { width: 230 });
    // Código DEBAJO de la descripción, en gris pequeño
    if (hasCode) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text(`Cód: ${item.id}`, 60, y + 7 + descHeight + 2, { width: 230 });
    }

    // Cantidad, precio, subtotal (alineados con la descripción)
    doc.fillColor(DARK).fontSize(10).font('Helvetica');
    doc.text(String(item.cantidad), 300, y + 7, { width: 50, align: 'center' });
    doc.text(`${m}${precioVis.toFixed(2)}`, 355, y + 7, { width: 85, align: 'right' });
    doc.font('Helvetica-Bold').text(`${m}${subVis.toFixed(2)}`, 445, y + 7, { width: 95, align: 'right' });

    y += rowH;
  });

  // línea final de la tabla
  doc.moveTo(50, y).lineTo(550, y).strokeColor(BORDER).lineWidth(1).stroke();

  // ====== TOTALES ======
  y += 20;

  const totalPrincipal = mostrarEnUSD ? totalUSD : totalXG;
  const totalRef       = mostrarEnUSD ? totalXG  : totalUSD;
  const monPrincipal   = mostrarEnUSD ? '$ '     : 'XG ';
  const monRef         = mostrarEnUSD ? 'XG '    : '$ ';

  // si no cabe, salto de página
  if (y + 100 > doc.page.height - 80) {
    doc.addPage();
    y = 50;
  }

  // Caja de total principal
  doc.roundedRect(330, y, 220, 70, 6).fill(PRIMARY);
  doc.fillColor('#cbd5e1').fontSize(10).font('Helvetica').text('TOTAL A PAGAR', 345, y + 12);
  doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold')
     .text(`${monPrincipal}${totalPrincipal.toFixed(2)}`, 345, y + 28, { width: 195, align: 'right' });
  doc.fillColor('#cbd5e1').fontSize(8).font('Helvetica')
     .text(`Equivalente: ${monRef}${totalRef.toFixed(2)}`, 345, y + 56, { width: 195, align: 'right' });

  // Línea de items / subtotal a la izquierda
  doc.fillColor(MUTED).fontSize(9).font('Helvetica');
  doc.text(`Total de ítems: ${items.length}`, 50, y + 12);
  doc.text(`Cantidad total: ${items.reduce((a, b) => a + (parseInt(b.cantidad) || 0), 0)}`, 50, y + 28);

  y += 90;

  // ====== NOTAS ======
  if (notas && notas.trim()) {
    if (y + 60 > doc.page.height - 80) { doc.addPage(); y = 50; }
    doc.roundedRect(50, y, 500, 50, 6).fillAndStroke('#fef9c3', '#fde68a');
    doc.fillColor('#854d0e').fontSize(8).font('Helvetica-Bold').text('NOTAS', 60, y + 8);
    doc.fillColor(DARK).fontSize(9).font('Helvetica').text(notas, 60, y + 20, { width: 480 });
    y += 60;
  }

  // ====== PIE DE PÁGINA ======
  const yPie = doc.page.height - 90;
  doc.moveTo(50, yPie).lineTo(550, yPie).strokeColor(BORDER).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(9).font('Helvetica-Oblique')
     .text('¡Gracias por su preferencia!', 50, yPie + 8, { align: 'center', width: 500, lineBreak: false });
  doc.fontSize(7).font('Helvetica')
     .text(`${config.empresa_nombre || ''} • Documento generado el ${new Date().toLocaleString('es-ES')}`,
           50, yPie + 24, { align: 'center', width: 500, lineBreak: false });
}

// Endpoint: PDF de nueva factura (sin guardar)
app.post('/api/factura-pdf', async (req, res) => {
  const { items, tasaCambio, clienteNombre, mostrarEnUSD, notas, numero } = req.body;

  // Obtener info del cliente si existe
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
  res.setHeader('Content-Disposition', `attachment; filename=Factura_${(clienteNombre || 'cliente').replace(/\s+/g, '_')}.pdf`);
  doc.pipe(res);

  await generarPDFFactura(doc, {
    numero: numero || 'NUEVA',
    clienteNombre,
    clienteInfo,
    items,
    tasaCambio,
    totalXG,
    totalUSD,
    mostrarEnUSD,
    notas
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
  res.setHeader('Content-Disposition', `attachment; filename=${f.numero || 'Factura_' + f.id}.pdf`);
  doc.pipe(res);

  await generarPDFFactura(doc, {
    numero: f.numero || ('F-' + String(f.id).padStart(6, '0')),
    fecha: f.fecha,
    clienteNombre: f.cliente_nombre,
    clienteInfo,
    items,
    tasaCambio: f.tasa_cambio || 1.82,
    totalXG: f.total_xg,
    totalUSD: f.total_usd,
    mostrarEnUSD: f.moneda === 'USD',
    notas: f.notas
  });

  doc.end();
});

// ---------------------------------------------------------
//  ARRANQUE
// ---------------------------------------------------------
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`==============================================================`);
  console.log(`  SISTEMA DE FACTURACIÓN ENCENDIDO`);
  console.log(`  Abrir en el navegador:  http://localhost:${PORT}`);
  console.log(`==============================================================`);
});