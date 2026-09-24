const STATUS_CONFIG = {
  PRESENCA: {
    lista: ["PRESENTE", "ADVERTÊNCIA"],
    badgeClass: "badge-success",
    bgHex: "#10B981",
    contaComoPresenca: true,
    geraAbsenteismo: false
  },
  ABSENTEISMO: {
    lista: [
      "FALTA SEM JUSTIFICATIVA", "ATESTADO MÉDICO", "ATESTADO DE ÓBITO",
      "DECLARAÇÃO", "BO", "ÓBITO",
      "LICENÇA CASAMENTO", "LICENÇA PATERNIDADE"
    ],
    badgeClass: "badge-danger",
    bgHex: "#EF4444",
    contaComoPresenca: false,
    geraAbsenteismo: true
  },
  ISENCAO: {
    lista: [
      "COMPENSAÇÃO", "FÉRIAS", "FOLGA", "EXAME PERIÓDICO",
      "LICENÇA MATERNIDADE", "INSS", "AGUARDANDO CRACHÁ", "TREINAMENTO", "FERIADO",
      "AGUARDANDO MOBILIZAÇÃO SGC", "TRANSFERÊNCIA"
    ],
    badgeClass: "badge-secondary",
    bgHex: "#6B7280",
    contaComoPresenca: false,
    geraAbsenteismo: false
  },
  DEMISSAO: {
    lista: ["DEMITIDO"],
    badgeClass: "badge-purple",
    bgHex: "#8B5CF6",
    contaComoPresenca: false,
    geraAbsenteismo: false,
    requerJustificativa: true
  }
};

const STATUS_ALIASES = {
  ADVERTENCIA: 'ADVERTÊNCIA',
  ATESTADO: 'ATESTADO MÉDICO',
  'ATESTADO MEDICO': 'ATESTADO MÉDICO',
  DECARACAO: 'DECLARAÇÃO',
  'DECLARACAO BANCO': 'DECLARAÇÃO',
  'DECLARACAO': 'DECLARAÇÃO',
  'ATESTADO DE OBITO': 'ATESTADO DE ÓBITO',
  OBITO: 'ÓBITO',
  'BOLETIM DE OCORRENCIA': 'BO',
  FALTA: 'FALTA SEM JUSTIFICATIVA',
  'LICENCA CASAMENTO': 'LICENÇA CASAMENTO',
  'LICENCA PATERNIDADE': 'LICENÇA PATERNIDADE',
  EXAME: 'EXAME PERIÓDICO',
  'EXAME PERIODICO': 'EXAME PERIÓDICO',
  'LICENCA MATERNIDADE': 'LICENÇA MATERNIDADE',
  'JUSTIFICADO FOLGA': 'FOLGA',
  'LICENCA INSS': 'INSS',
  COMPENSACAO: 'COMPENSAÇÃO',
  FERIAS: 'FÉRIAS',
  'AGUARDANDO CRACHA': 'AGUARDANDO CRACHÁ',
  DEMISSAO: 'DEMITIDO',
  DEMISSÃO: 'DEMITIDO',
  DESLIGADO: 'DEMITIDO',
  RESCISAO: 'DEMITIDO',
  RESCISÃO: 'DEMITIDO'
};

const DESCONHECIDO_META = {
  grupo: 'DESCONHECIDO',
  badgeClass: 'badge-gray',
  bgHex: '#6B7280',
  contaComoPresenca: false,
  geraAbsenteismo: false,
  requerJustificativa: false,
  label: ''
};

function normalizeStatusKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const _index = new Map();
for (const [grupo, cfg] of Object.entries(STATUS_CONFIG)) {
  for (const item of cfg.lista) {
    _index.set(normalizeStatusKey(item), {
      grupo,
      badgeClass: cfg.badgeClass,
      bgHex: cfg.bgHex,
      contaComoPresenca: !!cfg.contaComoPresenca,
      geraAbsenteismo: !!cfg.geraAbsenteismo,
      requerJustificativa: !!cfg.requerJustificativa,
      label: item
    });
  }
}

function sanitizeStatus(raw) {
  const key = normalizeStatusKey(raw);
  if (!key) return '';
  const alias = STATUS_ALIASES[key];
  if (alias) return alias;
  const hit = _index.get(key);
  if (hit) return hit.label;
  return String(raw || '').trim();
}

function getStatusMeta(status) {
  const key = normalizeStatusKey(sanitizeStatus(status));
  if (!key) return Object.assign({}, DESCONHECIDO_META);
  const hit = _index.get(key);
  if (!hit) return Object.assign({}, DESCONHECIDO_META);
  return hit;
}

function badgeForStatus(status) {
  return getStatusMeta(status).badgeClass;
}

function classificarRegistros(rows) {
  const contagem = {
    presenca: 0,
    absenteismo: 0,
    isencoes: 0,
    demissoes: 0,
    desconhecidos: 0
  };

  const list = rows || [];
  for (const row of list) {
    const meta = getStatusMeta(row && row.status);
    if (meta.grupo === 'PRESENCA') contagem.presenca++;
    else if (meta.grupo === 'ABSENTEISMO') contagem.absenteismo++;
    else if (meta.grupo === 'ISENCAO') contagem.isencoes++;
    else if (meta.grupo === 'DEMISSAO') contagem.demissoes++;
    else contagem.desconhecidos++;
  }

  return {
    presenca: contagem.presenca,
    absenteismo: contagem.absenteismo,
    isencoes: contagem.isencoes,
    demissoes: contagem.demissoes,
    desconhecidos: contagem.desconhecidos,
    totalPrevistos: contagem.presenca + contagem.absenteismo,
    excluidos: {
      isencoes: contagem.isencoes,
      demissoes: contagem.demissoes,
      desconhecidos: contagem.desconhecidos
    }
  };
}

function calcularAbsenteismo(rows) {
  const g = classificarRegistros(rows);
  const percentual = g.totalPrevistos > 0
    ? (g.absenteismo / g.totalPrevistos) * 100
    : 0;

  const contagemPorStatus = {};
  for (const row of (rows || [])) {
    const meta = getStatusMeta(row && row.status);
    if (meta.geraAbsenteismo) {
      const key = meta.label || String((row && row.status) || '').trim();
      contagemPorStatus[key] = (contagemPorStatus[key] || 0) + 1;
    }
  }

  const detalhamento = Object.entries(contagemPorStatus)
    .map(([status, quantidade]) => ({ status, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return {
    percentual: parseFloat(percentual.toFixed(2)),
    totalAusencias: g.absenteismo,
    totalPrevistos: g.totalPrevistos,
    excluidos: g.excluidos,
    detalhamento
  };
}

function listarStatusOpcoes() {
  const opcoes = [];
  for (const [grupo, cfg] of Object.entries(STATUS_CONFIG)) {
    for (const item of cfg.lista) {
      opcoes.push({ grupo, label: item, badgeClass: cfg.badgeClass });
    }
  }
  return opcoes;
}

module.exports = {
  STATUS_CONFIG,
  STATUS_ALIASES,
  normalizeStatusKey,
  sanitizeStatus,
  getStatusMeta,
  badgeForStatus,
  classificarRegistros,
  calcularAbsenteismo,
  listarStatusOpcoes
};
