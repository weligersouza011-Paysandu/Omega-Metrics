require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');

// Cache em memória: TTL de 60 s para respostas do endpoint /api/dashboard/kpis.
// Invalidado automaticamente ao confirmar uma nova importação.
const kpiCache = new NodeCache({ stdTTL: 60, checkperiod: 90, useClones: false });

const { initDatabase, createLote, getLote, confirmLote,
  upsertPontoHistorico, insertDesligamentosJustificados, updateCalendario,
  getPontoHistorico, getPontoParaTurnover, getKpisAgregados,
  getDesligamentosHistorico, getCalendarioDatas,
  getCalendarioOperacional, getCalendarioDiasFatos, getCalendarioAno,
  upsertDiaOperacional, gerarCalendarioAno,
  getPeriodoLimites, getEfetivoTotal,
  countByDate, getByDate, deleteByDate, formatHorarioValue, verificarMatriculasNovas, updatePontoBatch } = require('./src/database/dbService');

const { parseExcelFiles, validateData, validatePontoRow, applyCorrecoes, toPontoDataShape, toDesligDataShape, calculateMetrics, formatExcelDate, excelDecimalToTime, STATUS_CONFIG, STATUS_ALIASES, getStatusMeta, calcularAbsenteismo, calcEfetivoAtivoPorMes, calcTurnoverMensal, calcTurnoverPorFuncao, applyCrossFilters, applyCrossFiltersDeslig, temFiltro, META_TURNOVER_GERAL, META_TURNOVER_OPERACIONAL, MOTIVOS_TURNOVER_RELEVANTES } = require('./src/services/tratamentoService');

// Labels de mês em português (espelha MESES_PT de tratamentoService.js).
const MESES_PT_SRV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/**
 * parseAgregados(rows) — converte o resultado do GROUPING SETS (getKpisAgregados)
 * nas estruturas que o dashboard espera para cada componente:
 *   .global       → totais para o KPI de velocímetro
 *   .porStatus    → rosca de justificativas (absenteismoPorStatus)
 *   .porDia       → legado (o calendário passou a vir de getCalendarioDiasFatos)
 *   .porMes       → gráfico de linha mensal (absenteismoPorMes)
 *
 * Identifica cada linha pelo conjunto de chaves não-nulas retornadas pelo
 * GROUPING SETS: () → global; (status_raw) → por status; etc.
 */
function parseAgregados(rows) {
  const global  = { totalFaltas: 0, totalPrevistos: 0 };
  const porStatus = [];
  const porDia    = [];
  const porMes    = [];
  const porFuncionarioCargo = [];

  for (const r of (rows || [])) {
    const faltas    = parseInt(r.total_faltas || r.faltas || 0, 10);
    const previstos = parseInt(r.total_previstos || r.previstos || 0, 10);
    const calFaltas = parseInt(r.cal_faltas || r.total_faltas || r.faltas || 0, 10);
    const calPrevistos = parseInt(r.cal_previstos || r.total_previstos || r.previstos || 0, 10);
    const hasStatus = Boolean(r.status_raw && String(r.status_raw).trim());
    const hasData   = Boolean(r.data_registro && String(r.data_registro).trim());
    const hasMes    = Boolean(r.mes && String(r.mes).trim());
    const hasCargo  = Boolean(r.cargo && String(r.cargo).trim());
    const nomeFunc  = String(r.nome_funcionario || '').trim();
    const chaveFunc = String(r.chave_funcionario || '').trim();
    const hasNome   = Boolean(nomeFunc && nomeFunc !== 'TOTAL');

    // GROUPING SET () → totais globais (todas as chaves de grupo são nulas)
    if (!hasStatus && !hasData && !hasMes && !hasCargo && !hasNome && !chaveFunc) {
      global.totalFaltas    = faltas;
      global.totalPrevistos = previstos;
    }
    // GROUPING SET (status_raw) → rosca de justificativas (apenas faltas)
    else if (hasStatus && !hasData && !hasMes && !hasCargo && !hasNome && !chaveFunc) {
      if (faltas > 0) porStatus.push({ label: r.status_raw, value: faltas });
    }
    // GROUPING SET (data_registro) → calendário
    else if (hasData && !hasStatus && !hasMes && !hasCargo && !hasNome && !chaveFunc) {
      if (calPrevistos > 0 || calFaltas > 0) {
        porDia.push({
          data: r.data_registro,
          faltas: calFaltas,
          previstos: calPrevistos,
          inss: parseInt(r.total_inss || 0, 10),
          ferias: parseInt(r.total_ferias || 0, 10),
          maternidade: parseInt(r.total_maternidade || 0, 10),
          percentual: calPrevistos > 0 ? parseFloat(((calFaltas / calPrevistos) * 100).toFixed(2)) : 0
        });
      }
    }
    // GROUPING SET (mes) → gráfico % Absenteísmo Mês
    else if (hasMes && !hasStatus && !hasData && !hasCargo && !hasNome && !chaveFunc) {
      if (previstos > 0) {
        const [ano, mesNum] = r.mes.split('-');
        const label = `${MESES_PT_SRV[parseInt(mesNum, 10) - 1] || mesNum}/${ano.slice(2)}`;
        porMes.push({
          label,
          value: parseFloat(((faltas / previstos) * 100).toFixed(2)),
          chave: r.mes
        });
      }
    }
    // GROUPING SET (chave_funcionario, nome_funcionario, cargo) → Ranking e Absenteísmo por Função
    // NÃO valida !r.cargo pois 'cargo' vem preenchido neste GROUPING SET
    else if ((hasNome || chaveFunc) && !hasStatus && !hasData && !hasMes) {
      if (previstos > 0) {
        porFuncionarioCargo.push({
          chave: chaveFunc,
          nome: nomeFunc,
          nome_funcionario: nomeFunc,
          chave_funcionario: chaveFunc,
          cargo: r.cargo || '',
          funcao: r.cargo || '',
          faltas,
          previstos,
          total_faltas: faltas,
          total_previstos: previstos
        });
      }
    }
  }

  porStatus.sort((a, b) => b.value - a.value);
  porDia.sort((a, b) => a.data.localeCompare(b.data));
  porMes.sort((a, b) => a.chave.localeCompare(b.chave));

  return { global, porStatus, porDia, porMes, porFuncionarioCargo };
}

/**
 * montarDiaCalendario(linha) — padroniza UM dia do calendário no padrão
 * relacional consumido pelo dashboard e pronto para API/Power Query (Power BI):
 *   { data, dia_semana, tipo_dia, descricao_evento, tem_lancamento, pct_absenteismo }
 * Preserva os campos históricos (faltas/previstos/percentual/status_cor/
 * dia_descricao) usados pela renderização atual.
 */
function montarDiaCalendario(r) {
  const previstos  = parseInt(r.previstos, 10) || 0;
  const faltas     = parseInt(r.faltas, 10) || 0;
  const percentual = previstos > 0 ? parseFloat(((faltas / previstos) * 100).toFixed(2)) : 0;
  // "lançamento" = dia com linhas contáveis no absenteísmo (sem denominador não há taxa)
  const temLancamento = previstos > 0 || faltas > 0;

  let statusCor = 'neutro';
  if (temLancamento) {
    if (percentual <= 3.0) statusCor = 'verde';
    else if (percentual <= 4.0) statusCor = 'amarelo';
    else statusCor = 'vermelho';
  }

  const descricao = r.descricao_evento || null;

  return {
    data: r.data,
    dia_semana: parseInt(r.dia_semana, 10) || 0,   // 0=Dom ... 6=Sáb
    dia_semana_nome: r.dia_semana_nome || '',
    tipo_dia: r.tipo_dia || null,                  // UTIL | FERIADO | COMPENSADO
    descricao_evento: descricao,
    descricao: descricao,                          // compat: Calendário Operacional
    dia_descricao: descricao,                      // compat: Matriz Detalhada
    tem_lancamento: temLancamento,
    'tem_lançamento': temLancamento,               // alias acentuado (padrão Power BI)
    pct_absenteismo: temLancamento ? percentual : null,
    faltas: faltas,
    previstos: previstos,
    percentual: percentual,
    inss: parseInt(r.inss, 10) || 0,
    ferias: parseInt(r.ferias, 10) || 0,
    maternidade: parseInt(r.maternidade, 10) || 0,
    presentes: previstos - faltas,
    status_cor: statusCor
  };
}

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
// Compressão Gzip/Deflate para todos os endpoints (payloads JSON ≤ 1 KB são
// ignorados — threshold evita overhead em respostas triviais como /api/health).
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ext === '.xlsx' || ext === '.xls') {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são aceitos.'));
    }
  }
});

app.post('/api/tratamento/processar-arquivo', upload.fields([
  { name: 'file_ponto', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files.file_ponto) {
      return res.status(400).json({
        success: false,
        error: 'Arquivo fDB_Ponto Tratado é obrigatório.'
      });
    }

    const pontoBuffer = req.files.file_ponto[0].buffer;
    const arquivoPontoNome = req.files.file_ponto[0].originalname;

    const { pontoData, desligamentoData, parseInfo, demissoesPendentes } = parseExcelFiles(pontoBuffer, null);

    const { inconsistencias, validacaoInfo } = validateData(pontoData, desligamentoData);

    const payload = { pontoData, desligamentoData, parseInfo, demissoesPendentes };
    const loteId = await createLote(arquivoPontoNome, null, payload);

    const fmtHora = (v) => {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (v.type === 'time' && v.time !== null && v.time !== undefined) {
        const h = Math.floor(v.time / 60);
        const m = v.time % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      }
      return v.text || null;
    };

    const preview = {
      totalRegistros: pontoData.length,
      statusConfig: STATUS_CONFIG,
      statusAliases: STATUS_ALIASES,
      previsaoAbsenteismo: calcularAbsenteismo(pontoData),
      linhas: pontoData.map((r, i) => ({
        rowIndex: i,
        linha: i + 1,
        linhaPlanilha: i + 2,
        matricula: r.matricula,
        funcionario: r.nomeFuncionario,
        funcao: r.nomeCargo || '',
        dia: r.dia,
        status: r.status,
        cid: r.cid || null,
        entrada1: fmtHora(r.entrada1),
        saida2: fmtHora(r.saida2),
        totalNormais: r.totalNormais
      }))
    };
    return res.json({
      success: true,
      loteId,
      processamento: {
        ponto: {
          totalRegistros: pontoData.length,
          funcionariosUnicos: parseInfo.funcionariosUnicos,
          departamentos: parseInfo.departamentos,
          periodo: parseInfo.periodo
        },
        desligamentos: {
          totalRegistros: desligamentoData.length,
          motivosEncontrados: parseInfo.motivosEncontrados
        }
      },
      preview,
      inconsistencias: {
        total: inconsistencias.length,
        porCategoria: validacaoInfo.porCategoria,
        registros: inconsistencias.slice(0, 500)
      },
      demissoesPendentes
    });
  } catch (err) {
    console.error('Erro no processamento:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno no processamento dos arquivos.'
    });
  }
});

app.post('/api/tratamento/confirmar-e-salvar', express.json(), async (req, res) => {
  // Invalida o cache de KPIs: novos dados importados devem refletir imediatamente.
  kpiCache.flushAll();
  try {
    const { loteId, justificativas, correcoes } = req.body;

    if (!loteId || !justificativas || !Array.isArray(justificativas)) {
      return res.status(400).json({
        success: false,
        error: 'loteId e justificativas (array) são obrigatórios.'
      });
    }

    const lote = await getLote(loteId);
    if (!lote) {
      return res.status(404).json({ success: false, error: 'Lote não encontrado.' });
    }
    if (lote.status === 'confirmado') {
      return res.status(409).json({ success: false, error: 'Este lote já foi confirmado anteriormente.' });
    }

    const payload = JSON.parse(lote.payload_json);
    let { pontoData, demissoesPendentes } = payload;

    const correcaoResult = applyCorrecoes(pontoData, correcoes);
    pontoData = correcaoResult.pontoData;

    const pendentesBase = demissoesPendentes || [];
    const pendentes = [...pendentesBase];
    const pendenteByNameDia = new Set(
      pendentesBase.map(p => (p.nomeFuncionario || '').trim().toUpperCase() + '|' + p.dia)
    );

    for (let i = 0; i < pontoData.length; i++) {
      const row = pontoData[i];
      const meta = getStatusMeta(row.status);
      if (meta.grupo !== 'DEMISSAO') continue;
      const dedupeKey = (row.nomeFuncionario || '').trim().toUpperCase() + '|' + row.dia;
      if (pendenteByNameDia.has(dedupeKey)) continue;
      pendenteByNameDia.add(dedupeKey);
      pendentes.push({
        id: `dem_corr_${i}`,
        nomeFuncionario: row.nomeFuncionario,
        matricula: row.matricula,
        dia: row.dia,
        cargo: row.nomeCargo,
        departamento: row.nomeDepartamento,
        campoDetectado: 'status',
        valorOriginal: row.status,
        palavraChave: 'demitido'
      });
    }

    const validCodes = ['absenteismo', 'baixa_produtividade', 'desvio_comportamental', 'pedido_demissao', 'reducao_quadro'];
    const pendenteMap = new Map(pendentes.map(p => [p.id, p]));
    const answeredIds = new Set();

    for (const j of justificativas) {
      if (!validCodes.includes(j.codigo)) {
        return res.status(422).json({ success: false, error: `Código de justificativa inválido: ${j.codigo}` });
      }
      if (!pendenteMap.has(j.id)) {
        return res.status(422).json({ success: false, error: `Demissão desconhecida: ${j.id}` });
      }
      answeredIds.add(j.id);
    }

    const naoRespondidas = pendentes.filter(p => !answeredIds.has(p.id));
    if (naoRespondidas.length > 0) {
      return res.status(422).json({
        success: false,
        error: `${naoRespondidas.length} demissão(ões) ainda sem justificativa: ` +
          naoRespondidas.map(p => p.nomeFuncionario).join(', ')
      });
    }

    const pontoResult = await upsertPontoHistorico(pontoData, loteId);

    const desligamentosParaSalvar = pendentes.map(p => {
      const j = justificativas.find(x => x.id === p.id);
      return {
        nomeFuncionario: p.nomeFuncionario,
        matricula: p.matricula,
        cargo: p.cargo,
        departamento: p.departamento,
        dia: p.dia,
        campoDetectado: p.campoDetectado,
        valorOriginal: p.valorOriginal,
        codigoMotivo: j.codigo
      };
    });
    const desligResult = await insertDesligamentosJustificados(desligamentosParaSalvar, loteId);

    const datasTocadas = [
      ...new Set([...(pontoResult.datasTocadas || []), ...(desligResult.datasTocadas || [])])
    ];
    await updateCalendario(datasTocadas);

    await confirmLote(loteId);

    const dadosGravados = pontoData.map(r => ({
      matricula: r.matricula || '',
      funcionario: r.nomeFuncionario || '',
      funcao: r.nomeCargo || '',
      dia: r.dia,
      status: r.status || '',
      cid: r.cid || '',
      entrada1: formatHorarioValue(r.entrada1),
      saida2: formatHorarioValue(r.saida2),
      totalNormais: r.totalNormais || 0
    }));

    return res.json({
      success: true,
      resumo: {
        registrosInseridos: pontoResult.inseridos,
        registrosAtualizados: pontoResult.atualizados,
        registrosPulados: pontoResult.pulados || 0,
        desligamentosSalvos: desligResult.count,
        correcoesAplicadas: correcaoResult.aplicadas,
        turnoverOperacional: desligamentosParaSalvar.filter(d => d.codigoMotivo !== 'reducao_quadro').length,
        reducaoQuadro: desligamentosParaSalvar.filter(d => d.codigoMotivo === 'reducao_quadro').length,
        datasAtualizadas: datasTocadas
      },
      dadosGravados
    });
  } catch (err) {
    console.error('Erro ao confirmar e salvar:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao salvar os dados.'
    });
  }
});

app.get('/api/dashboard/datas-disponiveis', async (req, res) => {
  try {
    const datas = await getCalendarioDatas();
    const limites = await getPeriodoLimites();
    return res.json({
      success: true,
      datas,
      periodoMin: limites.min,
      periodoMax: limites.max,
      totalDias: datas.length
    });
  } catch (err) {
    console.error('Erro ao buscar datas:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard/detalhe-dia', async (req, res) => {
  try {
    const { dia, status, funcao, colaborador } = req.query;
    if (!dia) return res.status(400).json({ success: false, error: 'Parâmetro dia é obrigatório.' });

    const params = [dia];
    let whereClauses = ['data_registro = $1'];
    let idx = 2;

    if (status && status.trim()) {
      whereClauses.push(`UPPER(TRIM(status)) = $${idx++}`);
      params.push(status.trim().toUpperCase());
    }
    if (funcao && funcao.trim()) {
      whereClauses.push(`UPPER(TRIM(cargo)) = $${idx++}`);
      params.push(funcao.trim().toUpperCase());
    }
    if (colaborador && colaborador.trim()) {
      whereClauses.push(`UPPER(TRIM(nome_funcionario)) = $${idx++}`);
      params.push(colaborador.trim().toUpperCase());
    }

    const query = `
      SELECT
        matricula,
        nome_funcionario,
        status,
        COALESCE(cid, observacao, '') AS justificativa
      FROM ponto_historico
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY nome_funcionario
    `;
    
    // We try CID or Observacao, if one doesn't exist it might fail, let's just ask for cid if that's what's mapped, or just cid
    // The previous parsing maps 'cid' directly.
    const safeQuery = `
      SELECT
        matricula,
        nome_funcionario,
        status,
        COALESCE(cid, '') AS justificativa
      FROM ponto_historico
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY nome_funcionario
    `;

    const result = await pool.query(safeQuery, params);
    return res.json({ success: true, dia, dados: result.rows });
  } catch (err) {
    console.error('Erro ao buscar detalhe do dia:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard/kpis', async (req, res) => {
  try {
    const { dataInicio, dataFim, status, dia, mes, colaborador, funcao, motivo } = req.query;

    if (!dataInicio || !dataFim) {
      return res.status(400).json({ success: false, error: 'Parâmetros dataInicio e dataFim são obrigatórios.' });
    }

    // Cache em memória: chave composta por todos os parâmetros da requisição.
    // Retorna a resposta armazenada em < 5 ms sem tocar no banco.
    const cacheKey = `kpis|${dataInicio}|${dataFim}|${status || ''}|${dia || ''}|${mes || ''}|${colaborador || ''}|${funcao || ''}|${motivo || ''}`;
    const cachedResponse = kpiCache.get(cacheKey);
    if (cachedResponse !== undefined) {
      return res.json(cachedResponse);
    }


    // Monta o objeto cross ANTES das chamadas ao banco para permitir Promise.all.
    const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const diaStr = str(dia);
    const mesStr = str(mes);
    const cross = {
      status: str(status),
      dia: diaStr && /^\d{4}-\d{2}-\d{2}$/.test(diaStr) ? diaStr : null,
      mes: mesStr && /^\d{4}-\d{2}$/.test(mesStr) ? mesStr : null,
      colaborador: str(colaborador),
      funcao: str(funcao),
      motivo: str(motivo)
    };

    // Dispara apenas as consultas estritamente necessárias em paralelo (Promise.all):
    //  - getPontoParaTurnover      : agregações mensais por colaborador/cargo no DB (~400 linhas)
    //  - getDesligamentosHistorico : lista de desligamentos no período
    //  - getEfetivoTotal           : contagem de colaboradores distintos
    //  - getKpisAgregados (global) : CTE única no Postgres com GROUPING SETS
    // Se a dimensão não tiver filtro ativo, reutiliza agGlobal (evita 3 queries repetidas no Postgres).
    const needsStatusQuery = Boolean(cross.status);
    const needsMesQuery    = Boolean(cross.mes);

    const [
      pontoRows,
      desligRows,
      efetivoTotalPeriodo,
      agGlobal,
      agStatusOpt,
      agMesOpt,
      todosDesligRows
    ] = await Promise.all([
      getPontoParaTurnover(dataInicio, dataFim),
      getDesligamentosHistorico(dataInicio, dataFim),
      getEfetivoTotal(dataInicio, dataFim),
      getKpisAgregados(dataInicio, dataFim, cross, null),
      needsStatusQuery ? getKpisAgregados(dataInicio, dataFim, cross, 'status') : Promise.resolve(null),
      needsMesQuery    ? getKpisAgregados(dataInicio, dataFim, cross, 'mes')    : Promise.resolve(null),
      getDesligamentosHistorico()
    ]);

    const agStatus = agStatusOpt || agGlobal;
    const agMes    = agMesOpt    || agGlobal;

    // Analisa os resultados do GROUPING SETS
    const sqlGlobal = parseAgregados(agGlobal);
    const sqlStatus = parseAgregados(agStatus);
    const sqlMes    = parseAgregados(agMes);


    const baseRows = toPontoDataShape(pontoRows);

    // Desligamentos na foto do filtro cruzado (`status` é ignorado: não há
    // justificativa de ponto correspondente a motivo de desligamento)
    const desligRowsFiltradas = applyCrossFiltersDeslig(desligRows, cross);
    const desligData = toDesligDataShape(desligRowsFiltradas);

    // Justificativas de demissão: agrupa pulando a própria dimensão `motivo`
    // (regra de escopo) — todas as fatias continuam visíveis e clicáveis
    const desligDataSemMotivo = toDesligDataShape(
      applyCrossFiltersDeslig(desligRows, cross, 'motivo')
    );
    const contagemMotivos = {};
    for (const d of desligDataSemMotivo) {
      const m = (d.motivo && String(d.motivo).trim()) || 'NÃO INFORMADO';
      contagemMotivos[m] = (contagemMotivos[m] || 0) + 1;
    }
    const justificativas = Object.keys(contagemMotivos)
      .map(k => ({ label: k, value: contagemMotivos[k] }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

    // Efetivo total: foto do filtro sem o `status` (a query por período nunca
    // foi afetada pelo filtro de status — comportamento histórico preservado)
    const crossSemStatus = { status: null, dia: cross.dia, mes: cross.mes, colaborador: cross.colaborador, funcao: cross.funcao };
    const efetivoTotal = temFiltro(crossSemStatus)
      ? new Set(
          applyCrossFilters(baseRows, crossSemStatus)
            .map(r => String(r.chaveFuncionario || '').trim())
            .filter(Boolean)
        ).size
      : efetivoTotalPeriodo;

    const { kpis, graficos } = calculateMetrics(baseRows, desligData, efetivoTotal, cross);

    // --- Substitui gráficos de absenteísmo pelos valores calculados no PostgreSQL ---
    // O pipeline JS (calculateMetrics) continua rodando para aderência, turnover,
    // ranking e gráfico por função (que precisam de filtrarAtivos sobre linhas).
    // Os componentes abaixo são equivalentes mas vêm do banco pré-agrupado:
    graficos.absenteismoPorStatus = sqlStatus.porStatus;  // rosca (skip=status)
    graficos.absenteismoPorMes    = sqlMes.porMes;        // gráfico mês (skip=mes)

    // Calendário de Absenteísmo — MODELO DIMENSÃO/FEITOS (LEFT JOIN):
    // UMA única query devolve TODOS os dias do período (série de datas) com a
    // classificação do Calendário Operacional e os lançamentos de absenteísmo,
    // inclusive para dias SEM qualquer registro de faltas/presenças (datas
    // futuras, meses sem frequência importada).
    // A dimensão `dia` não filtra: o próprio calendário é a dimensão do dia.
    const linhasDia = await getCalendarioDiasFatos(dataInicio, dataFim, cross);
    graficos.absenteismoPorDia = linhasDia.map(montarDiaCalendario);

    // Ranking e Gráfico por Função (FILTRAGEM RIGOROSA DE COLABORADORES ATIVOS)
    const desligados = [...(todosDesligRows || []), ...(desligRows || []), ...(desligData || [])];
    const demitidosSet = new Set(
      desligados
        .map(d => String(d.nome_funcionario || d.nome || '').trim().toUpperCase())
        .filter(Boolean)
    );
    desligados.forEach(d => {
      const chave = String(d.chave_funcionario || d.chave || '').trim().toUpperCase();
      if (chave) demitidosSet.add(chave);
      if (d.matricula) {
        const mat = String(d.matricula).trim().toUpperCase();
        if (mat) demitidosSet.add('MAT_' + mat);
      }
    });

    const ativosFuncCargo = sqlGlobal.porFuncionarioCargo.filter(row => {
      const nomeLimpo = String(row.nome_funcionario || row.nome || '').trim().toUpperCase();
      const chaveLimpa = String(row.chave_funcionario || row.chave || '').trim().toUpperCase();
      if (nomeLimpo && demitidosSet.has(nomeLimpo)) return false;
      if (chaveLimpa && demitidosSet.has(chaveLimpa)) return false;
      return true;
    });

    const rankingMapped = ativosFuncCargo.map(row => {
      const totalFaltas = parseInt(row.total_faltas || row.faltas || 0, 10);
      const totalPrevistos = parseInt(row.total_previstos || row.previstos || 0, 10);
      const percentual = totalPrevistos > 0 ? Number(((totalFaltas / totalPrevistos) * 100).toFixed(2)) : 0;
      const rotulo = `${percentual.toFixed(2).replace('.', ',')}% (${totalFaltas}f)`;
      return {
        nome: row.nome_funcionario || row.nome || '',
        chave: row.chave_funcionario || row.chave || '',
        funcao: row.cargo || row.funcao || '',
        faltas: totalFaltas,
        previstos: totalPrevistos,
        percentual,
        rotulo
      };
    });

    const comFaltas = rankingMapped.filter(r => r.faltas > 0);
    const rankingFinal = (comFaltas.length > 0 ? comFaltas : rankingMapped)
      .sort((a, b) => (b.faltas - a.faltas) || (b.percentual - a.percentual) || a.nome.localeCompare(b.nome));

    graficos.rankingAbsenteismo = rankingFinal.slice(0, 10);

    const funcaoMap = {};
    for (const r of ativosFuncCargo) {
      const f = r.funcao || 'NÃO INFORMADA';
      if (!funcaoMap[f]) funcaoMap[f] = { faltas: 0, previstos: 0 };
      funcaoMap[f].faltas += r.faltas;
      funcaoMap[f].previstos += r.previstos;
    }
    graficos.absenteismoPorFuncao = Object.keys(funcaoMap)
      .map(f => {
        const { faltas, previstos } = funcaoMap[f];
        return {
          label: f,
          value: previstos > 0 ? parseFloat(((faltas / previstos) * 100).toFixed(2)) : 0
        };
      })
      .filter(f => f.value > 0)
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

    // KPI de velocímetro: substitui percentual e totais brutos pelo valor SQL.
    // Preserva `excluidos` e `detalhamento` calculados pelo JS (não disponíveis no SQL).
    if (sqlGlobal.global.totalPrevistos > 0) {
      const pctSql = parseFloat(
        ((sqlGlobal.global.totalFaltas / sqlGlobal.global.totalPrevistos) * 100).toFixed(2)
      );
      kpis.absenteismo = {
        ...kpis.absenteismo,
        percentual:  pctSql,
        totalFaltas: sqlGlobal.global.totalFaltas,
        totalGeral:  sqlGlobal.global.totalPrevistos
      };
    }

    // --- Turnover sobre Efetivo Ativo (deduz LICENÇA PATERNIDADE/MATERNIDADE/FÉRIAS/INSS) ---
    const pontoCross = applyCrossFilters(baseRows, cross);
    const efetivoAtivo = calcEfetivoAtivoPorMes(pontoCross);
    const turnoverMensal = calcTurnoverMensal(desligData, efetivoAtivo.porMes);
    const turnoverPorFuncao = calcTurnoverPorFuncao(pontoCross, desligData);

    // Série do gráfico Headcount & Movimentação: pula o próprio filtro
    // `mes` (regra de escopo) — todos os meses seguem visíveis e clicáveis
    // para alternar/limpar o filtro, enquanto dia/colaborador/função/
    // justificativa continuam valendo
    const pontoCrossSemMes = applyCrossFilters(baseRows, cross, 'mes');
    const efetivoAtivoSemMes = calcEfetivoAtivoPorMes(pontoCrossSemMes);
    const desligDataSemMes = toDesligDataShape(applyCrossFiltersDeslig(desligRows, cross, 'mes'));
    const turnoverHeadcount = calcTurnoverMensal(desligDataSemMes, efetivoAtivoSemMes.porMes);

    // Contagens operacional/reducao: mesmo critério `conta_turnover` da
    // consulta do banco, porém sobre as linhas já cruzadas pelo filtro
    const turnoverCounts = { operacional: 0, reducao: 0 };
    for (const r of desligRowsFiltradas) {
      if (Number(r.conta_turnover) === 1) turnoverCounts.operacional++;
      else turnoverCounts.reducao++;
    }
    const totalDeslig = turnoverCounts.operacional + turnoverCounts.reducao;
    const pct = (n, d) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(2)) : 0);

    kpis.turnover = {
      ...kpis.turnover,
      desligamentosRelevantes: turnoverCounts.operacional,
      totalDesligamentos: totalDeslig,
      excluidoDoCalculo: {
        motivo: 'Redução de Quadro / Desmobilização do Cliente',
        quantidade: turnoverCounts.reducao,
        percentual: efetivoTotal > 0 ? parseFloat(((turnoverCounts.reducao / efetivoTotal) * 100).toFixed(2)) : 0
      },
      efetivoAtivoMedio: efetivoAtivo.efetivoAtivoMedio,
      geralPercentual: pct(totalDeslig, efetivoAtivo.efetivoAtivoMedio),
      operacionalPercentual: pct(turnoverCounts.operacional, efetivoAtivo.efetivoAtivoMedio),
      metaGeral: META_TURNOVER_GERAL,
      metaOperacional: META_TURNOVER_OPERACIONAL,
      efetivo: efetivoAtivo
    };
    graficos.turnoverMensal = turnoverMensal;
    graficos.turnoverHeadcount = turnoverHeadcount;
    graficos.justificativas = justificativas;
    graficos.turnoverPorFuncao = turnoverPorFuncao;
    graficos.desligamentosDetalhe = desligData
      .map(d => ({
        nome: d.nome,
        funcao: d.funcao || '—',
        data: d.dataDesligamento,
        motivo: d.motivo,
        classificacao: MOTIVOS_TURNOVER_RELEVANTES.includes(d.motivo)
          ? 'Operacional'
          : (d.motivo === 'REDUÇÃO DE QUADRO (EFETIVO)' ? 'Redução de Quadro' : 'Não classificado')
      }))
      .sort((a, b) => String(b.data).localeCompare(String(a.data)));

    const responsePayload = {
      success: true,
      periodo: { dataInicio, dataFim },
      kpis: {
        absenteismo: kpis.absenteismo,
        aderencia: kpis.aderencia,
        turnover: kpis.turnover
      },
      graficos,
      efetivoTotal,
      totais: { registrosPonto: pontoRows.length, desligamentos: desligRows.length },
      semDados: pontoRows.length === 0 && desligRows.length === 0
    };

    // Armazena no cache apenas respostas com dados reais (evita cachear "sem dados")
    if (!responsePayload.semDados) {
      kpiCache.set(cacheKey, responsePayload);
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error('Erro ao buscar KPIs:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ============================================================
   GESTÃO / EXPURGO DE DADOS DIÁRIOS
   ============================================================ */

app.get('/api/dados/checar', async (req, res) => {
  try {
    const { data, dataFim } = req.query;
    const counts = await countByDate(data, dataFim);
    const dados = await getByDate(data, dataFim);
    return res.json({
      success: true,
      data,
      dataFim,
      ponto: counts.ponto,
      desligamentos: counts.desligamentos,
      funcionarios: counts.funcionarios,
      total: counts.ponto + counts.desligamentos,
      registros: dados.ponto,
      registrosDesligamentos: dados.desligamentos
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

app.get('/api/dados/download', async (req, res) => {
  try {
    const { data, dataFim } = req.query;
    const { ponto, desligamentos } = await getByDate(data, dataFim);

    if (ponto.length === 0 && desligamentos.length === 0) {
      return res.status(404).json({ success: false, error: 'Nenhum registro encontrado para esta data.' });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(ponto),
      'Ponto'
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(desligamentos.length ? desligamentos : [{ aviso: 'Sem desligamentos nesta data' }]),
      'Desligamentos'
    );

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="backup_dados_${data}.xlsx"`);
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

app.delete('/api/dados/deletar', async (req, res) => {
  try {
    const { data } = req.query;
    const result = await deleteByDate(data);
    console.log(`[EXPURGO] ${data} — ponto: ${result.ponto}, desligamentos: ${result.desligamentos}`);
    return res.json({ success: true, data, removidos: result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

app.put('/api/dados/atualizar', async (req, res) => {
  try {
    const { alteracoes } = req.body;
    if (!alteracoes || !Array.isArray(alteracoes)) {
      return res.status(400).json({ success: false, error: 'Lista de alterações é obrigatória.' });
    }
    const count = await updatePontoBatch(alteracoes);
    kpiCache.flushAll();
    return res.json({ success: true, atualizados: count });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   CALENDÁRIO OPERACIONAL
   ============================================================ */

/**
 * GET /api/calendario-operacional?mes=9&ano=2026
 * Retorna os dias marcados como não-úteis no mês/ano informados.
 */
app.get('/api/calendario-operacional', async (req, res) => {
  try {
    const mes = parseInt(req.query.mes, 10);
    const ano = parseInt(req.query.ano, 10);
    if (!mes || !ano || mes < 1 || mes > 12 || ano < 2000 || ano > 2100) {
      return res.status(400).json({ success: false, error: 'Parâmetros mes (1-12) e ano (2000-2100) são obrigatórios.' });
    }
    const dias = await getCalendarioOperacional(mes, ano);
    return res.json({ success: true, mes, ano, dias });
  } catch (err) {
    console.error('Erro ao buscar calendário operacional:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/calendario-operacional
 * Body: { data: 'YYYY-MM-DD', tipo_dia: 'UTIL'|'FERIADO'|'COMPENSADO', descricao?: string }
 *
 * tipo_dia 'UTIL' = "Dia Útil / Normal": reverte a exceção gravando um registro
 * explícito com tipo_dia 'UTIL' (UPSERT, com ou sem descrição). A data volta a
 * ser dia de trabalho normal nas métricas (Efetivo Previsto/Real e
 * absenteísmo) e não é mais reclassificada na leitura.
 *
 * Invalida o cache de KPIs para refletir imediatamente no dashboard.
 */
app.post('/api/calendario-operacional', async (req, res) => {
  try {
    const { data, tipo_dia, descricao } = req.body;
    if (!data || !tipo_dia) {
      return res.status(400).json({ success: false, error: 'Campos data e tipo_dia são obrigatórios.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ success: false, error: 'Campo data deve estar no formato YYYY-MM-DD.' });
    }
    const result = await upsertDiaOperacional(data, tipo_dia, descricao);
    kpiCache.flushAll(); // invalida cache para refletir nos KPIs imediatamente
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/calendario-operacional/painel?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD
 *
 * Dimensão-calendário COMPLETA (LEFT JOIN calendario_operacional x fatos de
 * absenteísmo de ponto_historico): retorna TODOS os dias do intervalo com a
 * classificação do Calendário Operacional mesmo quando NÃO existem lançamentos
 * de faltas/presenças (datas futuras, meses sem frequência importada etc.).
 *
 * Padrão relacional para consumo externo (Power BI / Power Query):
 *   { data, dia_semana, tipo_dia, descricao_evento, tem_lancamento, pct_absenteismo }
 *
 * Também é a fonte das marcações do "Calendário de Absenteísmo" do dashboard
 * para os dias fora do período de KPI carregado (janela de 12 meses).
 */
app.get('/api/calendario-operacional/painel', async (req, res) => {
  try {
    const dataInicio = String(req.query.dataInicio || '').trim();
    const dataFim    = String(req.query.dataFim || '').trim();
    const isoOk = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!isoOk(dataInicio) || !isoOk(dataFim) || dataInicio > dataFim) {
      return res.status(400).json({ success: false, error: 'dataInicio e dataFim obrigatórios no formato YYYY-MM-DD (dataInicio <= dataFim).' });
    }
    const maxDias = 800; // janela máxima (~26 meses) por chamada
    const diasEntre = Math.round((new Date(dataFim + 'T00:00:00Z') - new Date(dataInicio + 'T00:00:00Z')) / 86400000);
    if (diasEntre >= maxDias) {
      return res.status(400).json({ success: false, error: `Intervalo máximo de ${maxDias} dias por chamada.` });
    }

    const cacheKey = `calpainel|${dataInicio}|${dataFim}`;
    const cached = kpiCache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const linhas = await getCalendarioDiasFatos(dataInicio, dataFim, null);
    const payload = {
      success: true,
      dataInicio,
      dataFim,
      total: linhas.length,
      dias: linhas.map(montarDiaCalendario)
    };
    kpiCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('Erro ao montar painel do calendário:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/calendario-operacional/ano?ano=2026
 * Retorna TODOS os dias do ano informado (usado pela visão anual de 12 meses).
 */
app.get('/api/calendario-operacional/ano', async (req, res) => {
  try {
    const ano = parseInt(req.query.ano, 10);
    if (!ano || ano < 2000 || ano > 2100) {
      return res.status(400).json({ success: false, error: 'Parâmetro ano (2000-2100) é obrigatório.' });
    }
    const dias = await getCalendarioAno(ano);
    return res.json({ success: true, ano, dias });
  } catch (err) {
    console.error('Erro ao buscar calendário anual:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/calendario-operacional/gerar-ano
 * Body: { ano: 2026, sobrescrever?: false }
 * Preenche o ano inteiro com a classificação padrão (S/D=COMPENSADO, Feriados=FERIADO, resto=UTIL).
 * sobrescrever=false (padrão): respeita ajustes manuais existentes.
 * sobrescrever=true: reescreve tudo.
 */
app.post('/api/calendario-operacional/gerar-ano', async (req, res) => {
  try {
    const ano = parseInt(req.body.ano, 10);
    const sobrescrever = req.body.sobrescrever === true || req.body.sobrescrever === 'true';
    if (!ano || ano < 2000 || ano > 2100) {
      return res.status(400).json({ success: false, error: 'Campo ano (2000-2100) é obrigatório.' });
    }
    const result = await gerarCalendarioAno(ano, sobrescrever);
    kpiCache.flushAll();
    console.log(`[CALENDÁRIO] Ano ${ano} gerado: ${result.inseridos} inseridos, ${result.pulados} pulados.`);
    return res.json({ success: true, ano, ...result });
  } catch (err) {
    console.error('Erro ao gerar calendário do ano:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function start() {
  try {
    await initDatabase(pool);
    console.log('Conectado ao PostgreSQL (Neon) — schema verificado.');
  } catch (err) {
    console.error('Falha ao conectar/inicializar o PostgreSQL:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Omega Metrics v2 rodando em http://localhost:${PORT}`);
    console.log('Banco de dados: PostgreSQL (Neon)');
  });
}

start();