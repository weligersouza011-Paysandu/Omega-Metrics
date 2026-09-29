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
  getPeriodoLimites, getEfetivoTotal,
  countByDate, getByDate, deleteByDate, formatHorarioValue } = require('./src/database/dbService');

const { parseExcelFiles, validateData, validatePontoRow, applyCorrecoes, toPontoDataShape, toDesligDataShape, calculateMetrics, formatExcelDate, excelDecimalToTime, STATUS_CONFIG, STATUS_ALIASES, getStatusMeta, calcularAbsenteismo, calcEfetivoAtivoPorMes, calcTurnoverMensal, calcTurnoverPorFuncao, applyCrossFilters, applyCrossFiltersDeslig, temFiltro, META_TURNOVER_GERAL, META_TURNOVER_OPERACIONAL, MOTIVOS_TURNOVER_RELEVANTES } = require('./src/services/tratamentoService');

// Labels de mês em português (espelha MESES_PT de tratamentoService.js).
const MESES_PT_SRV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/**
 * parseAgregados(rows) — converte o resultado do GROUPING SETS (getKpisAgregados)
 * nas estruturas que o dashboard espera para cada componente:
 *   .global       → totais para o KPI de velocímetro
 *   .porStatus    → rosca de justificativas (absenteismoPorStatus)
 *   .porDia       → calendário (absenteismoPorDia)
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
    const faltas    = Number(r.total_faltas)    || 0;
    const previstos = Number(r.total_previstos) || 0;
    const hasStatus = r.status_raw    != null && r.status_raw    !== '';
    const hasData   = r.data_registro != null && r.data_registro !== '';
    const hasMes    = r.mes           != null && r.mes           !== '';
    const hasCargo  = r.cargo         != null && r.cargo         !== '';
    const hasNome   = r.nome_funcionario != null && r.nome_funcionario !== '';

    // GROUPING SET () → totais globais (todas as chaves de grupo são nulas)
    if (!hasStatus && !hasData && !hasMes && !hasCargo && !hasNome) {
      global.totalFaltas    = faltas;
      global.totalPrevistos = previstos;
    }
    // GROUPING SET (status_raw) → rosca de justificativas (apenas faltas)
    else if (hasStatus && !hasData && !hasMes && !hasCargo && !hasNome) {
      if (faltas > 0) porStatus.push({ label: r.status_raw, value: faltas });
    }
    // GROUPING SET (data_registro) → calenário
    else if (hasData && !hasStatus && !hasMes && !hasCargo && !hasNome) {
      if (previstos > 0) {
        porDia.push({
          data: r.data_registro,
          faltas,
          previstos,
          percentual: parseFloat(((faltas / previstos) * 100).toFixed(2))
        });
      }
    }
    // GROUPING SET (mes) → gráfico % Absenteísmo Mês
    else if (hasMes && !hasStatus && !hasData && !hasCargo && !hasNome) {
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
    // GROUPING SET (nome_funcionario, cargo) → Ranking e Absenteísmo por Função
    else if (hasNome && !hasStatus && !hasData && !hasMes) {
      if (previstos > 0) {
        porFuncionarioCargo.push({
          nome: r.nome_funcionario,
          funcao: r.cargo,
          faltas,
          previstos
        });
      }
    }
  }

  porStatus.sort((a, b) => b.value - a.value);
  porDia.sort((a, b) => a.data.localeCompare(b.data));
  porMes.sort((a, b) => a.chave.localeCompare(b.chave));

  return { global, porStatus, porDia, porMes, porFuncionarioCargo };
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
    const needsDiaQuery    = Boolean(cross.dia);
    const needsMesQuery    = Boolean(cross.mes);

    const [
      pontoRows,
      desligRows,
      efetivoTotalPeriodo,
      agGlobal,
      agStatusOpt,
      agDiaOpt,
      agMesOpt
    ] = await Promise.all([
      getPontoParaTurnover(dataInicio, dataFim),
      getDesligamentosHistorico(dataInicio, dataFim),
      getEfetivoTotal(dataInicio, dataFim),
      getKpisAgregados(dataInicio, dataFim, cross, null),
      needsStatusQuery ? getKpisAgregados(dataInicio, dataFim, cross, 'status') : Promise.resolve(null),
      needsDiaQuery    ? getKpisAgregados(dataInicio, dataFim, cross, 'dia')    : Promise.resolve(null),
      needsMesQuery    ? getKpisAgregados(dataInicio, dataFim, cross, 'mes')    : Promise.resolve(null)
    ]);

    const agStatus = agStatusOpt || agGlobal;
    const agDia    = agDiaOpt    || agGlobal;
    const agMes    = agMesOpt    || agGlobal;

    // Analisa os resultados do GROUPING SETS
    const sqlGlobal = parseAgregados(agGlobal);
    const sqlStatus = parseAgregados(agStatus);
    const sqlDia    = parseAgregados(agDia);
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
    graficos.absenteismoPorDia    = sqlDia.porDia;        // calendário (skip=dia)
    graficos.absenteismoPorMes    = sqlMes.porMes;        // gráfico mês (skip=mes)

    // Ranking e Gráfico por Função (filtrando demitidos/desligados)
    const demitidosUpper = new Set(desligData.map(d => String(d.nome || '').trim().toUpperCase()));
    const ativosFuncCargo = sqlGlobal.porFuncionarioCargo.filter(
      r => !demitidosUpper.has(String(r.nome || '').trim().toUpperCase())
    );

    graficos.rankingAbsenteismo = ativosFuncCargo
      .map(r => ({
        nome: r.nome,
        funcao: r.funcao,
        faltas: r.faltas,
        previstos: r.previstos,
        percentual: r.previstos > 0 ? parseFloat(((r.faltas / r.previstos) * 100).toFixed(2)) : 0
      }))
      .filter(r => r.percentual > 0)
      .sort((a, b) => b.percentual - a.percentual || a.nome.localeCompare(b.nome))
      .slice(0, 10);

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
    const { data } = req.query;
    const counts = await countByDate(data);
    return res.json({
      success: true,
      data,
      ponto: counts.ponto,
      desligamentos: counts.desligamentos,
      funcionarios: counts.funcionarios,
      total: counts.ponto + counts.desligamentos
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

app.get('/api/dados/download', async (req, res) => {
  try {
    const { data } = req.query;
    const { ponto, desligamentos } = await getByDate(data);

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