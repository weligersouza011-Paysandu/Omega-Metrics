(function () {
  'use strict';

  // Base dinâmica da API: local vazio; hospedado (Render/GH Pages) aponta ao backend
  var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? ''
    : 'https://omega-metrics1.onrender.com';

  var selectedDate = null;
  var lastCounts = null;

  var drawer = document.getElementById('menu-drawer');
  var loadingEl = document.getElementById('status-loading');
  var loadingText = document.getElementById('status-loading-text');
  var errorEl = document.getElementById('status-error');
  var dateInput = document.getElementById('data-selecao');
  var dateFinalInput = document.getElementById('data-final');
  var painel = document.getElementById('painel-contagem');
  var modal = document.getElementById('modal-confirmar-exclusao');
  var modalCorrigir = document.getElementById('modal-corrigir-registro');
  var confirmInput = document.getElementById('confirmacao-texto');
  var btnConfirmDelete = document.getElementById('btn-confirmar-exclusao');

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    init();
  }

  var initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;

    renderDataPorExtenso();
    setupDrawer();
    initFlatpickr();
    setupActions();
    setupModal();
    setupDetalhes();
    setupModalCorrigir();

    if (dateInput && dateInput.value) {
      selectedDate = dateInput.value;
      checar();
    }
  }

  /* ============================================================
     1. ESTRUTURA / NAVEGAÇÃO
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

  function initFlatpickr() {
    if (typeof flatpickr === 'undefined') return;
    if (dateInput) {
      flatpickr(dateInput, {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd/m/Y',
        locale: 'pt',
        onChange: function (selectedDates, dateStr) {
          selectedDate = dateStr || null;
          resetPainel();
        }
      });
      var hoje = new Date().toISOString().slice(0, 10);
      if (dateInput._flatpickr) dateInput._flatpickr.setDate(hoje, false);
      selectedDate = hoje;
    }
    if (dateFinalInput) {
      flatpickr(dateFinalInput, {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd/m/Y',
        locale: 'pt',
        onChange: function () {
          resetPainel();
        }
      });
    }
  }

  /* ============================================================
     2. AÇÕES (CHECAR / DOWNLOAD / EXCLUIR)
     ============================================================ */

  function setupActions() {
    var btnChecar = document.getElementById('btn-checar');
    var btnDownload = document.getElementById('btn-download');
    var btnExcluir = document.getElementById('btn-excluir');

    if (btnChecar) btnChecar.addEventListener('click', checar);
    if (btnDownload) btnDownload.addEventListener('click', download);
    if (btnExcluir) btnExcluir.addEventListener('click', abrirModal);

    if (dateInput) {
      dateInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') checar();
      });
    }
  }

  function getDate() {
    if (dateInput && dateInput._flatpickr && dateInput._flatpickr.selectedDates.length) {
      return dateInput._flatpickr.formatDate(dateInput._flatpickr.selectedDates[0], 'Y-m-d');
    }
    return selectedDate;
  }

  function getDateFim() {
    if (dateFinalInput && dateFinalInput._flatpickr && dateFinalInput._flatpickr.selectedDates.length) {
      return dateFinalInput._flatpickr.formatDate(dateFinalInput._flatpickr.selectedDates[0], 'Y-m-d');
    }
    return null;
  }

  function resetPainel() {
    lastCounts = null;
    if (painel) painel.style.display = 'none';
    hideError();
  }

  function checar() {
    var data = getDate();
    var dataFim = getDateFim();
    if (!data) {
      showError('Selecione uma data válida.');
      return;
    }
    hideError();
    setLoading(true, dataFim ? 'Consultando registros do período...' : 'Consultando registros do dia...');

    var url = API_URL + '/api/dados/checar?data=' + encodeURIComponent(data);
    if (dataFim) url += '&dataFim=' + encodeURIComponent(dataFim);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (json) {
        setLoading(false);
        if (!json.success) {
          showError(json.error || 'Erro ao consultar os dados.');
          return;
        }
        lastCounts = json;
        renderContagem(json);
      })
      .catch(function (err) {
        setLoading(false);
        showError('Falha de comunicação com o servidor: ' + err.message);
      });
  }

  function renderContagem(json) {
    document.getElementById('count-ponto').textContent = json.ponto;
    document.getElementById('count-desligamentos').textContent = json.desligamentos;
    document.getElementById('count-funcionarios').textContent = json.funcionarios;

    var vazio = json.total === 0;
    var alertaVazio = document.getElementById('alerta-vazio');
    if (alertaVazio) alertaVazio.style.display = vazio ? 'block' : 'none';

    var dataFim = getDateFim();
    document.getElementById('btn-download').disabled = vazio;
    document.getElementById('btn-excluir').disabled = vazio || !!dataFim;
    renderTabelaDetalhes(json.registros, json.registrosDesligamentos);
    painel.style.display = 'block';
  }

  function download() {
    var data = getDate();
    var dataFim = getDateFim();
    if (!data || !lastCounts || lastCounts.total === 0) return;
    var url = API_URL + '/api/dados/download?data=' + encodeURIComponent(data);
    if (dataFim) url += '&dataFim=' + encodeURIComponent(dataFim);
    window.location.href = url;
  }

  var currentRegistros = [];
  var STATUS_OPTIONS = [
    'Presença / Trabalhado',
    'Falta Não Justificada',
    'Atestado Médico',
    'Declaração',
    'INSS',
    'Férias',
    'Licença Maternidade',
    'Desligado / Demitido'
  ];

  function setupDetalhes() {
    var btnSalvar = document.getElementById('btn-salvar-alteracoes');
    if (btnSalvar) {
      btnSalvar.addEventListener('click', salvarAlteracoes);
    }
  }

  function classifyRecord(r, desligamentos) {
    var isDemitido = false;
    if (desligamentos && Array.isArray(desligamentos)) {
      isDemitido = desligamentos.some(function (d) {
        return d.chave_funcionario === r.chave_funcionario;
      });
    }

    var st = (r.status || '').trim().toUpperCase();
    var demitido = isDemitido || st.includes('DESLIGADO') || st.includes('DEMITIDO') || st.includes('RESCIS') || st.includes('DISPENSA');
    var admitido = st.includes('ADMITIDO') || st.includes('CONTRATADO') || st.includes('ADMISS');
    var afastado = st.includes('INSS') || st.includes('LICEN') || st.includes('AFAST') || st.includes('FÉRIAS') || st.includes('FERIAS') || st.includes('ACIDENTE');
    var falta = st.includes('FALTA') || st.includes('ATESTADO') || st.includes('DECLARA') || st.includes('SUSPENS') || st.includes('ATRASO');
    var presente = !demitido && !admitido && !afastado && !falta;

    return {
      id: r.id,
      data: r.data_registro,
      matricula: r.chave_funcionario || '',
      nome: r.nome_funcionario || '',
      status: r.status || '',
      originalStatus: r.status || '',
      justificativa: r.cid || r.observacao || '',
      originalJustificativa: r.cid || r.observacao || '',
      isDemitido: demitido,
      isAdmitido: admitido,
      isAfastado: afastado,
      isFalta: falta,
      isPresente: presente
    };
  }

  function recomputeFlags(r) {
    var st = (r.status || '').trim().toUpperCase();
    r.isDemitido = st.includes('DESLIGADO') || st.includes('DEMITIDO') || st.includes('RESCIS') || st.includes('DISPENSA');
    r.isAdmitido = st.includes('ADMITIDO') || st.includes('CONTRATADO') || st.includes('ADMISS');
    r.isAfastado = st.includes('INSS') || st.includes('LICEN') || st.includes('AFAST') || st.includes('FÉRIAS') || st.includes('FERIAS') || st.includes('ACIDENTE');
    r.isFalta = st.includes('FALTA') || st.includes('ATESTADO') || st.includes('DECLARA') || st.includes('SUSPENS') || st.includes('ATRASO');
    r.isPresente = !r.isDemitido && !r.isAdmitido && !r.isAfastado && !r.isFalta;
  }

  function renderTabelaDetalhes(ponto, desligamentos) {
    currentRegistros = (ponto || []).map(function (r) {
      return classifyRecord(r, desligamentos);
    });

    var painelDetalhes = document.getElementById('painel-detalhes');
    if (painelDetalhes) {
      painelDetalhes.style.display = currentRegistros.length ? 'block' : 'none';
    }

    renderTodosQuadros();
    checkChanges();
  }

  function renderTodosQuadros() {
    var admitidosList = currentRegistros.filter(function (r) { return r.isAdmitido; });
    var demitidosList = currentRegistros.filter(function (r) { return r.isDemitido && !r.isAdmitido; });
    var afastamentosList = currentRegistros.filter(function (r) { return !r.isDemitido && !r.isAdmitido && (r.isAfastado || r.isFalta); });
    var presentesList = currentRegistros.filter(function (r) { return !r.isDemitido && !r.isAdmitido && !r.isAfastado && !r.isFalta; });

    // Atualiza badges de contagem
    var bAdmitidos = document.getElementById('badge-count-admitidos');
    var bDemitidos = document.getElementById('badge-count-demitidos');
    var bAfastamentos = document.getElementById('badge-count-afastamentos');
    var bPresentes = document.getElementById('badge-count-presentes');

    if (bAdmitidos) bAdmitidos.textContent = admitidosList.length + ' admitido(s)';
    if (bDemitidos) bDemitidos.textContent = demitidosList.length + ' desligado(s)';
    if (bAfastamentos) bAfastamentos.textContent = afastamentosList.length + ' ocorrência(s)';
    if (bPresentes) bPresentes.textContent = presentesList.length + ' presente(s)';

    // Renderiza cada tbody
    renderTbody('tbody-admitidos', admitidosList, 'Nenhum admitido registrado para esta data.');
    renderTbody('tbody-demitidos', demitidosList, 'Nenhum colaborador desligado/demitido registrado.');
    renderTbody('tbody-afastamentos', afastamentosList, 'Nenhum afastamento ou ocorrência registrado.');
    renderTbody('tbody-presentes', presentesList, 'Nenhum colaborador presente registrado.');

    bindQuadrosEvents();
  }

  function renderTbody(tbodyId, list, emptyMsg) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted" style="padding: 1.25rem 1rem; text-align: center;"><i class="bi bi-info-circle"></i> ' + esc(emptyMsg) + '</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(function (r) {
      var trCls = [];
      if (r.isDemitido) trCls.push('row-demitido');
      else if (r.isAdmitido) trCls.push('row-admitido');

      var isModified = (r.status !== r.originalStatus || r.justificativa !== r.originalJustificativa);
      if (isModified) trCls.push('row-corrigida');

      var matriculaHtml = r.matricula;
      if (r.matricula.indexOf('MAT_') === 0) matriculaHtml = r.matricula.replace('MAT_', '');
      if (r.matricula.indexOf('NOM_') === 0) matriculaHtml = '—';

      var badgeTag = '';
      if (r.isDemitido) {
        badgeTag = ' <span class="badge badge-demitido">🚨 DESLIGADO</span>';
      } else if (r.isAdmitido) {
        badgeTag = ' <span class="badge badge-admitido">✨ ADMITIDO</span>';
      }

      var dataFmt = formatBR(r.data);

      return '<tr class="' + trCls.join(' ') + '" data-id="' + r.id + '">' +
        '<td><span style="font-weight:600; color:var(--gray-700);">' + dataFmt + '</span></td>' +
        '<td><code>' + esc(matriculaHtml) + '</code>' + badgeTag + '</td>' +
        '<td><strong>' + esc(r.nome) + '</strong></td>' +
        '<td>' + statusBadgeHtml(r) + '</td>' +
        '<td class="text-center">' +
          '<button type="button" class="btn btn-sm btn-primary btn-corrigir-registro" data-id="' + r.id + '" title="Corrigir registro">📝 Corrigir</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function statusBadgeHtml(r) {
    var cls = 'badge-success';
    if (r.isDemitido) cls = 'badge-demitido';
    else if (r.isAdmitido) cls = 'badge-admitido';
    else if (r.isAfastado) cls = 'badge-warning';
    else if (r.isFalta) cls = 'badge-danger';

    return '<span class="badge ' + cls + '">' + esc(r.status || '—') + '</span>';
  }

  function quadroAtual(r) {
    if (r.isDemitido) return 'Desligados / Demitidos';
    if (r.isAdmitido) return 'Admitidos';
    if (r.isAfastado || r.isFalta) return 'Afastamentos / Ocorrências';
    return 'Presentes';
  }

  function bindQuadrosEvents() {
    var painelDetalhes = document.getElementById('painel-detalhes');
    if (!painelDetalhes) return;

    var botoes = painelDetalhes.querySelectorAll('.btn-corrigir-registro');
    botoes.forEach(function (btn) {
      btn.onclick = function (e) {
        var id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        abrirModalCorrigir(id);
      };
    });
  }

  var registroEditandoId = null;

  function setupModalCorrigir() {
    var btnFechar = document.getElementById('btn-corrigir-close');
    var btnCancelar = document.getElementById('btn-corrigir-cancelar');
    var btnSalvar = document.getElementById('btn-corrigir-salvar');

    if (btnFechar) btnFechar.addEventListener('click', fecharModalCorrigir);
    if (btnCancelar) btnCancelar.addEventListener('click', fecharModalCorrigir);
    if (btnSalvar) btnSalvar.addEventListener('click', salvarCorrigirRegistro);

    if (modalCorrigir) {
      modalCorrigir.addEventListener('click', function (e) {
        if (e.target === modalCorrigir) fecharModalCorrigir();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalCorrigir && modalCorrigir.classList.contains('open')) {
        fecharModalCorrigir();
      }
    });
  }

  function abrirModalCorrigir(id) {
    var reg = currentRegistros.find(function (x) { return x.id === id; });
    if (!reg || !modalCorrigir) return;

    registroEditandoId = reg.id;

    var matriculaTxt = reg.matricula || '—';
    if (matriculaTxt.indexOf('MAT_') === 0) matriculaTxt = matriculaTxt.replace('MAT_', '');
    if (reg.matricula && reg.matricula.indexOf('NOM_') === 0) matriculaTxt = '—';

    var elNome = document.getElementById('corrigir-nome');
    var elMatData = document.getElementById('corrigir-matricula-data');
    var elStatusAtual = document.getElementById('corrigir-status-atual');

    if (elNome) elNome.textContent = reg.nome || '—';
    if (elMatData) elMatData.textContent = 'Matrícula: ' + matriculaTxt + '  •  Data: ' + formatBR(reg.data);

    if (elStatusAtual) {
      elStatusAtual.innerHTML =
        '<span class="badge badge-gray">Status: ' + esc(reg.originalStatus || '—') + '</span>' +
        '<span class="badge badge-info">Quadro: ' + esc(quadroAtual(reg)) + '</span>' +
        '<span class="badge badge-gray">Obs.: ' + esc(reg.originalJustificativa || '—') + '</span>';
    }

    var sel = document.getElementById('modal-status-select');
    if (sel) {
      var existe = Array.prototype.some.call(sel.options, function (o) { return o.value === reg.status; });
      if (!existe && reg.status) {
        var opt = document.createElement('option');
        opt.value = reg.status;
        opt.textContent = reg.status;
        sel.appendChild(opt);
      }
      sel.value = reg.status;
    }

    var obs = document.getElementById('modal-observacao-input');
    if (obs) obs.value = reg.justificativa || '';

    modalCorrigir.classList.add('open', 'active', 'show');
    modalCorrigir.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { if (sel) sel.focus(); }, 100);
  }

  function fecharModalCorrigir() {
    if (!modalCorrigir) return;
    modalCorrigir.classList.remove('open', 'active', 'show');
    modalCorrigir.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    registroEditandoId = null;
  }

  function salvarCorrigirRegistro() {
    if (registroEditandoId === null) return;

    var reg = currentRegistros.find(function (x) { return x.id === registroEditandoId; });
    if (!reg) {
      fecharModalCorrigir();
      return;
    }

    var sel = document.getElementById('modal-status-select');
    var obs = document.getElementById('modal-observacao-input');
    var novoStatus = sel ? String(sel.value || '').trim() : '';

    if (!novoStatus) {
      showToast('Selecione um status válido para aplicar a correção.', 'error');
      return;
    }

    reg.status = novoStatus;
    reg.justificativa = obs ? String(obs.value || '').trim() : '';
    recomputeFlags(reg);

    fecharModalCorrigir();
    renderTodosQuadros();
    checkChanges();

    showToast('Correção aplicada a ' + (reg.nome || 'colaborador') + '. Clique em "💾 Salvar Alterações do Dia" para persistir.', 'success');
  }

  function checkChanges() {
    var alteracoes = currentRegistros.filter(function (r) {
      return r.status !== r.originalStatus || r.justificativa !== r.originalJustificativa;
    });

    var btnSalvar = document.getElementById('btn-salvar-alteracoes');
    var infoEl = document.getElementById('info-alteracoes-pendentes');

    if (btnSalvar) {
      btnSalvar.disabled = alteracoes.length === 0;
    }

    if (infoEl) {
      if (alteracoes.length > 0) {
        infoEl.innerHTML = '<span class="badge badge-warning" style="font-size:0.78rem; font-weight:700;">' + alteracoes.length + '</span> alteração(ões) pendente(s) de salvamento';
      } else {
        infoEl.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--success);"></i> Nenhuma alteração pendente';
      }
    }
  }

  function salvarAlteracoes() {
    var alteracoes = currentRegistros.filter(function (r) {
      return r.status !== r.originalStatus || r.justificativa !== r.originalJustificativa;
    }).map(function (r) {
      return { id: r.id, status: r.status, justificativa: r.justificativa };
    });

    if (!alteracoes.length) return;

    setLoading(true, 'Salvando alterações...');
    fetch(API_URL + '/api/dados/atualizar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alteracoes: alteracoes })
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        setLoading(false);
        if (!json.success) {
          showError(json.error || 'Erro ao salvar alterações.');
          return;
        }
        showToast('Alterações salvas com sucesso!', 'success');
        checar();
      })
      .catch(function (err) {
        setLoading(false);
        showError('Falha de comunicação com o servidor: ' + err.message);
      });
  }

  /* ============================================================
     3. MODAL DE EXCLUSÃO (DUPLA CONFIRMAÇÃO)
     ============================================================ */

  function setupModal() {
    var btnFechar = document.getElementById('btn-fechar-modal');
    var btnCancelar = document.getElementById('btn-cancelar-exclusao');

    if (btnFechar) btnFechar.addEventListener('click', fecharModal);
    if (btnCancelar) btnCancelar.addEventListener('click', fecharModal);

    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) fecharModal();
      });
    }

    if (confirmInput) {
      confirmInput.addEventListener('input', function () {
        btnConfirmDelete.disabled = confirmInput.value.trim().toUpperCase() !== 'EXCLUIR';
      });
    }

    if (btnConfirmDelete) btnConfirmDelete.addEventListener('click', confirmarExclusao);
  }

  function abrirModal() {
    var data = getDate();
    if (!data || !lastCounts || lastCounts.total === 0) return;

    document.getElementById('modal-data').textContent = formatBR(data);
    document.getElementById('modal-ponto').textContent = lastCounts.ponto;
    document.getElementById('modal-deslig').textContent = lastCounts.desligamentos;

    if (confirmInput) confirmInput.value = '';
    btnConfirmDelete.disabled = true;

    if (modal) {
      modal.classList.add('open', 'active', 'show');
      modal.setAttribute('aria-hidden', 'false');
      setTimeout(function () { if (confirmInput) confirmInput.focus(); }, 100);
    }
  }

  function fecharModal() {
    if (!modal) return;
    modal.classList.remove('open', 'active', 'show');
    modal.setAttribute('aria-hidden', 'true');
    if (confirmInput) confirmInput.value = '';
    btnConfirmDelete.disabled = true;
  }

  function confirmarExclusao() {
    var data = getDate();
    if (!data) return;
    if (!confirmInput || confirmInput.value.trim().toUpperCase() !== 'EXCLUIR') return;

    btnConfirmDelete.disabled = true;
    setLoading(true, 'Excluindo registros do dia...');

    fetch(API_URL + '/api/dados/deletar?data=' + encodeURIComponent(data), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        setLoading(false);
        fecharModal();
        if (!json.success) {
          showError(json.error || 'Erro ao excluir os dados.');
          return;
        }
        showToast(
          'Excluídos ' + json.removidos.ponto + ' ponto(s) e ' +
          json.removidos.desligamentos + ' desligamento(s) de ' + formatBR(data) + '.',
          'success'
        );
        checar();
      })
      .catch(function (err) {
        setLoading(false);
        fecharModal();
        showError('Falha na exclusão: ' + err.message);
      });
  }

  /* ============================================================
     4. UTILITÁRIOS DE UI
     ============================================================ */

  function setLoading(on, msg) {
    if (!loadingEl) return;
    loadingEl.style.display = on ? 'flex' : 'none';
    if (msg && loadingText) loadingText.textContent = msg;
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function hideError() {
    if (errorEl) errorEl.style.display = 'none';
  }

  function formatBR(iso) {
    if (!iso) return '—';
    var p = iso.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'success');
    var icon = type === 'error' ? 'bi-x-circle-fill text-danger' : 'bi-check-circle-fill text-success';
    toast.innerHTML = '<i class="bi ' + icon + '"></i> <span>' + esc(msg) + '</span>';
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  function esc(str) {
    if (str === null || str === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
})();
