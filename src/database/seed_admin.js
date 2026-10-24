require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function seedAdmin() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const senhaHash = await bcrypt.hash('1234', 10);
    const sql = `
      INSERT INTO usuarios (matricula, nome, senha_hash, perfil, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (matricula) DO UPDATE SET
        nome = EXCLUDED.nome,
        senha_hash = EXCLUDED.senha_hash,
        perfil = EXCLUDED.perfil,
        status = EXCLUDED.status
      RETURNING id, matricula, nome, perfil, status, created_at;
    `;
    const res = await pool.query(sql, ['23574', 'Weligton Souza', senhaHash, 'Gestao', 'Ativo']);
    console.log('✅ Usuário Gestor Master inserido/atualizado com sucesso:');
    console.log(res.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao semear usuário:', err);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seedAdmin();
}

module.exports = { seedAdmin };
