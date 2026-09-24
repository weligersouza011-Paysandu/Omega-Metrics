const XLSX = require('xlsx');
const { formatExcelDate, excelDecimalToTime } = require('./excelService');
const {
  STATUS_CONFIG,
  STATUS_ALIASES,
  normalizeStatusKey,
  sanitizeStatus,
  getStatusMeta,
  badgeForStatus,
  classificarRegistros,
  calcularAbsenteismo
} = require('../utils/statusRules');

const HEADER_MAP_PONTO = {
  'nome do funcionário': 'nomeFuncionario',
  'nome funcionario': 'nomeFuncionario',
  'funcionário': 'nomeFuncionario',
  'funcionario': 'nomeFuncionario',
  'matricula': 'matricula',
  'matrícula': 'matricula',
  'nome do cargo': 'nomeCargo',
  'cargo': 'nomeCargo',
  'nome do departamento': 'nomeDepartamento',
  'departamento': 'nomeDepartamento',
  'depto': 'nomeDepartamento',
  'dia': 'dia',
  'data': 'dia',
  'entrada 1': 'entrada1',
  'entrada1': 'entrada1',
  'saída 1': 'saida1',
  'saida 1': 'saida1',
  'saida1': 'saida1',
  'entrada 2': 'entrada2',
  'entrada2': 'entrada2',
  'saída 2': 'saida2',
  'saida 2': 'saida2',
  'saida2': 'saida2',
  'total normais': 'totalNormais',
  'totalnormais': 'totalNormais',
  'normais': 'totalNormais',
  'adicional noturno': 'adicionalNoturno',
  'adicionalnoturno': 'adicionalNoturno',
  'noturno': 'adicionalNoturno',
  'dia falta': 'diaFalta',
  'diafalta': 'diaFalta',
  'horas atraso': 'horasAtraso',
  'horasatraso': 'horasAtraso',
  'atraso': 'horasAtraso',
  'falta e atraso': 'faltaEAtraso',
  'faltaeatraso': 'faltaEAtraso',
  'atestado': 'atestado',
  'extra 50%': 'extra50',
  'extra 50': 'extra50',
  'extra50': 'extra50',
  'status': 'status'
};

const HEADER_MAP_DESLIG = {
  'indx': 'indx',
  'índice': 'indx',
  'indice': 'indx',
  'index': 'indx',
  'matricula': 'matricula',
  'matrícula': 'matricula',
  'nome': 'nome',
  'funcao': 'funcao',
  'função': 'funcao',
  'cargo': 'funcao',
  'obra': 'obra',
  'obras': 'obra',
  'motivo': 'motivo',
  'motivos': 'motivo',
  'aviso': 'aviso'
};

const DEMISSAO_KEYWORDS = ['demissão', 'demissao', 'demitido', 'desligado', 'rescisão', 'rescisao'];

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function findHeaderRow(rows, keywords) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    let matches = 0;
    for (const cell of row) {
      const normalized = String(cell).trim().toLowerCase();
      for (const kw of keywords) {
        if (normalized === kw || normalized.includes(kw)) {
          matches++;
          break;
        }
      }
    }
    if (matches >= 3) return i;
  }
  return -1;
}

function mapHeaders(rawHeaders, headerMap) {
  const mapped = {};
  for (let i = 0; i < rawHeaders.length; i++) {
    const raw = String(rawHeaders[i]).trim().toLowerCase();
    for (const [key, value] of Object.entries(headerMap)) {
      if (raw === key || raw.includes(key)) {
        if (!mapped[value]) {
          mapped[value] = i;
        }
        break;
      }
    }
  }
  return mapped;
}

function parseTimeOrJustification(value) {
  if (value === null || value === undefined) {
    return { type: 'empty', time: null, text: null };
  }
  const str = String(value).trim();
  if (str === '') {
    return { type: 'empty', time: null, text: null };
  }
  const timeMatch = str.match(/^(\d{1,2})[.:](\d{2})$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { type: 'time', time: hours * 60 + minutes, text: null };
    }
  }
  const asNumber = Number(str);
  if (!isNaN(asNumber) && asNumber > 0 && asNumber < 1) {
    const timeStr = excelDecimalToTime(asNumber);
    const parts = timeStr.split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (!isNaN(hours) && !isNaN(minutes)) {
      return { type: 'time', time: hours * 60 + minutes, text: null };
    }
  }
  return { type: 'justification', time: null, text: str };
}

function safeNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const num = parseFloat(String(val).replace(',', '.'));
  return isNaN(num) ? 0 : num;
}

function normalizePontoRow(rawRow, colMap) {
  const get = (field) => {
    const idx = colMap[field];
    if (idx === undefined || idx === null) return '';
    return rawRow[idx] !== undefined ? rawRow[idx] : '';
  };

  const entrada1Raw = get('entrada1');
  const saida2Raw = get('saida2');

  const entrada1 = parseTimeOrJustification(entrada1Raw);
  const saida2 = parseTimeOrJustification(saida2Raw);

  return {
    nomeFuncionario: String(get('nomeFuncionario')).trim(),
    matricula: String(get('matricula')).trim(),
    nomeCargo: String(get('nomeCargo')).trim(),
    nomeDepartamento: String(get('nomeDepartamento')).trim(),
    dia: formatExcelDate(get('dia')),
    entrada1,
    saida2,
    totalNormais: safeNumber(get('totalNormais')),
    adicionalNoturno: safeNumber(get('adicionalNoturno')),
    diaFalta: String(get('diaFalta')).trim(),
    horasAtraso: safeNumber(get('horasAtraso')),
    faltaEAtraso: String(get('faltaEAtraso')).trim(),
    atestado: String(get('atestado')).trim(),
    extra50: safeNumber(get('extra50')),
    status: sanitizeStatus(get('status')),
    cid: ''
  };
}

function normalizeDesligRow(rawRow, colMap) {
  const get = (field) => {
    const idx = colMap[field];
    if (idx === undefined || idx === null) return '';
    return rawRow[idx] !== undefined ? rawRow[idx] : '';
  };

  return {
    indx: get('indx'),
    matricula: String(get('matricula')).trim(),
    nome: String(get('nome')).trim(),
    funcao: String(get('funcao')).trim(),
    obra: String(get('obra')).trim(),
    motivo: String(get('motivo')).trim().toUpperCase(),
    aviso: String(get('aviso')).trim()
  };
}

function detectDemissao(row) {
  const detections = [];
  const status = (row.status || '').toLowerCase();
  const entrada1Text = row.entrada1?.text?.toLowerCase() || '';
  const saida2Text = row.saida2?.text?.toLowerCase() || '';

  for (const kw of DEMISSAO_KEYWORDS) {
    if (status.includes(kw)) {
      detections.push({ campo: 'status', valor: row.status, palavraChave: kw });
    }
    if (entrada1Text.includes(kw)) {
      detections.push({ campo: 'entrada1', valor: row.entrada1.text, palavraChave: kw });
    }
    if (saida2Text.includes(kw)) {
      detections.push({ campo: 'saida2', valor: row.saida2.text, palavraChave: kw });
    }
  }
  return detections;
}

function parseExcelFiles(pontoBuffer, desligBuffer) {
  const pontoRows = readSheet(pontoBuffer);
  const desligRows = desligBuffer ? readSheet(desligBuffer) : [];

  if (pontoRows.length < 2) {
    throw new Error('A planilha de ponto está vazia ou não contém dados.');
  }

  const pontoKeywords = ['nome do funcionário', 'nome funcionario', 'funcionário', 'dia', 'entrada', 'status'];
  const pontoHeaderIdx = findHeaderRow(pontoRows, pontoKeywords);
  if (pontoHeaderIdx === -1) {
    throw new Error('Não foi possível identificar o cabeçalho da planilha de ponto.');
  }

  let desligamentoData = [];
  let parseInfoDeslig = { motivosEncontrados: [] };

  if (desligRows.length >= 2) {
    const desligKeywords = ['matricula', 'matrícula', 'nome', 'motivo', 'função', 'funcao'];
    const desligHeaderIdx = findHeaderRow(desligRows, desligKeywords);
    if (desligHeaderIdx !== -1) {
      const desligRawHeaders = desligRows[desligHeaderIdx];
      const desligColMap = mapHeaders(desligRawHeaders, HEADER_MAP_DESLIG);

      for (let i = desligHeaderIdx + 1; i < desligRows.length; i++) {
        const row = desligRows[i];
        const hasData = row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
        if (!hasData) continue;
        const normalized = normalizeDesligRow(row, desligColMap);
        if (!normalized.nome && !normalized.matricula) continue;
        desligamentoData.push(normalized);
      }
      parseInfoDeslig = extractDesligInfo(desligamentoData);
    }
  }

  const pontoRawHeaders = pontoRows[pontoHeaderIdx];
  const pontoColMap = mapHeaders(pontoRawHeaders, HEADER_MAP_PONTO);

  if (pontoColMap.nomeFuncionario === undefined) {
    throw new Error('Coluna "Nome do funcionário" não encontrada na planilha de ponto.');
  }
  if (pontoColMap.status === undefined) {
    throw new Error('Coluna "Status" não encontrada na planilha de ponto.');
  }

  const pontoData = [];
  const demissoesPendentes = [];
  const demissaoKeys = new Set();
  let demissaoCounter = 0;

  for (let i = pontoHeaderIdx + 1; i < pontoRows.length; i++) {
    const row = pontoRows[i];
    const hasData = row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
    if (!hasData) continue;

    const normalized = normalizePontoRow(row, pontoColMap);
    if (!normalized.nomeFuncionario) continue;

    const detections = detectDemissao(normalized);
    if (detections.length > 0) {
      const dedupeKey = normalized.nomeFuncionario.trim().toUpperCase() + '|' + normalized.dia;
      if (!demissaoKeys.has(dedupeKey)) {
        demissaoKeys.add(dedupeKey);
        demissaoCounter++;
        demissoesPendentes.push({
          id: `dem_${demissaoCounter}`,
          nomeFuncionario: normalized.nomeFuncionario,
          matricula: normalized.matricula,
          dia: normalized.dia,
          cargo: normalized.nomeCargo,
          departamento: normalized.nomeDepartamento,
          campoDetectado: detections[0].campo,
          valorOriginal: detections[0].valor,
          palavraChave: detections[0].palavraChave
        });
      }
    }

    pontoData.push(normalized);
  }

  const parseInfo = extractPontoInfo(pontoData);
  parseInfo.motivosEncontrados = parseInfoDeslig.motivosEncontrados;

  return { pontoData, desligamentoData, parseInfo, demissoesPendentes };
}

function extractPontoInfo(pontoData) {
  const nomesSet = new Set();
  const deptosSet = new Set();
  let diaMin = null;
  let diaMax = null;

  for (const row of pontoData) {
    if (row.nomeFuncionario) nomesSet.add(row.nomeFuncionario);
    if (row.nomeDepartamento) deptosSet.add(row.nomeDepartamento);

    if (row.dia) {
      const d = row.dia;
      if (!diaMin || d < diaMin) diaMin = d;
      if (!diaMax || d > diaMax) diaMax = d;
    }
  }

  return {
    funcionariosUnicos: nomesSet.size,
    departamentos: Array.from(deptosSet).sort(),
    periodo: { inicio: diaMin || 'N/A', fim: diaMax || 'N/A' },
    motivosEncontrados: []
  };
}

function extractDesligInfo(desligData) {
  const motivosMap = {};
  for (const row of desligData) {
    const m = row.motivo;
    if (m) {
      motivosMap[m] = (motivosMap[m] || 0) + 1;
    }
  }
  return Object.entries(motivosMap).map(([motivo, quantidade]) => ({ motivo, quantidade }));
}

const STATUS_FALTAS = STATUS_CONFIG.ABSENTEISMO.lista.map(s => s);

function validatePontoRow(row, rowIndex, linhaPlanilha) {
  const inconsistencias = [];

  if (!row.status || row.status.trim() === '') {
    inconsistencias.push({
      id: 'STATUS_VAZIO:' + rowIndex,
      rowIndex,
      linhaPlanilha,
      tipo: 'STATUS_VAZIO',
      linha: linhaPlanilha,
      funcionario: row.nomeFuncionario || 'Desconhecido',
      departamento: row.nomeDepartamento || '',
      detalhe: 'Coluna Status sem preenchimento.',
      campos: ['status']
    });
  } else {
    const meta = getStatusMeta(row.status);
    if (meta.grupo === 'DESCONHECIDO') {
      inconsistencias.push({
        id: 'STATUS_DESCONHECIDO:' + rowIndex,
        rowIndex,
        linhaPlanilha,
        tipo: 'STATUS_DESCONHECIDO',
        linha: linhaPlanilha,
        funcionario: row.nomeFuncionario || 'Desconhecido',
        departamento: row.nomeDepartamento || '',
        detalhe: `Status "${row.status}" fora do catálogo (não conta no absenteísmo).`,
        campos: ['status']
      });
    }
  }

  if (normalizeStatusKey(row.status) === 'ATESTADO MEDICO' &&
      !(row.cid && String(row.cid).trim())) {
    inconsistencias.push({
      id: 'CID_PENDENTE:' + rowIndex,
      rowIndex,
      linhaPlanilha,
      tipo: 'CID_PENDENTE',
      linha: linhaPlanilha,
      funcionario: row.nomeFuncionario || 'Desconhecido',
      departamento: row.nomeDepartamento || '',
      detalhe: 'ATESTADO MÉDICO sem CID informado (pendência leve, não bloqueia).',
      campos: ['cid']
    });
  }

  if (row.entrada1 && row.entrada1.type === 'time' &&
      (!row.saida2 || row.saida2.type === 'empty')) {
    inconsistencias.push({
      id: 'SAIDA_2_AUSENTE:' + rowIndex,
      rowIndex,
      linhaPlanilha,
      tipo: 'SAIDA_2_AUSENTE',
      linha: linhaPlanilha,
      funcionario: row.nomeFuncionario || 'Desconhecido',
      departamento: row.nomeDepartamento || '',
      detalhe: 'Entrada 1 registrada, mas Saída 2 está vazia sem justificativa.',
      campos: ['saida2', 'status']
    });
  }

  return inconsistencias;
}

function validatePontoData(pontoData) {
  const inconsistencias = [];
  for (let i = 0; i < pontoData.length; i++) {
    const linhaPlanilha = i + 2;
    inconsistencias.push(...validatePontoRow(pontoData[i], i, linhaPlanilha));
  }
  return inconsistencias;
}

function validateDesligamentoData(desligamentoData) {
  const inconsistencias = [];

  for (let i = 0; i < desligamentoData.length; i++) {
    const row = desligamentoData[i];
    const linha = i + 2;

    if (!row.matricula || row.matricula.trim() === '') {
      inconsistencias.push({
        tipo: 'MATRICULA_VAZIA',
        linha,
        funcionario: row.nome || 'Desconhecido',
        departamento: row.obra || '',
        detalhe: 'Campo Matrícula vazio no registro de desligamento.'
      });
    }

    if (!row.nome || row.nome.trim() === '') {
      inconsistencias.push({
        tipo: 'NOME_VAZIO_DESLIG',
        linha,
        funcionario: 'N/A',
        departamento: row.obra || '',
        detalhe: 'Campo Nome vazio no registro de desligamento.'
      });
    }

    if (!row.motivo || row.motivo.trim() === '') {
      inconsistencias.push({
        tipo: 'MOTIVO_VAZIO',
        linha,
        funcionario: row.nome || 'Desconhecido',
        departamento: row.obra || '',
        detalhe: 'Campo Motivo vazio no registro de desligamento.'
      });
    }
  }

  return inconsistencias;
}

function applyCorrecoes(pontoData, correcoes) {
  if (!Array.isArray(correcoes) || correcoes.length === 0) return { pontoData, aplicadas: 0 };

  const whitelist = ['status', 'saida2', 'entrada1', 'cid'];
  let aplicadas = 0;

  for (const c of correcoes) {
    if (typeof c.rowIndex !== 'number' || c.rowIndex < 0 || c.rowIndex >= pontoData.length) continue;
    const campos = c.campos || {};
    const row = pontoData[c.rowIndex];

    for (const key of whitelist) {
      if (campos[key] === undefined) continue;
      const val = campos[key];
      if (key === 'saida2' || key === 'entrada1') {
        if (val === null || val === '') {
          row[key] = { type: 'empty', time: null, text: null };
        } else if (typeof val === 'string' && /^\d{1,2}:\d{2}$/.test(val)) {
          const parts = val.split(':');
          row[key] = { type: 'time', time: parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10), text: null };
        } else {
          row[key] = { type: 'justification', time: null, text: String(val) };
        }
      } else if (key === 'status') {
        row[key] = sanitizeStatus(val);
      } else {
        row[key] = String(val === null || val === undefined ? '' : val).trim();
      }
    }
    aplicadas++;
  }

  return { pontoData, aplicadas };
}

function validateData(pontoData, desligamentoData) {
  const inconsPonto = validatePontoData(pontoData);
  const inconsDeslig = validateDesligamentoData(desligamentoData);
  const todas = [...inconsPonto, ...inconsDeslig];

  const porCategoriaMap = {};
  for (const inc of todas) {
    porCategoriaMap[inc.tipo] = (porCategoriaMap[inc.tipo] || 0) + 1;
  }
  const porCategoria = Object.entries(porCategoriaMap)
    .map(([tipo, quantidade]) => ({ tipo, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return {
    inconsistencias: todas,
    validacaoInfo: { porCategoria }
  };
}

function toPontoDataShape(dbRows) {
  return dbRows.map(r => ({
    chaveFuncionario: r.chave_funcionario,
    nomeFuncionario: r.nome_funcionario,
    nomeCargo: r.cargo,
    nomeDepartamento: r.departamento,
    dia: r.data_registro,
    entrada1: r.entrada1 ? { type: 'time', time: parseTimeToMinutes(r.entrada1) } : { type: 'empty' },
    saida2: r.saida2 ? { type: 'time', time: parseTimeToMinutes(r.saida2) } : { type: 'empty' },
    totalNormais: r.total_normais,
    adicionalNoturno: r.adicional_noturno,
    diaFalta: r.dia_falta,
    horasAtraso: r.horas_atraso,
    faltaEAtraso: r.falta_e_atraso,
    atestado: r.atestado,
    extra50: r.extra50,
    status: r.status,
    cid: r.cid || null
  }));
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  return 0;
}

const MOTIVO_TO_METRIC = {
  absenteismo: 'ALTO ÍNDICE DE ABSENTEÍSMO',
  baixa_produtividade: 'BAIXA PRODUTIVIDADE',
  desvio_comportamental: 'DESVIO COMPORTAMENTAL',
  pedido_demissao: 'PEDIDO DE DEMISSÃO',
  reducao_quadro: 'REDUÇÃO DE QUADRO (EFETIVO)'
};

function toDesligDataShape(dbRows) {
  return dbRows.map(r => ({
    dataDesligamento: r.data_desligamento,
    matricula: r.chave_funcionario.replace('MAT_', ''),
    nome: r.nome_funcionario,
    funcao: r.cargo,
    obra: r.departamento,
    motivo: MOTIVO_TO_METRIC[r.justificativa_rh] || r.justificativa_rh,
    aviso: ''
  }));
}

const MESES_PT = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'
];

const JORNADA_PADRAO_HORAS = 8;

const MOTIVOS_TURNOVER_RELEVANTES = [
  'ALTO ÍNDICE DE ABSENTEÍSMO',
  'BAIXA PRODUTIVIDADE',
  'PEDIDO DE DEMISSÃO',
  'DESVIO COMPORTAMENTAL'
];

const MOTIVO_EXCLUIDO_TURNOVER = 'REDUÇÃO DE QUADRO (EFETIVO)';

// Status deduzidos da base do Efetivo Ativo (regra de turnover).
// Conjunto literal — independente dos grupos do statusRules
// (LICENÇA PATERNIDADE é ABSENTEISMO lá, mas sai do efetivo ativo aqui).
const ESTATUS_EFETIVO_EXCLUIDOS = [
  'LICENÇA PATERNIDADE',
  'LICENÇA MATERNIDADE',
  'FÉRIAS',
  'INSS'
];

const META_TURNOVER_GERAL = 5.0;
const META_TURNOVER_OPERACIONAL = 3.0;
const TURNOVER_CRITICO = 5.0;

function chaveMesDe(dia) {
  if (!dia) return null;
  if (dia instanceof Date) {
    return `${dia.getFullYear()}-${String(dia.getMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof dia !== 'string') return null;
  const partes = dia.split(/[\/\-\.]/);
  if (partes.length >= 3) {
    const mes = partes[1].padStart(2, '0');
    if (partes[0].length <= 2) return `${partes[2]}-${mes}`; // dd/mm/yyyy
    return `${partes[0]}-${mes}`; // yyyy-mm-dd
  }
  return null;
}

function chavePessoaDe(row) {
  if (row.chaveFuncionario && String(row.chaveFuncionario).trim() !== '') {
    return String(row.chaveFuncionario).trim();
  }
  const nome = (row.nomeFuncionario || '').trim().toUpperCase();
  return nome ? `NOM_${nome}` : null;
}

/**
 * Efetivo Ativo por mês (base do turnover):
 *   vinculados   = DISTINCT colaboradores com ≥1 registro no mês
 *   deduzidos    = desses, quem teve ≥1 status sanitizado em ESTATUS_EFETIVO_EXCLUIDOS
 *   efetivoAtivo = vinculados - deduzidos
 * (deduzir LICENÇA PATERNIDADE etc. para não inflar o denominador)
 */
function calcEfetivoAtivoPorMes(pontoData) {
  const meses = new Map(); // chaveMes -> Map(pessoa -> {afastado})

  for (const row of pontoData) {
    const chaveMes = chaveMesDe(row.dia);
    const chavePessoa = chavePessoaDe(row);
    if (!chaveMes || !chavePessoa) continue;
    if (!meses.has(chaveMes)) meses.set(chaveMes, new Map());
    const pessoas = meses.get(chaveMes);
    const p = pessoas.get(chavePessoa) || { afastado: false };
    const status = sanitizeStatus(row.status);
    if (ESTATUS_EFETIVO_EXCLUIDOS.includes(status)) p.afastado = true;
    pessoas.set(chavePessoa, p);
  }

  const porMes = [...meses.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([chave, pessoas]) => {
      const arr = [...pessoas.values()];
      const vinculados = arr.length;
      const deduzidos = arr.filter(p => p.afastado).length;
      const [ano, mes] = chave.split('-');
      return {
        chave,
        label: `${MESES_PT[parseInt(mes, 10) - 1] || mes}/${ano.slice(2)}`,
        vinculados,
        deduzidos,
        efetivoAtivo: vinculados - deduzidos
      };
    });

  const comDados = porMes.filter(m => m.vinculados > 0);
  const efetivoAtivoMedio = comDados.length
    ? parseFloat((comDados.reduce((s, m) => s + m.efetivoAtivo, 0) / comDados.length).toFixed(2))
    : 0;

  const todos = new Map();
  for (const [, pessoas] of meses) {
    for (const [k, v] of pessoas) todos.set(k, v);
  }

  return {
    porMes,
    efetivoAtivoMedio,
    efetivoTotalVinculados: todos.size,
    deduzidosNoPeriodo: [...todos.values()].filter(p => p.afastado).length
  };
}

function calcTurnoverMensal(desligamentoData, porMesEfetivo) {
  const desligPorMes = {};
  for (const row of desligamentoData) {
    const chaveMes = chaveMesDe(row.dataDesligamento);
    if (!chaveMes) continue;
    if (!desligPorMes[chaveMes]) desligPorMes[chaveMes] = { total: 0, operacional: 0 };
    desligPorMes[chaveMes].total++;
    if (MOTIVOS_TURNOVER_RELEVANTES.includes(row.motivo)) {
      desligPorMes[chaveMes].operacional++;
    }
  }

  return (porMesEfetivo || []).map(m => {
    const d = desligPorMes[m.chave] || { total: 0, operacional: 0 };
    const reducaoCount = d.total - d.operacional;
    return {
      chave: m.chave,
      label: m.label,
      efetivoAtivo: m.efetivoAtivo,
      desligadosGeral: d.total,
      operacionais: d.operacional,
      reducao: reducaoCount,
      geral: m.efetivoAtivo > 0
        ? parseFloat(((d.total / m.efetivoAtivo) * 100).toFixed(2))
        : 0,
      operacional: m.efetivoAtivo > 0
        ? parseFloat(((d.operacional / m.efetivoAtivo) * 100).toFixed(2))
        : 0,
      reducaoPct: m.efetivoAtivo > 0
        ? parseFloat(((reducaoCount / m.efetivoAtivo) * 100).toFixed(2))
        : 0
    };
  });
}

function calcTurnoverPorFuncao(pontoData, desligamentoData) {
  const porCargo = new Map(); // cargo -> Map(pessoa -> {afastado})
  for (const row of pontoData) {
    const cargo = (row.nomeCargo || '').trim() || 'Sem Função';
    const chavePessoa = chavePessoaDe(row);
    if (!chavePessoa) continue;
    if (!porCargo.has(cargo)) porCargo.set(cargo, new Map());
    const pessoas = porCargo.get(cargo);
    const p = pessoas.get(chavePessoa) || { afastado: false };
    const status = sanitizeStatus(row.status);
    if (ESTATUS_EFETIVO_EXCLUIDOS.includes(status)) p.afastado = true;
    pessoas.set(chavePessoa, p);
  }

  const desligPorCargo = {};
  for (const row of desligamentoData) {
    const cargo = (row.funcao || '').trim() || 'Sem Função';
    desligPorCargo[cargo] = (desligPorCargo[cargo] || 0) + 1;
  }

  const resultado = [];
  for (const cargo of new Set([...porCargo.keys(), ...Object.keys(desligPorCargo)])) {
    const desligados = desligPorCargo[cargo] || 0;
    if (desligados === 0) continue;
    const pessoas = porCargo.get(cargo);
    const arr = pessoas ? [...pessoas.values()] : [];
    const vinculados = arr.length;
    const deduzidos = arr.filter(p => p.afastado).length;
    const efetivoAtivo = vinculados - deduzidos;
    const taxa = efetivoAtivo > 0
      ? parseFloat(((desligados / efetivoAtivo) * 100).toFixed(2))
      : 0;
    resultado.push({ label: cargo, taxa, desligados, efetivoAtivo, vinculados });
  }

  return resultado
    .sort((a, b) => (b.taxa - a.taxa) || (b.desligados - a.desligados))
    .slice(0, 10);
}

function getEfetivoTotal(pontoData) {
  const nomes = new Set();
  for (const row of pontoData) {
    if (row.nomeFuncionario && row.nomeFuncionario.trim() !== '') {
      nomes.add(row.nomeFuncionario.trim());
    }
  }
  return nomes.size;
}

function calcAbsenteismo(pontoData) {
  const totalGeral = pontoData.length;
  const classes = classificarRegistros(pontoData);
  const abs = calcularAbsenteismo(pontoData);

  return {
    percentual: abs.percentual,
    totalGeral: classes.totalPrevistos,
    totalFaltas: abs.totalAusencias,
    totalRegistros: totalGeral,
    excluidos: abs.excluidos,
    detalhamento: abs.detalhamento
  };
}

function calcAbsenteismoPorMes(pontoData) {
  const porMes = {};

  for (const row of pontoData) {
    const dia = row.dia;
    if (!dia) continue;

    let chaveMes;
    if (dia instanceof Date) {
      chaveMes = `${dia.getFullYear()}-${String(dia.getMonth() + 1).padStart(2, '0')}`;
    } else if (typeof dia === 'string') {
      const partes = dia.split(/[\/\-\.]/);
      if (partes.length >= 3) {
        const mes = partes[1].padStart(2, '0');
        const ano = partes[2];
        if (partes[0].length <= 2) {
          chaveMes = `${ano}-${mes}`;
        } else {
          chaveMes = `${partes[0]}-${mes}`;
        }
      } else if (partes.length === 2) {
        chaveMes = `${partes[1]}-${partes[0].padStart(2, '0')}`;
      } else {
        continue;
      }
    } else {
      continue;
    }

    if (!porMes[chaveMes]) {
      porMes[chaveMes] = { total: 0, faltas: 0 };
    }
    const meta = getStatusMeta(row.status);
    if (meta.geraAbsenteismo || meta.contaComoPresenca || meta.grupo === 'DESCONHECIDO') {
      porMes[chaveMes].total++;
      if (meta.geraAbsenteismo) {
        porMes[chaveMes].faltas++;
      }
    }
  }

  const resultado = Object.entries(porMes)
    .map(([chave, dados]) => {
      const [ano, mes] = chave.split('-');
      const mesNum = parseInt(mes, 10) - 1;
      const label = `${MESES_PT[mesNum] || mes}/${ano.slice(2)}`;
      const percentual = dados.total > 0
        ? parseFloat(((dados.faltas / dados.total) * 100).toFixed(2))
        : 0;
      return { label, value: percentual, chave };
    })
    .sort((a, b) => a.chave.localeCompare(b.chave));

  return resultado;
}

function calcAbsenteismoPorFuncao(pontoData) {
  const porFuncao = {};

  for (const row of pontoData) {
    const funcao = (row.nomeCargo || row.nomeFuncao || '').trim() || 'Sem Função';
    if (!porFuncao[funcao]) {
      porFuncao[funcao] = { total: 0, faltas: 0 };
    }
    const meta = getStatusMeta(row.status);
    if (meta.geraAbsenteismo || meta.contaComoPresenca || meta.grupo === 'DESCONHECIDO') {
      porFuncao[funcao].total++;
      if (meta.geraAbsenteismo) {
        porFuncao[funcao].faltas++;
      }
    }
  }

  return Object.entries(porFuncao)
    .map(([funcao, dados]) => ({
      label: funcao,
      value: dados.total > 0
        ? parseFloat(((dados.faltas / dados.total) * 100).toFixed(2))
        : 0,
      total: dados.total,
      faltas: dados.faltas
    }))
    .sort((a, b) => b.value - a.value);
}

function calcAbsenteismoPorDia(pontoData) {
  const porDia = {};

  for (const row of pontoData) {
    const dia = row.dia;
    if (!dia || typeof dia !== 'string') continue;

    const meta = getStatusMeta(row.status);
    if (!(meta.geraAbsenteismo || meta.contaComoPresenca || meta.grupo === 'DESCONHECIDO')) {
      continue;
    }

    if (!porDia[dia]) {
      porDia[dia] = { data: dia, faltas: 0, previstos: 0 };
    }
    porDia[dia].previstos++;
    if (meta.geraAbsenteismo) {
      porDia[dia].faltas++;
    }
  }

  return Object.values(porDia)
    .map(d => ({
      ...d,
      percentual: d.previstos > 0
        ? parseFloat(((d.faltas / d.previstos) * 100).toFixed(2))
        : 0
    }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

function calcAbsenteismoPorFuncionario(pontoData) {
  const porPessoa = {};

  for (const row of pontoData) {
    const nome = (row.nomeFuncionario || '').trim() || 'Sem Nome';
    if (!porPessoa[nome]) {
      porPessoa[nome] = { faltas: 0, previstos: 0 };
    }
    const meta = getStatusMeta(row.status);
    if (meta.geraAbsenteismo || meta.contaComoPresenca || meta.grupo === 'DESCONHECIDO') {
      porPessoa[nome].previstos++;
      if (meta.geraAbsenteismo) {
        porPessoa[nome].faltas++;
      }
    }
  }

  return Object.entries(porPessoa)
    .filter(([, d]) => d.previstos > 0)
    .map(([nome, dados]) => ({
      nome,
      faltas: dados.faltas,
      previstos: dados.previstos,
      percentual: parseFloat(((dados.faltas / dados.previstos) * 100).toFixed(2))
    }))
    .sort((a, b) => b.percentual - a.percentual || b.faltas - a.faltas);
}

function calcAderencia(pontoData) {
  let somaHorasTrabalhadas = 0;
  let somaHorasPrevistas = 0;

  for (const row of pontoData) {
    const horasNormais = row.totalNormais || 0;
    somaHorasTrabalhadas += horasNormais;

    if (horasNormais > 0) {
      somaHorasPrevistas += JORNADA_PADRAO_HORAS;
    } else {
      const st = (row.status || '').trim();
      const meta = getStatusMeta(st);
      if (meta.geraAbsenteismo || meta.contaComoPresenca || st === '' || meta.grupo === 'DESCONHECIDO') {
        somaHorasPrevistas += JORNADA_PADRAO_HORAS;
      }
    }
  }

  const percentual = somaHorasPrevistas > 0
    ? (somaHorasTrabalhadas / somaHorasPrevistas) * 100
    : 0;

  return {
    percentual: parseFloat(percentual.toFixed(2)),
    somaHorasTrabalhadas: parseFloat(somaHorasTrabalhadas.toFixed(2)),
    somaHorasPrevistas: parseFloat(somaHorasPrevistas.toFixed(2))
  };
}

function calcTurnover(desligamentoData, efetivoTotal) {
  const contagemPorMotivo = {};
  for (const row of desligamentoData) {
    const m = row.motivo;
    if (m) {
      contagemPorMotivo[m] = (contagemPorMotivo[m] || 0) + 1;
    }
  }

  let desligamentosRelevantes = 0;
  for (const row of desligamentoData) {
    if (MOTIVOS_TURNOVER_RELEVANTES.includes(row.motivo)) {
      desligamentosRelevantes++;
    }
  }

  const quantidadeExcluido = contagemPorMotivo[MOTIVO_EXCLUIDO_TURNOVER] || 0;
  const totalDesligamentos = desligamentoData.length;

  const percentual = efetivoTotal > 0
    ? (desligamentosRelevantes / efetivoTotal) * 100
    : 0;

  const detalhamentoMotivos = MOTIVOS_TURNOVER_RELEVANTES
    .map(motivo => ({
      motivo,
      quantidade: contagemPorMotivo[motivo] || 0
    }))
    .filter(d => d.quantidade > 0);

  const percentualReducao = efetivoTotal > 0
    ? parseFloat(((quantidadeExcluido / efetivoTotal) * 100).toFixed(2))
    : 0;

  return {
    percentual: parseFloat(percentual.toFixed(2)),
    desligamentosRelevantes,
    efetivoTotal,
    totalDesligamentos,
    detalhamentoMotivos,
    excluidoDoCalculo: {
      motivo: MOTIVO_EXCLUIDO_TURNOVER,
      quantidade: quantidadeExcluido,
      percentual: percentualReducao
    }
  };
}

function buildGraficos(pontoData, desligamentoData, absenteismo, turnover) {
  const absenteismoPorStatus = absenteismo.detalhamento.map(d => ({
    label: d.status,
    value: d.quantidade
  }));

  const absenteismoPorMes = calcAbsenteismoPorMes(pontoData);

  const absenteismoPorFuncao = calcAbsenteismoPorFuncao(pontoData);

  const absenteismoPorDia = calcAbsenteismoPorDia(pontoData);

  const absenteismoPorFuncionario = calcAbsenteismoPorFuncionario(pontoData);

  const turnoverPorMotivo = turnover.detalhamentoMotivos.map(d => ({
    label: d.motivo,
    value: d.quantidade
  }));

  const deptoFaltas = {};
  const deptoTotal = {};
  for (const row of pontoData) {
    const depto = row.nomeDepartamento || 'Sem Departamento';
    const meta = getStatusMeta(row.status);
    if (meta.geraAbsenteismo || meta.contaComoPresenca || meta.grupo === 'DESCONHECIDO') {
      deptoTotal[depto] = (deptoTotal[depto] || 0) + 1;
      if (meta.geraAbsenteismo) {
        deptoFaltas[depto] = (deptoFaltas[depto] || 0) + 1;
      }
    }
  }

  const absenteismoPorDepartamento = Object.entries(deptoTotal)
    .map(([departamento, total]) => {
      const faltas = deptoFaltas[departamento] || 0;
      return {
        label: departamento,
        value: total > 0 ? parseFloat(((faltas / total) * 100).toFixed(2)) : 0
      };
    })
    .sort((a, b) => b.value - a.value);

  const turnoverPorMotivoCompleto = Object.entries(
    desligamentoData.reduce((acc, d) => {
      const m = d.motivo || 'DESCONHECIDO';
      acc[m] = (acc[m] || 0) + 1;
      return acc;
    }, {})
  ).map(([motivo, quantidade]) => ({ label: motivo, value: quantidade }));

  const turnoverComparativo = {
    operacional: turnover.desligamentosRelevantes,
    operacionalPercentual: turnover.percentual,
    reducaoQuadro: turnover.excluidoDoCalculo.quantidade,
    reducaoQuadroPercentual: turnover.excluidoDoCalculo.percentual,
    motivosOperacionais: turnover.detalhamentoMotivos
  };

  return {
    absenteismoPorStatus,
    absenteismoPorMes,
    absenteismoPorFuncao,
    absenteismoPorDia,
    absenteismoPorFuncionario,
    turnoverPorMotivo,
    absenteismoPorDepartamento,
    turnoverPorMotivoCompleto,
    turnoverComparativo
  };
}

function calculateMetrics(pontoData, desligamentoData, efetivoTotalOverride) {
  const efetivoTotal = efetivoTotalOverride !== undefined ? efetivoTotalOverride : getEfetivoTotal(pontoData);

  const absenteismo = calcAbsenteismo(pontoData);
  const aderencia = calcAderencia(pontoData);
  const turnover = calcTurnover(desligamentoData, efetivoTotal);

  const graficos = buildGraficos(pontoData, desligamentoData, absenteismo, turnover);

  const kpis = {
    absenteismo,
    aderencia,
    turnover
  };

  return { kpis, graficos, efetivoTotal };
}

module.exports = {
  parseExcelFiles,
  validateData,
  validatePontoRow,
  applyCorrecoes,
  detectDemissao,
  toPontoDataShape,
  toDesligDataShape,
  calculateMetrics,
  formatExcelDate,
  excelDecimalToTime,
  STATUS_FALTAS,
  STATUS_CONFIG,
  STATUS_ALIASES,
  normalizeStatusKey,
  sanitizeStatus,
  getStatusMeta,
  badgeForStatus,
  classificarRegistros,
  calcularAbsenteismo,
  calcEfetivoAtivoPorMes,
  calcTurnoverMensal,
  calcTurnoverPorFuncao,
  ESTATUS_EFETIVO_EXCLUIDOS,
  META_TURNOVER_GERAL,
  META_TURNOVER_OPERACIONAL,
  MOTIVOS_TURNOVER_RELEVANTES
};