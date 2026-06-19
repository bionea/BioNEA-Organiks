const pool = require('./db');

async function getMediciones() {
  const res = await pool.query(`
    SELECT i.especie, m.temperatura, m.fecha_hora
    FROM mediciones m
    JOIN sesiones s ON m.id_sesion = s.id_sesion
    JOIN individuos i ON s.id_individuo = i.id_individuo
  `);

  console.log(res.rows);
}

getMediciones();