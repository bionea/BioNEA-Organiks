const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'bionea_db',
  password: '200588',
  port: 5432,
});

module.exports = pool;