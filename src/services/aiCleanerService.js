const STATUS_CANONICOS = {
  'falta': 'Falta',
  'advertencia': 'Advertência',
  'advertência': 'Advertência',
  'advertancia': 'Advertência',
  'advertencia': 'Advertência',
  'advertecia': 'Advertência',
  'atestado': 'Atestado',
  'atestado de obito': 'Atestado de Óbito',
  'atestado de óbito': 'Atestado de Óbito',
  'boletin de ocorrencia': 'Boletim de Ocorrência',
  'boletim de ocorrencia': 'Boletim de Ocorrência',
  'boletim de ocorrência': 'Boletim de Ocorrência',
  'declaracao': 'Declaração',
  'declaração': 'Declaração',
  'decaracao': 'Declaração',
  'decaração': 'Declaração',
  'declaracao banco': 'Declaração Banco',
  'declaração banco': 'Declaração Banco',
  'exame': 'Exame',
  'exame medico': 'Exame Médico',
  'exame médico': 'Exame Médico',
  'licenca casamento': 'Licença Casamento',
  'licença casamento': 'Licença Casamento',
  'licenca maternidade': 'Licença Maternidade',
  'licença maternidade': 'Licença Maternidade',
  'licenca paternidade': 'Licença Paternidade',
  'licença paternidade': 'Licença Paternidade',
  'medico': 'Médico',
  'médico': 'Médico',
  'periodico': 'Periódico',
  'periódico': 'Periódico'
};

const MOTIVO_CATEGORIAS = {
  'ALTO ÍNDICE DE ABSENTEÍSMO': 'OPERACIONAL',
  'ALTO INDICE DE ABSENTEISMO': 'OPERACIONAL',
  'BAIXA PRODUTIVIDADE': 'OPERACIONAL',
  'PEDIDO DE DEMISSÃO': 'OPERACIONAL',
  'PEDIDO DE DEMISSAO': 'OPERACIONAL',
  'DESVIO COMPORTAMENTAL': 'OPERACIONAL',
  'REDUÇÃO DE QUADRO (EFETIVO)': 'CONTRATUAL',
  'REDUCAO DE QUADRO (EFETIVO)': 'CONTRATUAL'
};

const MOTIVOS_OPERACIONAIS = [
  'ALTO ÍNDICE DE ABSENTEÍSMO',
  'BAIXA PRODUTIVIDADE',
  'PEDIDO DE DEMISSÃO',
  'DESVIO COMPORTAMENTAL'
];

const MOTIVO_EXCLUIDO = 'REDUÇÃO DE QUADRO (EFETIVO)';

function levenshteinDistance(a, b) {
  var m = a.length;
  var n = b.length;
  var dp = [];

  for (var i = 0; i <= m; i++) {
    dp[i] = [i];
  }
  for (var j = 0; j <= n; j++) {
    dp[0][j] = j;
  }

  for (var i = 1; i <= m; i++) {
    for (var j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeStatus(input) {
  if (!input || typeof input !== 'string') {
    return { value: input, method: 'empty', needsAI: false };
  }

  var trimmed = input.trim();
  var lower = trimmed.toLowerCase();

  var exactMatch = STATUS_CANONICOS[lower];
  if (exactMatch) {
    return { value: exactMatch, method: 'exact', needsAI: false };
  }

  var stripped = stripAccents(lower);
  for (var key in STATUS_CANONICOS) {
    if (stripAccents(key) === stripped) {
      return { value: STATUS_CANONICOS[key], method: 'accent', needsAI: false };
    }
  }

  var bestMatch = null;
  var bestDist = Infinity;
  var threshold = lower.length <= 8 ? 2 : 3;

  for (var key in STATUS_CANONICOS) {
    var dist = levenshteinDistance(lower, key);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = STATUS_CANONICOS[key];
    }
  }

  if (bestDist <= threshold && bestMatch) {
    return { value: bestMatch, method: 'fuzzy', distance: bestDist, needsAI: false };
  }

  return { value: trimmed, method: 'unchanged', needsAI: true };
}

function normalizeMotivo(input) {
  if (!input || typeof input !== 'string') {
    return { value: input, category: 'DESCONHECIDO', method: 'empty', needsAI: false };
  }

  var trimmed = input.trim();
  var upper = trimmed.toUpperCase();

  var exactCategory = MOTIVO_CATEGORIAS[upper];
  if (exactCategory) {
    return { value: trimmed, category: exactCategory, method: 'exact', needsAI: false };
  }

  var stripped = stripAccents(upper);
  for (var key in MOTIVO_CATEGORIAS) {
    if (stripAccents(key) === stripped) {
      return { value: trimmed, category: MOTIVO_CATEGORIAS[key], method: 'accent', needsAI: false };
    }
  }

  if (upper.indexOf('ABSENTEISMO') !== -1 || upper.indexOf('ABSENTEÍSMO') !== -1) {
    return { value: 'ALTO ÍNDICE DE ABSENTEÍSMO', category: 'OPERACIONAL', method: 'keyword', needsAI: false };
  }
  if (upper.indexOf('PRODUTIVIDADE') !== -1 && upper.indexOf('BAIXA') !== -1) {
    return { value: 'BAIXA PRODUTIVIDADE', category: 'OPERACIONAL', method: 'keyword', needsAI: false };
  }
  if (upper.indexOf('DEMISSÃO') !== -1 || upper.indexOf('DEMISSAO') !== -1 || upper.indexOf('PEDIDO') !== -1) {
    return { value: 'PEDIDO DE DEMISSÃO', category: 'OPERACIONAL', method: 'keyword', needsAI: false };
  }
  if (upper.indexOf('COMPORTAMENTAL') !== -1 || upper.indexOf('DESVIO') !== -1) {
    return { value: 'DESVIO COMPORTAMENTAL', category: 'OPERACIONAL', method: 'keyword', needsAI: false };
  }
  if (upper.indexOf('REDUÇÃO') !== -1 || upper.indexOf('REDUCAO') !== -1 || upper.indexOf('QUADRO') !== -1) {
    return { value: 'REDUÇÃO DE QUADRO (EFETIVO)', category: 'CONTRATUAL', method: 'keyword', needsAI: false };
  }

  var bestMatch = null;
  var bestDist = Infinity;

  for (var key in MOTIVO_CATEGORIAS) {
    var dist = levenshteinDistance(stripped, stripAccents(key));
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = key;
    }
  }

  if (bestDist <= 4 && bestMatch) {
    return { value: bestMatch, category: MOTIVO_CATEGORIAS[bestMatch], method: 'fuzzy', distance: bestDist, needsAI: false };
  }

  return { value: trimmed, category: 'OUTROS', method: 'unchanged', needsAI: true };
}

function batchCleanLocal(pontoData, desligamentoData) {
  var corrections = [];
  var totalCorrected = 0;
  var needsAI = [];

  var statusCounts = {};
  for (var i = 0; i < pontoData.length; i++) {
    var status = pontoData[i].status;
    if (status) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
  }

  for (var rawStatus in statusCounts) {
    var result = normalizeStatus(rawStatus);
    if (result.method !== 'exact' || rawStatus !== result.value) {
      corrections.push({
        type: 'status',
        original: rawStatus,
        corrected: result.value,
        method: result.method,
        count: statusCounts[rawStatus],
        needsAI: result.needsAI
      });
      totalCorrected += statusCounts[rawStatus];
      if (result.needsAI) {
        needsAI.push({ type: 'status', value: rawStatus });
      }
    }
  }

  var motivoCounts = {};
  for (var j = 0; j < desligamentoData.length; j++) {
    var motivo = desligamentoData[j].motivo;
    if (motivo) {
      motivoCounts[motivo] = (motivoCounts[motivo] || 0) + 1;
    }
  }

  for (var rawMotivo in motivoCounts) {
    var motivoResult = normalizeMotivo(rawMotivo);
    if (motivoResult.method !== 'exact' || rawMotivo !== motivoResult.value) {
      corrections.push({
        type: 'motivo',
        original: rawMotivo,
        corrected: motivoResult.value,
        category: motivoResult.category,
        method: motivoResult.method,
        count: motivoCounts[rawMotivo],
        needsAI: motivoResult.needsAI
      });
      totalCorrected += motivoCounts[rawMotivo];
      if (motivoResult.needsAI) {
        needsAI.push({ type: 'motivo', value: rawMotivo });
      }
    }
  }

  corrections.sort(function (a, b) { return b.count - a.count; });

  return {
    corrections: corrections,
    totalCorrected: totalCorrected,
    needsAI: needsAI
  };
}

async function callGeminiForCleaning(unresolvedItems) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'sua_chave_aqui') {
    return { corrections: [], unresolved: unresolvedItems.length };
  }

  try {
    var axios = require('axios');

    var itemsText = unresolvedItems.map(function (item, i) {
      return (i + 1) + '. Tipo: ' + item.type + ' | Valor: "' + item.value + '"';
    }).join('\n');

    var prompt = 'Você é um normalizador de dados de recursos humanos.\n' +
      'Corrija os erros de digitação e acentuação nos textos abaixo.\n' +
      'Retorne APENAS um array JSON, na mesma ordem, com os textos corrigidos.\n\n' +
      'Valores de status devem ser: Falta, Advertência, Atestado, Atestado de Óbito, ' +
      'Boletim de Ocorrência, Declaração, Declaração Banco, Exame, Exame Médico, ' +
      'Licença Casamento, Licença Maternidade, Licença Paternidade, Médico, Periódico.\n\n' +
      'Valores de motivo devem ser: ALTO ÍNDICE DE ABSENTEÍSMO, BAIXA PRODUTIVIDADE, ' +
      'PEDIDO DE DEMISSÃO, DESVIO COMPORTAMENTAL, REDUÇÃO DE QUADRO (EFETIVO).\n\n' +
      'Itens:\n' + itemsText;

    var response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json'
        }
      },
      { timeout: 30000 }
    );

    var text = response.data.candidates[0].content.parts[0].text;
    var parsed = JSON.parse(text);

    var aiCorrections = [];
    for (var k = 0; k < unresolvedItems.length && k < parsed.length; k++) {
      if (parsed[k] && parsed[k] !== unresolvedItems[k].value) {
        aiCorrections.push({
          type: unresolvedItems[k].type,
          original: unresolvedItems[k].value,
          corrected: parsed[k],
          method: 'ai',
          count: 1
        });
      }
    }

    return { corrections: aiCorrections, unresolved: unresolvedItems.length - aiCorrections.length };
  } catch (err) {
    console.error('Erro na chamada Gemini para limpeza:', err.message);
    return { corrections: [], unresolved: unresolvedItems.length };
  }
}

async function cleanDataWithAI(pontoData, desligamentoData) {
  var localResults = batchCleanLocal(pontoData, desligamentoData);

  var aiResults = { corrections: [], unresolved: 0 };
  if (localResults.needsAI.length > 0) {
    aiResults = await callGeminiForCleaning(localResults.needsAI);
  }

  var allCorrections = localResults.corrections.concat(aiResults.corrections);

  var correctedLocally = 0;
  var correctedByAI = 0;
  for (var i = 0; i < allCorrections.length; i++) {
    if (allCorrections[i].method === 'ai') {
      correctedByAI += allCorrections[i].count;
    } else {
      correctedLocally += allCorrections[i].count;
    }
  }

  var totalRecords = pontoData.length + desligamentoData.length;
  var totalCorrections = correctedLocally + correctedByAI;

  return {
    corrections: allCorrections,
    stats: {
      totalProcessed: totalRecords,
      correctedLocally: correctedLocally,
      correctedByAI: correctedByAI,
      totalCorrected: totalCorrections,
      unchanged: totalRecords - totalCorrections,
      aiAvailable: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'sua_chave_aqui')
    }
  };
}

module.exports = {
  cleanDataWithAI: cleanDataWithAI,
  normalizeStatus: normalizeStatus,
  normalizeMotivo: normalizeMotivo,
  STATUS_CANONICOS: STATUS_CANONICOS,
  MOTIVO_CATEGORIAS: MOTIVO_CATEGORIAS,
  MOTIVOS_OPERACIONAIS: MOTIVOS_OPERACIONAIS,
  MOTIVO_EXCLUIDO: MOTIVO_EXCLUIDO
};
