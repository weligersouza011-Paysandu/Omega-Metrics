const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DB_DIR, 'omega.db');

let db;

function initDatabase() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  createTables();
  seedMotivosDesligamento();
  return db;
}

function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createTables() {
  db.exec(`
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  ensureColumn('ponto_historico', 'cid', 'cid TEXT');
}

function ensureColumn(table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  } catch (err) {
    console.warn(`Aviso ao garantir coluna ${table}.${column}:`, err.message);
  }
}

function seedMotivosDesligamento() {
  const count = db.prepare('SELECT COUNT(*) as c FROM motivos_desligamento').get().c;
  if (count > 0) return;

  const insert = db.prepare('INSERT INTO motivos_desligamento (codigo, label, conta_turnover) VALUES (?, ?, ?)');
  const motivos = [
    ['absenteismo', 'Excesso de Atestados / Absenteísmo', 1],
    ['baixa_produtividade', 'Baixa Produtividade', 1],
    ['desvio_comportamental', 'Desvio Comportamental', 1],
    ['pedido_demissao', 'Pedido de Demissão pelo Colaborador', 1],
    ['reducao_quadro', 'Redução de Quadro / Desmobilização do Cliente', 0]
  ];
  withTransaction(() => {
    for (const m of motivos) insert.run(...m);
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

function createLote(arquivoPonto, arquivoDeslig, payload) {
  const loteId = generateLoteId();
  db.prepare(`
    INSERT INTO lotes_importacao (id, arquivo_ponto, arquivo_deslig, payload_json, registros_lidos, criado_em)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    loteId,
    arquivoPonto,
    arquivoDeslig || null,
    JSON.stringify(payload),
    (payload.pontoData && payload.pontoData.length) || 0,
    nowIso()
  );
  return loteId;
}

function getLote(loteId) {
  return db.prepare('SELECT * FROM lotes_importacao WHERE id = ?').get(loteId);
}

function confirmLote(loteId) {
  db.prepare('UPDATE lotes_importacao SET status = ?, confirmado_em = ? WHERE id = ?')
    .run('confirmado', nowIso(), loteId);
}

function upsertPontoHistorico(registros, loteId) {
  const stmt = db.prepare(`
    INSERT INTO ponto_historico (
      data_registro, chave_funcionario, nome_funcionario, cargo, departamento,
      entrada1, saida2, total_normais, adicional_noturno, dia_falta,
      horas_atraso, falta_e_atraso, atestado, extra50, status, cid,
      lote_id, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  `);
  const existsStmt = db.prepare(
    'SELECT 1 FROM ponto_historico WHERE data_registro = ? AND chave_funcionario = ?'
  );

  return withTransaction(() => {
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
      const existed = !!existsStmt.get(dataRegistro, chave);

      stmt.run(
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
      );

      if (existed) atualizados++;
      else inseridos++;
      datasTocadas.add(dataRegistro);
    }

    return { inseridos, atualizados, pulados, datasTocadas: [...datasTocadas] };
  });
}

function insertDesligamentosJustificados(desligamentos, loteId) {
  const stmt = db.prepare(`
    INSERT INTO desligamentos_justificados (
      data_desligamento, chave_funcionario, nome_funcionario, cargo, departamento,
      campo_detectado, valor_original, justificativa_rh, conta_turnover,
      lote_id, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  `);
  const motivoStmt = db.prepare('SELECT conta_turnover FROM motivos_desligamento WHERE codigo = ?');

  return withTransaction(() => {
    let count = 0;
    const datasTocadas = new Set();

    for (const d of desligamentos) {
      const motivo = motivoStmt.get(d.codigoMotivo);
      const contaTurnover = motivo ? motivo.conta_turnover : 1;
      const dataDeslig = normalizeDate(d.dia) || normalizeDate(d.data_desligamento);
      if (!dataDeslig) continue;
      const chave = normalizeFuncionarioKey(d.nomeFuncionario, d.matricula);

      stmt.run(
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
      );
      count++;
      datasTocadas.add(dataDeslig);
    }

    return { count, datasTocadas: [...datasTocadas] };
  });
}

function updateCalendario(datas) {
  const upsert = db.prepare(`
    INSERT INTO calendario_datas (data, registros_ponto, desligamentos)
    VALUES (?, ?, ?)
    ON CONFLICT(data) DO UPDATE SET
      registros_ponto = excluded.registros_ponto,
      desligamentos = excluded.desligamentos
  `);
  const countPonto = db.prepare('SELECT COUNT(*) as c FROM ponto_historico WHERE data_registro = ?');
  const countDeslig = db.prepare('SELECT COUNT(*) as c FROM desligamentos_justificados WHERE data_desligamento = ?');

  return withTransaction(() => {
    const unicas = [...new Set(datas.filter(Boolean))];
    for (const data of unicas) {
      const p = countPonto.get(data).c;
      const d = countDeslig.get(data).c;
      upsert.run(data, p, d);
    }
    return unicas.length;
  });
}

function getPontoHistorico(dataInicio, dataFim) {
  return db.prepare(`
    SELECT * FROM ponto_historico
    WHERE data_registro BETWEEN ? AND ?
    ORDER BY data_registro, nome_funcionario
  `).all(dataInicio, dataFim);
}

function getDesligamentosHistorico(dataInicio, dataFim) {
  return db.prepare(`
    SELECT * FROM desligamentos_justificados
    WHERE data_desligamento BETWEEN ? AND ?
    ORDER BY data_desligamento, nome_funcionario
  `).all(dataInicio, dataFim);
}

function getCalendarioDatas() {
  return db.prepare(`
    SELECT data, registros_ponto, desligamentos
    FROM calendario_datas
    ORDER BY data
  `).all();
}

function getPeriodoLimites() {
  const min = db.prepare('SELECT MIN(data_registro) as min FROM ponto_historico').get();
  const max = db.prepare('SELECT MAX(data_registro) as max FROM ponto_historico').get();
  return { min: min && min.min ? min.min : null, max: max && max.max ? max.max : null };
}

function getEfetivoTotal(dataInicio, dataFim) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT chave_funcionario) as total
    FROM ponto_historico
    WHERE data_registro BETWEEN ? AND ?
  `).get(dataInicio, dataFim);
  return (row && row.total) || 0;
}

function getTurnoverCounts(dataInicio, dataFim) {
  const rows = db.prepare(`
    SELECT conta_turnover, COUNT(*) as qtd
    FROM desligamentos_justificados
    WHERE data_desligamento BETWEEN ? AND ?
    GROUP BY conta_turnover
  `).all(dataInicio, dataFim);
  const result = { operacional: 0, reducao: 0 };
  for (const r of rows) {
    if (r.conta_turnover === 1) result.operacional = r.qtd;
    else result.reducao = r.qtd;
  }
  return result;
}

module.exports = {
  initDatabase,
  getDb: () => db,
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
  getEfetivoTotal,
  getTurnoverCounts,
  normalizeDate,
  normalizeFuncionarioKey,
  formatHorarioValue
};