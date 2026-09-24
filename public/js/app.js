(function () {
  'use strict';

  const API_URL = '/api/upload';
  const MAX_VISIBLE_ROWS = 200;

  const CHART_COLORS = [
    '#2563eb', '#ef4444', '#f59e0b', '#22c55e', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
    '#d946ef', '#84cc16', '#0ea5e9', '#e11d48', '#a855f7'
  ];

  let chartInstances = {};
  let currentData = null;

  const form = document.getElementById('upload-form');
  const btnProcessar = document.getElementById('btn-processar');
  const btnLimpar = document.getElementById('btn-limpar');
  const uploadStatus = document.getElementById('upload-status');
  const uploadStatusText = document.getElementById('upload-status-text');
  const uploadError = document.getElementById('upload-error');
  const resultsSection = document.getElementById('results-section');
  const filtroTipo = document.getElementById('filtro-tipo');
  const btnExportarCsv = document.getElementById('btn-exportar-csv');

  form.addEventListener('submit', handleSubmit);
  btnLimpar.addEventListener('click', handleLimpar);
  filtroTipo.addEventListener('change', handleFiltroTipo);
  btnExportarCsv.addEventListener('click', handleExportarCsv);

  function handleSubmit(e) {
    e.preventDefault();

    const filePonto = document.getElementById('file_ponto').files[0];
    const fileDeslig = document.getElementById('file_deslig').files[0];

    if (!filePonto || !fileDeslig) {
      showError('Selecione ambos os arquivos antes de processar.');
      return;
    }

    hideError();
    setLoading(true);

    const formData = new FormData();
    formData.append('file_ponto', filePonto);
    formData.append('file_deslig', fileDeslig);

    fetch(API_URL, {
      method: 'POST',
      body: formData
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then(data => {
            throw new Error(data.error || `Erro HTTP ${response.status}`);
          });
        }
        return response.json();
      })
      .then(data => {
        if (!data.success) {
          throw new Error(data.error || 'Erro desconhecido no processamento.');
        }
        currentData = data;
        renderResults(data);
        resultsSection.style.display = 'block';
        resultsSection.classList.add('fade-in');
        btnLimpar.disabled = false;
        setLoading(false);
      })
      .catch(err => {
        showError(err.message || 'Erro ao comunicar com o servidor.');
        setLoading(false);
      });
  }

  function handleLimpar() {
    form.reset();
    resultsSection.style.display = 'none';
    hideError();
    setLoading(false);
    btnLimpar.disabled = true;
    currentData = null;
    destroyAllCharts();
    filtroTipo.innerHTML = '<option value="">Todos os tipos</option>';
  }

  function handleFiltroTipo() {
    if (!currentData) return;
    renderInconsistenciasTable(
      currentData.inconsistencias.registros,
      filtroTipo.value
    );
  }

  function handleExportarCsv() {
    if (!currentData || !currentData.inconsistencias.registros.length) return;

    const rows = currentData.inconsistencias.registros;
    const headers = ['Tipo', 'Linha', 'Funcionário', 'Departamento', 'Detalhe', 'Sugestão'];
    const csvContent = [
      '\uFEFF' + headers.join(';'),
      ...rows.map(r => [
        r.tipo,
        r.linha,
        `"${(r.funcionario || '').replace(/"/g, '""')}"`,
        `"${(r.departamento || '').replace(/"/g, '""')}"`,
        `"${(r.detalhe || '').replace(/"/g, '""')}"`,
        `"${(r.sugestao || '').replace(/"/g, '""')}"`
      ].join(';'))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `omega_inconsistencias_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function setLoading(loading) {
    btnProcessar.disabled = loading;
    uploadStatus.style.display = loading ? 'block' : 'none';
    uploadStatusText.textContent = loading ? 'Processando arquivos...' : '';
  }

  function showError(msg) {
    uploadError.textContent = msg;
    uploadError.style.display = 'block';
  }

  function hideError() {
    uploadError.style.display = 'none';
  }

  function renderResults(data) {
    renderKPIs(data.kpis);
    renderProcessamentoInfo(data.processamento);
    renderResumoInconsistencias(data.inconsistencias);
    renderInconsistenciasTable(data.inconsistencias.registros, '');
    renderCharts(data.graficos);
  }

  function renderKPIs(kpis) {
    const absEl = document.getElementById('kpi-absenteismo');
    const absDetail = document.getElementById('kpi-absenteismo-detail');
    absEl.textContent = kpis.absenteismo.percentual.toFixed(2) + '%';
    absDetail.textContent = `${kpis.absenteismo.totalFaltas} faltas de ${kpis.absenteismo.totalGeral} registros`;

    const aderEl = document.getElementById('kpi-aderencia');
    const aderDetail = document.getElementById('kpi-aderencia-detail');
    aderEl.textContent = kpis.aderencia.percentual.toFixed(2) + '%';
    aderDetail.textContent = `${kpis.aderencia.somaHorasTrabalhadas}h / ${kpis.aderencia.somaHorasPrevistas}h previstas`;

    const turnEl = document.getElementById('kpi-turnover');
    const turnDetail = document.getElementById('kpi-turnover-detail');
    turnEl.textContent = kpis.turnover.percentual.toFixed(2) + '%';
    turnDetail.textContent = `${kpis.turnover.desligamentosRelevantes} relevantes de ${kpis.turnover.efetivoTotal} efetivos`;
  }

  function renderProcessamentoInfo(proc) {
    document.getElementById('info-reg-ponto').textContent =
      proc.ponto.totalRegistros.toLocaleString('pt-BR');
    document.getElementById('info-func-unicos').textContent =
      proc.ponto.funcionariosUnicos.toLocaleString('pt-BR');
    document.getElementById('info-deptos').textContent =
      proc.ponto.departamentos.length;
    document.getElementById('info-deslig').textContent =
      proc.desligamentos.totalRegistros.toLocaleString('pt-BR');
    document.getElementById('info-periodo').textContent =
      `${proc.ponto.periodo.inicio} — ${proc.ponto.periodo.fim}`;
  }

  function renderResumoInconsistencias(incons) {
    document.getElementById('badge-inconsistencias').textContent = incons.total;

    const container = document.getElementById('resumo-inconsistencias');
    if (incons.porCategoria.length === 0) {
      container.innerHTML = '<div class="text-success"><i class="bi bi-check-circle me-1"></i>Nenhuma inconsistência encontrada.</div>';
      return;
    }

    const tipoLabels = {
      'STATUS_VAZIO': 'Status Vazio',
      'ERRO_DIGITACAO': 'Erro de Digitação',
      'SAIDA_2_AUSENTE': 'Saída 2 Ausente',
      'MATRICULA_VAZIA': 'Matrícula Vazia',
      'NOME_VAZIO_DESLIG': 'Nome Vazio',
      'MOTIVO_VAZIO': 'Motivo Vazio'
    };

    container.innerHTML = incons.porCategoria.map(c => `
      <div class="d-flex justify-content-between align-items-center py-1 border-bottom">
        <span class="inconsistencia-tipo tipo-${c.tipo.toLowerCase()}">${tipoLabels[c.tipo] || c.tipo}</span>
        <strong>${c.quantidade}</strong>
      </div>
    `).join('');
  }

  function renderInconsistenciasTable(registros, filtro) {
    const tbody = document.getElementById('tbody-inconsistencias');
    const footer = document.getElementById('footer-inconsistencias');

    const filtered = filtro
      ? registros.filter(r => r.tipo === filtro)
      : registros;

    const tipoLabels = {
      'STATUS_VAZIO': 'Status Vazio',
      'ERRO_DIGITACAO': 'Erro Digitação',
      'SAIDA_2_AUSENTE': 'Saída 2 Ausente',
      'MATRICULA_VAZIA': 'Matrícula Vazia',
      'NOME_VAZIO_DESLIG': 'Nome Vazio',
      'MOTIVO_VAZIO': 'Motivo Vazio'
    };

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7">
            <div class="empty-state">
              <i class="bi bi-check-circle"></i>
              <p>Nenhuma inconsistência encontrada.</p>
            </div>
          </td>
        </tr>`;
      footer.textContent = 'Nenhum registro';
      return;
    }

    const visible = filtered.slice(0, MAX_VISIBLE_ROWS);
    tbody.innerHTML = visible.map((r, i) => `
      <tr>
        <td class="text-muted">${i + 1}</td>
        <td><span class="inconsistencia-tipo tipo-${r.tipo.toLowerCase()}">${tipoLabels[r.tipo] || r.tipo}</span></td>
        <td>${r.linha}</td>
        <td>${escapeHtml(r.funcionario)}</td>
        <td>${escapeHtml(r.departamento)}</td>
        <td>${escapeHtml(r.detalhe)}</td>
        <td>${r.sugestao ? '<span class="text-success fw-semibold">' + escapeHtml(r.sugestao) + '</span>' : '—'}</td>
      </tr>
    `).join('');

    footer.textContent = `Exibindo ${Math.min(filtered.length, MAX_VISIBLE_ROWS)} de ${filtered.length} registros` +
      (filtro ? ' (filtrado)' : '');

    populateFiltroTipo(registros);
  }

  function populateFiltroTipo(registros) {
    const tipos = {};
    for (const r of registros) {
      tipos[r.tipo] = (tipos[r.tipo] || 0) + 1;
    }

    const tipoLabels = {
      'STATUS_VAZIO': 'Status Vazio',
      'ERRO_DIGITACAO': 'Erro de Digitação',
      'SAIDA_2_AUSENTE': 'Saída 2 Ausente',
      'MATRICULA_VAZIA': 'Matrícula Vazia',
      'NOME_VAZIO_DESLIG': 'Nome Vazio',
      'MOTIVO_VAZIO': 'Motivo Vazio'
    };

    const currentVal = filtroTipo.value;
    filtroTipo.innerHTML = '<option value="">Todos os tipos</option>';
    for (const [tipo, qty] of Object.entries(tipos).sort((a, b) => b[1] - a[1])) {
      const opt = document.createElement('option');
      opt.value = tipo;
      opt.textContent = `${tipoLabels[tipo] || tipo} (${qty})`;
      filtroTipo.appendChild(opt);
    }
    filtroTipo.value = currentVal;
  }

  function renderCharts(graficos) {
    destroyAllCharts();

    if (graficos.absenteismoPorStatus.length > 0) {
      const ctx1 = document.getElementById('chart-absenteismo-status').getContext('2d');
      chartInstances.absStatus = new Chart(ctx1, {
        type: 'doughnut',
        data: {
          labels: graficos.absenteismoPorStatus.map(d => d.label),
          datasets: [{
            data: graficos.absenteismoPorStatus.map(d => d.value),
            backgroundColor: CHART_COLORS.slice(0, graficos.absenteismoPorStatus.length),
            borderWidth: 2,
            borderColor: '#ffffff'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { padding: 12, font: { size: 11 } }
            }
          }
        }
      });
    }

    if (graficos.absenteismoPorDepartamento.length > 0) {
      const ctx2 = document.getElementById('chart-absenteismo-depto').getContext('2d');
      chartInstances.absDepto = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: graficos.absenteismoPorDepartamento.map(d => d.label),
          datasets: [{
            label: 'Absenteísmo %',
            data: graficos.absenteismoPorDepartamento.map(d => d.value),
            backgroundColor: graficos.absenteismoPorDepartamento.map((_, i) =>
              CHART_COLORS[i % CHART_COLORS.length] + 'cc'
            ),
            borderColor: graficos.absenteismoPorDepartamento.map((_, i) =>
              CHART_COLORS[i % CHART_COLORS.length]
            ),
            borderWidth: 1,
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              beginAtZero: true,
              ticks: {
                callback: function (val) { return val + '%'; },
                font: { size: 11 }
              },
              grid: { color: '#f1f5f9' }
            },
            y: {
              ticks: { font: { size: 11 } },
              grid: { display: false }
            }
          }
        }
      });
    }

    if (graficos.turnoverPorMotivo.length > 0) {
      const ctx3 = document.getElementById('chart-turnover-motivo').getContext('2d');
      chartInstances.turnMotivo = new Chart(ctx3, {
        type: 'pie',
        data: {
          labels: graficos.turnoverPorMotivo.map(d => d.label),
          datasets: [{
            data: graficos.turnoverPorMotivo.map(d => d.value),
            backgroundColor: CHART_COLORS.slice(0, graficos.turnoverPorMotivo.length),
            borderWidth: 2,
            borderColor: '#ffffff'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                padding: 12,
                font: { size: 11 },
                generateLabels: function (chart) {
                  const data = chart.data;
                  if (data.labels.length && data.datasets.length) {
                    return data.labels.map(function (label, i) {
                      const truncated = label.length > 20 ? label.substring(0, 20) + '...' : label;
                      return {
                        text: truncated,
                        fillStyle: data.datasets[0].backgroundColor[i],
                        hidden: false,
                        index: i
                      };
                    });
                  }
                  return [];
                }
              }
            }
          }
        }
      });
    }
  }

  function destroyAllCharts() {
    for (const key of Object.keys(chartInstances)) {
      if (chartInstances[key]) {
        chartInstances[key].destroy();
      }
    }
    chartInstances = {};
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
