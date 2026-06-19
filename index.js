const pool = require('./db');

async function test() {
  const res = await pool.query('SELECT NOW()');
  console.log(res.rows);
}

test();