-- ═══════════════════════════════════════════════════════════
--  BioNEA Organiks — Migraciones para Supabase
--  Ejecutar en: Supabase → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────
--  1. individuos
--     codigo_individuo era NUMBER, pero el ESP32 envía
--     códigos como "LAG-001" → cambiar a texto
-- ───────────────────────────────────────────────────────────
ALTER TABLE individuos
  ALTER COLUMN codigo_individuo TYPE VARCHAR(50);


-- ───────────────────────────────────────────────────────────
--  2. sesiones
--     sesion_externa: guarda el session_id que genera el
--     ESP32 (String de millis()). Permite que el servidor
--     Node.js retome la sesión aunque se reinicie.
--
--     temp_min / temp_max: rango configurado al iniciar
--     la sesión desde la interfaz web del ESP32.
-- ───────────────────────────────────────────────────────────
ALTER TABLE sesiones
  ADD COLUMN IF NOT EXISTS sesion_externa TEXT,
  ADD COLUMN IF NOT EXISTS temp_min       NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS temp_max       NUMERIC(5, 2);


-- ───────────────────────────────────────────────────────────
--  3. mediciones
--     alerta: 'OK' o 'FUERA DE RANGO', calculada por el
--     ESP32 al comparar la temperatura con temp_min/max.
-- ───────────────────────────────────────────────────────────
ALTER TABLE mediciones
  ADD COLUMN IF NOT EXISTS alerta TEXT DEFAULT 'OK';


-- ───────────────────────────────────────────────────────────
--  4. Índices para mejorar el rendimiento de las consultas
-- ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sesiones_externa
  ON sesiones(sesion_externa);

CREATE INDEX IF NOT EXISTS idx_sesiones_individuo
  ON sesiones(id_individuo);

CREATE INDEX IF NOT EXISTS idx_mediciones_sesion
  ON mediciones(id_sesion);

CREATE INDEX IF NOT EXISTS idx_mediciones_fecha
  ON mediciones(fecha_hora DESC);
