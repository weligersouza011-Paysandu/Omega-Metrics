(function () {
  'use strict';

  // Base dinâmica da API: local vazio; hospedado (Render/GH Pages) aponta ao backend
  var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? ''
    : 'https://seu-backend.onrender.com';

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
  var mapPorDia = {};
  var calState = { ano: null, mes: null, anual: false };

  var dayFilter = null;
  var periodBeforeDayFilter = null;
  var suppressSliderChange = false;

  var funcaoExpanded = false;
  var lastFuncaoData = null;

  var lastRankingRows = [];
  var cacheDesligamentos = [];
  var localStorageRecords = null;

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

  function getContainerCanvas(containerId, canvasId) {
    var container = document.getElementById(containerId);
    if (!container) return null;
    destroyChart(containerId);
    container.innerHTML = '<canvas id="' + canvasId + '"></canvas>';
    return document.getElementById(canvasId);
  }

  function placeholderVazio() {
    return '<div class="text-muted small text-center p-3" style="margin:auto;">Sem dados suficientes para este indicador.</div>';
  }

  function pctBr(v) {
    return (Number(v) || 0).toFixed(2).replace('.', ',') + '%';
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

  function fetchDashboardData() {
    if (!currentRange.inicio || !currentRange.fim) {
      tryLocalStorageFallback();
      return;
    }
    showLoading();

    var url = API_URL + '/api/dashboard/kpis?dataInicio=' + currentRange.inicio + '&dataFim=' + currentRange.fim;
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success || data.semDados) {
          tryLocalStorageFallback();
          return;
        }
        showGrid();
        renderDashboard(data);
      })
      .catch(function (err) {
        console.warn('Erro ao buscar KPIs do servidor, acionando fallback LocalStorage:', err);
        tryLocalStorageFallback();
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

    var statusFaltas = ["FALTA", "ATESTADO MÉDICO", "ATESTADO DE ÓBITO", "DECLARAÇÃO", "BO", "ÓBITO", "LICENÇA CASAMENTO", "LICENÇA PATERNIDADE"];
    var statusPresenca = ["PRESENTE", "ADVERTÊNCIA"];

    var totalFaltas = 0;
    var totalPresencas = 0;
    var statusCounts = {};
    var diaMap = {};
    var funcMap = {};
    var mesMap = {};
    var funcaoMap = {};
    var funcsUnicos = new Set();
    var desligamentos = [];

    records.forEach(function (r) {
      var st = (r.status || '').toUpperCase().trim();
      var fName = r.funcionario || r.nome || r.nomeFuncionario || 'Não Identificado';
      var funcCargo = r.funcao || r.cargo || r.nomeCargo || 'Não Definido';
      var d = r.dia;
      var mesKey = d ? d.substring(0, 7) : 'Geral';

      funcsUnicos.add(fName);

      if (st) statusCounts[st] = (statusCounts[st] || 0) + 1;

      var isFalta = statusFaltas.indexOf(st) !== -1;
      var isPresenca = statusPresenca.indexOf(st) !== -1 || (!st && r.entrada1);

      if (isFalta || isPresenca) {
        if (!diaMap[d]) diaMap[d] = { data: d, faltas: 0, previstos: 0, percentual: 0 };
        diaMap[d].previstos++;
        if (isFalta) {
          diaMap[d].faltas++;
          totalFaltas++;
        } else {
          totalPresencas++;
        }

        if (!funcMap[fName]) funcMap[fName] = { nome: fName, faltas: 0, previstos: 0, percentual: 0 };
        funcMap[fName].previstos++;
        if (isFalta) funcMap[fName].faltas++;

        if (!mesMap[mesKey]) mesMap[mesKey] = { label: mesKey, faltas: 0, previstos: 0, value: 0 };
        mesMap[mesKey].previstos++;
        if (isFalta) mesMap[mesKey].faltas++;

        if (!funcaoMap[funcCargo]) funcaoMap[funcCargo] = { label: funcCargo, faltas: 0, previstos: 0, value: 0 };
        funcaoMap[funcCargo].previstos++;
        if (isFalta) funcaoMap[funcCargo].faltas++;
      }

      if (st === 'DEMITIDO' || st.indexOf('DEMISS') !== -1 || st.indexOf('DESLIG') !== -1) {
        desligamentos.push({
          nome: fName,
          funcao: funcCargo,
          data: d,
          motivo: r.cid || st,
          classificacao: 'Operacional'
        });
      }
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

    var efetivo = funcsUnicos.size || 1;
    var turnGeralPct = (desligamentos.length / efetivo) * 100;

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
        turnoverMensal: mesArr.map(function (m) {
          return {
            label: m.label,
            efetivoAtivo: efetivo,
            desligadosGeral: desligamentos.length,
            operacional: Number(turnGeralPct.toFixed(2)),
            operacionais: desligamentos.length,
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

    if (rangeInicio) flatpickr('#range-inicio', Object.assign({}, config, { defaultDate: periodoMin }));
    if (rangeFim) flatpickr('#range-fim', Object.assign({}, config, { defaultDate: periodoMax }));
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
    debounceTimer = setTimeout(fetchDashboardData, 300);
  }

  /* ============================================================
     4. RENDERIZADOR PRINCIPAL DO DASHBOARD
     ============================================================ */

  function renderDashboard(data) {
    if (!data) return;
    var k = data.kpis || {};
    var g = data.graficos || {};

    // 1. Resumo Geral de Absenteísmo (Velocímetro + Rosca)
    renderGauge(k.absenteismo ? k.absenteismo.percentual : 0);
    renderMotivos(g.absenteismoPorStatus || []);

    // 2. Calendário de Absenteísmo
    mapPorDia = {};
    (g.absenteismoPorDia || []).forEach(function (d) { mapPorDia[d.data] = d; });
    renderCalendario();

    // 3. Linha Inferior de Absenteísmo
    renderRanking(g.absenteismoPorFuncionario || []);
    renderAbsenteismoMes(g.absenteismoPorMes || []);
    renderAbsenteismoFuncao(g.absenteismoPorFuncao || []);

    // 4. Turnover KPIs & 4 Gráficos Dedicados de Headcount/Turnover
    cacheDesligamentos = g.desligamentosDetalhe || [];
    renderTurnoverKpis(k.turnover || {}, data.efetivoTotal || 0);

    renderHeadcountMovimentacao(g.turnoverMensal || [], data.efetivoTotal || 0);
    renderTurnoverOperacional(g.turnoverMensal || [], k.turnover || {});
    renderRazaoReposicao(g.turnoverMensal || []);
    renderComposicaoDesligamentos(g.turnoverMensal || []);
  }

  /* ============================================================
     5. CARDS DE ABSENTEÍSMO
     ============================================================ */

  // BLOCO 1: VELOCÍMETRO (SPEEDOMETER GAUGE)
  function renderGauge(val) {
    var canvas = getContainerCanvas('gauge-container', 'gauge-absenteismo');
    if (!canvas || typeof Chart === 'undefined') return;

    var numVal = Number(val) || 0;
    var resto = Math.max(0, GAUGE_MAX - numVal);
    var corPonteiro = numVal > LIMITE_ALERTA ? CORES.vermelho : (numVal > META_ABSENTEISMO ? CORES.ambar : CORES.verde);

    chartInstances['gauge-container'] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [numVal, resto],
          backgroundColor: [corPonteiro, CORES.pista],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        rotation: 270,
        circumference: 180,
        cutout: '75%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        }
      },
      plugins: [{
        id: 'gaugeText',
        afterDraw: function (chart) {
          var ctx = chart.ctx;
          var width = chart.width;
          var height = chart.height;

          ctx.save();
          ctx.font = '800 1.5rem Inter, sans-serif';
          ctx.fillStyle = corPonteiro;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pctBr(numVal), width / 2, height / 1.4);

          ctx.font = '600 0.72rem Inter, sans-serif';
          ctx.fillStyle = '#64748b';
          ctx.fillText('Média Geral', width / 2, height / 1.18);
          ctx.restore();
        }
      }]
    });
  }

  // BLOCO 2: ROSCA DE JUSTIFICATIVAS (AMPLIADA)
  function renderMotivos(rows) {
    var container = document.getElementById('chart-motivos');
    if (!container) return;
    var canvas = getContainerCanvas('chart-motivos', 'canvas-motivos');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!rows || !rows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var paletaMotivos = [CORES.vinho, CORES.vermelho, CORES.ambar, CORES.verde, CORES.roxo, CORES.azul, CORES.cinza];

    chartInstances['chart-motivos'] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: rows.map(function (d) { return d.label; }),
        datasets: [{
          data: rows.map(function (d) { return d.value; }),
          backgroundColor: paletaMotivos.slice(0, rows.length),
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
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
          }
        }
      }
    });
  }

  // CALENDÁRIO DE ABSENTEÍSMO (GRID 4 MESES SEM CORTAR SÁBADO)
  function renderCalendario() {
    var container = document.getElementById('calendario');
    if (!container) return;

    var datas = Array.from(datasDisponiveis).sort();
    if (!datas.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var minDate = new Date(datas[0]);

    if (!calState.ano || isNaN(calState.ano)) {
      calState.ano = minDate.getFullYear();
      calState.mes = minDate.getMonth();
    }

    container.innerHTML = '';

    for (var i = 0; i < 4; i++) {
      var d = new Date(calState.ano, calState.mes + i, 1);
      container.appendChild(buildMonthTable(d.getFullYear(), d.getMonth()));
    }
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
      var reg = mapPorDia[iso];

      var dayBox = document.createElement('div');
      dayBox.className = 'cal-day';
      dayBox.textContent = dia;

      if (reg && reg.previstos > 0) {
        dayBox.classList.add('cal-day--has-data');
        var pct = reg.percentual;
        if (pct <= META_ABSENTEISMO) dayBox.classList.add('cal-day--verde');
        else if (pct <= LIMITE_ALERTA) dayBox.classList.add('cal-day--amarelo');
        else dayBox.classList.add('cal-day--vermelho');

        dayBox.dataset.iso = iso;
        dayBox.title = 'Data: ' + iso + ' | Absenteísmo: ' + pctBr(pct) + ' (' + reg.faltas + '/' + reg.previstos + ')';
      } else {
        dayBox.classList.add('cal-day--neutro');
      }

      if (dayFilter === iso) {
        dayBox.classList.add('cal-day--selected');
      }

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
        calState.mes -= 4;
        if (calState.mes < 0) {
          calState.mes += 12;
          calState.ano -= 1;
        }
        renderCalendario();
      });
    }
    if (next) {
      next.addEventListener('click', function () {
        calState.mes += 4;
        if (calState.mes >= 12) {
          calState.mes -= 12;
          calState.ano += 1;
        }
        renderCalendario();
      });
    }
    if (ano) {
      ano.addEventListener('click', function () {
        calState.ano = new Date(periodoMin || Date.now()).getFullYear();
        calState.mes = 0;
        renderCalendario();
      });
    }
  }

  function setupCalendarioClick() {
    var container = document.getElementById('calendario');
    if (!container) return;

    container.addEventListener('click', function (e) {
      var target = e.target.closest('.cal-day--has-data');
      if (!target) return;

      var iso = target.dataset.iso;
      if (!iso) return;

      if (dayFilter === iso) {
        clearDayFilter();
      } else {
        applyDayFilter(iso);
      }
    });
  }

  function applyDayFilter(iso) {
    dayFilter = iso;
    periodBeforeDayFilter = { inicio: currentRange.inicio, fim: currentRange.fim };
    currentRange.inicio = iso;
    currentRange.fim = iso;

    var chip = document.getElementById('day-filter-chip');
    if (chip) {
      chip.style.display = 'inline-flex';
      var txt = chip.querySelector('.day-chip__text');
      if (txt) txt.textContent = iso.split('-').reverse().join('/');
    }

    // Sempre busca do servidor; LocalStorage permanece apenas como
    // fallback dentro de fetchDashboardData() (erro/vazio real).
    fetchDashboardData();
  }

  function clearDayFilter() {
    if (!dayFilter) return;
    dayFilter = null;
    if (periodBeforeDayFilter) {
      currentRange.inicio = periodBeforeDayFilter.inicio;
      currentRange.fim = periodBeforeDayFilter.fim;
    }
    var chip = document.getElementById('day-filter-chip');
    if (chip) chip.style.display = 'none';

    updateSliderFromInputs();

    fetchDashboardData();
  }

  function setupDayChip() {
    var btn = document.getElementById('day-chip-clear');
    if (btn) btn.addEventListener('click', clearDayFilter);
  }

  // RANKING DE COLABORADORES
  function renderRanking(rows) {
    lastRankingRows = rows || [];
    var container = document.getElementById('lista-colaboradores');
    if (!container) return;

    if (!rows || !rows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var top10 = rows.slice(0, TOP_RANKING);
    var html = '<div class="ranking-list">';
    top10.forEach(function (item, idx) {
      html +=
        '<div class="ranking-item">' +
          '<span class="ranking-item__pos">#' + (idx + 1) + '</span>' +
          '<span class="ranking-item__name" title="' + item.nome + '">' + item.nome + '</span>' +
          '<span class="ranking-item__val">' + pctBr(item.percentual) + ' (' + item.faltas + 'f)</span>' +
        '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
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
  function renderAbsenteismoMes(rows) {
    var container = document.getElementById('chart-mes');
    if (!container) return;
    var canvas = getContainerCanvas('chart-mes', 'canvas-mes');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!rows || !rows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    chartInstances['chart-mes'] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(function (d) { return d.label; }),
        datasets: [{
          label: '% Absenteísmo',
          data: rows.map(function (d) { return d.value; }),
          backgroundColor: CORES.vinho,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) { return ' % Absenteísmo: ' + pctBr(c.parsed.y); }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: function (v) { return v + '%'; } }
          }
        }
      }
    });
  }

  // ABSENTEÍSMO FUNÇÃO
  function renderAbsenteismoFuncao(rows) {
    lastFuncaoData = rows || [];
    var container = document.getElementById('chart-funcao');
    if (!container) return;
    var canvas = getContainerCanvas('chart-funcao', 'canvas-funcao');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!rows || !rows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var displayRows = funcaoExpanded ? rows : rows.slice(0, 10);

    chartInstances['chart-funcao'] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: displayRows.map(function (d) { return d.label; }),
        datasets: [{
          label: '% Absenteísmo',
          data: displayRows.map(function (d) { return d.value; }),
          backgroundColor: CORES.vermelho,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) { return ' % Absenteísmo: ' + pctBr(c.parsed.x); }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
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

    el.innerHTML =
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
  }

  // GRÁFICO 1: HEADCOUNT & MOVIMENTAÇÃO
  function renderHeadcountMovimentacao(turnoverMesRows, capacityTotal) {
    var container = document.getElementById('chart-headcount-movimentacao');
    if (!container) return;
    var canvas = getContainerCanvas('chart-headcount-movimentacao', 'canvas-headcount-movimentacao');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var labels = turnoverMesRows.map(function (d) { return d.label; });
    var demitidos = turnoverMesRows.map(function (d) { return d.desligadosGeral; });

    var admitidos = [];
    for (var i = 0; i < turnoverMesRows.length; i++) {
      var efAtual = turnoverMesRows[i].efetivoAtivo || 0;
      var efAnterior = i > 0 ? (turnoverMesRows[i - 1].efetivoAtivo || efAtual) : efAtual;
      var delta = efAtual - efAnterior;
      var adm = Math.max(0, delta + demitidos[i]);
      admitidos.push(adm);
    }

    var capacityLine = labels.map(function () { return capacityTotal || 0; });

    chartInstances['chart-headcount-movimentacao'] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Admitidos',
            data: admitidos,
            backgroundColor: CORES.verde,
            borderRadius: 4
          },
          {
            type: 'bar',
            label: 'Demitidos Total',
            data: demitidos,
            backgroundColor: CORES.vermelho,
            borderRadius: 4
          },
          {
            type: 'line',
            label: 'Efetivo Máximo (Capacity)',
            data: capacityLine,
            borderColor: CORES.azul,
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 3,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  // GRÁFICO 2: TAXA DE TURNOVER OPERACIONAL ISOLADO (%)
  function renderTurnoverOperacional(turnoverMesRows, turnoverKpi) {
    var container = document.getElementById('chart-turnover-operacional');
    if (!container) return;
    var canvas = getContainerCanvas('chart-turnover-operacional', 'canvas-turnover-operacional');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var labels = turnoverMesRows.map(function (d) { return d.label; });
    var operData = turnoverMesRows.map(function (d) { return d.operacional; });
    var metaLine = labels.map(function () { return META_TURNOVER_OPERACIONAL; });

    chartInstances['chart-turnover-operacional'] = new Chart(canvas, {
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
            pointBackgroundColor: CORES.vinho
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
            ticks: { callback: function (v) { return v + '%'; } }
          }
        }
      }
    });
  }

  // GRÁFICO 3: RAZÃO DE REPOSIÇÃO (DONUT)
  function renderRazaoReposicao(turnoverMesRows) {
    var container = document.getElementById('chart-razao-reposicao');
    if (!container) return;
    var canvas = getContainerCanvas('chart-razao-reposicao', 'canvas-razao-reposicao');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var totalDesligOperacionais = turnoverMesRows.reduce(function (s, r) { return s + (r.operacionais || 0); }, 0);

    var totalAdmissoes = 0;
    for (var i = 0; i < turnoverMesRows.length; i++) {
      var efAtual = turnoverMesRows[i].efetivoAtivo || 0;
      var efAnterior = i > 0 ? (turnoverMesRows[i - 1].efetivoAtivo || efAtual) : efAtual;
      var delta = efAtual - efAnterior;
      var adm = Math.max(0, delta + (turnoverMesRows[i].desligadosGeral || 0));
      totalAdmissoes += adm;
    }

    var substituicao = Math.min(totalAdmissoes, totalDesligOperacionais);
    var expansao = Math.max(0, totalAdmissoes - substituicao);

    chartInstances['chart-razao-reposicao'] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['% Substituição de Turnover', '% Expansão de Quadro'],
        datasets: [{
          data: [substituicao, expansao],
          backgroundColor: [CORES.roxo, CORES.verde],
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var total = substituicao + expansao;
                var pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) + '%' : '0%';
                return ' ' + ctx.label + ': ' + ctx.raw + ' colab. (' + pct + ')';
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
    var canvas = getContainerCanvas('chart-composicao-desligamentos', 'canvas-composicao-desligamentos');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!turnoverMesRows || !turnoverMesRows.length) {
      container.innerHTML = placeholderVazio();
      return;
    }

    var labels = turnoverMesRows.map(function (d) { return d.label; });
    var operacionais = turnoverMesRows.map(function (d) { return d.operacionais || 0; });
    var reducao = turnoverMesRows.map(function (d) { return d.reducao || 0; });

    chartInstances['chart-composicao-desligamentos'] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Turnover Operacional',
            data: operacionais,
            backgroundColor: CORES.vinho,
            stack: 'desligamentos'
          },
          {
            label: 'Redução de Efetivo (Contratual)',
            data: reducao,
            backgroundColor: CORES.cinza,
            borderRadius: { topLeft: 4, topRight: 4 },
            stack: 'desligamentos'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
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
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
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

      html2pdf().set(opt).from(element).save();
    });
  }

})();
