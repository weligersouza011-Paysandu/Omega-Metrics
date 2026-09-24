const { types } = require('pg');

// COUNT(*) retorna int8 — padroniza como Number para manter a matemática dos KPIs
types.setTypeParser(20, (val) => parseInt(val, 10));

let pool = null;

function initDatabase(pgPool) {
  pool = pgPool;
  return createSchema().then(() => seedMotivosDesligamento());
}

function getPool() {
  return pool;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lotes_importacao (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pendente',
      arquivo_ponto TEXT,
      arquivo_deslig TEXT,
      payload_json TEXT NOT NULL,
      registros_lidos INTEGER DEFAULT 0,
      criado_em TEXT NOT NULL,
      confirmado_em TEXT
    );

    CREATE TABLE IF NOT EXISTS ponto_historico (
      id SERIAL PRIMARY KEY,
      data_registro TEXT NOT NULL,
      chave_funcionario TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      cargo TEXT,
      departamento TEXT,
      entrada1 TEXT,
      saida2 TEXT,
      total_normais REAL DEFAULT 0,
      adicional_noturno REAL DEFAULT 0,
      dia_falta TEXT,
      horas_atraso REAL DEFAULT 0,
      falta_e_atraso TEXT,
      atestado TEXT,
      extra50 REAL DEFAULT 0,
      status TEXT,
      cid TEXT,
      lote_id TEXT REFERENCES lotes_importacao(id),
      atualizado_em TEXT NOT NULL,
      UNIQUE (data_registro, chave_funcionario)
    );
    CREATE INDEX IF NOT EXISTS idx_ponto_data ON ponto_historico(data_registro);
    CREATE INDEX IF NOT EXISTS idx_ponto_funcionario ON ponto_historico(chave_funcionario);

    CREATE TABLE IF NOT EXISTS desligamentos_justificados (
      id SERIAL PRIMARY KEY,
      data_desligamento TEXT NOT NULL,
      chave_funcionario TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      cargo TEXT,
      departamento TEXT,
      campo_detectado TEXT NOT NULL,
      valor_original TEXT NOT NULL,
      justificativa_rh TEXT NOT NULL,
      conta_turnover INTEGER NOT NULL,
      lote_id TEXT REFERENCES lotes_importacao(id),
      criado_em TEXT NOT NULL,
      UNIQUE (data_desligamento, chave_funcionario)
    );
    CREATE INDEX IF NOT EXISTS idx_deslig_data ON desligamentos_justificados(data_desligamento);
    CREATE INDEX IF NOT EXISTS idx_deslig_funcionario ON desligamentos_justificados(chave_funcionario);

    CREATE TABLE IF NOT EXISTS motivos_desligamento (
      codigo TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      conta_turnover INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendario_datas (
      data TEXT PRIMARY KEY,
      registros_ponto INTEGER DEFAULT 0,
      desligamentos INTEGER DEFAULT 0
    );
  `);
  await pool.query('ALTER TABLE ponto_historico ADD COLUMN IF NOT EXISTS cid TEXT');
}

async function seedMotivosDesligamento() {
  const countResult = await pool.query('SELECT COUNT(*) as c FROM motivos_desligamento');
  if (countResult.rows[0].c > 0) return;

  const motivos = [
    ['absenteismo', 'Excesso de Atestados / Absenteísmo', 1],
    ['baixa_produtividade', 'Baixa Produtividade', 1],
    ['desvio_comportamental', 'Desvio Comportamental', 1],
    ['pedido_demissao', 'Pedido de Demissão pelo Colaborador', 1],
    ['reducao_quadro', 'Redução de Quadro / Desmobilização do Cliente', 0]
  ];
  await withTransaction(async (client) => {
    for (const m of motivos) {
      await client.query(
        'INSERT INTO motivos_desligamento (codigo, label, conta_turnover) VALUES ($1, $2, $3) ON CONFLICT (codigo) DO NOTHING',
        m
      );
    }
  });
}

function generateLoteId() {
  return 'lote_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDate(dateStr) {
  if (dateStr === null || dateStr === undefined) return null;
  if (dateStr instanceof Date && !isNaN(dateStr)) {
    return dateStr.toISOString().slice(0, 10);
  }
  const str = String(dateStr).trim();
  if (!str) return null;

  if (/^\d{5}(\.\d+)?$/.test(str)) {
    const serial = parseFloat(str);
    if (serial > 20000 && serial < 80000) {
      const epoch = Date.UTC(1899, 11, 30);
      return new Date(epoch + serial * 86400000).toISOString().slice(0, 10);
    }
  }

  const parts = str.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const [d, m, y] = parts;
    if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (d.length === 4) return `${d}-${m.padStart(2, '0')}-${y.padStart(2, '0')}`;
  }
  return str;
}

function normalizeFuncionarioKey(nome, matricula) {
  if (matricula && String(matricula).trim() !== '') {
    return 'MAT_' + String(matricula).trim().toUpperCase();
  }
  return 'NOM_' + String(nome || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function formatHorarioValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    if (v.type === 'time' && v.time !== null && v.time !== undefined) {
      const h = Math.floor(v.time / 60);
      const m = v.time % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
    if (v.text) return String(v.text).trim() || null;
  }
  return null;
}

async function createLote(arquivoPonto, arquivoDeslig, payload) {
  const loteId = generateLoteId();
  await pool.query(`
    INSERT INTO lotes_importacao (id, arquivo_ponto, arquivo_deslig, payload_json, registros_lidos, criado_em)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    loteId,
    arquivoPonto,
    arquivoDeslig || null,
    JSON.stringify(payload),
    (payload.pontoData && payload.pontoData.length) || 0,
    nowIso()
  ]);
  return loteId;
}

async function getLote(loteId) {
  const result = await pool.query('SELECT * FROM lotes_importacao WHERE id = $1', [loteId]);
  return result.rows[0];
}

async function confirmLote(loteId) {
  await pool.query(
    'UPDATE lotes_importacao SET status = $1, confirmado_em = $2 WHERE id = $3',
    ['confirmado', nowIso(), loteId]
  );
}

async function upsertPontoHistorico(registros, loteId) {
  const upsertSql = `
    INSERT INTO ponto_historico (
      data_registro, chave_funcionario, nome_funcionario, cargo, departamento,
      entrada1, saida2, total_normais, adicional_noturno, dia_falta,
      horas_atraso, falta_e_atraso, atestado, extra50, status, cid,
      lote_id, atualizado_em
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT(data_registro, chave_funcionario) DO UPDATE SET
      nome_funcionario = excluded.nome_funcionario,
      cargo = excluded.cargo,
      departamento = excluded.departamento,
      entrada1 = excluded.entrada1,
      saida2 = excluded.saida2,
      total_normais = excluded.total_normais,
      adicional_noturno = excluded.adicional_noturno,
      dia_falta = excluded.dia_falta,
      horas_atraso = excluded.horas_atraso,
      falta_e_atraso = excluded.falta_e_atraso,
      atestado = excluded.atestado,
      extra50 = excluded.extra50,
      status = excluded.status,
      cid = excluded.cid,
      lote_id = excluded.lote_id,
      atualizado_em = excluded.atualizado_em
  `;

  return withTransaction(async (client) => {
    let inseridos = 0;
    let atualizados = 0;
    let pulados = 0;
    const datasTocadas = new Set();

    for (const r of registros) {
      const dataRegistro = normalizeDate(r.dia);
      if (!dataRegistro) {
        pulados++;
        continue;
      }
      const chave = normalizeFuncionarioKey(r.nomeFuncionario, r.matricula);
      const existsResult = await client.query(
        'SELECT 1 FROM ponto_historico WHERE data_registro = $1 AND chave_funcionario = $2',
        [dataRegistro, chave]
      );
      const existed = existsResult.rowCount > 0;

      await client.query(upsertSql, [
        dataRegistro,
        chave,
        r.nomeFuncionario || '',
        r.nomeCargo || null,
        r.nomeDepartamento || null,
        formatHorarioValue(r.entrada1),
        formatHorarioValue(r.saida2),
        r.totalNormais || 0,
        r.adicionalNoturno || 0,
        r.diaFalta || null,
        r.horasAtraso || 0,
        r.faltaEAtraso || null,
        r.atestado || null,
        r.extra50 || 0,
        r.status || null,
        (r.cid && String(r.cid).trim()) ? String(r.cid).trim() : null,
        loteId,
        nowIso()
      ]);

      if (existed) atualizados++;
      else inseridos++;
      datasTocadas.add(dataRegistro);
    }

    return { inseridos, atualizados, pulados, datasTocadas: [...datasTocadas] };
  });
}

async function insertDesligamentosJustificados(desligamentos, loteId) {
  const upsertSql = `
    INSERT INTO desligamentos_justificados (
      data_desligamento, chave_funcionario, nome_funcionario, cargo, departamento,
      campo_detectado, valor_original, justificativa_rh, conta_turnover,
      lote_id, criado_em
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(data_desligamento, chave_funcionario) DO UPDATE SET
      nome_funcionario = excluded.nome_funcionario,
      cargo = excluded.cargo,
      departamento = excluded.departamento,
      campo_detectado = excluded.campo_detectado,
      valor_original = excluded.valor_original,
      justificativa_rh = excluded.justificativa_rh,
      conta_turnover = excluded.conta_turnover,
      lote_id = excluded.lote_id,
      criado_em = excluded.criado_em
  `;

  return withTransaction(async (client) => {
    let count = 0;
    const datasTocadas = new Set();

    for (const d of desligamentos) {
      const motivoResult = await client.query(
        'SELECT conta_turnover FROM motivos_desligamento WHERE codigo = $1',
        [d.codigoMotivo]
      );
      const motivo = motivoResult.rows[0];
      const contaTurnover = motivo ? motivo.conta_turnover : 1;
      const dataDeslig = normalizeDate(d.dia) || normalizeDate(d.data_desligamento);
      if (!dataDeslig) continue;
      const chave = normalizeFuncionarioKey(d.nomeFuncionario, d.matricula);

      await client.query(upsertSql, [
        dataDeslig,
        chave,
        d.nomeFuncionario || '',
        d.cargo || null,
        d.departamento || null,
        d.campoDetectado || 'status',
        d.valorOriginal || '',
        d.codigoMotivo,
        contaTurnover,
        loteId,
        nowIso()
      ]);
      count++;
      datasTocadas.add(dataDeslig);
    }

    return { count, datasTocadas: [...datasTocadas] };
  });
}

async function updateCalendario(datas) {
  return withTransaction(async (client) => {
    const unicas = [...new Set(datas.filter(Boolean))];
    for (const data of unicas) {
      const pResult = await client.query(
        'SELECT COUNT(*) as c FROM ponto_historico WHERE data_registro = $1', [data]
      );
      const dResult = await client.query(
        'SELECT COUNT(*) as c FROM desligamentos_justificados WHERE data_desligamento = $1', [data]
      );
      await client.query(`
        INSERT INTO calendario_datas (data, registros_ponto, desligamentos)
        VALUES ($1, $2, $3)
        ON CONFLICT(data) DO UPDATE SET
          registros_ponto = excluded.registros_ponto,
          desligamentos = excluded.desligamentos
      `, [data, pResult.rows[0].c, dResult.rows[0].c]);
    }
    return unicas.length;
  });
}

async function getPontoHistorico(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT * FROM ponto_historico
    WHERE data_registro BETWEEN $1 AND $2
    ORDER BY data_registro, nome_funcionario
  `, [dataInicio, dataFim]);
  return result.rows;
}

async function getDesligamentosHistorico(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT * FROM desligamentos_justificados
    WHERE data_desligamento BETWEEN $1 AND $2
    ORDER BY data_desligamento, nome_funcionario
  `, [dataInicio, dataFim]);
  return result.rows;
}

async function getCalendarioDatas() {
  const result = await pool.query(`
    SELECT data, registros_ponto, desligamentos
    FROM calendario_datas
    ORDER BY data
  `);
  return result.rows;
}

function isValidDate(data) {
  return typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data);
}

function invalidDateError() {
  const err = new Error('Data inválida. Use o formato YYYY-MM-DD.');
  err.statusCode = 400;
  return err;
}

async function countByDate(data) {
  if (!isValidDate(data)) throw invalidDateError();
  const pontoResult = await pool.query(
    'SELECT COUNT(*) as c FROM ponto_historico WHERE data_registro = $1', [data]
  );
  const desligResult = await pool.query(
    'SELECT COUNT(*) as c FROM desligamentos_justificados WHERE data_desligamento = $1', [data]
  );
  const funcsResult = await pool.query(
    'SELECT COUNT(DISTINCT chave_funcionario) as c FROM ponto_historico WHERE data_registro = $1', [data]
  );
  return {
    ponto: pontoResult.rows[0].c,
    desligamentos: desligResult.rows[0].c,
    funcionarios: funcsResult.rows[0].c
  };
}

async function getByDate(data) {
  if (!isValidDate(data)) throw invalidDateError();
  const ponto = await pool.query(
    'SELECT * FROM ponto_historico WHERE data_registro = $1 ORDER BY nome_funcionario', [data]
  );
  const desligamentos = await pool.query(
    'SELECT * FROM desligamentos_justificados WHERE data_desligamento = $1 ORDER BY nome_funcionario', [data]
  );
  return { ponto: ponto.rows, desligamentos: desligamentos.rows };
}

async function deleteByDate(data) {
  if (!isValidDate(data)) throw invalidDateError();
  return withTransaction(async (client) => {
    const ponto = await client.query('DELETE FROM ponto_historico WHERE data_registro = $1', [data]);
    const deslig = await client.query(
      'DELETE FROM desligamentos_justificados WHERE data_desligamento = $1', [data]
    );
    const restantePonto = await client.query(
      'SELECT COUNT(*) as c FROM ponto_historico WHERE data_registro = $1', [data]
    );
    const restanteDeslig = await client.query(
      'SELECT COUNT(*) as c FROM desligamentos_justificados WHERE data_desligamento = $1', [data]
    );
    if (restantePonto.rows[0].c === 0 && restanteDeslig.rows[0].c === 0) {
      await client.query('DELETE FROM calendario_datas WHERE data = $1', [data]);
    }
    return { ponto: ponto.rowCount, desligamentos: deslig.rowCount };
  });
}

async function getPeriodoLimites() {
  const result = await pool.query(
    'SELECT MIN(data_registro) as min, MAX(data_registro) as max FROM ponto_historico'
  );
  const row = result.rows[0];
  return { min: row.min || null, max: row.max || null };
}

async function getEfetivoTotal(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT COUNT(DISTINCT chave_funcionario) as total
    FROM ponto_historico
    WHERE data_registro BETWEEN $1 AND $2
  `, [dataInicio, dataFim]);
  return result.rows[0].total || 0;
}

async function getTurnoverCounts(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT conta_turnover, COUNT(*) as qtd
    FROM desligamentos_justificados
    WHERE data_desligamento BETWEEN $1 AND $2
    GROUP BY conta_turnover
  `, [dataInicio, dataFim]);
  const counts = { operacional: 0, reducao: 0 };
  for (const r of result.rows) {
    if (r.conta_turnover === 1) counts.operacional = r.qtd;
    else counts.reducao = r.qtd;
  }
  return counts;
}

module.exports = {
  initDatabase,
  getPool,
  getDb: () => pool,
  createLote,
  getLote,
  confirmLote,
  upsertPontoHistorico,
  insertDesligamentosJustificados,
  updateCalendario,
  getPontoHistorico,
  getDesligamentosHistorico,
  getCalendarioDatas,
  getPeriodoLimites,
  countByDate,
  getByDate,
  deleteByDate,
  isValidDate,
  getEfetivoTotal,
  getTurnoverCounts,
  normalizeDate,
  normalizeFuncionarioKey,
  formatHorarioValue
};
