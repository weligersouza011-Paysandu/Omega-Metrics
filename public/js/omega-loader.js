// ============================================================
// MODAL DE CARREGAMENTO & SUCESSO (ÔMEGA) — utilitários globais
// Compartilhado entre dashboard.html e tratamento.html.
//   window.setOmegaProgress(45, 'Carregando dados...')
//   window.showOmegaSuccess('Dashboard Atualizado!', callback)  // fecha com fade-out
//   window.closeOmegaLoader()                                  // fecha e reseta
// ============================================================
(function () {
  'use strict';

  var OMEGA_LOADER_DEFAULT_STATUS = 'Carregando dados...';
  var omegaSuccessTimer = null;

  function omegaEl(id) {
    return document.getElementById(id);
  }

  function getModal() {
    return omegaEl('omega-loader-modal') || omegaEl('loading-modal');
  }

  window.setOmegaProgress = function (porcentagem, statusText) {
    var modal = getModal();
    if (!modal) return;
    var pct = Math.max(0, Math.min(100, Math.round(Number(porcentagem) || 0)));

    if (omegaSuccessTimer) {
      clearTimeout(omegaSuccessTimer);
      omegaSuccessTimer = null;
    }

    modal.classList.remove('omega-loader-fadeout');
    modal.hidden = false;

    // garante a fase de progresso visível e o sucesso oculto
    var track = omegaEl('omega-progress-track');
    if (track) track.style.display = '';
    var pctEl = omegaEl('omega-progress-pct');
    if (pctEl) pctEl.style.display = '';
    var status = omegaEl('omega-status-text');
    if (status) status.style.display = '';
    var logo = modal.querySelector('.omega-loader-logo');
    if (logo) logo.style.display = '';
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
    var modal = getModal();
    if (!modal) return;
    modal.classList.remove('omega-loader-fadeout');
    modal.hidden = false;

    // oculta barra, percentual, status e logo temporariamente para focar no checkmark
    var track = omegaEl('omega-progress-track');
    if (track) track.style.display = 'none';
    var pctEl = omegaEl('omega-progress-pct');
    if (pctEl) pctEl.style.display = 'none';
    var status = omegaEl('omega-status-text');
    if (status) status.style.display = 'none';
    var logo = modal.querySelector('.omega-loader-logo');
    if (logo) logo.style.display = 'none';

    var su = omegaEl('omega-success-state');
    if (su) {
      var txt = su.querySelector('.omega-success-text');
      if (txt) txt.textContent = mensagem || 'Dashboard Atualizado!';
      su.hidden = false;
    }

    if (omegaSuccessTimer) clearTimeout(omegaSuccessTimer);
    omegaSuccessTimer = setTimeout(function () {
      omegaSuccessTimer = null;
      window.closeOmegaLoader(callback);
    }, 1400);
  };

  window.closeOmegaLoader = function (callback) {
    if (omegaSuccessTimer) {
      clearTimeout(omegaSuccessTimer);
      omegaSuccessTimer = null;
    }
    var modal = getModal();
    if (!modal) return;

    // Efeito suave de fade-out antes de ocultar
    modal.classList.add('omega-loader-fadeout');
    setTimeout(function () {
      modal.hidden = true;
      modal.classList.remove('omega-loader-fadeout');

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
      var logo = modal.querySelector('.omega-loader-logo');
      if (logo) logo.style.display = '';
      var su = omegaEl('omega-success-state');
      if (su) su.hidden = true;

      if (typeof callback === 'function') callback();
    }, 300);
  };
})();
