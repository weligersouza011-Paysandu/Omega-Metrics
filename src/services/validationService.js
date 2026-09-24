const ERROS_DIGITACAO = {
  'Decaração': 'Declaração',
  'Advertencia': 'Advertência',
  'Advertancia': 'Advertência',
  'Advertêcia': 'Advertência',
  'BOLETIM DE OCORRENCIA': 'BOLETIM DE OCORRÊNCIA',
  'BOLETIN DE OCORRENCIA': 'BOLETIM DE OCORRÊNCIA',
  'Exame Medico': 'Exame Médico',
  'Licenca Casamento': 'Licença Casamento',
  'Licenca Maternidade': 'Licença Maternidade',
  'Licenca Paternidade': 'Licença Paternidade',
  'Periodico': 'Periódico',
  'ATESTADO DE OBITO': 'ATESTADO DE ÓBITO',
  'Declaracao': 'Declaração',
  'declaracao': 'Declaração',
  'declarção': 'Declaração'
};

function validatePontoData(pontoData) {
  const inconsistencias = [];
  let linha = 1;

  for (const row of pontoData) {
    linha++;

    if (!row.status || row.status.trim() === '') {
      inconsistencias.push({
        tipo: 'STATUS_VAZIO',
        linha,
        funcionario: row.nomeFuncionario || 'Desconhecido',
        departamento: row.nomeDepartamento || '',
        detalhe: 'Coluna Status sem preenchimento.'
      });
    } else {
      const sugestao = ERROS_DIGITACAO[row.status];
      if (sugestao) {
        inconsistencias.push({
          tipo: 'ERRO_DIGITACAO',
          linha,
          funcionario: row.nomeFuncionario || 'Desconhecido',
          departamento: row.nomeDepartamento || '',
          valorEncontrado: row.status,
          sugestao,
          detalhe: `Possível erro de digitação no Status "${row.status}". Sugestão: "${sugestao}".`
        });
      }
    }

    if (row.entrada1 && row.entrada1.type === 'time' &&
        (!row.saida2 || row.saida2.type === 'empty')) {
      inconsistencias.push({
        tipo: 'SAIDA_2_AUSENTE',
        linha,
        funcionario: row.nomeFuncionario || 'Desconhecido',
        departamento: row.nomeDepartamento || '',
        detalhe: 'Entrada 1 registrada, mas Saída 2 está vazia sem justificativa.'
      });
    }
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

module.exports = { validateData };
