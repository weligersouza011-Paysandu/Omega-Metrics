(function () {
  'use strict';

  // Registra o plugin DataLabels globalmente. A build UMD carregada via
  // <script> NÃO se auto-registra — sem este passo, as opções de datalabels
  // dos gráficos do Mês e da Função são ignoradas e os rótulos nunca aparecem.
  try {
    if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
      Chart.register(ChartDataLabels);
    }
  } catch (e) { /* ignore */ }

  // Base dinâmica da API: local vazio; hospedado (Render/GH Pages) aponta ao backend
  var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? ''
    : 'https://omega-metrics1.onrender.com';

  // Configurações Globais & Cores do Design System
  var CORES = {
    verde: '#10b981',
    ambar: '#f59e0b',
    vermelho: '#ef4444',
    pista: '#e2e8f0',
    vinho: '#7f1d1d',
    vinhoDark: '#4c0519',
    roxo: '#8b5cf6',
    azul: '#2563eb',
    cinza: '#64748b',
    grafite: '#0f172a'
  };

  var META_ABSENTEISMO = 3.0;
  var LIMITE_ALERTA = 4.0;
  var GAUGE_MAX = 6.0;
  var CAL_PAGE_MONTHS = 8;
  var TOP_RANKING = 10;
  var META_TURNOVER_GERAL = 5.0;
  var META_TURNOVER_OPERACIONAL = 3.0;
  var TURNOVER_CRITICO = 5.0;

  // Armazenamento de Instâncias dos Gráficos Chart.js
  var chartInstances = {};

  // Estado da Aplicação
  var datasDisponiveis = new Set();
  var periodoMin = null;
  var periodoMax = null;
  var currentRange = { inicio: null, fim: null };
  var debounceTimer = null;
  // Base completa (sem filtro cruzado) e mapa de exibição do calendário.
  // Com filtro ativo a resposta vem parcial: vira mapPorDia (dias sem dado
  // ficam neutros); sem filtro a exibição é a própria base (merge preserva
  // as cores do período inteiro).
  var mapPorDia = {};
  var mapPorDiaBase = {};
  var calState = { ano: null, mes: null, anual: false };

  // Filtro global cruzado: um único estado para todos os componentes.
  // Cada componente é filtrado por TODAS as dimensões ativas EXCETO a
  // própria (regra de escopo) — assim ele mantém as opções visíveis para
  // alternar/limpar o clique. Mesma regra em applyCrossFilters (servidor)
  // e matchFiltroLocal (fallback LocalStorage).
  var globalFilter = { dia: null, mes: null, colaborador: null, funcao: null, justificativa: null, motivo: null };
  var suppressSliderChange = false;
  var inflightCtrl = null;

  var funcaoExpanded = false;
  var lastFuncaoData = null;

  var lastRankingRows = [];
  var cacheDesligamentos = [];
  var localStorageRecords = null;
  var gridRendered = false;

  // Elementos do DOM
  var loadingEl = document.getElementById('dashboard-loading');
  var emptyEl = document.getElementById('dashboard-empty');
  var gridEl = document.getElementById('dashboard-grid');
  var rangeInicio = document.getElementById('range-inicio');
  var rangeFim = document.getElementById('range-fim');
  var slider = document.getElementById('slider-periodo');
  var drawer = document.getElementById('menu-drawer');

  // Inicialização principal
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    init();
  }

  var initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;

    // Datalabels: plugin registrado globalmente no topo do arquivo; o padrão
    // fica desligado e cada gráfico liga o seu (Rosca, Mês e Função).
    try {
      if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined' && Chart.defaults) {
        Chart.defaults.set('datalabels', { display: false });
      }
    } catch (e) { /* ignore */ }

    try {
      renderDataPorExtenso();
      setupDrawer();
      setupCalendarioControls();
      setupCalendarioClick();
      setupSlider();
      setupFuncaoExpand();
      setupRankExpand();
      setupDigitalTurnover();
      setupDayChip();
      setupStatusChip();
      setupCrossChip();
      setupRankingClick();
      setupExportPdf();
    } catch (e) {
      console.error('Erro durante o setup do dashboard (renderização segue):', e);
    }

    // Busca da API / LocalStorage e renderização — sempre executam,
    // mesmo que algum setup acima falhe (evita página em branco).
    preloadLocalStorage();
    loadDatasDisponiveis();
  }

  /* ============================================================
     1. AUXILIARES E ESTRUTURA GERAL
     ============================================================ */

  function renderDataPorExtenso() {
    var el = document.getElementById('data-por-extenso');
    if (el) {
      el.textContent = new Date().toLocaleDateString('pt-BR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
    }
  }

  function setupDrawer() {
    var btn = document.getElementById('btn-menu');
    if (!btn || !drawer) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      drawer.classList.toggle('open');
      drawer.setAttribute('aria-hidden', drawer.classList.contains('open') ? 'false' : 'true');
    });
    document.addEventListener('click', function (e) {
      if (drawer.classList.contains('open') && !drawer.contains(e.target)) {
        drawer.classList.remove('open');
      }
    });
  }

  function destroyChart(id) {
    if (chartInstances[id]) {
      try { chartInstances[id].destroy(); } catch (e) { /* ignore */ }
      delete chartInstances[id];
    }
  }

  // Compara estado serializável (data/options/meta) para pular repaints.
  function jsonEqual(a, b) {
    if (a === b) return true;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
      return false;
    }
  }

  // Atualização in-place: reutiliza a instância Chart.js existente (data +
  // options + update) em vez de destruir/recriar o canvas a cada render.
  // `meta` é um objeto livre lido pelos plugins custom via chart.$meta.
  // Performance: nada mudou → sem repaint; mudou → update('none') sem animação.
  function updateChart(id, canvasId, config, meta) {
    var inst = chartInstances[id];
    if (inst && inst.canvas && inst.canvas.parentNode) {
      var dataChanged = !jsonEqual(inst.data, config.data);
      var optsChanged = !jsonEqual(inst.options, config.options);
      var metaChanged = !jsonEqual(inst.$meta, meta);

      inst.$meta = meta;
      if (dataChanged) inst.data = config.data;
      if (optsChanged) inst.options = config.options;

      // Sem dados novos e sem mudança de opções → nem repinta
      if (dataChanged || optsChanged || metaChanged) {
        inst.update('none');
      }
      return inst;
    }

    if (inst) destroyChart(id);

    var container = document.getElementById(id);
    if (!container || typeof Chart === 'undefined') return null;
    container.innerHTML = '<canvas id="' + canvasId + '"></canvas>';
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    inst = new Chart(canvas, config);
    inst.$meta = meta;
    chartInstances[id] = inst;
    return inst;
  }

  function placeholderVazio() {
    return '<div class="text-muted small text-center p-3" style="margin:auto;">Sem dados suficientes para este indicador.</div>';
  }

  function pctBr(v) {
    return (Number(v) || 0).toFixed(2).replace('.', ',') + '%';
  }

  /* ============================================================
     1B. FILTRO GLOBAL CRUZADO (cross-filter)
     ============================================================ */

  var MESES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function normLocal(v) {
    return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function fmtMesLabel(chave) {
    var p = String(chave || '').split('-');
    if (p.length !== 2) return String(chave || '');
    var mes = MESES_CURTO[parseInt(p[1], 10) - 1] || p[1];
    return mes + '/' + p[0].slice(2);
  }

  // Query string com os filtros globais ativos
  function crossFilterQuery() {
    var q = '';
    if (globalFilter.justificativa) q += '&status=' + encodeURIComponent(globalFilter.justificativa);
    if (globalFilter.dia) q += '&dia=' + encodeURIComponent(globalFilter.dia);
    if (globalFilter.mes) q += '&mes=' + encodeURIComponent(globalFilter.mes);
    if (globalFilter.colaborador) q += '&colaborador=' + encodeURIComponent(globalFilter.colaborador);
      if (globalFilter.funcao) q += '&funcao=' + encodeURIComponent(globalFilter.funcao);
      if (globalFilter.motivo) q += '&motivo=' + encodeURIComponent(globalFilter.motivo);
      return q;
  }

  // Algum filtro que encolhe a resposta do calendário? (o filtro de dia é
  // pulado pelo servidor no calendário — só os demais geram foto parcial)
  function crossFilterParcial() {
    return !!(globalFilter.justificativa || globalFilter.mes ||
      globalFilter.colaborador || globalFilter.funcao);
  }

  // Liga/desliga uma dimensão do filtro e recarrega o dashboard inteiro
  function toggleCrossFilter(key, value) {
    var atual = globalFilter[key];
    globalFilter[key] = (atual && normLocal(atual) === normLocal(value)) ? null : value;
    syncFilterChips();
    fetchDashboardData({ background: true, filterChange: true });
  }

      function clearCrossFilters() {
        globalFilter.colaborador = null;
        globalFilter.funcao = null;
        globalFilter.mes = null;
        globalFilter.motivo = null;
        syncFilterChips();
    fetchDashboardData({ background: true, filterChange: true });
  }

  // Chips da barra de filtros (dia, justificativa e cruzados)
  function syncFilterChips() {
    updateDayChip();
    updateStatusChip();
    updateCrossChip();
    // Seleção do calendário acompanha o filtro de dia imediatamente
    setCalSelectedDay(globalFilter.dia);
    // Destaque do ranking acompanha a seleção imediatamente
    refreshRankingSelection();
  }

  function updateCrossChip() {
    var chip = document.getElementById('cross-filter-chip');
    if (!chip) return;
    var partes = [];
    if (globalFilter.colaborador) partes.push('Colaborador: ' + globalFilter.colaborador);
    if (globalFilter.funcao) partes.push('Função: ' + globalFilter.funcao);
    if (globalFilter.mes) partes.push('Mês: ' + fmtMesLabel(globalFilter.mes));
    if (globalFilter.motivo) partes.push('Motivo: ' + globalFilter.motivo);
    if (partes.length) {
      chip.style.display = 'inline-flex';
      var txt = document.getElementById('cross-filter-chip-text');
      if (txt) txt.textContent = partes.join(' · ');
    } else {
      chip.style.display = 'none';
    }
  }

  function setupCrossChip() {
    var btn = document.getElementById('cross-chip-clear');
    if (btn) btn.addEventListener('click', clearCrossFilters);
  }

  // Regra de escopo do filtro local (fallback sem servidor): mesma matriz
  // do backend — cada componente pula a própria dimensão.
  function matchFiltroLocal(r, skip, nome, cargo) {
    var f = globalFilter;
    if (skip !== 'justificativa' && f.justificativa &&
        normLocal(r.status) !== normLocal(f.justificativa)) return false;
    if (skip !== 'dia' && f.dia && r.dia !== f.dia) return false;
    if (skip !== 'mes' && f.mes && String(r.dia || '').substring(0, 7) !== f.mes) return false;
    if (skip !== 'colaborador' && f.colaborador &&
        normLocal(nome) !== normLocal(f.colaborador)) return false;
    if (skip !== 'funcao' && f.funcao && normLocal(cargo) !== normLocal(f.funcao)) return false;
    return true;
  }

  /* ============================================================
     2. COMUNICAÇÃO DE DADOS & FALLBACK LOCALSTORAGE
        (fDB_Ponto_Tratado / omega_ponto_data)
     ============================================================ */

  function preloadLocalStorage() {
    localStorageRecords = readLocalStorageRecords();
  }

  // Normaliza dia vindo do LocalStorage (DD/MM/YYYY do Tratamento) para ISO (YYYY-MM-DD)
  function toIsoDate(value) {
    if (value === null || value === undefined) return value;
    var s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    }
    return s;
  }

  function normalizeLocalRecords(records) {
    return records.map(function (r) {
      if (!r || typeof r !== 'object') return r;
      var iso = toIsoDate(r.dia);
      if (iso === r.dia) return r;
      var copy = {};
      for (var k in r) {
        if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
      }
      copy.dia = iso;
      return copy;
    });
  }

  function readLocalStorageRecords() {
    try {
      var raw = localStorage.getItem('omega_ponto_data') ||
                localStorage.getItem('fDB_Ponto_Tratado');
      if (!raw) return null;

      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return normalizeLocalRecords(parsed);
      }

      // Compatibilidade com formatos antigos ({ registros: [...] } ou { data: [...] })
      if (parsed && typeof parsed === 'object') {
        var candidates = [parsed.registros, parsed.records, parsed.data, parsed.rows, parsed.dados];
        for (var i = 0; i < candidates.length; i++) {
          if (Array.isArray(candidates[i]) && candidates[i].length > 0) {
            return normalizeLocalRecords(candidates[i]);
          }
        }
      }
    } catch (e) {
      console.error('Erro ao ler LocalStorage:', e);
    }
    return null;
  }

  function getLocalDates(records) {
    return (records || [])
      .map(function (r) { return r.dia; })
      .filter(Boolean)
      .sort();
  }

  function applyLocalRange(dates) {
    if (!dates.length) return false;
    datasDisponiveis = new Set(dates);
    periodoMin = dates[0];
    periodoMax = dates[dates.length - 1];
    if (!currentRange.inicio) currentRange.inicio = periodoMin;
    if (!currentRange.fim) currentRange.fim = periodoMax;
    return true;
  }

  function loadDatasDisponiveis() {
    showLoading();
    fetch(API_URL + '/api/dashboard/datas-disponiveis')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success || !data.datas || !data.datas.length) {
          tryLocalStorageFallback();
          return;
        }
        var rawDatas = (data.datas || []).map(function (item) {
          return typeof item === 'string' ? item : (item && item.data);
        }).filter(Boolean);

        datasDisponiveis = new Set(rawDatas);
        periodoMin = data.periodoMin;
        periodoMax = data.periodoMax;
        currentRange.inicio = data.periodoMin;
        currentRange.fim = data.periodoMax;

        initFlatpickr();
        initSliderValues();
        fetchDashboardData();
      })
      .catch(function (err) {
        console.warn('Servidor indisponível ou sem resposta, tentando LocalStorage:', err);
        tryLocalStorageFallback();
      });
  }

  function tryLocalStorageFallback() {
    var records = localStorageRecords || readLocalStorageRecords();
    if (records && records.length) {
      localStorageRecords = records;
      var dates = getLocalDates(records);
      if (applyLocalRange(dates)) {
        initFlatpickr();
        initSliderValues();
        computeDashboardFromLocalStorage(records);
        return;
      }
    }
    showEmpty();
  }

  function fetchDashboardData(opts) {
    opts = opts || {};
    if (!currentRange.inicio || !currentRange.fim) {
      tryLocalStorageFallback();
      return;
    }

    // Após o 1º render, toda busca roda em background: evita esconder o
    // grid (display:none) e forçar o resize/redraw dos 9 canvas a cada
    // clique de filtro ou ajuste de período.
    var background = !!opts.background || gridRendered;
    if (background) {
      // Atualização leve: mantém o grid visível (sem spinner full-screen)
      if (gridEl) gridEl.classList.add('is-refreshing');
    } else {
      showLoading();
    }

    // Aborta a busca anterior — cliques rápidos não acumulam requisições
    if (inflightCtrl) {
      try { inflightCtrl.abort(); } catch (e) { /* ignore */ }
    }
    var ctrl = new AbortController();
    inflightCtrl = ctrl;

    var url = API_URL + '/api/dashboard/kpis?dataInicio=' + currentRange.inicio + '&dataFim=' + currentRange.fim;
    url += crossFilterQuery();

    // Modal Ômega: só no carregamento inicial (fora do caminho "background",
    // que atualiza os gráficos a cada clique de filtro sem bloquear a tela).
    if (!background) window.setOmegaProgress(15, 'Conectando ao banco Neon...');

    fetch(url, { signal: ctrl.signal })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (inflightCtrl === ctrl) inflightCtrl = null;
        if (gridEl) gridEl.classList.remove('is-refreshing');
        if (!data.success || data.semDados) {
          // Período vazio (ou erro): recai no LocalStorage / estado vazio.
          // Clique de filtro mantém a visão anterior (evita "pisca").
          if (!opts.filterChange) tryLocalStorageFallback();
          if (!background) window.closeOmegaLoader();
          return;
        }
        if (!background) {
          window.setOmegaProgress(70, 'Processando indicadores do BI e gráficos...');
        }
        showGrid();
        renderDashboard(data, opts);
        if (!background) {
          window.setOmegaProgress(100, 'Concluído!');
          window.showOmegaSuccess('Dashboard Atualizado!', window.closeOmegaLoader);
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (inflightCtrl === ctrl) inflightCtrl = null;
        if (gridEl) gridEl.classList.remove('is-refreshing');
        console.warn('Erro ao buscar KPIs do servidor, acionando fallback LocalStorage:', err);
        tryLocalStorageFallback();
        window.closeOmegaLoader();
      });
  }

  function computeDashboardFromLocalStorage(allRecords) {
    if (!allRecords || !allRecords.length) {
      showEmpty();
      return;
    }

    var inicio = currentRange.inicio;
    var fim = currentRange.fim;
    var records = allRecords.filter(function (r) {
      if (!r.dia) return false;
      if (inicio && r.dia < inicio) return false;
      if (fim && r.dia > fim) return false;
      return true;
    });

    if (!records.length) {
      showEmpty();
      return;
    }

    // Status atual por colaborador (maior dia) — demitidos ficam de fora
    // das agregações de absenteísmo (ranking e por-função locais)
    var statusAtualPorNome = {};
    records.forEach(function (r) {
      var nome = r.funcionario || r.nome || r.nomeFuncionario || 'Não Identificado';
      var st = (r.status || '').toUpperCase().trim();
      var isDemissao = st === 'DEMITIDO' || st.indexOf('DEMISS') !== -1 ||
        st.indexOf('DESLIG') !== -1 || st.indexOf('RESCIS') !== -1;
      var d = r.dia || '';
      var prev = statusAtualPorNome[nome];
      if (!prev || d > prev.dia) {
        statusAtualPorNome[nome] = { dia: d, demissao: isDemissao };
      } else if (d === prev.dia && isDemissao) {
        prev.demissao = true;
      }
    });
    function ehDemitidoAtual(nome) {
      var info = statusAtualPorNome[nome];
      return !!(info && info.demissao);
    }

    var statusFaltas = ["FALTA SEM JUSTIFICATIVA", "FALTA", "ATESTADO MÉDICO", "ATESTADO DE ÓBITO", "DECLARAÇÃO", "BO", "ÓBITO", "LICENÇA CASAMENTO", "LICENÇA PATERNIDADE"];
    var statusPresenca = ["PRESENTE", "ADVERTÊNCIA"];

    var totalFaltas = 0;
    var totalPresencas = 0;
    var statusCounts = {};
    var diaMap = {};
    var funcMap = {};
    var mesMap = {};
    var funcaoMap = {};
    var funcsUnicos = new Set();
    var funcsSeries = new Set();
    var desligamentos = [];
    var desligamentosSemMes = [];
    var desligamentosSemMotivo = [];

    function nomeDe(r) { return r.funcionario || r.nome || r.nomeFuncionario || 'Não Identificado'; }
    function cargoDe(r) { return r.funcao || r.cargo || r.nomeCargo || 'Não Definido'; }
    function isFaltaDe(r) {
      var st = (r.status || '').toUpperCase().trim();
      return statusFaltas.indexOf(st) !== -1;
    }
    function isPresencaDe(r) {
      var st = (r.status || '').toUpperCase().trim();
      return statusPresenca.indexOf(st) !== -1 || (!st && r.entrada1);
    }

    // Cada componente tem sua própria passagem com a regra de escopo
    // (matchFiltroLocal com o `skip` da dimensão), igual ao servidor.

    // Efetivo — mesmos filtros, exceto justificativa (como a query do banco)
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (matchFiltroLocal(r, 'justificativa', nome, cargoDe(r))) funcsUnicos.add(nome);
    });

    // Efetivo da série do Headcount — pula também o mês (regra de escopo:
    // todos os meses seguem visíveis para o clique no gráfico)
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (matchFiltroLocal(r, 'mes', nome, cargoDe(r))) funcsSeries.add(nome);
    });

    // Justificativas (rosca) — pula o próprio status
    records.forEach(function (r) {
      if (!matchFiltroLocal(r, 'justificativa', nomeDe(r), cargoDe(r))) return;
      var st = (r.status || '').toUpperCase().trim();
      if (st) statusCounts[st] = (statusCounts[st] || 0) + 1;
    });

    // KPI de absenteísmo — todos os filtros (demitidos seguem excluídos,
    // como sempre foi neste fallback)
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (!matchFiltroLocal(r, null, nome, cargoDe(r))) return;
      if (ehDemitidoAtual(nome)) return;
      if (isFaltaDe(r)) totalFaltas++;
      else if (isPresencaDe(r)) totalPresencas++;
    });

    // Calendário — pula o dia (a seleção fica só no destaque)
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (!matchFiltroLocal(r, 'dia', nome, cargoDe(r))) return;
      if (ehDemitidoAtual(nome)) return;
      if (!isFaltaDe(r) && !isPresencaDe(r)) return;
      var d = r.dia;
      if (!diaMap[d]) diaMap[d] = { data: d, faltas: 0, previstos: 0, percentual: 0 };
      diaMap[d].previstos++;
      if (isFaltaDe(r)) diaMap[d].faltas++;
    });

    // Ranking — pula o colaborador
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (!matchFiltroLocal(r, 'colaborador', nome, cargoDe(r))) return;
      if (ehDemitidoAtual(nome)) return;
      if (!isFaltaDe(r) && !isPresencaDe(r)) return;
      if (!funcMap[nome]) funcMap[nome] = { nome: nome, faltas: 0, previstos: 0, percentual: 0 };
      funcMap[nome].previstos++;
      if (isFaltaDe(r)) funcMap[nome].faltas++;
    });

    // Gráfico de mês — pula o mês (todas as colunas seguem visíveis)
    records.forEach(function (r) {
      var nome = nomeDe(r);
      if (!matchFiltroLocal(r, 'mes', nome, cargoDe(r))) return;
      if (ehDemitidoAtual(nome)) return;
      if (!isFaltaDe(r) && !isPresencaDe(r)) return;
      var d = r.dia;
      var mesKey = d ? d.substring(0, 7) : 'Geral';
      if (!mesMap[mesKey]) {
        mesMap[mesKey] = {
          label: mesKey,
          chave: /^\d{4}-\d{2}$/.test(mesKey) ? mesKey : null,
          faltas: 0, previstos: 0, value: 0
        };
      }
      mesMap[mesKey].previstos++;
      if (isFaltaDe(r)) mesMap[mesKey].faltas++;
    });

    // Por função — pula a própria função
    records.forEach(function (r) {
      var nome = nomeDe(r);
      var cargo = cargoDe(r);
      if (!matchFiltroLocal(r, 'funcao', nome, cargo)) return;
      if (ehDemitidoAtual(nome)) return;
      if (!isFaltaDe(r) && !isPresencaDe(r)) return;
      if (!funcaoMap[cargo]) funcaoMap[cargo] = { label: cargo, faltas: 0, previstos: 0, value: 0 };
      funcaoMap[cargo].previstos++;
      if (isFaltaDe(r)) funcaoMap[cargo].faltas++;
    });

    // Desligamentos (turnover) — filtros cruzados sem justificativa
    records.forEach(function (r) {
      var st = (r.status || '').toUpperCase().trim();
      var ehDeslig = st === 'DEMITIDO' || st.indexOf('DEMISS') !== -1 ||
        st.indexOf('DESLIG') !== -1;
      if (!ehDeslig) return;
      var nome = nomeDe(r);
      var cargo = cargoDe(r);
      var d = r.dia;
      var f = globalFilter;
      if (f.dia && d !== f.dia) return;
      if (f.colaborador && normLocal(nome) !== normLocal(f.colaborador)) return;
      if (f.funcao && normLocal(cargo) !== normLocal(f.funcao)) return;
      var itemDeslig = {
        nome: nome,
        funcao: cargo,
        data: d,
        motivo: r.cid || st,
        classificacao: 'Operacional'
      };
      var noMes = !f.mes || String(d || '').substring(0, 7) === f.mes;
      var noMotivo = !f.motivo || normLocal(itemDeslig.motivo) === normLocal(f.motivo);
      // série do Headcount: pula o filtro `mes` (regra de escopo)
      if (noMotivo) desligamentosSemMes.push(itemDeslig);
      // rosca de justificativas: pula o filtro `motivo` (regra de escopo)
      if (noMes) desligamentosSemMotivo.push(itemDeslig);
      // detalhe/KPIs: todos os filtros
      if (noMes && noMotivo) desligamentos.push(itemDeslig);
    });

    var totalPrevistos = totalFaltas + totalPresencas;
    var pctGeralAbs = totalPrevistos > 0 ? (totalFaltas / totalPrevistos) * 100 : 0;

    var statusArr = Object.keys(statusCounts).map(function (k) {
      return { label: k, value: statusCounts[k] };
    });

    var diaArr = Object.keys(diaMap).map(function (k) {
      var item = diaMap[k];
      item.percentual = item.previstos > 0 ? (item.faltas / item.previstos) * 100 : 0;
      return item;
    });

    var funcArr = Object.keys(funcMap).map(function (k) {
      var item = funcMap[k];
      item.percentual = item.previstos > 0 ? (item.faltas / item.previstos) * 100 : 0;
      return item;
    }).sort(function (a, b) { return b.percentual - a.percentual || b.faltas - a.faltas; });

    var mesArr = Object.keys(mesMap).map(function (k) {
      var item = mesMap[k];
      item.value = item.previstos > 0 ? Number(((item.faltas / item.previstos) * 100).toFixed(2)) : 0;
      return item;
    });

    var funcaoArr = Object.keys(funcaoMap).map(function (k) {
      var item = funcaoMap[k];
      item.value = item.previstos > 0 ? Number(((item.faltas / item.previstos) * 100).toFixed(2)) : 0;
      return item;
    }).sort(function (a, b) { return b.value - a.value; });

    // Justificativas de demissão: agrupadas por motivo real (pula o filtro
    // `motivo` — regra de escopo — para todas as fatias seguirem clicáveis)
    var motivoContagem = {};
    desligamentosSemMotivo.forEach(function (dd) {
      var m = dd.motivo || 'NÃO INFORMADO';
      motivoContagem[m] = (motivoContagem[m] || 0) + 1;
    });
    var justificativasArr = Object.keys(motivoContagem).map(function (k) {
      return { label: k, value: motivoContagem[k] };
    }).sort(function (a, b) {
      return b.value - a.value || a.label.localeCompare(b.label);
    });

    var efetivo = funcsUnicos.size || 1;
    var turnGeralPct = (desligamentos.length / efetivo) * 100;
    var efetivoSeries = funcsSeries.size || 1;
    var turnHeadPct = (desligamentosSemMes.length / efetivoSeries) * 100;

    var dataCalculada = {
      success: true,
      efetivoTotal: efetivo,
      kpis: {
        absenteismo: { percentual: Number(pctGeralAbs.toFixed(2)) },
        turnover: {
          geralPercentual: Number(turnGeralPct.toFixed(2)),
          operacionalPercentual: Number(turnGeralPct.toFixed(2)),
          totalDesligamentos: desligamentos.length,
          desligamentosRelevantes: desligamentos.length,
          efetivoAtivoMedio: efetivo
        }
      },
      graficos: {
        absenteismoPorStatus: statusArr,
        absenteismoPorDia: diaArr,
        absenteismoPorFuncionario: funcArr,
        absenteismoPorMes: mesArr,
        absenteismoPorFuncao: funcaoArr,
        desligamentosDetalhe: desligamentos,
        justificativas: justificativasArr,
        turnoverMensal: mesArr.map(function (m) {
          return {
            label: m.label,
            chave: m.chave,
            efetivoAtivo: efetivo,
            desligadosGeral: desligamentos.length,
            operacional: Number(turnGeralPct.toFixed(2)),
            operacionais: desligamentos.length,
            reducao: 0
          };
        }),
        // Série do gráfico Headcount: pula o filtro `mes` (todos os meses)
        turnoverHeadcount: mesArr.map(function (m) {
          return {
            label: m.label,
            chave: m.chave,
            efetivoAtivo: efetivoSeries,
            desligadosGeral: desligamentosSemMes.length,
            operacional: Number(turnHeadPct.toFixed(2)),
            operacionais: desligamentosSemMes.length,
            reducao: 0
          };
        })
      }
    };

    showGrid();
    renderDashboard(dataCalculada);
  }

  function showLoading() {
    if (loadingEl) loadingEl.style.display = 'flex';
    if (emptyEl) emptyEl.style.display = 'none';
    if (gridEl) gridEl.style.display = 'none';
  }

  function showEmpty() {
    if (loadingEl) loadingEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    if (gridEl) gridEl.style.display = 'none';
  }

  function showGrid() {
    if (loadingEl) loadingEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    if (gridEl) gridEl.style.display = 'flex';
    gridRendered = true;
  }

  /* ============================================================
     3. FILTROS DE PERÍODO & CALENDÁRIO
     ============================================================ */

  // A instância noUiSlider é criada em initSliderValues() após o
  // período chegar do servidor/LocalStorage (necessita periodoMin/Max).
  function setupSlider() {
    if (!slider) return;
  }

  function initFlatpickr() {
    if (typeof flatpickr === 'undefined') return;

    // Guarda por input: reentradas (ex.: fallback LocalStorage) não podem
    // criar uma 2ª instância com onChange duplicado (fetch em dobro).
    if (rangeInicio && rangeInicio._flatpickr) {
      try {
        rangeInicio._flatpickr.set('minDate', periodoMin);
        rangeInicio._flatpickr.set('maxDate', periodoMax);
      } catch (e) { /* ignore */ }
    }
    if (rangeFim && rangeFim._flatpickr) {
      try {
        rangeFim._flatpickr.set('minDate', periodoMin);
        rangeFim._flatpickr.set('maxDate', periodoMax);
      } catch (e) { /* ignore */ }
    }

    var config = {
      dateFormat: 'Y-m-d',
      altInput: true,
      altFormat: 'd/m/Y',
      locale: 'pt',
      minDate: periodoMin,
      maxDate: periodoMax,
      onChange: function () {
        if (rangeInicio) currentRange.inicio = rangeInicio.value;
        if (rangeFim) currentRange.fim = rangeFim.value;
        updateSliderFromInputs();
        triggerDataFetch();
      }
    };

    if (rangeInicio && !rangeInicio._flatpickr) {
      flatpickr('#range-inicio', Object.assign({}, config, { defaultDate: periodoMin }));
    }
    if (rangeFim && !rangeFim._flatpickr) {
      flatpickr('#range-fim', Object.assign({}, config, { defaultDate: periodoMax }));
    }
  }

  function initSliderValues() {
    if (!slider || typeof noUiSlider === 'undefined' || !periodoMin || !periodoMax) return;
    var dMin = new Date(periodoMin).getTime();
    var dMax = new Date(periodoMax).getTime();

    if (isNaN(dMin) || isNaN(dMax)) return;

    if (slider.noUiSlider) slider.noUiSlider.destroy();

    noUiSlider.create(slider, {
      start: [dMin, dMax],
      connect: true,
      range: { min: dMin, max: dMax },
      step: 24 * 60 * 60 * 1000
    });

    slider.noUiSlider.on('change', function (values) {
      if (suppressSliderChange) return;
      var d1 = new Date(Number(values[0])).toISOString().split('T')[0];
      var d2 = new Date(Number(values[1])).toISOString().split('T')[0];

      if (rangeInicio && rangeInicio._flatpickr) rangeInicio._flatpickr.setDate(d1, false);
      if (rangeFim && rangeFim._flatpickr) rangeFim._flatpickr.setDate(d2, false);

      currentRange.inicio = d1;
      currentRange.fim = d2;
      triggerDataFetch();
    });
  }

  function updateSliderFromInputs() {
    if (!slider || !slider.noUiSlider || !currentRange.inicio || !currentRange.fim) return;
    var d1 = new Date(currentRange.inicio).getTime();
    var d2 = new Date(currentRange.fim).getTime();
    if (isNaN(d1) || isNaN(d2)) return;
    suppressSliderChange = true;
    slider.noUiSlider.set([d1, d2]);
    suppressSliderChange = false;
  }

  function triggerDataFetch() {
    clearTimeout(debounceTimer);
    // background: não esconde o grid nem recria os gráficos — só atualiza
    debounceTimer = setTimeout(function () { fetchDashboardData({ background: true }); }, 300);
  }

  /* ============================================================
     4. RENDERIZADOR PRINCIPAL DO DASHBOARD
     ============================================================ */

  function renderDashboard(data, opts) {
    if (!data) return;
    opts = opts || {};
    var k = data.kpis || {};
    var g = data.graficos || {};

    // 1. Resumo Geral de Absenteísmo (Velocímetro + Rosca)
    renderGauge(k.absenteismo ? k.absenteismo.percentual : 0);
    renderMotivos(g.absenteismoPorStatus || []);

    // 2. Calendário de Absenteísmo — sem filtro cruzado o merge (sem reset)
    //    preserva as cores dos dias do período inteiro (base = exibição).
    //    Com filtro parcial a resposta traz só a foto: vira o mapa de
    //    exibição e os dias sem dado daquele filtro ficam neutros.
    var parcial = crossFilterParcial();
    (g.absenteismoPorDia || []).forEach(function (d) {
      if (!parcial) mapPorDiaBase[d.data] = d;
    });
    if (parcial) {
      mapPorDia = {};
      (g.absenteismoPorDia || []).forEach(function (d) { mapPorDia[d.data] = d; });
    } else {
      mapPorDia = mapPorDiaBase;
    }
    renderCalendario();

    // 3. Linha Inferior de Absenteísmo
    renderRanking(g.absenteismoPorFuncionario || []);
    renderAbsenteismoMes(g.absenteismoPorMes || []);
    renderAbsenteismoFuncao(g.absenteismoPorFuncao || []);

    // 4. Turnover KPIs & 4 Gráficos Dedicados de Headcount/Turnover
    cacheDesligamentos = g.desligamentosDetalhe || [];
    renderTurnoverKpis(k.turnover || {}, data.efetivoTotal || 0);

    renderHeadcountMovimentacao(g.turnoverHeadcount || g.turnoverMensal || []);
    renderTurnoverOperacional(g.turnoverMensal || [], k.turnover || {});
    renderJustificativasDemissao(g.justificativas || []);
    renderComposicaoDesligamentos(g.turnoverMensal || []);

    // Chips acompanham o estado (inclusive no fallback LocalStorage)
    syncFilterChips();
  }

  /* ============================================================
     5. CARDS DE ABSENTEÍSMO
     ============================================================ */

  // BLOCO 1: VELOCÍMETRO (GAUGE CHART COM FAIXAS E PONTEIRO)
  // Plugin desenhado à mão: ponteiro + valor + rótulo + destaque da Meta.
  // Lê o estado atual de chart.$meta a cada draw (viaza update in-place).
  var gaugeOverlayPlugin = {
    id: 'gaugeOverlay',
    afterDatasetsDraw: function (chart) {
      var m = chart.$meta;
      if (!m) return;
      var meta0 = chart.getDatasetMeta(0);
      if (!meta0 || !meta0.data || !meta0.data.length) return;

      var first = meta0.data[0];
      var last = meta0.data[meta0.data.length - 1];
      var start = first.startAngle;
      var end = last.endAngle;
      var t = Math.max(0, Math.min(1, m.max > 0 ? m.value / m.max : 0));
      var angle = start + (end - start) * t;

      var cx = first.x;
      var cy = first.y;
      var outer = Math.max(first.innerRadius, first.outerRadius);
      var tipX = cx + Math.cos(angle) * (outer - 4);
      var tipY = cy + Math.sin(angle) * (outer - 4);
      var tailX = cx - Math.cos(angle) * 12;
      var tailY = cy - Math.sin(angle) * 12;

      var ctx = chart.ctx;
      ctx.save();

      // Ponteiro com contorno branco (contraste sobre as faixas coloridas)
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // Cuba central
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // Valor + rótulo + Meta em destaque
      var width = chart.width;
      var height = chart.height;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.font = '800 1.45rem Inter, sans-serif';
      ctx.fillStyle = m.color;
      ctx.fillText(pctBr(m.value), width / 2, height * 0.70);

      ctx.font = '600 0.68rem Inter, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('Média Geral', width / 2, height * 0.83);

      ctx.font = '700 0.62rem Inter, sans-serif';
      ctx.fillStyle = CORES.verde;
      ctx.fillText('Meta ' + pctBr(META_ABSENTEISMO), width / 2, height * 0.955);

      ctx.restore();
    }
  };

  function renderGauge(val) {
    var numVal = Number(val) || 0;
    // Escala dinâmica: nunca abaixo de 0–6%, estende para acomodar o valor
    var gaugeMax = Math.max(GAUGE_MAX, Math.ceil(numVal));
    var clamped = Math.max(0, Math.min(numVal, gaugeMax));
    var corPonteiro = clamped > LIMITE_ALERTA ? CORES.vermelho
      : (clamped > META_ABSENTEISMO ? CORES.ambar : CORES.verde);

    // Faixas: Verde 0–3 (Meta) · Amarelo 3–4 (Atenção) · Vermelho >4
    var bands = [
      META_ABSENTEISMO,
      LIMITE_ALERTA - META_ABSENTEISMO,
      Math.max(0.01, gaugeMax - LIMITE_ALERTA)
    ];

    var config = {
      type: 'doughnut',
      data: {
        datasets: [{
          data: bands,
          backgroundColor: [CORES.verde, CORES.ambar, CORES.vermelho],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        rotation: 270,
        circumference: 180,
        cutout: '74%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
          datalabels: { display: false }
        }
      },
      plugins: [gaugeOverlayPlugin]
    };

    updateChart('gauge-container', 'gauge-absenteismo', config, {
      value: numVal,
      clamped: clamped,
      max: gaugeMax,
      color: corPonteiro
    });

    var foot = document.getElementById('gauge-foot');
    if (foot) {
      foot.textContent = 'Escala 0,00% – ' + gaugeMax.toFixed(2).replace('.', ',') +
        '% · Meta ' + pctBr(META_ABSENTEISMO);
    }
  }

  // BLOCO 2: ROSCA DE JUSTIFICATIVAS (AMPLIADA)
  // Plugin do total central (lê chart.$meta; suporta filtro de status)
  var donutCenterPlugin = {
    id: 'donutCenter',
    afterDraw: function (chart) {
      var m = chart.$meta;
      if (!m) return;
      var area = chart.chartArea;
      if (!area) return;

      var ctx = chart.ctx;
      var cx = (area.left + area.right) / 2;
      var cy = (area.top + area.bottom) / 2;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.font = '800 1.35rem Inter, sans-serif';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(String(m.total), cx, cy - 8);

      ctx.font = '600 0.66rem Inter, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText(m.filteredLabel || 'ocorrências', cx, cy + 12);
      ctx.restore();
    }
  };

  function renderMotivos(rows) {
    var container = document.getElementById('chart-motivos');
    if (!container) return;
    if (!rows || !rows.length) {
      destroyChart('chart-motivos');
      container.innerHTML = placeholderVazio();
      return;
    }

    var paletaMotivos = [CORES.vinho, CORES.vermelho, CORES.ambar, CORES.verde, CORES.roxo, CORES.azul, CORES.cinza];
    var total = rows.reduce(function (s, d) { return s + (Number(d.value) || 0); }, 0);
    var justSel = globalFilter.justificativa;

    // ChartDataLabels já vem registrado globalmente no topo do arquivo;
    // repeti-lo aqui duplicaria as execuções dos hooks do plugin.
    var plugins = [donutCenterPlugin];

    var config = {
      type: 'doughnut',
      data: {
        labels: rows.map(function (d) { return d.label; }),
        datasets: [{
          data: rows.map(function (d) { return d.value; }),
          backgroundColor: rows.map(function (d, i) {
            // Com justificativa ativa, a fatia escolhida ganha destaque e
            // as demais desbotam (todas continuam clicáveis)
            var base = paletaMotivos[i % paletaMotivos.length];
            if (justSel && d.label !== justSel) return base + '59';
            return base;
          }),
          borderWidth: rows.map(function (d) {
            return (justSel && d.label === justSel) ? 4 : 2;
          }),
          borderColor: rows.map(function (d) {
            return (justSel && d.label === justSel) ? CORES.vinho : '#ffffff';
          })
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        onHover: function (e, elements) {
          if (e.native && e.native.target) {
            e.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
          }
        },
        onClick: function (e, elements) {
          if (!elements || !elements.length) return;
          var inst = chartInstances['chart-motivos'];
          var label = inst && inst.data.labels ? inst.data.labels[elements[0].index] : null;
          if (label) toggleStatusFilter(label);
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 12,
              font: { size: 11, family: 'Inter', weight: '600' },
              color: '#334155',
              padding: 10
            }
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ' ' + ctx.label + ': ' + ctx.raw + ' ocorrência(s)';
              }
            }
          },
          datalabels: {
            color: '#ffffff',
            font: { family: 'Inter', weight: '700', size: 10 },
            textAlign: 'center',
            display: function (ctx) {
              var data = ctx.chart.data.datasets[0].data || [];
              var sum = data.reduce(function (s, v) { return s + (Number(v) || 0); }, 0);
              return sum > 0 && (Number(data[ctx.dataIndex]) || 0) / sum >= 0.05;
            },
            formatter: function (value, ctx) {
              var data = ctx.chart.data.datasets[0].data || [];
              var sum = data.reduce(function (s, v) { return s + (Number(v) || 0); }, 0);
              var pct = sum > 0 ? Math.round((value / sum) * 100) : 0;
              return value + '\n' + pct + '%';
            }
          }
        }
      },
      plugins: plugins
    };

    updateChart('chart-motivos', 'canvas-motivos', config, {
      total: total,
      filteredLabel: globalFilter.justificativa ? 'filtrado' : 'ocorrências'
    });
  }

  // ---- FILTRO POR JUSTIFICATIVA (clique nas fatias da rosca) ----
  function toggleStatusFilter(label) {
    toggleCrossFilter('justificativa', label);
  }

  function updateStatusChip() {
    var chip = document.getElementById('status-filter-chip');
    if (chip) {
      if (globalFilter.justificativa) {
        chip.style.display = 'inline-flex';
        var txt = document.getElementById('status-filter-chip-text');
        if (txt) txt.textContent = globalFilter.justificativa;
      } else {
        chip.style.display = 'none';
      }
    }
    var wrap = document.getElementById('chart-motivos');
    if (wrap) wrap.classList.toggle('is-filtered', !!globalFilter.justificativa);
  }

  function setupStatusChip() {
    var btn = document.getElementById('status-chip-clear');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!globalFilter.justificativa) return;
      globalFilter.justificativa = null;
      syncFilterChips();
      fetchDashboardData({ background: true, filterChange: true });
    });
  }

  // CALENDÁRIO DE ABSENTEÍSMO (GRID 8 MESES COM ROLAGEM VERTICAL)
  // Chave da página de meses atualmente no DOM — permite atualizar as
  // células in-place sem reconstruir o HTML quando a página não muda.
  var calPageKey = null;

  function calPageKeyAtual(pageMonths) {
    return (calState.anual ? 'A' : 'P') + '|' + calState.ano + '|' + calState.mes + '|' + pageMonths;
  }

  function renderCalendario() {
    var container = document.getElementById('calendario');
    if (!container) return;

    var datas = Array.from(datasDisponiveis).sort();
    if (!datas.length) {
      container.innerHTML = placeholderVazio();
      calPageKey = null;
      return;
    }

    var minDate = new Date(datas[0]);

    if (!calState.ano || isNaN(calState.ano)) {
      calState.ano = minDate.getFullYear();
      calState.mes = minDate.getMonth();
    }

    var pageMonths = calState.anual ? 12 : CAL_PAGE_MONTHS;
    var key = calPageKeyAtual(pageMonths);

    // Mesma página de meses no DOM → só atualiza classes/títulos/seleção
    // das células existentes (sem innerHTML, sem recriar nós).
    if (key === calPageKey && container.dataset.calKey === key &&
        container.querySelector('.rhub-month')) {
      refreshCalendarioCells(container);
      return;
    }

    var scrollTop = container.scrollTop;

    container.innerHTML = '';
    for (var i = 0; i < pageMonths; i++) {
      var d = new Date(calState.ano, calState.mes + i, 1);
      container.appendChild(buildMonthTable(d.getFullYear(), d.getMonth()));
    }

    container.scrollTop = scrollTop;
    calPageKey = key;
    container.dataset.calKey = key;
  }

  // Estado visual de uma célula (cor por faixa, título e seleção)
  function applyDayState(el, iso) {
    var reg = mapPorDia[iso];

    el.classList.remove(
      'cal-day--has-data', 'cal-day--verde', 'cal-day--amarelo',
      'cal-day--vermelho', 'cal-day--neutro', 'cal-day--selected'
    );

    if (reg && reg.previstos > 0) {
      var pct = reg.percentual;
      el.classList.add('cal-day--has-data');
      if (pct <= META_ABSENTEISMO) el.classList.add('cal-day--verde');
      else if (pct <= LIMITE_ALERTA) el.classList.add('cal-day--amarelo');
      else el.classList.add('cal-day--vermelho');
      el.title = 'Data: ' + iso + ' | Absenteísmo: ' + pctBr(pct) +
        ' (' + reg.faltas + '/' + reg.previstos + ')';
    } else {
      el.classList.add('cal-day--neutro');
      el.title = '';
    }

    if (globalFilter.dia === iso) el.classList.add('cal-day--selected');
  }

  // Atualização in-place: percorre as células já renderizadas
  function refreshCalendarioCells(container) {
    var cells = container.querySelectorAll('.cal-day[data-iso]');
    for (var i = 0; i < cells.length; i++) {
      var el = cells[i];
      var iso = el.dataset.iso;
      if (iso) applyDayState(el, iso);
    }
  }

  // Atualização in-place da seleção do dia (sem reconstruir o DOM)
  function setCalSelectedDay(iso) {
    var container = document.getElementById('calendario');
    if (!container) return;
    var prev = container.querySelectorAll('.cal-day--selected');
    prev.forEach(function (el) { el.classList.remove('cal-day--selected'); });
    if (!iso) return;
    var el = container.querySelector('.cal-day[data-iso="' + iso + '"]');
    if (el) el.classList.add('cal-day--selected');
  }

  function buildMonthTable(ano, mes) {
    var div = document.createElement('div');
    div.className = 'rhub-month';

    var mesesNome = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    var title = document.createElement('div');
    title.className = 'rhub-month__title';
    title.textContent = (mesesNome[mes] || '') + ' ' + ano;
    div.appendChild(title);

    var table = document.createElement('table');
    table.className = 'rhub-month-table';
    table.innerHTML = '<thead><tr><th>Dom</th><th>Seg</th><th>Ter</th><th>Qua</th><th>Qui</th><th>Sex</th><th>Sáb</th></tr></thead>';

    var tbody = document.createElement('tbody');
    var primeiroDia = new Date(ano, mes, 1).getDay();
    var totalDias = new Date(ano, mes + 1, 0).getDate();

    var tr = document.createElement('tr');
    for (var i = 0; i < primeiroDia; i++) {
      tr.appendChild(document.createElement('td'));
    }

    for (var dia = 1; dia <= totalDias; dia++) {
      if (tr.children.length === 7) {
        tbody.appendChild(tr);
        tr = document.createElement('tr');
      }

      var td = document.createElement('td');
      var iso = ano + '-' + String(mes + 1).padStart(2, '0') + '-' + String(dia).padStart(2, '0');

      var dayBox = document.createElement('div');
      dayBox.className = 'cal-day';
      dayBox.textContent = dia;
      // Sempre com data-iso: permite o refresh in-place das células
      dayBox.dataset.iso = iso;

      applyDayState(dayBox, iso);

      td.appendChild(dayBox);
      tr.appendChild(td);
    }

    while (tr.children.length < 7) {
      tr.appendChild(document.createElement('td'));
    }
    tbody.appendChild(tr);
    table.appendChild(tbody);
    div.appendChild(table);

    return div;
  }

  function setupCalendarioControls() {
    var prev = document.getElementById('cal-prev');
    var next = document.getElementById('cal-next');
    var ano = document.getElementById('cal-ano');

    if (prev) {
      prev.addEventListener('click', function () {
        calState.ano = calState.ano || new Date().getFullYear();
        calState.mes -= CAL_PAGE_MONTHS;
        if (calState.mes < 0) {
          calState.mes += 12;
          calState.ano -= 1;
        }
        calState.anual = false;
        renderCalendario();
      });
    }
    if (next) {
      next.addEventListener('click', function () {
        calState.ano = calState.ano || new Date().getFullYear();
        calState.mes += CAL_PAGE_MONTHS;
        if (calState.mes >= 12) {
          calState.mes -= 12;
          calState.ano += 1;
        }
        calState.anual = false;
        renderCalendario();
      });
    }
    if (ano) {
      ano.addEventListener('click', function () {
        if (calState.anual) {
          // Segundo clique: volta para a página de 8 meses na mesma posição
          calState.anual = false;
        } else {
          calState.anual = true;
          calState.ano = new Date(periodoMin || Date.now()).getFullYear();
          calState.mes = 0;
        }
        renderCalendario();
      });
    }
  }

  // EVENT DELEGATION: um único listener no container do calendário.
  // As células de dia podem ser reconstruídas/atualizadas livremente —
  // nenhum listener é anexado por célula (evita vazamento/escuta múltipla).
  function setupCalendarioClick() {
    var container = document.getElementById('calendario');
    if (!container) return;
    if (container.dataset.delegation === '1') return; // já registrado
    container.dataset.delegation = '1';
    container.addEventListener('click', onCalendarioClick);
  }

  function onCalendarioClick(e) {
    var target = e.target && e.target.closest ? e.target.closest('.cal-day--has-data') : null;
    if (!target) return;

    var iso = target.dataset.iso;
    if (!iso) return;

    if (globalFilter.dia === iso) {
      clearDayFilter();
    } else {
      applyDayFilter(iso);
    }
  }

  // Filtro de dia: mais uma dimensão do filtro global (?dia=) — o período
  // (slider/flatpickr) permanece intacto e o calendário mantém a grade
  // completa com o dia selecionado destacado.
  function applyDayFilter(iso) {
    globalFilter.dia = iso;
    syncFilterChips();

    // Sempre busca do servidor; LocalStorage permanece apenas como
    // fallback dentro de fetchDashboardData() (erro/vazio real).
    // background: mantém o grid visível (sem spinner full-screen).
    fetchDashboardData({ background: true, filterChange: true });
  }

  function clearDayFilter() {
    if (!globalFilter.dia) return;
    globalFilter.dia = null;
    syncFilterChips();
    fetchDashboardData({ background: true, filterChange: true });
  }

  function updateDayChip() {
    var chip = document.getElementById('day-filter-chip');
    if (!chip) return;
    if (globalFilter.dia) {
      chip.style.display = 'inline-flex';
      var txt = chip.querySelector('.day-chip__text');
      if (txt) txt.textContent = globalFilter.dia.split('-').reverse().join('/');
    } else {
      chip.style.display = 'none';
    }
  }

  function setupDayChip() {
    var btn = document.getElementById('day-chip-clear');
    if (btn) btn.addEventListener('click', clearDayFilter);
  }

  // RANKING DE COLABORADORES
  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderRanking(rows) {
    lastRankingRows = rows || [];
    var container = document.getElementById('lista-colaboradores');
    if (!container) return;

    if (!rows || !rows.length) {
      container.innerHTML = placeholderVazio();
      container.dataset.sig = '';
      return;
    }

    var sel = globalFilter.colaborador ? normLocal(globalFilter.colaborador) : null;
    var top10 = rows.slice(0, TOP_RANKING);
    var html = '<div class="ranking-list">';
    top10.forEach(function (item, idx) {
      var nome = escapeHtml(item.nome);
      var selecionado = !!sel && normLocal(item.nome) === sel;
      html +=
        '<div class="ranking-item' + (selecionado ? ' ranking-item--selected' : '') + '"' +
          ' data-nome="' + nome + '" title="Clique para filtrar o dashboard">' +
          '<span class="ranking-item__pos">#' + (idx + 1) + '</span>' +
          '<span class="ranking-item__name">' + nome + '</span>' +
          '<span class="ranking-item__val">' + pctBr(item.percentual) + ' (' + item.faltas + 'f)</span>' +
        '</div>';
    });
    html += '</div>';

    // Assinatura do HTML: pula a reescrita quando nada mudou
    if (container.dataset.sig !== html) {
      container.innerHTML = html;
      container.dataset.sig = html;
    }
  }

  // Delegação única: as linhas são reescritas a cada render, mas o listener
  // fica no container (mesma estratégia do calendário).
  function setupRankingClick() {
    var container = document.getElementById('lista-colaboradores');
    if (!container) return;
    if (container.dataset.delegation === '1') return;
    container.dataset.delegation = '1';
    container.addEventListener('click', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.ranking-item[data-nome]') : null;
      if (!item) return;
      toggleCrossFilter('colaborador', item.dataset.nome);
    });
  }

  // Destaque imediato da linha selecionada (antes do fetch responder)
  function refreshRankingSelection() {
    var container = document.getElementById('lista-colaboradores');
    if (!container) return;
    var sel = globalFilter.colaborador ? normLocal(globalFilter.colaborador) : null;
    var itens = container.querySelectorAll('.ranking-item[data-nome]');
    for (var i = 0; i < itens.length; i++) {
      var el = itens[i];
      el.classList.toggle('ranking-item--selected', !!sel && normLocal(el.dataset.nome) === sel);
    }
  }

  function setupRankExpand() {
    var btn = document.getElementById('btn-rank-expand');
    var modal = document.getElementById('modal-ranking');
    var closeBtn = document.getElementById('btn-ranking-close');
    var fecharBtn = document.getElementById('btn-ranking-fechar');

    if (btn) {
      btn.addEventListener('click', function () {
        if (!modal) return;
        var tbody = modal.querySelector('tbody');
        if (tbody) {
          tbody.innerHTML = lastRankingRows.map(function (item, i) {
            return '<tr>' +
              '<td>' + (i + 1) + '</td>' +
              '<td><strong>' + item.nome + '</strong></td>' +
              '<td>' + item.faltas + '</td>' +
              '<td>' + item.previstos + '</td>' +
              '<td><span class="text-danger fw-bold">' + pctBr(item.percentual) + '</span></td>' +
            '</tr>';
          }).join('');
        }
        modal.classList.add('open', 'active', 'show');
      });
    }

    [closeBtn, fecharBtn].forEach(function (el) {
      if (el) el.addEventListener('click', function () { if (modal) modal.classList.remove('open', 'active', 'show'); });
    });
  }

  // ABSENTEÍSMO MÊS
  // Sem eixo Y: só as colunas com o data label exato em cima. O clique na
  // coluna filtra o dashboard inteiro para aquele mês (o período/slider
  // permanece intacto e todas as colunas seguem visíveis para trocar).
  function renderAbsenteismoMes(rows) {
    var container = document.getElementById('chart-mes');
    if (!container) return;
    if (!rows || !rows.length) {
      destroyChart('chart-mes');
      container.innerHTML = placeholderVazio();
      return;
    }

    var selMes = globalFilter.mes;

    updateChart('chart-mes', 'canvas-mes', {
      type: 'bar',
      data: {
        labels: rows.map(function (d) { return d.label; }),
        datasets: [{
          label: '% Absenteísmo',
          data: rows.map(function (d) { return d.value; }),
          backgroundColor: rows.map(function (d) {
            if (selMes) return d.chave === selMes ? CORES.vinho : '#cbd5e1';
            return '#718096';
          }),
          hoverBackgroundColor: rows.map(function (d) {
            if (selMes) return d.chave === selMes ? CORES.vinho : '#94a3b8';
            return '#8b9cb3';
          }),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onHover: function (e, elements) {
          if (e.native && e.native.target) {
            e.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
          }
        },
        onClick: function (e, elements) {
          if (!elements || !elements.length) return;
          var alvo = rows[elements[0].index];
          if (alvo && alvo.chave) toggleCrossFilter('mes', alvo.chave);
        },
        plugins: {
          legend: { display: false },
          datalabels: {
            display: true,
            anchor: 'end',
            align: 'top',
            offset: 4,
            clip: false,
            color: '#1e293b',
            font: { family: 'Inter', weight: '700', size: 12 },
            formatter: function (v) {
              return (Number(v) || 0).toFixed(2).replace('.', ',') + '%';
            }
          },
          tooltip: {
            callbacks: {
              label: function (c) { return ' % Absenteísmo: ' + pctBr(c.parsed.y); }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }
          },
          // Sem eixo Y: a altura continua proporcionar e o valor aparece
          // apenas no data label sobre a coluna
          y: {
            display: false,
            beginAtZero: true,
            // folga superior: o rótulo acima da coluna nunca é cortado
            grace: '15%',
            grid: { display: false },
            ticks: { display: false }
          }
        }
      }
    });
  }

  // ABSENTEÍSMO FUNÇÃO
  // O clique na barra filtra Ranking/Calendário/etc. para aquela função;
  // o próprio gráfico mantém todas as funções (pula a própria dimensão).
  function renderAbsenteismoFuncao(rows) {
    lastFuncaoData = rows || [];
    var container = document.getElementById('chart-funcao');
    if (!container) return;
    if (!rows || !rows.length) {
      destroyChart('chart-funcao');
      container.innerHTML = placeholderVazio();
      return;
    }

    var displayRows = funcaoExpanded ? rows : rows.slice(0, 10);
    var selFuncao = globalFilter.funcao;

    updateChart('chart-funcao', 'canvas-funcao', {
      type: 'bar',
      data: {
        labels: displayRows.map(function (d) { return d.label; }),
        datasets: [{
          label: '% Absenteísmo',
          data: displayRows.map(function (d) { return d.value; }),
          backgroundColor: displayRows.map(function (d) {
            if (selFuncao) return d.label === selFuncao ? CORES.vinho : '#fca5a5';
            return CORES.vermelho;
          }),
          hoverBackgroundColor: displayRows.map(function (d) {
            if (selFuncao) return d.label === selFuncao ? CORES.vinho : '#f87171';
            return '#dc2626';
          }),
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onHover: function (e, elements) {
          if (e.native && e.native.target) {
            e.native.target.style.cursor = (elements && elements.length) ? 'pointer' : 'default';
          }
        },
        onClick: function (e, elements) {
          if (!elements || !elements.length) return;
          var alvo = displayRows[elements[0].index];
          if (alvo && alvo.label) toggleCrossFilter('funcao', alvo.label);
        },
        plugins: {
          legend: { display: false },
          // Rótulo na ponta de cada barra horizontal, fora da barra (para a
          // direita) e com folga na escala para não cortar a leitura
          datalabels: {
            display: true,
            anchor: 'end',
            align: 'right',
            offset: 4,
            clip: false,
            color: '#1e293b',
            font: { family: 'Inter', weight: '700', size: 11 },
            formatter: function (v) {
              return (Number(v) || 0).toFixed(1).replace('.', ',') + '%';
            }
          },
          tooltip: {
            callbacks: {
              label: function (c) { return ' % Absenteísmo: ' + pctBr(c.parsed.x); }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            // folga à direita: a ponta da barra nunca encosta na borda,
            // deixando espaço para o rótulo de valor
            grace: '18%',
            ticks: { callback: function (v) { return v + '%'; } }
          }
        }
      }
    });
  }

  function setupFuncaoExpand() {
    var btn = document.getElementById('btn-funcao-expand');
    if (!btn) return;
    btn.addEventListener('click', function () {
      funcaoExpanded = !funcaoExpanded;
      btn.innerHTML = funcaoExpanded
        ? '<i class="bi bi-dash-circle"></i> Ver TOP 10'
        : '<i class="bi bi-search"></i> Ver todas as funções';
      renderAbsenteismoFuncao(lastFuncaoData);
    });
  }

  /* ============================================================
     6. SEÇÃO TURNOVER & HEADCOUNT (4 GRÁFICOS DEDICADOS 2x2)
     ============================================================ */

  function renderTurnoverKpis(t, efetivoTotal) {
    var el = document.getElementById('turnover-kpis');
    if (!el) return;

    var metaG = t.metaGeral != null ? t.metaGeral : META_TURNOVER_GERAL;
    var metaO = t.metaOperacional != null ? t.metaOperacional : META_TURNOVER_OPERACIONAL;
    var geral = Number(t.geralPercentual) || 0;
    var oper = Number(t.operacionalPercentual) || 0;
    var efetivoMedio = Number(t.efetivoAtivoMedio) || 0;
    var totalDeslig = Number(t.totalDesligamentos) || 0;
    var operCount = Number(t.desligamentosRelevantes) || 0;

    var levelG = geral > metaG ? 'vermelho' : 'verde';
    var levelO = oper > TURNOVER_CRITICO ? 'vermelho' : (oper > metaO ? 'ambar' : 'verde');

    var html =
      '<div class="t-kpi" data-level="' + levelG + '">' +
        '<span class="t-kpi__label">Turnover Geral (Com Contratual)</span>' +
        '<span class="t-kpi__value">' + pctBr(geral) + '</span>' +
        '<span class="t-kpi__meta">' + totalDeslig + ' desligamentos · Efetivo Ativo Médio: ' +
          efetivoMedio.toFixed(1) + ' · Meta ≤ ' + pctBr(metaG) + '</span>' +
      '</div>' +
      '<div class="t-kpi" data-level="' + levelO + '">' +
        '<span class="t-kpi__label">Turnover Operacional (Gerenciável)</span>' +
        '<span class="t-kpi__value">' + pctBr(oper) + '</span>' +
        '<span class="t-kpi__meta">' + operCount + ' deslig. operacionais · Meta ≤ ' + pctBr(metaO) + '</span>' +
      '</div>';

    if (el.dataset.sig !== html) {
      el.innerHTML = html;
      el.dataset.sig = html;
    }
  }

  // GRÁFICO 1: HEADCOUNT & MOVIMENTAÇÃO (eixo duplo)
  // Colunas de efetivo no eixo esquerdo (Y1) + linhas de admissões/demissões
  // no eixo direito (Y2).
  // Clique numa coluna aplica/limpa o filtro global de mês; com mês ativo as
  // demais colunas ficam em alpha ~35% (a série pula o filtro `mes` no
  // servidor — regra de escopo — então todos os meses seguem visíveis).
  function renderHeadcountMovimentacao(turnoverMesRows) {
    var container = document.getElementById('chart-headcount-movimentacao');
    if (!container) return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      destroyChart('chart-headcount-movimentacao');
      container.innerHTML = placeholderVazio();
      return;
    }

    var rows = turnoverMesRows;
    var labels = rows.map(function (d) { return d.label; });
    var efetivo = rows.map(function (d) { return Number(d.efetivoAtivo) || 0; });
    var demitidos = rows.map(function (d) { return Number(d.desligadosGeral) || 0; });

    function chaveDe(d) {
      if (d && d.chave) return d.chave;
      var lb = d && String(d.label || '');
      return /^\d{4}-\d{2}$/.test(lb) ? lb : null;
    }

    // Destaque do mês filtrado: selecionado em tom sólido, demais com
    // alpha de ~35% ('#94a3b859')
    var selMes = globalFilter.mes;
    function corColuna(d) {
      var ativo = !selMes || chaveDe(d) === selMes;
      return ativo ? '#94a3b8' : '#94a3b859';
    }
    function corColunaHover(d) {
      var ativo = !selMes || chaveDe(d) === selMes;
      return ativo ? '#64748b' : '#94a3b859';
    }

    var admitidos = [];
    for (var i = 0; i < rows.length; i++) {
      var efAtual = efetivo[i];
      var efAnterior = i > 0 ? (efetivo[i - 1] || efAtual) : efAtual;
      var delta = efAtual - efAnterior;
      var adm = Math.max(0, delta + demitidos[i]);
      admitidos.push(adm);
    }

    // Y1 (esquerdo): só as matrículas — faixa folgada em passos de 50,
    // calculada apenas sobre o efetivo (ex.: 400..412 → eixo 350..450)
    var minY1 = Math.min.apply(null, efetivo);
    var maxY1 = Math.max.apply(null, efetivo);
    var y1Min = Math.max(0, Math.floor((minY1 * 0.9) / 50) * 50);
    var y1Max = Math.max(y1Min + 50, Math.ceil((maxY1 * 1.05) / 50) * 50);

    // Y2 (direito): só movimentações — do zero ao pico com folga (ex.: 30 → 40)
    var picoMov = Math.max(1, Math.max.apply(null, admitidos.concat(demitidos)));
    var y2Max = Math.max(5, Math.ceil((picoMov * 1.25) / 5) * 5);

    function rotuloMov(cor) {
      return {
        display: true,
        anchor: 'end',
        align: 'top',
        offset: 4,
        clip: false,
        // mantém o texto dentro da área do gráfico (não invade o eixo X)
        clamp: true,
        color: cor,
        font: { family: 'Inter', weight: '700', size: 10 },
        formatter: function (v) { return String(Math.round(Number(v) || 0)); }
      };
    }

    updateChart('chart-headcount-movimentacao', 'canvas-headcount-movimentacao', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Efetivo Total (Matrículas Ativas)',
            data: efetivo,
            backgroundColor: rows.map(corColuna),
            hoverBackgroundColor: rows.map(corColunaHover),
            borderRadius: 4,
            yAxisID: 'y1',
            order: 2
          },
          {
            type: 'line',
            label: 'Admitidos',
            data: admitidos,
            borderColor: CORES.verde,
            backgroundColor: CORES.verde,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: CORES.verde,
            fill: false,
            yAxisID: 'y2',
            order: 1,
            datalabels: rotuloMov(CORES.verde)
          },
          {
            type: 'line',
            label: 'Demitidos Total',
            data: demitidos,
            borderColor: CORES.vermelho,
            backgroundColor: CORES.vermelho,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: CORES.vermelho,
            fill: false,
            yAxisID: 'y2',
            order: 1,
            datalabels: Object.assign(rotuloMov(CORES.vermelho), { align: 'bottom' })
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Clique em coluna ou ponto → filtro global de mês (2º clique limpa)
        onClick: function (e, elements) {
          if (!elements || !elements.length) return;
          var d = rows[elements[0].index];
          var chave = d && chaveDe(d);
          if (chave) toggleCrossFilter('mes', chave);
        },
        // Cursor de mão sobre qualquer barra ou ponto
        onHover: function (e, elements, chart) {
          var alvo = (e && e.chart && e.chart.canvas) ||
            (chart && chart.canvas) ||
            (e && e.native && e.native.target);
          if (alvo) alvo.style.cursor = elements && elements.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          datalabels: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: function (ctx) {
                var v = ctx.parsed.y;
                var lbl = ctx.dataset.label;
                if (lbl === 'Efetivo Total (Matrículas Ativas)') {
                  return ' Total de Matrículas Ativas: ' + v;
                }
                if (lbl === 'Admitidos') return ' Admissões: ' + v;
                if (lbl === 'Demitidos Total') return ' Demissões: ' + v;
                return ' ' + lbl + ': ' + v;
              },
              footer: function (items) {
                if (!items.length) return '';
                var admit = null;
                var demit = null;
                items.forEach(function (it) {
                  if (it.dataset.label === 'Admitidos') admit = it.parsed.y;
                  if (it.dataset.label === 'Demitidos Total') demit = it.parsed.y;
                });
                if (admit === null || demit === null) return '';
                var saldo = admit - demit;
                return ' Saldo Líquido do Mês (Admitidos - Demitidos): ' +
                  (saldo > 0 ? '+' : '') + saldo;
              }
            }
          }
        },
        scales: {
          // Y1 esquerdo: total de matrículas
          y1: {
            position: 'left',
            min: y1Min,
            max: y1Max,
            ticks: { precision: 0 },
            grid: { color: 'rgba(148, 163, 184, 0.2)' }
          },
          // Y2 direito: exclusivo de admissões/demissões, sem grid
          y2: {
            position: 'right',
            min: 0,
            max: y2Max,
            grid: { display: false },
            ticks: { precision: 0 }
          },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // GRÁFICO 2: TAXA DE TURNOVER OPERACIONAL ISOLADO (%)
  function renderTurnoverOperacional(turnoverMesRows, turnoverKpi) {
    var container = document.getElementById('chart-turnover-operacional');
    if (!container) return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      destroyChart('chart-turnover-operacional');
      container.innerHTML = placeholderVazio();
      return;
    }

    var labels = turnoverMesRows.map(function (d) { return d.label; });
    var operData = turnoverMesRows.map(function (d) { return d.operacional; });
    var metaLine = labels.map(function () { return META_TURNOVER_OPERACIONAL; });

    updateChart('chart-turnover-operacional', 'canvas-turnover-operacional', {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Turnover Operacional Isolado (%)',
            data: operData,
            borderColor: CORES.vinho,
            backgroundColor: 'rgba(127, 29, 29, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: CORES.vinho,
            // Rótulo percentual exato acima de cada ponto vermelho
            datalabels: {
              display: true,
              anchor: 'end',
              align: 'top',
              offset: 6,
              clip: false,
              color: '#7f1d1d',
              font: { family: 'Inter', weight: '700', size: 11 },
              formatter: function (v) {
                return (Number(v) || 0).toFixed(2).replace('.', ',') + '%';
              }
            }
          },
          {
            label: 'Meta Operacional (3,00%)',
            data: metaLine,
            borderColor: CORES.ambar,
            borderWidth: 2,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          datalabels: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ' ' + ctx.dataset.label + ': ' + pctBr(ctx.parsed.y);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            // folga superior: os rótulos no topo nunca são cortados
            grace: '15%',
            ticks: { callback: function (v) { return v + '%'; } }
          }
        }
      }
    });
  }

  // GRÁFICO 3: JUSTIFICATIVAS DE DEMISSÃO (donut por motivo real)
  // Clique numa fatia aplica/limpa o cross-filter `motivo` (filtra a lista
  // detalhada/digital do turnover e os KPIs de desligamento); com motivo
  // ativo as demais fatias desbotam. O servidor agrupa pulando a própria
  // dimensão (regra de escopo), então todas as justificativas seguem
  // visíveis e clicáveis.
  function renderJustificativasDemissao(rows) {
    var container = document.getElementById('chart-razao-reposicao');
    if (!container) return;
    if (!rows || !rows.length) {
      destroyChart('chart-razao-reposicao');
      container.innerHTML = placeholderVazio();
      return;
    }

    var paleta = [
      '#7f1d1d', '#dc2626', '#f59e0b', '#10b981',
      '#2563eb', '#8b5cf6', '#64748b', '#0ea5e9'
    ];
    var selMotivo = globalFilter.motivo;

    updateChart('chart-razao-reposicao', 'canvas-razao-reposicao', {
      type: 'doughnut',
      data: {
        labels: rows.map(function (d) { return d.label; }),
        datasets: [{
          data: rows.map(function (d) { return d.value; }),
          backgroundColor: rows.map(function (d, i) {
            var base = paleta[i % paleta.length];
            if (selMotivo && d.label !== selMotivo) return base + '59';
            return base;
          }),
          borderWidth: rows.map(function (d) {
            return (selMotivo && d.label === selMotivo) ? 4 : 2;
          }),
          borderColor: rows.map(function (d) {
            return (selMotivo && d.label === selMotivo) ? CORES.vinho : '#ffffff';
          })
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        onHover: function (e, elements, chart) {
          var alvo = (e && e.chart && e.chart.canvas) ||
            (chart && chart.canvas) ||
            (e && e.native && e.native.target);
          if (alvo) alvo.style.cursor = elements && elements.length ? 'pointer' : 'default';
        },
        onClick: function (e, elements) {
          if (!elements || !elements.length) return;
          var inst = chartInstances['chart-razao-reposicao'];
          var label = inst && inst.data.labels ? inst.data.labels[elements[0].index] : null;
          if (label) toggleCrossFilter('motivo', label);
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 8 } },
          // quantidade + percentual dentro de cada fatia (ex.: '12 (40,0%)')
          datalabels: {
            display: function (ctx) {
              var val = Number(ctx.dataset.data[ctx.dataIndex]) || 0;
              return val > 0;
            },
            anchor: 'center',
            align: 'center',
            color: '#ffffff',
            font: { family: 'Inter', weight: '700', size: 11 },
            formatter: function (val, ctx) {
              var total = ctx.dataset.data.reduce(function (a, b) {
                return a + (Number(b) || 0);
              }, 0);
              if (!total) return '';
              var pct = ((val / total) * 100).toFixed(1).replace('.', ',') + '%';
              return val + ' (' + pct + ')';
            }
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var val = Number(ctx.parsed) || 0;
                var data = ctx.dataset.data || [];
                var total = data.reduce(function (a, b) {
                  return a + (Number(b) || 0);
                }, 0);
                var pct = total
                  ? ((val / total) * 100).toFixed(1).replace('.', ',') + '%'
                  : '0%';
                return ' ' + ctx.label + ': ' + val + ' colaboradores (' + pct + ')';
              }
            }
          }
        }
      }
    });
  }

  // GRÁFICO 4: COMPOSIÇÃO TEMPORAL DOS DESLIGAMENTOS (STACKED BAR)
  function renderComposicaoDesligamentos(turnoverMesRows) {
    var container = document.getElementById('chart-composicao-desligamentos');
    if (!container) return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      destroyChart('chart-composicao-desligamentos');
      container.innerHTML = placeholderVazio();
      return;
    }

    var labels = turnoverMesRows.map(function (d) { return d.label; });
    var operacionais = turnoverMesRows.map(function (d) { return d.operacionais || 0; });
    var reducao = turnoverMesRows.map(function (d) { return d.reducao || 0; });

    updateChart('chart-composicao-desligamentos', 'canvas-composicao-desligamentos', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Turnover Operacional',
            data: operacionais,
            backgroundColor: CORES.vinho,
            stack: 'desligamentos',
            // valor dentro da fatia (apenas quando > 0)
            datalabels: {
              display: function (ctx) {
                return (Number(ctx.dataset.data[ctx.dataIndex]) || 0) > 0;
              },
              anchor: 'center',
              align: 'center',
              color: '#ffffff',
              font: { family: 'Inter', weight: '700', size: 11 },
              formatter: function (v) { return String(Math.round(Number(v) || 0)); }
            }
          },
          {
            label: 'Redução de Efetivo (Contratual)',
            data: reducao,
            backgroundColor: CORES.cinza,
            borderRadius: { topLeft: 4, topRight: 4 },
            stack: 'desligamentos',
            // último dataset da pilha: valor interno + total do mês acima
            datalabels: {
              labels: {
                valor: {
                  display: function (ctx) {
                    return (Number(ctx.dataset.data[ctx.dataIndex]) || 0) > 0;
                  },
                  anchor: 'center',
                  align: 'center',
                  color: '#ffffff',
                  font: { family: 'Inter', weight: '700', size: 11 },
                  formatter: function (v) { return String(Math.round(Number(v) || 0)); }
                },
                total: {
                  display: true,
                  anchor: 'end',
                  align: 'top',
                  offset: 4,
                  clip: false,
                  color: '#1e293b',
                  font: { family: 'Inter', weight: '700', size: 12 },
                  formatter: function (v, ctx) {
                    var index = ctx.dataIndex;
                    var total = ctx.chart.data.datasets.reduce(function (acc, ds) {
                      return acc + (Number(ds.data[index]) || 0);
                    }, 0);
                    return total > 0 ? String(Math.round(total)) : '';
                  }
                }
              }
            }
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          datalabels: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              footer: function (items) {
                var sum = items.reduce(function (s, item) { return s + item.parsed.y; }, 0);
                return 'Total Desligamentos: ' + sum;
              }
            }
          }
        },
        scales: {
          x: { stacked: true },
          y: {
            stacked: true,
            beginAtZero: true,
            // folga superior: o total do mês acima da coluna não é cortado
            grace: '15%',
            ticks: { precision: 0 }
          }
        }
      }
    });
  }

  /* ============================================================
     7. MODAL DIGITAL DO TURNOVER & EXPORTAÇÃO PDF
     ============================================================ */

  function setupDigitalTurnover() {
    var btn = document.getElementById('btn-digital-turnover');
    var modal = document.getElementById('modal-digital-turnover');
    var closeBtn = document.getElementById('btn-digital-close');
    var fecharBtn = document.getElementById('btn-digital-fechar');

    if (btn) {
      btn.addEventListener('click', function () {
        if (!modal) return;
        renderDigitalTurnoverModal();
        modal.classList.add('open', 'active', 'show');
      });
    }

    [closeBtn, fecharBtn].forEach(function (el) {
      if (el) el.addEventListener('click', function () { if (modal) modal.classList.remove('open', 'active', 'show'); });
    });
  }

  function renderDigitalTurnoverModal() {
    var periodoEl = document.getElementById('digital-turnover-periodo');
    var tbody = document.querySelector('#tabela-digital-turnover tbody');
    var vazioEl = document.getElementById('digital-turnover-vazio');

    if (periodoEl) {
      periodoEl.textContent = 'Período: ' +
        (currentRange.inicio ? currentRange.inicio.split('-').reverse().join('/') : '—') +
        ' até ' +
        (currentRange.fim ? currentRange.fim.split('-').reverse().join('/') : '—');
    }

    if (!tbody) return;

    if (!cacheDesligamentos || !cacheDesligamentos.length) {
      tbody.innerHTML = '';
      if (vazioEl) vazioEl.style.display = 'block';
      return;
    }

    if (vazioEl) vazioEl.style.display = 'none';

    tbody.innerHTML = cacheDesligamentos.map(function (d) {
      var badgeClass = d.classificacao === 'Operacional' ? 'badge-danger' : 'badge-secondary';
      var dataFmt = d.data ? String(d.data).split('-').reverse().join('/') : '—';

      return '<tr>' +
        '<td><strong>' + (d.nome || '—') + '</strong></td>' +
        '<td>' + (d.funcao || '—') + '</td>' +
        '<td>' + dataFmt + '</td>' +
        '<td>' + (d.motivo || '—') + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + (d.classificacao || '—') + '</span></td>' +
      '</tr>';
    }).join('');
  }

  function setupExportPdf() {
    var btn = document.getElementById('btn-export-pdf');
    if (!btn) return;

    btn.addEventListener('click', function () {
      if (typeof html2pdf === 'undefined') {
        window.print();
        return;
      }
      var element = document.getElementById('rhub-main');
      if (!element) return;
      var opt = {
        margin: 5,
        filename: 'dashboard-rh-omega-251.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
      };

      // Expande a rolagem do calendário durante o snapshot do PDF
      var calGrid = document.getElementById('calendario');
      if (calGrid) calGrid.classList.add('cal-export');
      var restoreCal = function () {
        if (calGrid) calGrid.classList.remove('cal-export');
      };
      try {
        var task = html2pdf().set(opt).from(element).save();
        if (task && typeof task.then === 'function') {
          task.then(restoreCal).catch(restoreCal);
        } else {
          restoreCal();
        }
      } catch (e) {
        restoreCal();
        console.warn('Falha na exportação PDF:', e);
      }
    });
  }

  // Modal Ômega (setOmegaProgress/showOmegaSuccess/closeOmegaLoader) vive em
  // js/omega-loader.js — compartilhado com tratamento.html.

})();
