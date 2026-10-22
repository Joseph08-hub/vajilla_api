// ===================================================================
// CONTROL DE VAJILLA ESCOLAR - API (Node.js + Express + MySQL)
// Guías 1 a 4: retiros, devoluciones, informe diario, escaneo de carnet
// y consulta de utensilios pendientes. Listo para Render + Aiven.
// ===================================================================
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const mysqlP = require("mysql2/promise");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- CONEXIÓN A LA BASE DE DATOS ----------------
const env = (...nombres) => {
  for (const n of nombres) if (process.env[n]) return process.env[n];
  return undefined;
};
const host = env("DB_HOST", "MYSQLHOST", "MYSQL_HOST") || "localhost";
const usarSSL = process.env.DB_SSL === "true" || host.includes("aivencloud.com");
const DB_NAME = env("DB_NAME", "MYSQLDATABASE") || "cocina_escolar";
const ZONA = process.env.DB_TZ || "-06:00"; // hora de El Salvador (para que "hoy" sea hoy)

const configBase = {
  host,
  user: env("DB_USER", "MYSQLUSER", "MYSQL_USER") || "root",
  password: env("DB_PASSWORD", "MYSQLPASSWORD", "MYSQL_PASSWORD") || "",
  port: Number(env("DB_PORT", "MYSQLPORT", "MYSQL_PORT") || 3306),
  ssl: usarSSL ? { rejectUnauthorized: false } : undefined,
};

const pool = mysql.createPool({
  ...configBase,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // fechas como "2026-10-21 08:30:00"
  charset: "utf8mb4",
});
pool.on("connection", (conn) => conn.query(`SET time_zone = '${ZONA}'`));
const db = pool.promise();

// Captura errores de cada ruta sin tumbar el servidor
const ruta = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ status: "error", mensaje: e.message });
  });

// ---------------- CREACIÓN DE LA BASE Y LAS TABLAS ----------------
async function crearBaseSiNoExiste() {
  try {
    const c = await mysqlP.createConnection(configBase);
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4`);
    await c.end();
  } catch (e) {
    console.warn("Aviso al crear la base (si ya existe no pasa nada):", e.message);
  }
}

async function iniciarBD() {
  await db.query(`CREATE TABLE IF NOT EXISTS estudiantes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    carnet VARCHAR(50) NOT NULL UNIQUE,
    codigo_barra VARCHAR(100) NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS utensilios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL UNIQUE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS movimientos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    estudiante_id INT NOT NULL,
    utensilio_id INT NOT NULL,
    fecha_retiro DATETIME NOT NULL,
    fecha_devolucion DATETIME NULL,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (utensilio_id) REFERENCES utensilios(id)
  )`);
  // Utensilios iniciales
  for (const tipo of ["Plato", "Vaso", "Taza"]) {
    await db.query("INSERT IGNORE INTO utensilios (tipo) VALUES (?)", [tipo]);
  }
}

// ---------------- AYUDAS ----------------
// Busca un estudiante por carnet o por el código de barras escaneado
async function buscarEstudiante(codigo) {
  const [r] = await db.query(
    "SELECT id, nombre, carnet, codigo_barra FROM estudiantes WHERE carnet = ? OR codigo_barra = ? LIMIT 1",
    [String(codigo).trim(), String(codigo).trim()]
  );
  return r[0] || null;
}

// ---------------- ESTUDIANTES ----------------
app.get("/estudiantes", ruta(async (req, res) => {
  const [r] = await db.query("SELECT id, nombre, carnet, codigo_barra FROM estudiantes ORDER BY nombre");
  res.json(r);
}));

app.get("/estudiantes/carnet/:codigo", ruta(async (req, res) => {
  const est = await buscarEstudiante(req.params.codigo);
  if (!est) return res.json({ status: "error", mensaje: "Ese carnet no está registrado" });
  res.json(est);
}));

app.post("/estudiantes", ruta(async (req, res) => {
  const nombre = (req.body.nombre || "").trim();
  const carnet = (req.body.carnet || "").trim();
  const codigo = (req.body.codigo_barra || "").trim() || null;
  if (!nombre || !carnet) return res.json({ status: "error", mensaje: "Nombre y carnet son obligatorios" });
  const [dup] = await db.query(
    "SELECT id FROM estudiantes WHERE carnet = ? OR codigo_barra = ? OR carnet = ? OR codigo_barra = ?",
    [carnet, carnet, codigo, codigo]
  );
  if (dup.length) return res.json({ status: "error", mensaje: "Ya existe un estudiante con ese carnet o código" });
  await db.query("INSERT INTO estudiantes (nombre, carnet, codigo_barra) VALUES (?,?,?)", [nombre, carnet, codigo]);
  res.json({ status: "ok", mensaje: "Estudiante registrado correctamente" });
}));

app.delete("/estudiantes/:id", ruta(async (req, res) => {
  const [mov] = await db.query("SELECT COUNT(*) AS n FROM movimientos WHERE estudiante_id = ?", [req.params.id]);
  if (mov[0].n > 0) {
    return res.json({ status: "error", mensaje: "No se puede eliminar: el estudiante tiene movimientos registrados" });
  }
  await db.query("DELETE FROM estudiantes WHERE id = ?", [req.params.id]);
  res.json({ status: "ok", mensaje: "Estudiante eliminado" });
}));

// ---------------- UTENSILIOS ----------------
app.get("/utensilios", ruta(async (req, res) => {
  const [r] = await db.query("SELECT id, tipo FROM utensilios ORDER BY id");
  res.json(r);
}));

// ---------------- RETIRO Y DEVOLUCIÓN ----------------
// Body: { carnet, utensilio_id (id o nombre: "Plato"), cantidad (opcional) }
app.post("/retiro", ruta(async (req, res) => {
  const codigo = req.body.carnet ?? req.body.estudiante_id;
  const cantidad = Math.min(Math.max(parseInt(req.body.cantidad) || 1, 1), 20);
  if (!codigo) return res.json({ status: "error", mensaje: "Falta el carnet del estudiante" });

  const est = await buscarEstudiante(codigo);
  if (!est) return res.json({ status: "error", mensaje: "Ese carnet no está registrado" });

  const u = req.body.utensilio_id;
  const [uten] = /^\d+$/.test(String(u))
    ? await db.query("SELECT id, tipo FROM utensilios WHERE id = ?", [u])
    : await db.query("SELECT id, tipo FROM utensilios WHERE LOWER(tipo) = LOWER(?)", [String(u || "")]);
  if (!uten.length) return res.json({ status: "error", mensaje: "Ese utensilio no existe" });

  for (let i = 0; i < cantidad; i++) {
    await db.query("INSERT INTO movimientos (estudiante_id, utensilio_id, fecha_retiro) VALUES (?, ?, NOW())", [
      est.id, uten[0].id,
    ]);
  }
  res.json({ status: "ok", mensaje: `Retiro registrado: ${cantidad} x ${uten[0].tipo} para ${est.nombre}` });
}));

app.put("/devolucion/:id", ruta(async (req, res) => {
  const [r] = await db.query(
    "UPDATE movimientos SET fecha_devolucion = NOW() WHERE id = ? AND fecha_devolucion IS NULL",
    [req.params.id]
  );
  if (!r.affectedRows) return res.json({ status: "error", mensaje: "Ese movimiento no existe o ya fue devuelto" });
  res.json({ status: "ok", mensaje: "Devolución registrada" });
}));

app.put("/devolver-todo/:codigo", ruta(async (req, res) => {
  const est = await buscarEstudiante(req.params.codigo);
  if (!est) return res.json({ status: "error", mensaje: "Ese carnet no está registrado" });
  const [r] = await db.query(
    "UPDATE movimientos SET fecha_devolucion = NOW() WHERE estudiante_id = ? AND fecha_devolucion IS NULL",
    [est.id]
  );
  res.json({ status: "ok", mensaje: `${r.affectedRows} utensilio(s) devuelto(s) por ${est.nombre}` });
}));

// ---------------- PENDIENTES ----------------
// Todos los pendientes del colegio
app.get("/pendientes", ruta(async (req, res) => {
  const [r] = await db.query(
    `SELECT m.id, u.tipo, m.fecha_retiro, e.nombre AS estudiante, e.carnet
     FROM movimientos m
     JOIN estudiantes e ON m.estudiante_id = e.id
     JOIN utensilios u ON m.utensilio_id = u.id
     WHERE m.fecha_devolucion IS NULL
     ORDER BY m.fecha_retiro DESC`
  );
  res.json(r);
}));

// Pendientes de un estudiante (por carnet o código de barras)
app.get("/pendientes/:codigo", ruta(async (req, res) => {
  const est = await buscarEstudiante(req.params.codigo);
  if (!est) return res.json({ status: "error", mensaje: "Ese carnet no está registrado" });
  const [r] = await db.query(
    `SELECT m.id, u.tipo, m.fecha_retiro
     FROM movimientos m
     JOIN utensilios u ON m.utensilio_id = u.id
     WHERE m.estudiante_id = ? AND m.fecha_devolucion IS NULL
     ORDER BY m.fecha_retiro DESC`,
    [est.id]
  );
  res.json(r);
}));

// ---------------- INFORME DIARIO ----------------
// /informe            -> de hoy
// /informe?fecha=2026-10-21
app.get("/informe", ruta(async (req, res) => {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || "") ? req.query.fecha : null;
  const [r] = await db.query(
    `SELECT u.id, u.tipo,
            COUNT(m.id) AS entregados,
            COALESCE(SUM(m.fecha_devolucion IS NOT NULL), 0) AS devueltos,
            COALESCE(SUM(m.fecha_devolucion IS NULL), 0) AS pendientes
     FROM utensilios u
     LEFT JOIN movimientos m ON m.utensilio_id = u.id AND DATE(m.fecha_retiro) = COALESCE(?, CURDATE())
     GROUP BY u.id, u.tipo
     ORDER BY u.id`,
    [fecha]
  );
  res.json(r);
}));

// ---------------- PRUEBA Y ERRORES ----------------
app.get("/", (req, res) => res.json({ status: "ok", mensaje: "API Control de Vajilla Escolar funcionando" }));

app.use((err, req, res, next) => {
  res.status(400).json({ status: "error", mensaje: err.message });
});

// ---------------- ARRANQUE ----------------
const PUERTO = process.env.PORT || 3000;
(async () => {
  try {
    await crearBaseSiNoExiste();
    await iniciarBD();
    app.listen(PUERTO, "0.0.0.0", () => console.log("Servidor corriendo en el puerto " + PUERTO));
  } catch (e) {
    console.error("No se pudo conectar/preparar la base de datos:", e.message);
    process.exit(1);
  }
})();