const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'incidencias_secret_key_change_in_prod';

// DB setup
const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/incidencias.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'usuario',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS incidencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    ubicacion TEXT NOT NULL,
    ubicacion_custom TEXT,
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    estado TEXT DEFAULT 'abierta',
    prioridad TEXT DEFAULT 'normal',
    solucion TEXT,
    asignado_a TEXT,
    historial TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Custom SQLite function: normalize text (strip accents, lowercase) for accent-insensitive search
function normalizeStr(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
db.function('norm', normalizeStr);

// Migrations
try { db.exec("ALTER TABLE incidencias ADD COLUMN attachments TEXT DEFAULT '[]'"); } catch {}
try { db.exec("UPDATE users SET role = 'tecnico' WHERE role = 'cofotap'"); } catch {}

// Seed default data
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
  const hashCofo = bcrypt.hashSync('cofotap123', 10);
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('tecnico', hashCofo, 'tecnico');
}

const locCount = db.prepare('SELECT COUNT(*) as c FROM locations').get();
if (locCount.c === 0) {
  const defaultLocs = [
    'Aula 1.01', 'Aula 1.02', 'Aula 1.03', 'Aula 2.01', 'Aula 2.02',
    'Laboratorio Informática', 'Biblioteca', 'Sala de Profesores',
    'Secretaría', 'Dirección', 'Gimnasio', 'Patio', 'Pasillo Planta Baja',
    'Pasillo Primera Planta', 'Aseos Planta Baja', 'Cafetería'
  ];
  const ins = db.prepare('INSERT INTO locations (name, sort_order) VALUES (?, ?)');
  defaultLocs.forEach((name, i) => ins.run(name, i));
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Auth middleware
function authMiddleware(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Sin permisos suficientes' });
      }
      next();
    } catch {
      res.status(401).json({ error: 'Token inválido' });
    }
  };
}

function generateCodigo() {
  const year = new Date().getFullYear();
  const last = db.prepare('SELECT id FROM incidencias ORDER BY id DESC LIMIT 1').get();
  const num = String((last ? last.id + 1 : 1)).padStart(4, '0');
  return `INC-${year}-${num}`;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, role: user.role, username: user.username });
});

// ── LOCATIONS ─────────────────────────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
  const locs = db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY sort_order, name').all();
  res.json(locs);
});

app.post('/api/locations', authMiddleware(['admin']), (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM locations').get().m || 0;
  const result = db.prepare('INSERT INTO locations (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
  res.json({ id: result.lastInsertRowid, name: name.trim() });
});

app.put('/api/locations/:id', authMiddleware(['admin']), (req, res) => {
  const { name, active, sort_order } = req.body;
  db.prepare('UPDATE locations SET name = COALESCE(?, name), active = COALESCE(?, active), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name, active !== undefined ? active : null, sort_order, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/locations/:id', authMiddleware(['admin']), (req, res) => {
  db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/locations/reorder', authMiddleware(['admin']), (req, res) => {
  const { order } = req.body; // array of ids
  const upd = db.prepare('UPDATE locations SET sort_order = ? WHERE id = ?');
  order.forEach((id, i) => upd.run(i, id));
  res.json({ ok: true });
});

// ── INCIDENCIAS (PUBLIC CREATE) ───────────────────────────────────────────────
app.post('/api/incidencias', (req, res) => {
  const { nombre, email, descripcion, ubicacion, ubicacion_custom, prioridad, attachments } = req.body;
  if (!nombre || !email || !descripcion || !ubicacion) {
    return res.status(400).json({ error: 'Campos obligatorios faltantes' });
  }
  const codigo = generateCodigo();
  const historial = JSON.stringify([{
    fecha: new Date().toISOString(),
    accion: 'Incidencia creada',
    usuario: nombre,
    estado: 'abierta'
  }]);
  const result = db.prepare(`
    INSERT INTO incidencias (codigo, nombre, email, descripcion, ubicacion, ubicacion_custom, prioridad, historial, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(codigo, nombre, email, descripcion, ubicacion, ubicacion_custom || null, prioridad || 'normal', historial, JSON.stringify(attachments || []));

  res.json({ id: result.lastInsertRowid, codigo, message: 'Incidencia creada correctamente' });
});

// ── INCIDENCIAS (PUBLIC RESOLVED) ────────────────────────────────────────────
app.get('/api/public/incidencias', (req, res) => {
  const { search } = req.query;
  let query = "SELECT id, codigo, descripcion, ubicacion, ubicacion_custom, fecha_actualizacion, solucion, prioridad FROM incidencias WHERE estado = 'cerrada'";
  const params = [];
  if (search) {
    query += ' AND (norm(codigo) LIKE ? OR norm(descripcion) LIKE ? OR norm(ubicacion) LIKE ? OR norm(solucion) LIKE ?)';
    const s = `%${normalizeStr(search)}%`;
    params.push(s, s, s, s);
  }
  query += ' ORDER BY fecha_actualizacion DESC LIMIT 200';
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// ── INCIDENCIAS (AUTH REQUIRED) ──────────────────────────────────────────────
app.get('/api/incidencias', authMiddleware(['admin', 'tecnico', 'usuario']), (req, res) => {
  const { estado, search, page = 1, limit = 20 } = req.query;
  let query = 'SELECT * FROM incidencias WHERE 1=1';
  const params = [];
  if (estado) { query += ' AND estado = ?'; params.push(estado); }
  if (search) {
    query += ' AND (norm(codigo) LIKE ? OR norm(nombre) LIKE ? OR norm(descripcion) LIKE ? OR norm(ubicacion) LIKE ?)';
    const s = `%${normalizeStr(search)}%`;
    params.push(s, s, s, s);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM incidencias WHERE 1=1${estado ? ' AND estado = ?' : ''}${search ? ' AND (norm(codigo) LIKE ? OR norm(nombre) LIKE ? OR norm(descripcion) LIKE ? OR norm(ubicacion) LIKE ?)' : ''}`).get(...params).c;
  query += ' ORDER BY fecha_creacion DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  const rows = db.prepare(query).all(...params);
  res.json({ data: rows, total, page: Number(page), pages: Math.ceil(total / limit) });
});

app.get('/api/incidencias/:id', authMiddleware(['admin', 'tecnico', 'usuario']), (req, res) => {
  const row = db.prepare('SELECT * FROM incidencias WHERE id = ? OR codigo = ?').get(req.params.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json(row);
});

app.put('/api/incidencias/:id', authMiddleware(['admin', 'tecnico']), (req, res) => {
  const inc = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'No encontrada' });

  const { estado, solucion, prioridad, asignado_a, descripcion, attachments } = req.body;
  const historial = JSON.parse(inc.historial || '[]');

  if (estado && estado !== inc.estado) {
    historial.push({
      fecha: new Date().toISOString(),
      accion: `Estado cambiado: ${inc.estado} → ${estado}`,
      usuario: req.user.username,
      estado
    });
  }
  if (solucion !== undefined && solucion !== inc.solucion) {
    historial.push({
      fecha: new Date().toISOString(),
      accion: 'Solución actualizada',
      usuario: req.user.username,
      estado: estado || inc.estado
    });
  }

  db.prepare(`
    UPDATE incidencias SET
      estado = COALESCE(?, estado),
      solucion = COALESCE(?, solucion),
      prioridad = COALESCE(?, prioridad),
      asignado_a = COALESCE(?, asignado_a),
      descripcion = COALESCE(?, descripcion),
      attachments = COALESCE(?, attachments),
      historial = ?,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    estado || null,
    solucion !== undefined ? solucion : null,
    prioridad || null,
    asignado_a || null,
    descripcion || null,
    attachments !== undefined ? JSON.stringify(attachments) : null,
    JSON.stringify(historial),
    req.params.id
  );

  res.json({ ok: true });
});

app.delete('/api/incidencias/:id', authMiddleware(['admin']), (req, res) => {
  db.prepare('DELETE FROM incidencias WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', authMiddleware(['admin', 'tecnico', 'usuario']), (req, res) => {
  const estados = db.prepare('SELECT estado, COUNT(*) as c FROM incidencias GROUP BY estado').all();
  const total = db.prepare('SELECT COUNT(*) as c FROM incidencias').get().c;
  const ultimasAbiertas = db.prepare('SELECT * FROM incidencias WHERE estado = "abierta" ORDER BY fecha_creacion DESC LIMIT 5').all();
  res.json({ estados, total, ultimasAbiertas });
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', authMiddleware(['admin', 'tecnico']), (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users').all();
  res.json(users);
});

app.post('/api/users', authMiddleware(['admin']), (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: 'Datos incompletos' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, hash, role);
    res.json({ id: result.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Usuario ya existe' });
  }
});

app.put('/api/users/:id', authMiddleware(['admin']), (req, res) => {
  const { password, role } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ?, role = COALESCE(?, role) WHERE id = ?').run(hash, role || null, req.params.id);
  } else {
    db.prepare('UPDATE users SET role = COALESCE(?, role) WHERE id = ?').run(role || null, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', authMiddleware(['admin']), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user?.role === 'admin') {
    const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = "admin"').get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'No puedes eliminar el último administrador' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────────
app.get('/api/export', authMiddleware(['admin']), (req, res) => {
  const { type = 'all' } = req.query;
  const result = { exportado_el: new Date().toISOString(), version: 1 };
  if (type === 'all' || type === 'incidencias') {
    result.incidencias = db.prepare('SELECT * FROM incidencias').all();
  }
  if (type === 'all' || type === 'ubicaciones') {
    result.ubicaciones = db.prepare('SELECT * FROM locations').all();
  }
  if (type === 'all' || type === 'usuarios') {
    result.usuarios = db.prepare('SELECT id, username, role, created_at FROM users').all();
  }
  const filename = `gestor-backup-${new Date().toISOString().slice(0, 10)}${type !== 'all' ? '-' + type : ''}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(result);
});

app.post('/api/import', authMiddleware(['admin']), (req, res) => {
  const { incidencias, ubicaciones } = req.body;
  const imported = { incidencias: 0, ubicaciones: 0, errors: [] };

  if (Array.isArray(incidencias)) {
    const ins = db.prepare(`INSERT OR IGNORE INTO incidencias
      (codigo, nombre, email, descripcion, ubicacion, ubicacion_custom, fecha_creacion, fecha_actualizacion, estado, prioridad, solucion, asignado_a, historial, attachments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const inc of incidencias) {
      try {
        const r = ins.run(
          inc.codigo, inc.nombre, inc.email, inc.descripcion, inc.ubicacion,
          inc.ubicacion_custom || null, inc.fecha_creacion, inc.fecha_actualizacion,
          inc.estado || 'abierta', inc.prioridad || 'normal',
          inc.solucion || null, inc.asignado_a || null,
          inc.historial || '[]', inc.attachments || '[]'
        );
        if (r.changes) imported.incidencias++;
      } catch (e) { imported.errors.push(`Inc ${inc.codigo}: ${e.message}`); }
    }
  }

  if (Array.isArray(ubicaciones)) {
    const ins = db.prepare('INSERT OR IGNORE INTO locations (name, active, sort_order) VALUES (?, ?, ?)');
    for (const loc of ubicaciones) {
      try {
        const r = ins.run(loc.name, loc.active ?? 1, loc.sort_order ?? 0);
        if (r.changes) imported.ubicaciones++;
      } catch (e) { imported.errors.push(`Loc ${loc.name}: ${e.message}`); }
    }
  }

  res.json({ ok: true, imported });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`🚨 Gestor de Incidencias corriendo en puerto ${PORT}`));
