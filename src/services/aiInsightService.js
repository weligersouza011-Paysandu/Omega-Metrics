const SYSTEM_PROMPT = 'Você é um Analista Sênior de Gestão de Pessoas especializado em ' +
  'obras de construção civil. Seu papel é gerar diagnósticos executivos e planos de ação ' +
  'baseados em dados reais de absenteísmo, aderência e turnover de uma obra/contrato.\n\n' +
  '## Regras de Formato\n' +
  '- Responda SEMPRE em JSON válido seguindo o schema fornecido.\n' +
  '- Use linguagem técnica mas acessível, em português do Brasil.\n' +
  '- Seja objetivo e baseie-se APENAS nos dados fornecidos.\n' +
  '- Nunca invente números ou estatísticas.\n' +
  '- Recomendações devem ser práticas e executáveis em até 30 dias.\n\n' +
  '## Schema de Resposta\n' +
  '{\n' +
  '  "diagnosticoGeral": {\n' +
  '    "resumoExecutivo": "string (3-4 frases)",\n' +
  '    "gargalosCriticos": [\n' +
  '      { "indicador": "string", "valor": "string", "gravidade": "alta|média|baixa", "explicacao": "string" }\n' +
  '    ],\n' +
  '    "correlacoes": [\n' +
  '      { "variavel1": "string", "variavel2": "string", "relacao": "string", "evidencia": "string" }\n' +
  '    ]\n' +
  '  },\n' +
  '  "funcoesCriticas": [\n' +
  '    { "funcao": "string", "absenteismo": "number", "tendencia": "string", "recomendacao": "string" }\n' +
  '  ],\n' +
  '  "correlacaoAbsenteismoTurnover": {\n' +
  '    "analise": "string",\n' +
  '    "dados": [\n' +
  '      { "motivo": "string", "qtdDesligamentos": "number", "percentualDoTotal": "number" }\n' +
  '    ]\n' +
  '  },\n' +
  '  "planoDeAcao": {\n' +
  '    "imediato": [\n' +
  '      { "acao": "string", "responsavel": "string", "prazo": "string", "impacto": "string", "como": "string" }\n' +
  '    ],\n' +
  '    "curtoPrazo": [\n' +
  '      { "acao": "string", "responsavel": "string", "prazo": "string", "impacto": "string", "como": "string" }\n' +
  '    ],\n' +
  '    "medioPrazo": [\n' +
  '      { "acao": "string", "responsavel": "string", "prazo": "string", "impacto": "string", "como": "string" }\n' +
  '    ]\n' +
  '  },\n' +
  '  "indicadoresAlerta": [\n' +
  '    { "indicador": "string", "valor": "number", "meta": "number", "status": "crítico|atenção|normal" }\n' +
  '  ],\n' +
  '  "projecao": {\n' +
  '    "riscoContratual": "string",\n' +
  '    "recomendacaoGestor": "string"\n' +
  '  }\n' +
  '}';

function buildInsightsPrompt(kpis, graficos) {
  var prompt = '## DADOS DO DASHBOARD — FECHAMENTO PERÍODO\n\n';

  prompt += '### KPIs Principais\n';
  prompt += '- Absenteísmo Geral: ' + kpis.absenteismo.percentual + '% ';
  prompt += '(' + kpis.absenteismo.totalFaltas + ' faltas de ' + kpis.absenteismo.totalGeral + ' registros)\n';
  prompt += '- Aderência ao Trabalho: ' + kpis.aderencia.percentual + '% ';
  prompt += '(' + kpis.aderencia.somaHorasTrabalhadas + 'h trabalhadas / ' + kpis.aderencia.somaHorasPrevistas + 'h previstas)\n';
  prompt += '- Turnover Operacional: ' + kpis.turnover.percentual + '% ';
  prompt += '(' + kpis.turnover.desligamentosRelevantes + ' desligamentos relevantes de ' + kpis.turnover.efetivoTotal + ' efetivos)\n\n';

  if (graficos.absenteismoPorFuncao && graficos.absenteismoPorFuncao.length > 0) {
    prompt += '### Top 5 Funções com Maior Absenteísmo\n';
    var topFunc = graficos.absenteismoPorFuncao.slice(0, 5);
    for (var i = 0; i < topFunc.length; i++) {
      prompt += (i + 1) + '. ' + topFunc[i].label + ': ' + topFunc[i].value + '%';
      if (topFunc[i].faltas !== undefined) {
        prompt += ' (' + topFunc[i].faltas + ' faltas de ' + topFunc[i].total + ' registros)';
      }
      prompt += '\n';
    }
    prompt += '\n';
  }

  if (graficos.absenteismoPorStatus && graficos.absenteismoPorStatus.length > 0) {
    prompt += '### Distribuição de Ausências por Tipo\n';
    for (var j = 0; j < graficos.absenteismoPorStatus.length; j++) {
      prompt += '- ' + graficos.absenteismoPorStatus[j].label + ': ' + graficos.absenteismoPorStatus[j].value + ' ocorrências\n';
    }
    prompt += '\n';
  }

  if (graficos.turnoverComparativo) {
    var tc = graficos.turnoverComparativo;
    prompt += '### Turnover por Motivo (Relevantes)\n';
    if (tc.motivosOperacionais) {
      for (var k = 0; k < tc.motivosOperacionais.length; k++) {
        prompt += '- ' + tc.motivosOperacionais[k].motivo + ': ' + tc.motivosOperacionais[k].quantidade + ' desligamentos\n';
      }
    }
    prompt += '\n### Redução de Quadro (Excluído do Turnover)\n';
    prompt += (tc.reducaoQuadro || 0) + ' desligamentos por motivo "Redução de Quadro (Efetivo)"\n\n';
  }

  if (graficos.absenteismoPorDepartamento && graficos.absenteismoPorDepartamento.length > 0) {
    prompt += '### Top 5 Departamentos com Maior Absenteísmo\n';
    var topDept = graficos.absenteismoPorDepartamento.slice(0, 5);
    for (var l = 0; l < topDept.length; l++) {
      prompt += (l + 1) + '. ' + topDept[l].label + ': ' + topDept[l].value + '%\n';
    }
    prompt += '\n';
  }

  prompt += '---\nGere o diagnóstico executivo e plano de ação seguindo o schema JSON definido.';

  return prompt;
}

async function callGemini(prompt) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'sua_chave_aqui') {
    return null;
  }

  try {
    var axios = require('axios');

    var response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          topP: 0.8,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      },
      { timeout: 45000 }
    );

    var text = response.data.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  } catch (err) {
    console.error('Erro na chamada Gemini para insights:', err.message);
    return null;
  }
}

function generateLocalInsights(kpis, graficos) {
  var alerts = [];

  if (kpis.absenteismo.percentual > 10) {
    alerts.push({ indicador: 'Absenteísmo Geral', valor: kpis.absenteismo.percentual, meta: 5, status: 'crítico' });
  } else if (kpis.absenteismo.percentual > 7) {
    alerts.push({ indicador: 'Absenteísmo Geral', valor: kpis.absenteismo.percentual, meta: 5, status: 'atenção' });
  } else {
    alerts.push({ indicador: 'Absenteísmo Geral', valor: kpis.absenteismo.percentual, meta: 5, status: 'normal' });
  }

  if (kpis.turnover.percentual > 5) {
    alerts.push({ indicador: 'Turnover Operacional', valor: kpis.turnover.percentual, meta: 3, status: 'crítico' });
  } else if (kpis.turnover.percentual > 3) {
    alerts.push({ indicador: 'Turnover Operacional', valor: kpis.turnover.percentual, meta: 3, status: 'atenção' });
  } else {
    alerts.push({ indicador: 'Turnover Operacional', valor: kpis.turnover.percentual, meta: 3, status: 'normal' });
  }

  if (kpis.aderencia.percentual < 80) {
    alerts.push({ indicador: 'Aderência ao Trabalho', valor: kpis.aderencia.percentual, meta: 90, status: 'crítico' });
  } else if (kpis.aderencia.percentual < 85) {
    alerts.push({ indicador: 'Aderência ao Trabalho', valor: kpis.aderencia.percentual, meta: 90, status: 'atenção' });
  } else {
    alerts.push({ indicador: 'Aderência ao Trabalho', valor: kpis.aderencia.percentual, meta: 90, status: 'normal' });
  }

  var topFuncao = graficos.absenteismoPorFuncao && graficos.absenteismoPorFuncao.length > 0
    ? graficos.absenteismoPorFuncao[0]
    : null;

  var topDepto = graficos.absenteismoPorDepartamento && graficos.absenteismoPorDepartamento.length > 0
    ? graficos.absenteismoPorDepartamento[0]
    : null;

  var resumo = 'O período analisado apresentou absenteísmo geral de ' + kpis.absenteismo.percentual + '%. ';
  if (topFuncao) {
    resumo += 'A função com maior índice de ausência é ' + topFuncao.label + ' com ' + topFuncao.value + '%. ';
  }
  resumo += 'O turnover operacional foi de ' + kpis.turnover.percentual + '%, com ' + kpis.turnover.desligamentosRelevantes + ' desligamentos por motivos de desempenho/adaptação de um efetivo de ' + kpis.turnover.efetivoTotal + ' colaboradores. ';
  if (topDepto) {
    resumo += 'O departamento mais impactado é ' + topDepto.label + ' com ' + topDepto.value + '% de absenteísmo.';
  }

  var funcoesCriticas = [];
  if (graficos.absenteismoPorFuncao) {
    var top3 = graficos.absenteismoPorFuncao.slice(0, 3);
    for (var i = 0; i < top3.length; i++) {
      var gravidade = top3[i].value > 15 ? 'Crítica' : top3[i].value > 10 ? 'Alta' : 'Média';
      funcoesCriticas.push({
        funcao: top3[i].label,
        absenteismo: top3[i].value,
        tendencia: gravidade === 'Crítica' ? 'Increasing' : 'Stable',
        recomendacao: 'Investigar causas específicas na função ' + top3[i].label + ' e implementar plano de retenção.'
      });
    }
  }

  var motivosTurnover = graficos.turnoverComparativo && graficos.turnoverComparativo.motivosOperacionais
    ? graficos.turnoverComparativo.motivosOperacionais
    : [];
  var totalRelevantes = kpis.turnover.desligamentosRelevantes || 1;
  var dadosCorrelacao = motivosTurnover.map(function (m) {
    return {
      motivo: m.motivo,
      qtdDesligamentos: m.quantidade,
      percentualDoTotal: parseFloat(((m.quantidade / totalRelevantes) * 100).toFixed(1))
    };
  });

  var planoAcao = {
    imediato: [
      {
        acao: 'Reunião de emergência com lideranças dos departamentos críticos',
        responsavel: 'Gerente de RH',
        prazo: '5 dias úteis',
        impacto: 'Alinhamento imediato de expectativas e ações corretivas',
        how: 'Agendar reunião presencial ou virtual com encarregados e supervisores'
      },
      {
        acao: 'Aplicação de pesquisa de clima rápida nos setores com >10% de absenteísmo',
        responsavel: 'Analista de RH',
        prazo: '10 dias úteis',
        impacto: 'Identificação de fatores motivadores das ausências',
        how: 'Enviar formulário online ou aplicar entrevistas semiestruturadas'
      }
    ],
    curtoPrazo: [
      {
        acao: 'Implementar programa de acompanhamento pós-admissão (primeiros 90 dias)',
        responsavel: 'RH + Liderança Operacional',
        prazo: '15 dias',
        impacto: 'Redução do turnover nos primeiros meses de contrato',
        how: 'Definir mentor para cada novo colaborador e agendar check-ins semanais'
      },
      {
        acao: 'Estabelecer metas de absenteísmo por departamento com indicadores visíveis',
        responsavel: 'Gerente de Operações',
        prazo: '20 dias',
        impacto: 'Conscientização e comprometimento da equipe',
        how: 'Criar painel de indicadores e compartilhar semanalmente com lideranças'
      }
    ],
    medioPrazo: [
      {
        acao: 'Desenvolver programa de capacitação e retenção para funções críticas',
        responsavel: 'RH + Treinamento',
        prazo: '30 dias',
        impacto: 'Melhoria da produtividade e redução de desligamentos por baixa performance',
        how: 'Mapear necessidades de treinamento e executar plano de desenvolvimento'
      },
      {
        acao: 'Revisão do processo seletivo para melhorar o fit cultural e técnico',
        responsavel: 'Recrutamento',
        prazo: '30 dias',
        impacto: 'Redução de desligamentos por desvio comportamental',
        how: 'Incluir etapas de avaliação comportamental e teste prático'
      }
    ]
  };

  var riscoContratual = 'Médio';
  if (kpis.absenteismo.percentual > 10 || kpis.turnover.percentual > 5) {
    riscoContratual = 'Alto';
  } else if (kpis.absenteismo.percentual < 5 && kpis.turnover.percentual < 2) {
    riscoContratual = 'Baixo';
  }

  return {
    diagnosticoGeral: {
      resumoExecutivo: resumo,
      gargalosCriticas: funcoesCriticas.map(function (f) {
        return {
          indicador: 'Absenteísmo - ' + f.funcao,
          valor: f.absenteismo + '%',
          gravidade: f.absenteismo > 15 ? 'alta' : f.absenteismo > 10 ? 'média' : 'baixa',
          explicacao: f.recomendacao
        };
      }),
      correlacoes: dadosCorrelacao.length > 0 ? [{
        variavel1: 'Absenteísmo por Função',
        variavel2: 'Turnover Operacional',
        relacao: 'Funções com maior absenteísmo tendem a apresentar maior taxa de desligamento',
        evidencia: 'Top função: ' + (topFuncao ? topFuncao.label + ' (' + topFuncao.value + '%)' : 'N/A')
      }] : []
    },
    funcoesCriticas: funcoesCriticas,
    correlacaoAbsenteismoTurnover: {
      analise: 'Existe correlação entre altas taxas de absenteísmo e desligamentos por motivos de desempenho. ' +
        'Dos ' + kpis.turnover.desligamentosRelevantes + ' desligamentos relevantes, ' +
        (dadosCorrelacao.length > 0 ? 'o motivo principal é "' + dadosCorrelacao[0].motivo + '" com ' + dadosCorrelacao[0].percentualDoTotal + '% do total.' : 'não há dados suficientes para análise.'),
      dados: dadosCorrelacao
    },
    planoDeAcao: planoAcao,
    indicadoresAlerta: alerts,
    projecao: {
      riscoContratual: riscoContratual,
      recomendacaoGestor: riscoContratual === 'Alto'
        ? 'URGENTE: Implementar plano de ação imediato. O nível de absenteísmo e turnover compromete a continuidade operacional e pode gerar penalidades contratuais.'
        : riscoContratual === 'Médio'
        ? 'Recomenda-se monitoramento semanal dos indicadores e implementação das ações de curto prazo para evitar escalada.'
        : 'Indicadores dentro da faixa aceitável. Manter monitoramento mensal e focar em programas de retenção preventiva.'
    }
  };
}

async function generateInsights(kpis, graficos) {
  var prompt = buildInsightsPrompt(kpis, graficos);

  var aiResult = await callGemini(prompt);

  if (aiResult) {
    return {
      success: true,
      source: 'ai',
      provider: 'Gemini 2.0 Flash',
      insights: aiResult
    };
  }

  var localResult = generateLocalInsights(kpis, graficos);
  return {
    success: true,
    source: 'rules',
    provider: 'Regras Locais (Fallback)',
    insights: localResult
  };
}

module.exports = {
  generateInsights: generateInsights,
  generateLocalInsights: generateLocalInsights,
  buildInsightsPrompt: buildInsightsPrompt
};
