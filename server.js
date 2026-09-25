require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');

const { initDatabase, createLote, getLote, confirmLote,
  upsertPontoHistorico, insertDesligamentosJustificados, updateCalendario,
  getPontoHistorico, getDesligamentosHistorico, getCalendarioDatas,
  getPeriodoLimites, getEfetivoTotal,
  countByDate, getByDate, deleteByDate, formatHorarioValue } = require('./src/database/dbService');

const { parseExcelFiles, validateData, validatePontoRow, applyCorrecoes, toPontoDataShape, toDesligDataShape, calculateMetrics, formatExcelDate, excelDecimalToTime, STATUS_CONFIG, STATUS_ALIASES, getStatusMeta, calcularAbsenteismo, calcEfetivoAtivoPorMes, calcTurnoverMensal, calcTurnoverPorFuncao, applyCrossFilters, applyCrossFiltersDeslig, temFiltro, META_TURNOVER_GERAL, META_TURNOVER_OPERACIONAL, MOTIVOS_TURNOVER_RELEVANTES } = require('./src/services/tratamentoService');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    const { dataInicio, dataFim, status, dia, mes, colaborador, funcao } = req.query;

    if (!dataInicio || !dataFim) {
      return res.status(400).json({ success: false, error: 'Parâmetros dataInicio e dataFim são obrigatórios.' });
    }

    const pontoRows = await getPontoHistorico(dataInicio, dataFim);
    const desligRows = await getDesligamentosHistorico(dataInicio, dataFim);
    const efetivoTotalPeriodo = await getEfetivoTotal(dataInicio, dataFim);

    // --- FILTROS GLOBAIS (cross-filter) ------------------------------------
    // `status` = justificativa (fatias da rosca); `dia`, `mes`, `colaborador`
    // e `funcao` vêm dos cliques no calendário e nos 3 gráficos inferiores.
    const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const diaStr = str(dia);
    const mesStr = str(mes);
    const cross = {
      status: str(status),
      dia: diaStr && /^\d{4}-\d{2}-\d{2}$/.test(diaStr) ? diaStr : null,
      mes: mesStr && /^\d{4}-\d{2}$/.test(mesStr) ? mesStr : null,
      colaborador: str(colaborador),
      funcao: str(funcao)
    };

    const baseRows = toPontoDataShape(pontoRows);

    // Desligamentos na foto do filtro cruzado (`status` é ignorado: não há
    // justificativa de ponto correspondente a motivo de desligamento)
    const desligRowsFiltradas = applyCrossFiltersDeslig(desligRows, cross);
    const desligData = toDesligDataShape(desligRowsFiltradas);

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

    // --- Turnover sobre Efetivo Ativo (deduz LICENÇA PATERNIDADE/MATERNIDADE/FÉRIAS/INSS) ---
    const pontoCross = applyCrossFilters(baseRows, cross);
    const efetivoAtivo = calcEfetivoAtivoPorMes(pontoCross);
    const turnoverMensal = calcTurnoverMensal(desligData, efetivoAtivo.porMes);
    const turnoverPorFuncao = calcTurnoverPorFuncao(pontoCross, desligData);

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

    return res.json({
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
    });
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