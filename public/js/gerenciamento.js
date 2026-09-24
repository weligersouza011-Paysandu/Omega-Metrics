(function () {
  'use strict';

  // Base dinâmica da API: local vazio; hospedado (Render/GH Pages) aponta ao backend
  var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? ''
    : 'https://seu-backend.onrender.com';

  var selectedDate = null;
  var lastCounts = null;

  var drawer = document.getElementById('menu-drawer');
  var loadingEl = document.getElementById('status-loading');
  var loadingText = document.getElementById('status-loading-text');
  var errorEl = document.getElementById('status-error');
  var dateInput = document.getElementById('data-selecao');
  var painel = document.getElementById('painel-contagem');
  var modal = document.getElementById('modal-confirmar-exclusao');
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
    if (typeof flatpickr === 'undefined' || !dateInput) return;
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

  function resetPainel() {
    lastCounts = null;
    if (painel) painel.style.display = 'none';
    hideError();
  }

  function checar() {
    var data = getDate();
    if (!data) {
      showError('Selecione uma data válida.');
      return;
    }
    hideError();
    setLoading(true, 'Consultando registros do dia...');

    fetch(API_URL + '/api/dados/checar?data=' + encodeURIComponent(data))
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

    document.getElementById('btn-download').disabled = vazio;
    document.getElementById('btn-excluir').disabled = vazio;
    painel.style.display = 'block';
  }

  function download() {
    var data = getDate();
    if (!data || !lastCounts || lastCounts.total === 0) return;
    window.location.href = API_URL + '/api/dados/download?data=' + encodeURIComponent(data);
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
