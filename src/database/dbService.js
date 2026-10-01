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
    CREATE INDEX IF NOT EXISTS idx_ponto_perf ON ponto_historico (data_registro, status, cargo);

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

    CREATE TABLE IF NOT EXISTS calendario_operacional (
      data DATE PRIMARY KEY,
      tipo_dia VARCHAR(20) NOT NULL DEFAULT 'UTIL',
      descricao VARCHAR(100)
    );
    CREATE INDEX IF NOT EXISTS idx_calendario_data ON calendario_operacional (data);
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

  // Passo 6: adiciona RETURNING para detectar INSERT vs UPDATE sem pré-SELECT.
  // xmax = 0 → linha acabou de ser inserida; xmax ≠ 0 → linha atualizada.
  // Elimina o N+1 problem (antes: 2 queries por linha; agora: 1 query por linha).
  const upsertSqlReturning = upsertSql + '\n    RETURNING (xmax = 0) AS is_insert';

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

      // Uma única query por linha (UPSERT + RETURNING xmax).
      // Sem pré-SELECT: redução de N+1 → N queries para N registros.
      const result = await client.query(upsertSqlReturning, [
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

      const wasInsert = result.rows[0] && result.rows[0].is_insert;
      if (wasInsert) inseridos++;
      else atualizados++;
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

/**
 * getPontoParaTurnover — realiza agregação mensal por colaborador e cargo
 * diretamente no PostgreSQL (COUNT/GROUP BY). Reduz a transferência de
 * 100.000 linhas diárias para ~400 linhas mensais (redução de 99.6% no payload Neon→Node).
 */
async function getPontoParaTurnover(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT
      LEFT(data_registro, 7) || '-01' AS data_registro,
      chave_funcionario,
      MAX(nome_funcionario) AS nome_funcionario,
      COALESCE(TRIM(cargo), '') AS cargo,
      COALESCE(TRIM(departamento), '') AS departamento,
      CASE
        WHEN MAX(CASE WHEN TRIM(status) IN ('LICENÇA PATERNIDADE', 'LICENÇA MATERNIDADE', 'FÉRIAS', 'INSS') THEN 1 ELSE 0 END) = 1
        THEN 'INSS'
        ELSE 'PRESENTE'
      END AS status
    FROM ponto_historico
    WHERE data_registro BETWEEN $1 AND $2
    GROUP BY LEFT(data_registro, 7), chave_funcionario, COALESCE(TRIM(cargo), ''), COALESCE(TRIM(departamento), '')
    ORDER BY data_registro, nome_funcionario
  `, [dataInicio, dataFim]);
  return result.rows;
}

/**
 * getKpisAgregados — agrega os dados de absenteísmo diretamente no PostgreSQL
 * usando CTE com classificação de status, eliminando a transferência de linhas
 * brutas. Retorna contagens por dia, mês, cargo e funcionário já calculadas.
 *
 * Regra de classificação (espelha statusRules.js):
 *   geraAbsenteismo  → conta como falta E como previsto
 *   contaComoPresenca → conta apenas como previsto (não é falta)
 *   grupo DESCONHECIDO → também conta como previsto (comportamento legado)
 *   ISENCAO / DEMISSAO → excluído dos KPIs de absenteísmo
 *
 * Filtros cruzados opcionais (cada componente passa skip='sua-dimensão' para
 * manter a regra de escopo — o banco filtra apenas as dimensões que o
 * componente não deve pular).
 *
 * @param {string} dataInicio
 * @param {string} dataFim
 * @param {object} filtros  - { status, dia, mes, colaborador, funcao }
 *                            null ou string vazia = sem filtro para a dimensão
 * @param {string|null} skip - dimensão a ser pulada neste request (regra de escopo)
 */
async function getKpisAgregados(dataInicio, dataFim, filtros, skip) {
  const f = filtros || {};
  const fStatus  = (skip !== 'status'      && f.status      && String(f.status).trim())      ? String(f.status).trim()      : null;
  const fDia     = (skip !== 'dia'         && f.dia         && String(f.dia).trim())          ? String(f.dia).trim()         : null;
  const fMes     = (skip !== 'mes'         && f.mes         && String(f.mes).trim())          ? String(f.mes).trim()         : null;
  const fColab   = (skip !== 'colaborador' && f.colaborador && String(f.colaborador).trim())  ? String(f.colaborador).trim().toUpperCase() : null;
  const fFuncao  = (skip !== 'funcao'      && f.funcao      && String(f.funcao).trim())       ? String(f.funcao).trim().toUpperCase()       : null;

  // Listas de status que geram absenteísmo (= geraAbsenteismo: true em statusRules.js)
  const FALTAS = [
    'FALTA SEM JUSTIFICATIVA', 'FALTA', 'ATESTADO MÉDICO', 'ATESTADO MEDICO', 'ATESTADO',
    'ATESTADO DE ÓBITO', 'ATESTADO DE OBITO', 'DECLARAÇÃO', 'DECLARACAO', 'DECLARACAO BANCO',
    'BO', 'BOLETIM DE OCORRENCIA', 'ÓBITO', 'OBITO',
    'LICENÇA CASAMENTO', 'LICENCA CASAMENTO', 'LICENÇA PATERNIDADE', 'LICENCA PATERNIDADE',
    'SUSPENSÃO', 'SUSPENSAO', 'SUSPENCAO'
  ];
  // Listas de status que contam como presença (= contaComoPresenca: true)
  const PRESENCAS = [
    'PRESENTE', 'ADVERTÊNCIA', 'ADVERTENCIA', 'TRABALHO EXTERNO', 'RELOGIO BLOQUEADO', 'TRABALHO REMOTO'
  ];
  // Status de isenção/demissão que NÃO entram no denominador (excluídos de KPIs)
  const EXCLUIDOS = [
    'COMPENSAÇÃO', 'COMPENSACAO', 'FÉRIAS', 'FERIAS', 'FOLGA', 'JUSTIFICADO FOLGA', 'EXAME PERIÓDICO', 'EXAME PERIODICO', 'EXAME',
    'LICENÇA MATERNIDADE', 'LICENCA MATERNIDADE', 'INSS', 'LICENCA INSS', 'AGUARDANDO CRACHÁ', 'AGUARDANDO CRACHA',
    'TREINAMENTO', 'FERIADO', 'AGUARDANDO MOBILIZAÇÃO SGC', 'TRANSFERÊNCIA',
    'À DISPOSIÇÃO', 'A DISPOSICAO', 'DISPOSICAO', 'COMPENSADO', 'ABONO', 'À COMPENSAR', 'A COMPENSAR',
    'ACORDO COLETIVO', 'FOLGA ANIVERSÁRIO', 'FOLGA ANIVERSARIO', 'DEMITIDO', 'DEMISSAO', 'DEMISSÃO', 'DESLIGADO', 'RESCISAO', 'RESCISÃO'
  ];

  // Parametrização dinâmica: $1 e $2 são sempre dataInicio/dataFim.
  // Os filtros opcionais ocupam posições $3 em diante.
  const params = [dataInicio, dataFim];
  let idx = 3;

  function addParam(val) {
    params.push(val);
    return `$${idx++}`;
  }

  const whereClauses = [];
  if (fDia)    whereClauses.push(`data_registro = ${addParam(fDia)}`);
  if (fMes)    whereClauses.push(`LEFT(data_registro, 7) = ${addParam(fMes)}`);
  if (fColab)  whereClauses.push(`UPPER(TRIM(nome_funcionario)) = ${addParam(fColab)}`);
  if (fFuncao) whereClauses.push(`UPPER(TRIM(cargo)) = ${addParam(fFuncao)}`);
  if (fStatus) whereClauses.push(`UPPER(TRIM(status)) = ${addParam(fStatus.toUpperCase())}`);

  const extraWhere = whereClauses.length ? 'AND ' + whereClauses.join(' AND ') : '';

  // Parâmetros extras para o LEFT JOIN com calendario_operacional
  // (não há parâmetros adicionais — o filtro usa COALESCE inline)

  const sql = `
    WITH base AS (
      SELECT
        ph.data_registro,
        LEFT(ph.data_registro, 7)               AS mes,
        ph.chave_funcionario,
        COALESCE(TRIM(ph.nome_funcionario), '') AS nome_funcionario,
        COALESCE(TRIM(ph.cargo), '')            AS cargo,
        COALESCE(TRIM(ph.status), '')           AS status_raw,
        COALESCE(cal.tipo_dia, 'UTIL')          AS tipo_dia,
        CASE
          WHEN UPPER(TRIM(ph.status)) = ANY(${ addParam(FALTAS) }::text[])    THEN 'falta'
          WHEN UPPER(TRIM(ph.status)) = ANY(${ addParam(PRESENCAS) }::text[]) THEN 'presenca'
          WHEN UPPER(TRIM(ph.status)) = ANY(${ addParam(EXCLUIDOS) }::text[]) THEN 'excluido'
          ELSE 'desconhecido'
        END AS classe
      FROM ponto_historico ph
      LEFT JOIN calendario_operacional cal
        ON cal.data = ph.data_registro::date
      WHERE ph.data_registro BETWEEN $1 AND $2
        ${extraWhere}
    ),
    contaveis AS (
      SELECT * FROM base
    )
    SELECT
      -- Totais globais (KPI geral de absenteísmo)
      SUM(CASE WHEN tipo_dia = 'UTIL' AND classe = 'falta' THEN 1 ELSE 0 END)::int AS total_faltas,
      SUM(CASE WHEN tipo_dia = 'UTIL' AND classe <> 'excluido' THEN 1 ELSE 0 END)::int AS total_previstos,
      SUM(CASE WHEN classe = 'falta' THEN 1 ELSE 0 END)::int AS cal_faltas,
      SUM(CASE WHEN classe <> 'excluido' THEN 1 ELSE 0 END)::int AS cal_previstos,
      SUM(CASE WHEN UPPER(TRIM(status_raw)) = 'INSS' OR UPPER(TRIM(status_raw)) = 'LICENCA INSS' THEN 1 ELSE 0 END)::int AS total_inss,
      SUM(CASE WHEN UPPER(TRIM(status_raw)) = 'FÉRIAS' OR UPPER(TRIM(status_raw)) = 'FERIAS' THEN 1 ELSE 0 END)::int AS total_ferias,
      SUM(CASE WHEN UPPER(TRIM(status_raw)) = 'LICENÇA MATERNIDADE' OR UPPER(TRIM(status_raw)) = 'LICENCA MATERNIDADE' THEN 1 ELSE 0 END)::int AS total_maternidade,
      -- Por status (rosca de justificativas — inclui apenas faltas)
      status_raw,
      -- Por dia
      data_registro,
      -- Por mês
      mes,
      -- Por cargo
      cargo,
      -- Por funcionário
      nome_funcionario,
      chave_funcionario
    FROM contaveis
    GROUP BY GROUPING SETS (
      (),                                                       -- linha total (idx=0)
      (status_raw),                                             -- por status
      (data_registro),                                          -- por dia
      (mes),                                                    -- por mes
      (chave_funcionario, nome_funcionario, cargo)             -- por funcionario com funcao e chave
    )
    ORDER BY data_registro NULLS LAST, mes NULLS LAST, cargo NULLS LAST, nome_funcionario NULLS LAST
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

// Mantida por compatibilidade (usada em getByDate e outros pontos administrativos).
async function getPontoHistorico(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT * FROM ponto_historico
    WHERE data_registro BETWEEN $1 AND $2
    ORDER BY data_registro, nome_funcionario
  `, [dataInicio, dataFim]);
  return result.rows;
}

async function getDesligamentosHistorico(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) {
    const result = await pool.query(`
      SELECT * FROM desligamentos_justificados
      ORDER BY data_desligamento, nome_funcionario
    `);
    return result.rows;
  }
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

/**
 * getTipoDiasPorPeriodo — retorna o tipo_dia (UTIL/FERIADO/COMPENSADO) de
 * cada data registrada em calendario_operacional dentro do período.
 * Usado pelo servidor para enriquecer absenteismoPorDia com o campo tipo_dia,
 * permitindo destacar bordas de feriados/compensados no calendário do dashboard.
 * @param {string} dataInicio - 'YYYY-MM-DD'
 * @param {string} dataFim    - 'YYYY-MM-DD'
 * @returns {Array<{ data: string, tipo_dia: string, descricao: string }>}
 */
async function getTipoDiasPorPeriodo(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT data::text AS data, tipo_dia, descricao
    FROM calendario_operacional
    WHERE data BETWEEN $1::date AND $2::date
    ORDER BY data
  `, [dataInicio, dataFim]);
  return result.rows;
}

/**
 * getCalendarioOperacional — retorna todos os dias do mês/ano informados
 * que possuam registro na tabela calendario_operacional.
 * @param {number} mes  - 1..12
 * @param {number} ano  - ex. 2026
 */
async function getCalendarioOperacional(mes, ano) {
  const dataInicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const dataFim    = `${ano}-${String(mes).padStart(2, '0')}-31`; // PostgreSQL corta no último dia do mês
  const result = await pool.query(`
    SELECT data::text AS data, tipo_dia, descricao
    FROM calendario_operacional
    WHERE data >= $1::date AND data <= ($1::date + INTERVAL '1 month - 1 day')::date
    ORDER BY data
  `, [dataInicio]);
  return result.rows;
}

/**
 * getCalendarioPeriodoMapa — UMA única consulta com intervalo de datas
 * (`WHERE data >= $1 AND data <= $2`) e devolve um Map<data, {tipo_dia, descricao}>
 * para leitura O(1) no backend (nenhuma consulta sequencial por dia/mês).
 * @param {string} dataInicio - 'YYYY-MM-DD'
 * @param {string} dataFim    - 'YYYY-MM-DD'
 * @returns {Promise<Map<string, {tipo_dia: string, descricao: string|null}>>}
 */
async function getCalendarioPeriodoMapa(dataInicio, dataFim) {
  const result = await pool.query(`
    SELECT data::text AS data, tipo_dia, descricao
    FROM calendario_operacional
    WHERE data >= $1::date AND data <= $2::date
    ORDER BY data
  `, [dataInicio, dataFim]);
  const mapa = new Map();
  for (const row of result.rows) mapa.set(row.data, { tipo_dia: row.tipo_dia, descricao: row.descricao });
  return mapa;
}

/**
 * getCalendarioAno — todos os dias de um ano em UMA única query com intervalo
 * (substitui 12 consultas mensais encadeadas na visão anual). Retorno idêntico
 * ao de getCalendarioOperacional: array de { data, tipo_dia, descricao }.
 * @param {number} ano - ex. 2026
 */
async function getCalendarioAno(ano) {
  const result = await pool.query(`
    SELECT data::text AS data, tipo_dia, descricao
    FROM calendario_operacional
    WHERE data >= $1::date AND data <= $2::date
    ORDER BY data
  `, [`${ano}-01-01`, `${ano}-12-31`]);
  return result.rows;
}

/**
 * upsertDiaOperacional — grava o tipo do dia no calendário operacional.
 *
 * Regra de "Dia Útil / Normal" (reversão de exceção):
 *   - tipo UTIL **sem** descrição → o registro de exceção é REMOVIDO (DELETE),
 *     devolvendo a data ao comportamento padrão (conta no Efetivo Previsto/
 *     Real e no absenteísmo como qualquer dia de trabalho).
 *   - tipo UTIL **com** descrição → o registro é mantido com tipo_dia = 'UTIL'
 *     (a anotação é preservada e o dia deixa de ser exceção).
 *   - FERIADO / COMPENSADO → UPSERT normal.
 *
 * @param {string} data      - 'YYYY-MM-DD'
 * @param {string} tipo_dia  - 'UTIL' | 'FERIADO' | 'COMPENSADO'
 * @param {string} descricao - opcional
 * @returns {Promise<{data:string, tipo_dia:string, descricao:string|null, removido?:boolean}>}
 */
async function upsertDiaOperacional(data, tipo_dia, descricao) {
  const tiposValidos = ['UTIL', 'FERIADO', 'COMPENSADO'];
  if (!tiposValidos.includes(tipo_dia)) {
    const err = new Error(`tipo_dia inválido: ${tipo_dia}. Use: UTIL, FERIADO ou COMPENSADO.`);
    err.statusCode = 400;
    throw err;
  }
  const desc = descricao || null;

  // 1 único statement atômico por ramo (sem SELECTs preparatórios):
  //   UTIL sem anotação → DELETE da exceção; demais casos → UPSERT composto.
  // Voltou a ser Dia Útil sem anotação → apaga a exceção do banco
  if (tipo_dia === 'UTIL' && !desc) {
    const del = await pool.query(
      'DELETE FROM calendario_operacional WHERE data = $1::date RETURNING data',
      [data]
    );
    return { data, tipo_dia: 'UTIL', descricao: null, removido: del.rowCount > 0 };
  }

  await pool.query(`
    INSERT INTO calendario_operacional (data, tipo_dia, descricao)
    VALUES ($1::date, $2, $3)
    ON CONFLICT (data) DO UPDATE SET
      tipo_dia  = excluded.tipo_dia,
      descricao = excluded.descricao
  `, [data, tipo_dia, desc]);
  return { data, tipo_dia, descricao: desc };
}

/**
 * calcularPascoa(ano) — algoritmo de Gauss para Páscoa ocidental.
 * Retorna um objeto Date (UTC) com a data da Páscoa.
 */
function calcularPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);   // 1-indexado
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

/**
 * feriadosNacionaisBrasil(ano) — retorna um Map<'YYYY-MM-DD', string>
 * com todos os feriados nacionais fixos + móveis do ano.
 */
function feriadosNacionaisBrasil(ano) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const add = (d, dias) => new Date(d.getTime() + dias * 86400000);
  const f   = new Map();

  // Fixos
  f.set(`${ano}-01-01`, 'Confraternização Universal');
  f.set(`${ano}-04-21`, 'Tiradentes');
  f.set(`${ano}-05-01`, 'Dia do Trabalho');
  f.set(`${ano}-09-07`, 'Independência do Brasil');
  f.set(`${ano}-10-12`, 'N. Sra. Aparecida');
  f.set(`${ano}-11-02`, 'Finados');
  f.set(`${ano}-11-15`, 'Proclamação da República');
  f.set(`${ano}-11-20`, 'Consciência Negra');
  f.set(`${ano}-12-25`, 'Natal');

  // Móveis baseados na Páscoa
  const pascoa = calcularPascoa(ano);
  f.set(fmt(add(pascoa, -48)), 'Carnaval (segunda)');        // 48 dias antes
  f.set(fmt(add(pascoa, -47)), 'Carnaval (terça)');          // 47 dias antes
  f.set(fmt(add(pascoa,  -2)), 'Paixão de Cristo');
  f.set(fmt(pascoa),           'Páscoa');
  f.set(fmt(add(pascoa,  60)), 'Corpus Christi');

  return f;
}

/**
 * gerarCalendarioAno(ano) — preenche a tabela calendario_operacional com
 * todos os dias do ano usando a classificação padrão:
 *   - Sábado/Domingo  → COMPENSADO
 *   - Feriado nacional → FERIADO
 *   - Segunda–Sexta   → UTIL
 *
 * Usa ON CONFLICT DO NOTHING para não sobrescrever ajustes manuais.
 * Retorna { inseridos, pulados }.
 */
async function gerarCalendarioAno(ano, sobrescrever = false) {
  const feriados = feriadosNacionaisBrasil(ano);
  const registros = [];

  const inicio = new Date(Date.UTC(ano, 0, 1));
  const fim    = new Date(Date.UTC(ano, 11, 31));

  for (let d = new Date(inicio); d <= fim; d = new Date(d.getTime() + 86400000)) {
    const dataStr  = d.toISOString().slice(0, 10);
    const diaSem   = d.getUTCDay(); // 0=Dom, 6=Sab
    let   tipo_dia, descricao;

    if (feriados.has(dataStr)) {
      tipo_dia  = 'FERIADO';
      descricao = feriados.get(dataStr);
    } else if (diaSem === 0 || diaSem === 6) {
      tipo_dia  = 'COMPENSADO';
      descricao = diaSem === 0 ? 'Domingo' : 'Sábado';
    } else {
      tipo_dia  = 'UTIL';
      descricao = null;
    }
    registros.push([dataStr, tipo_dia, descricao]);
  }

  const conflictClause = sobrescrever
    ? 'DO UPDATE SET tipo_dia = excluded.tipo_dia, descricao = excluded.descricao'
    : 'DO NOTHING';

  // Escrita em lote: um único INSERT multi-linha por fatia (em vez de ~365
  // INSERTs sequenciais), tudo dentro da MESMA transação e com o mesmo
  // ON CONFLICT (data) de antes.
  const LOTE = 500;

  return withTransaction(async (client) => {
    let inseridos = 0, pulados = 0;
    for (let i = 0; i < registros.length; i += LOTE) {
      const fatia = registros.slice(i, i + LOTE);
      const params = [];
      const valores = fatia.map((r, j) => {
        params.push(r[0], r[1], r[2]);
        const b = j * 3;
        return `($${b + 1}::date, $${b + 2}, $${b + 3})`;
      }).join(', ');

      const r = await client.query(
        `INSERT INTO calendario_operacional (data, tipo_dia, descricao)
         VALUES ${valores}
         ON CONFLICT (data) ${conflictClause}`,
        params
      );
      inseridos += r.rowCount;
      pulados   += fatia.length - r.rowCount;
    }
    return { inseridos, pulados, total: registros.length };
  });
}

function isValidDate(data) {
  return typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data);
}

function invalidDateError() {
  const err = new Error('Data inválida. Use o formato YYYY-MM-DD.');
  err.statusCode = 400;
  return err;
}

async function countByDate(data, dataFim = null) {
  if (!isValidDate(data)) throw invalidDateError();
  if (dataFim && !isValidDate(dataFim)) throw invalidDateError();

  const queryCond = dataFim ? 'BETWEEN $1 AND $2' : '= $1';
  const params = dataFim ? [data, dataFim] : [data];

  const pontoResult = await pool.query(
    `SELECT COUNT(*) as c FROM ponto_historico WHERE data_registro ${queryCond}`, params
  );
  const desligResult = await pool.query(
    `SELECT COUNT(*) as c FROM desligamentos_justificados WHERE data_desligamento ${queryCond}`, params
  );
  const funcsResult = await pool.query(
    `SELECT COUNT(DISTINCT chave_funcionario) as c FROM ponto_historico WHERE data_registro ${queryCond}`, params
  );
  return {
    ponto: pontoResult.rows[0].c,
    desligamentos: desligResult.rows[0].c,
    funcionarios: funcsResult.rows[0].c
  };
}

async function getByDate(data, dataFim = null) {
  if (!isValidDate(data)) throw invalidDateError();
  if (dataFim && !isValidDate(dataFim)) throw invalidDateError();

  const queryCondPonto = dataFim ? 'data_registro BETWEEN $1 AND $2' : 'data_registro = $1';
  const queryCondDeslig = dataFim ? 'data_desligamento BETWEEN $1 AND $2' : 'data_desligamento = $1';
  const params = dataFim ? [data, dataFim] : [data];

  const ponto = await pool.query(
    `SELECT * FROM ponto_historico WHERE ${queryCondPonto} ORDER BY data_registro, nome_funcionario`, params
  );
  const desligamentos = await pool.query(
    `SELECT * FROM desligamentos_justificados WHERE ${queryCondDeslig} ORDER BY data_desligamento, nome_funcionario`, params
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

async function verificarMatriculasNovas(listaMatriculas) {
  if (!listaMatriculas || listaMatriculas.length === 0) return [];
  
  // Limpa possíveis valores vazios/nulos
  const limpa = listaMatriculas.filter(m => m && String(m).trim() !== '');
  if (limpa.length === 0) return [];

  // Remove duplicatas
  const unicos = [...new Set(limpa.map(m => String(m).trim()))];

  const result = await pool.query(
    'SELECT DISTINCT chave_funcionario FROM ponto_historico WHERE chave_funcionario = ANY($1)',
    [unicos]
  );
  
  const existentes = new Set(result.rows.map(r => r.chave_funcionario));
  const novas = unicos.filter(mat => !existentes.has(mat));
  return novas;
}

async function updatePontoBatch(alteracoes) {
  return withTransaction(async (client) => {
    let count = 0;
    for (const alt of alteracoes) {
      await client.query(
        'UPDATE ponto_historico SET status = $1, cid = $2, atualizado_em = $3 WHERE id = $4',
        [alt.status, alt.justificativa, nowIso(), alt.id]
      );
      count++;
    }
    return count;
  });
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
  getPontoParaTurnover,
  getKpisAgregados,
  getDesligamentosHistorico,
  getCalendarioDatas,
  getCalendarioOperacional,
  getCalendarioPeriodoMapa,
  getCalendarioAno,
  upsertDiaOperacional,
  gerarCalendarioAno,
  getPeriodoLimites,
  getTipoDiasPorPeriodo,
  countByDate,
  getByDate,
  deleteByDate,
  isValidDate,
  getEfetivoTotal,
  getTurnoverCounts,
  normalizeDate,
  normalizeFuncionarioKey,
  formatHorarioValue,
  verificarMatriculasNovas,
  updatePontoBatch
};
