const STATUS_FALTAS = [
  'Falta sem justificativa',
  'Falta',
  'Advertência',
  'Advertencia',
  'Atestado',
  'ATESTADO DE OBITO',
  'ATESTADO DE ÓBITO',
  'BOLETIN DE OCORRENCIA',
  'BOLETIM DE OCORRÊNCIA',
  'Decaração',
  'Declaração',
  'Declaração Banco',
  'Exame',
  'Exame Medico',
  'Exame Médico',
  'Licença Casamento',
  'Licença Maternidade',
  'Licença Paternidade',
  'Médico',
  'Periódico',
  'Periodico'
];

const MOTIVOS_TURNOVER_RELEVANTES = [
  'ALTO ÍNDICE DE ABSENTEÍSMO',
  'BAIXA PRODUTIVIDADE',
  'PEDIDO DE DEMISSÃO',
  'DESVIO COMPORTAMENTAL'
];

const MOTIVO_EXCLUIDO_TURNOVER = 'REDUÇÃO DE QUADRO (EFETIVO)';

const JORNADA_PADRAO_HORAS = 8;

const MESES_PT = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'
];

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

  const contagemPorStatus = {};
  for (const status of STATUS_FALTAS) {
    contagemPorStatus[status] = 0;
  }

  let totalFaltas = 0;
  for (const row of pontoData) {
    const st = row.status;
    if (STATUS_FALTAS.includes(st)) {
      totalFaltas++;
      contagemPorStatus[st] = (contagemPorStatus[st] || 0) + 1;
    }
  }

  const percentual = totalGeral > 0 ? (totalFaltas / totalGeral) * 100 : 0;

  const detalhamento = Object.entries(contagemPorStatus)
    .filter(([, qty]) => qty > 0)
    .map(([status, quantidade]) => ({ status, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return {
    percentual: parseFloat(percentual.toFixed(2)),
    totalGeral,
    totalFaltas,
    detalhamento
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
    porMes[chaveMes].total++;
    if (STATUS_FALTAS.includes(row.status)) {
      porMes[chaveMes].faltas++;
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
    porFuncao[funcao].total++;
    if (STATUS_FALTAS.includes(row.status)) {
      porFuncao[funcao].faltas++;
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
      if (STATUS_FALTAS.includes(st) || st === '') {
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

  const turnoverPorMotivo = turnover.detalhamentoMotivos.map(d => ({
    label: d.motivo,
    value: d.quantidade
  }));

  const deptoFaltas = {};
  const deptoTotal = {};
  for (const row of pontoData) {
    const depto = row.nomeDepartamento || 'Sem Departamento';
    deptoTotal[depto] = (deptoTotal[depto] || 0) + 1;
    if (STATUS_FALTAS.includes(row.status)) {
      deptoFaltas[depto] = (deptoFaltas[depto] || 0) + 1;
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
    turnoverPorMotivo,
    absenteismoPorDepartamento,
    turnoverPorMotivoCompleto,
    turnoverComparativo
  };
}

function calculateMetrics(pontoData, desligamentoData) {
  const efetivoTotal = getEfetivoTotal(pontoData);

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

module.exports = { calculateMetrics };
