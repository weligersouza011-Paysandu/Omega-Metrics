/**
 * sidebar-hover.js — Menu Lateral Retrátil Ativado por Hover
 * Omega Metrics · Engenharia & Estrutura
 *
 * Gatilho estritamente restrito ao canto superior esquerdo (80px x 60px)
 * com abertura suave e debounce de 200ms ao sair.
 */

(function () {
  'use strict';

  var closeTimer = null;
  var CLOSE_DELAY_MS = 200; // Delay suave de 200ms ao sair

  function initSidebarHover() {
    var trigger = document.getElementById('sidebar-hover-trigger') || document.querySelector('.eng-hover-trigger') || document.querySelector('.sidebar-hover-trigger');
    var sidebar = document.getElementById('sidebar-hover-menu') || document.querySelector('.eng-sidebar') || document.querySelector('.sidebar-hover-menu');
    var backdrop = document.getElementById('sidebar-hover-backdrop') || document.querySelector('.sidebar-hover-backdrop');

    if (!sidebar) return;

    function openSidebar() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      sidebar.classList.add('sidebar-hover-menu--open');
      sidebar.classList.add('eng-sidebar--open');
      if (backdrop) {
        backdrop.classList.add('sidebar-hover-backdrop--active');
      }
    }

    function scheduleCloseSidebar() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        sidebar.classList.remove('sidebar-hover-menu--open');
        sidebar.classList.remove('eng-sidebar--open');
        if (backdrop) {
          backdrop.classList.remove('sidebar-hover-backdrop--active');
        }
        closeTimer = null;
      }, CLOSE_DELAY_MS);
    }

    function immediateCloseSidebar() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      sidebar.classList.remove('sidebar-hover-menu--open');
      sidebar.classList.remove('eng-sidebar--open');
      if (backdrop) {
        backdrop.classList.remove('sidebar-hover-backdrop--active');
      }
    }

    // Eventos na zona de gatilho
    if (trigger) {
      trigger.addEventListener('mouseenter', openSidebar);
      trigger.addEventListener('mouseleave', scheduleCloseSidebar);

      // Permite que cliques na área do gatilho alcancem elementos abaixo
      trigger.addEventListener('click', function (e) {
        trigger.style.pointerEvents = 'none';
        var underEl = document.elementFromPoint(e.clientX, e.clientY);
        trigger.style.pointerEvents = 'auto';
        if (underEl && underEl !== trigger && underEl !== sidebar && !sidebar.contains(underEl)) {
          underEl.click();
        }
      });
    }

    // Eventos no próprio menu lateral (permanece aberto enquanto o mouse estiver sobre ele)
    sidebar.addEventListener('mouseenter', openSidebar);
    sidebar.addEventListener('mouseleave', scheduleCloseSidebar);

    // Fechar ao clicar no backdrop (se visível)
    if (backdrop) {
      backdrop.addEventListener('click', immediateCloseSidebar);
    }

    // Fechar ao pressionar tecla ESC (acessibilidade)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        immediateCloseSidebar();
      }
    });

    // Rastreamento coordenado estritamente no canto extremo superior esquerdo (<= 80px largura, <= 60px altura)
    document.addEventListener('mousemove', function (e) {
      var isTopLeftCorner = e.clientY >= 0 && e.clientY <= 60 && e.clientX >= 0 && e.clientX <= 80;
      if (isTopLeftCorner) {
        openSidebar();
      }
    });

    // Marcação da página ativa no menu lateral (default: RH)
    highlightActiveLink(sidebar);
  }

  function highlightActiveLink(sidebar) {
    if (!sidebar) return;
    var path = window.location.pathname.toLowerCase();
    var links = sidebar.querySelectorAll('.sidebar-hover-menu__link, .eng-sidebar__link');
    var matched = false;

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var page = link.getAttribute('data-sidebar-page') || '';
      link.classList.remove('active');

      if (page === 'usuarios' && (path.indexOf('gestao_usuarios') !== -1 || path.indexOf('usuarios') !== -1)) {
        link.classList.add('active');
        matched = true;
      } else if (page === 'rh' || page === 'dashboard') {
        if (path.indexOf('dashboard') !== -1 || path === '/' || path.endsWith('/') || path.indexOf('tratamento') !== -1 || path.indexOf('gerenciamento') !== -1) {
          link.classList.add('active');
          matched = true;
        }
      }
    }

    // Ativo por padrão se nenhuma outra aba específica coincidir (RH)
    if (!matched) {
      var rhLink = sidebar.querySelector('[data-sidebar-page="rh"], [data-sidebar-page="dashboard"]');
      if (rhLink) rhLink.classList.add('active');
    }
  }

  // Inicialização resiliente
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarHover);
  } else {
    initSidebarHover();
  }
})();
