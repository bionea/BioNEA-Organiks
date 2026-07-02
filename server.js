'use strict';
require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ═══════════════════════════════════════════════════════
//  CORS — permite peticiones desde el navegador
//  (necesario para el simulador web; el ESP32 no lo usa)
// ═══════════════════════════════════════════════════════
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ═══════════════════════════════════════════════════════
//  CONEXIÓN A SUPABASE (PostgreSQL)
// ═══════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado:', err.message);
});

// ═══════════════════════════════════════════════════════
//  CACHÉ EN MEMORIA: session_id ESP32 → id_sesion BD
//
//  El ESP32 genera session_id = millis() (ej: "47382").
//  Lo guardamos en memoria para no hacer SELECT en cada
//  medición. Si Render reinicia el servicio, el fallback
//  busca en BD por la columna sesion_externa.
// ═══════════════════════════════════════════════════════
const sesionesActivas = new Map();

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

/** Convierte "DD/MM/YYYY" + "HH:MM:SS" → objeto Date */
function parsearFechaHora(fecha, hora) {
  const [dd, mm, yyyy] = fecha.split('/');
  return new Date(`${yyyy}-${mm}-${dd}T${hora}`);
}

/**
 * Busca el individuo por código. Si no existe, lo crea.
 * Devuelve id_individuo.
 */
async function obtenerOCrearIndividuo(client, codigo, especie) {
  const { rows } = await client.query(
    'SELECT id_individuo FROM individuos WHERE codigo_individuo = $1',
    [codigo]
  );
  if (rows.length) return rows[0].id_individuo;

  const { rows: nuevo } = await client.query(
    `INSERT INTO individuos (codigo_individuo, especie, estado)
     VALUES ($1, $2, 'activo')
     RETURNING id_individuo`,
    [codigo, especie]
  );
  console.log(`[BD] ✅ Nuevo individuo: ${codigo} (${especie})`);
  return nuevo[0].id_individuo;
}

/**
 * Resuelve id_sesion en este orden:
 *   1. Caché en memoria
 *   2. Busca en BD por sesion_externa
 *   3. Crea sesión nueva
 */
async function obtenerOCrearSesion(client, { session_id, individuo, especie, fecha, hora, temp_min, temp_max }) {
  // ── 1. Caché ──────────────────────────────────────────
  if (sesionesActivas.has(session_id)) {
    return sesionesActivas.get(session_id);
  }

  // ── 2. Buscar en BD (fallback tras reinicio de Render) ─
  const { rows: encontradas } = await client.query(
    'SELECT id_sesion FROM sesiones WHERE sesion_externa = $1',
    [session_id]
  );
  if (encontradas.length) {
    const id = encontradas[0].id_sesion;
    sesionesActivas.set(session_id, id);
    return id;
  }

  // ── 3. Crear sesión nueva ──────────────────────────────
  const idIndividuo = await obtenerOCrearIndividuo(client, individuo, especie);
  const fechaInicio = parsearFechaHora(fecha, hora);

  // Primer dispositivo activo (null si la tabla está vacía)
  const { rows: dispRows } = await client.query(
    "SELECT id_dispositivo FROM dispositivos WHERE estado = 'activo' LIMIT 1"
  );
  const idDispositivo = dispRows[0]?.id_dispositivo ?? null;

  // Primer usuario registrado (null si la tabla está vacía)
  const { rows: userRows } = await client.query(
    'SELECT id_usuario FROM usuarios LIMIT 1'
  );
  const idUsuario = userRows[0]?.id_usuario ?? null;

  const { rows: sesion } = await client.query(
    `INSERT INTO sesiones
       (id_individuo, id_dispositivo, id_usuario,
        fecha_inicio, intervalo_minuto, estado,
        sesion_externa, temp_min, temp_max)
     VALUES ($1, $2, $3, $4, 10, 'activa', $5, $6, $7)
     RETURNING id_sesion`,
    [
      idIndividuo, idDispositivo, idUsuario,
      fechaInicio, session_id,
      temp_min ?? null, temp_max ?? null,
    ]
  );

  const idSesion = sesion[0].id_sesion;
  sesionesActivas.set(session_id, idSesion);
  console.log(`[BD] ✅ Sesión creada: id=${idSesion} | ${individuo} (${especie})`);
  return idSesion;
}

// ═══════════════════════════════════════════════════════
//  POST /bionea/guardar
//  Recibe todos los envíos del ESP32
// ═══════════════════════════════════════════════════════
app.post('/bionea/guardar', async (req, res) => {
  const {
    session_id, tipo, fecha, hora,
    individuo,  especie,
    temperatura, temp_min, temp_max, alerta,
  } = req.body;

  // Validación mínima
  if (!session_id || !tipo || !fecha || !hora) {
    return res.status(400).json({
      error: 'Campos obligatorios: session_id, tipo, fecha, hora',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ────────────────────────────────────────────────────
    //  CASO 1: medición periódica (cada 10 s)
    // ────────────────────────────────────────────────────
    if (tipo === 'medicion') {
      if (temperatura == null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Falta temperatura' });
      }

      const idSesion = await obtenerOCrearSesion(client, {
        session_id, individuo, especie, fecha, hora, temp_min, temp_max,
      });

      const fechaHora = parsearFechaHora(fecha, hora);
      const estadoAlerta = alerta === 'FUERA DE RANGO' ? 'FUERA DE RANGO' : 'OK';

      await client.query(
        `INSERT INTO mediciones (id_sesion, fecha_hora, temperatura, alerta)
         VALUES ($1, $2, $3, $4)`,
        [idSesion, fechaHora, temperatura, estadoAlerta]
      );

      await client.query('COMMIT');
      console.log(`🌡️  [${hora}] ${individuo} → ${temperatura}°C | ${estadoAlerta}`);
      return res.json({ ok: true, tipo: 'medicion', id_sesion: idSesion });
    }

    // ────────────────────────────────────────────────────
    //  CASO 2: fin de sesión
    // ────────────────────────────────────────────────────
    if (tipo === 'fin_sesion') {
      // Buscar id_sesion en caché o en BD
      let idSesion = sesionesActivas.get(session_id);
      if (!idSesion) {
        const { rows } = await client.query(
          'SELECT id_sesion FROM sesiones WHERE sesion_externa = $1',
          [session_id]
        );
        idSesion = rows[0]?.id_sesion;
      }

      if (idSesion) {
        const fechaFin = parsearFechaHora(fecha, hora);

        // Calcular duración real en minutos
        const { rows: sesData } = await client.query(
          'SELECT fecha_inicio FROM sesiones WHERE id_sesion = $1',
          [idSesion]
        );
        let duracion = null;
        if (sesData.length) {
          duracion = Math.round(
            (fechaFin - new Date(sesData[0].fecha_inicio)) / 60_000
          );
        }

        await client.query(
          `UPDATE sesiones
             SET fecha_fin       = $1,
                 estado          = 'finalizada',
                 duracion_sesion = $2
           WHERE id_sesion = $3`,
          [fechaFin, duracion, idSesion]
        );

        sesionesActivas.delete(session_id);
        console.log(`🏁 Sesión ${idSesion} finalizada | ${duracion ?? '?'} min`);
      } else {
        console.warn(`⚠️  No se encontró sesión para session_id=${session_id}`);
      }

      await client.query('COMMIT');
      return res.json({ ok: true, tipo: 'fin_sesion' });
    }

    // Tipo no reconocido
    await client.query('ROLLBACK');
    return res.status(400).json({ error: `Tipo desconocido: "${tipo}"` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ERROR]', err.message);
    return res.status(500).json({
      error: 'Error interno del servidor',
      detalle: err.message,
    });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════
//  GET /health  —  verificar que la API y la BD responden
// ═══════════════════════════════════════════════════════
app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS ahora');
    res.json({
      status: 'ok',
      db: 'conectada',
      hora_servidor: rows[0].ahora,
      sesiones_en_memoria: sesionesActivas.size,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'sin conexión', detalle: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  ARRANQUE
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 BioNEA Organiks API — puerto ${PORT}`);
  console.log(`   POST /bionea/guardar  ← ESP32`);
  console.log(`   GET  /health          ← diagnóstico`);
});
