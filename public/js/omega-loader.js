// ============================================================
// MODAL DE CARREGAMENTO & SUCESSO (ÔMEGA) — utilitários globais
// Compartilhado entre dashboard.html e tratamento.html.
//   window.setOmegaProgress(45, 'Processando e enviando para a IA...')
//   window.showOmegaSuccess('Enviado com Sucesso!', callback)  // fecha em 2s
//   window.closeOmegaLoader()                                  // fecha e reseta
// ============================================================
(function () {
  'use strict';

  var OMEGA_LOADER_DEFAULT_STATUS = 'Processando e enviando para a IA...';
  var omegaSuccessTimer = null;

  function omegaEl(id) {
    return document.getElementById(id);
  }

  window.setOmegaProgress = function (porcentagem, statusText) {
    var modal = omegaEl('omega-loader-modal');
    if (!modal) return;
    var pct = Math.max(0, Math.min(100, Math.round(Number(porcentagem) || 0)));

    if (omegaSuccessTimer) {
      clearTimeout(omegaSuccessTimer);
      omegaSuccessTimer = null;
    }
    modal.hidden = false;
    // garante a fase de progresso visível e o sucesso oculto
    var track = omegaEl('omega-progress-track');
    if (track) track.style.display = '';
    var pctEl = omegaEl('omega-progress-pct');
    if (pctEl) pctEl.style.display = '';
    var status = omegaEl('omega-status-text');
    if (status) status.style.display = '';
    var su = omegaEl('omega-success-state');
    if (su) su.hidden = true;

    var bar = omegaEl('omega-progress-bar');
    if (bar) bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (status && statusText != null && String(statusText) !== '') {
      status.textContent = String(statusText);
    }
  };

  window.showOmegaSuccess = function (mensagem, callback) {
    var modal = omegaEl('omega-loader-modal');
    if (!modal) return;
    modal.hidden = false;

    // oculta barra, percentual e status
    var track = omegaEl('omega-progress-track');
    if (track) track.style.display = 'none';
    var pctEl = omegaEl('omega-progress-pct');
    if (pctEl) pctEl.style.display = 'none';
    var status = omegaEl('omega-status-text');
    if (status) status.style.display = 'none';

    var su = omegaEl('omega-success-state');
    if (su) {
      var txt = su.querySelector('.omega-success-text');
      if (txt) txt.textContent = mensagem || 'Enviado com Sucesso!';
      su.hidden = false;
    }

    if (omegaSuccessTimer) clearTimeout(omegaSuccessTimer);
    omegaSuccessTimer = setTimeout(function () {
      omegaSuccessTimer = null;
      window.closeOmegaLoader();
      if (typeof callback === 'function') callback();
    }, 2000);
  };

  window.closeOmegaLoader = function () {
    if (omegaSuccessTimer) {
      clearTimeout(omegaSuccessTimer);
      omegaSuccessTimer = null;
    }
    var modal = omegaEl('omega-loader-modal');
    if (modal) modal.hidden = true;

    var track = omegaEl('omega-progress-track');
    if (track) track.style.display = '';
    var bar = omegaEl('omega-progress-bar');
    if (bar) bar.style.width = '0%';
    var pctEl = omegaEl('omega-progress-pct');
    if (pctEl) {
      pctEl.style.display = '';
      pctEl.textContent = '0%';
    }
    var status = omegaEl('omega-status-text');
    if (status) {
      status.style.display = '';
      status.textContent = OMEGA_LOADER_DEFAULT_STATUS;
    }
    var su = omegaEl('omega-success-state');
    if (su) su.hidden = true;
  };
})();
