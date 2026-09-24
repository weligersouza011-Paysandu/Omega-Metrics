const XLSX = require('xlsx');

function formatExcelDate(serial) {
  if (serial === null || serial === undefined || serial === '') return serial;
  if (typeof serial === 'string' && serial.includes('/')) return serial;
  if (isNaN(serial)) return serial;
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  const day = String(date_info.getUTCDate()).padStart(2, '0');
  const month = String(date_info.getUTCMonth() + 1).padStart(2, '0');
  const year = date_info.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function excelDecimalToTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    if (/^\d{1,2}[.:]\d{2}$/.test(t)) return t.replace('.', ':');
    const n = Number(t);
    if (isNaN(n)) return t;
    v = n;
  }
  if (typeof v === 'number') {
    if (v < 0 || v >= 1) return String(v);
    const totalMinutes = Math.round(v * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  return null;
}

const HEADER_MAP_PONTO = {
  'nome do funcionário': 'nomeFuncionario',
  'nome funcionario': 'nomeFuncionario',
  'funcionário': 'nomeFuncionario',
  'funcionario': 'nomeFuncionario',
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

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function findHeaderRow(rows, keywords) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
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
    nomeCargo: String(get('nomeCargo')).trim(),
    nomeDepartamento: String(get('nomeDepartamento')).trim(),
    dia: String(get('dia')).trim(),
    entrada1,
    saida2,
    totalNormais: safeNumber(get('totalNormais')),
    adicionalNoturno: safeNumber(get('adicionalNoturno')),
    diaFalta: String(get('diaFalta')).trim(),
    horasAtraso: safeNumber(get('horasAtraso')),
    faltaEAtraso: String(get('faltaEAtraso')).trim(),
    atestado: String(get('atestado')).trim(),
    extra50: safeNumber(get('extra50')),
    status: String(get('status')).trim()
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

function extractPontoInfo(pontoData) {
  const nomesSet = new Set();
  const deptosSet = new Set();
  const motivosMap = {};
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

function parseExcelFiles(pontoBuffer, desligBuffer) {
  const pontoRows = readSheet(pontoBuffer);
  const desligRows = readSheet(desligBuffer);

  if (pontoRows.length < 2) {
    throw new Error('A planilha de ponto está vazia ou não contém dados.');
  }
  if (desligRows.length < 2) {
    throw new Error('A planilha de desligamentos está vazia ou não contém dados.');
  }

  const pontoKeywords = ['nome do funcionário', 'nome funcionario', 'funcionário', 'dia', 'entrada', 'status'];
  const pontoHeaderIdx = findHeaderRow(pontoRows, pontoKeywords);
  if (pontoHeaderIdx === -1) {
    throw new Error('Não foi possível identificar o cabeçalho da planilha de ponto.');
  }

  const desligKeywords = ['matricula', 'matrícula', 'nome', 'motivo', 'função', 'funcao'];
  const desligHeaderIdx = findHeaderRow(desligRows, desligKeywords);
  if (desligHeaderIdx === -1) {
    throw new Error('Não foi possível identificar o cabeçalho da planilha de desligamentos.');
  }

  const pontoRawHeaders = pontoRows[pontoHeaderIdx];
  const desligRawHeaders = desligRows[desligHeaderIdx];

  const pontoColMap = mapHeaders(pontoRawHeaders, HEADER_MAP_PONTO);
  const desligColMap = mapHeaders(desligRawHeaders, HEADER_MAP_DESLIG);

  if (pontoColMap.nomeFuncionario === undefined) {
    throw new Error('Coluna "Nome do funcionário" não encontrada na planilha de ponto.');
  }
  if (pontoColMap.status === undefined) {
    throw new Error('Coluna "Status" não encontrada na planilha de ponto.');
  }

  const pontoData = [];
  for (let i = pontoHeaderIdx + 1; i < pontoRows.length; i++) {
    const row = pontoRows[i];
    const hasData = row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
    if (!hasData) continue;

    const normalized = normalizePontoRow(row, pontoColMap);
    if (!normalized.nomeFuncionario) continue;

    pontoData.push(normalized);
  }

  const desligamentoData = [];
  for (let i = desligHeaderIdx + 1; i < desligRows.length; i++) {
    const row = desligRows[i];
    const hasData = row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
    if (!hasData) continue;

    const normalized = normalizeDesligRow(row, desligColMap);
    if (!normalized.nome && !normalized.matricula) continue;

    desligamentoData.push(normalized);
  }

  const parseInfo = extractPontoInfo(pontoData);
  parseInfo.motivosEncontrados = extractDesligInfo(desligamentoData);

  return { pontoData, desligamentoData, parseInfo };
}

module.exports = { parseExcelFiles, formatExcelDate, excelDecimalToTime };
