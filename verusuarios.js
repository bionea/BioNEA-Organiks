const pool = require('./db');

async function getUsuarios() {
  const res = await pool.query('SELECT * FROM usuarios');
  console.log(res.rows);
}

getUsuarios();