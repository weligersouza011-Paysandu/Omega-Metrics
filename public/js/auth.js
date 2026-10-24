/**
 * OMEGA METRICS — Módulo Central de Autenticação e Controle de Acesso
 * Gerencia verificação de sessão, dados do usuário no localStorage e controle de permissões.
 */

(function () {
  'use strict';

  var STORAGE_KEY_USER = 'omega_user';
  var STORAGE_KEY_TOKEN = 'omega_auth_token';

  function getLoggedUser() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_USER);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY_USER);
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    window.location.replace('login.html');
  }

  function checkPageAuth() {
    var isLoginPage = window.location.pathname.indexOf('login.html') !== -1 || window.location.pathname.endsWith('/login');
    var user = getLoggedUser();

    if (isLoginPage) {
      if (user && user.matricula) {
        window.location.replace('dashboard.html');
      }
      return;
    }

    // Em todas as outras páginas, exige usuário autenticado
    if (!user || !user.matricula) {
      window.location.replace('login.html');
      return;
    }

    // Verificação estrita de permissões por página
    var currentPath = window.location.pathname.toLowerCase();

    // Gestão de Usuários: restrita EXCLUSIVAMENTE ao perfil 'Gestao'
    if (currentPath.indexOf('gestao_usuarios') !== -1 || currentPath.indexOf('usuarios') !== -1) {
      if (user.perfil !== 'Gestao') {
        alert('Acesso negado: a Gestão de Usuários é restrita ao perfil de Gestão.');
        window.location.replace('dashboard.html');
        return;
      }
    }

    // Aplica visibilidade por perfil
    applyProfileRestrictions(user);
    renderUserWidgets(user);
  }

  function applyProfileRestrictions(user) {
    var perfil = user.perfil || 'RH';

    // Se o perfil NÃO for 'Gestao', oculta todos os itens exclusivos de Gestão
    if (perfil !== 'Gestao') {
      var itensRestritosGestao = document.querySelectorAll('[data-role-restrict="Gestao"], a[href*="gestao_usuarios"], [data-sidebar-page="usuarios"]');
      itensRestritosGestao.forEach(function (el) {
        var li = el.closest('li');
        if (li) {
          li.style.display = 'none';
        } else {
          el.style.display = 'none';
        }
      });
    }

    // Se o perfil for 'Saude' ou 'Social', restringe abas de tratamento/expurgo operacional
    if (perfil === 'Saude' || perfil === 'Social') {
      var tabsRestritas = document.querySelectorAll('a[href*="tratamento.html"], a[href*="gerenciamento_dados.html"]');
      tabsRestritas.forEach(function (el) {
        var li = el.closest('li');
        if (li) li.style.display = 'none';
        else el.style.display = 'none';
      });
    }
  }

  function renderUserWidgets(user) {
    // 1. Injeta badge e botão de Logout no topo (.eng-topnav__actions)
    var topActions = document.querySelector('.eng-topnav__actions');
    if (topActions && !document.getElementById('omega-user-nav-widget')) {
      var widget = document.createElement('div');
      widget.id = 'omega-user-nav-widget';
      widget.style.display = 'inline-flex';
      widget.style.alignItems = 'center';
      widget.style.gap = '8px';
      widget.style.marginLeft = '12px';

      var badgeCor = '#f87171';
      var badgeBg = 'rgba(239, 68, 68, 0.15)';
      var badgeBorder = 'rgba(239, 68, 68, 0.3)';

      if (user.perfil === 'Gestao') {
        badgeCor = '#38bdf8';
        badgeBg = 'rgba(56, 189, 248, 0.15)';
        badgeBorder = 'rgba(56, 189, 248, 0.3)';
      } else if (user.perfil === 'Saude') {
        badgeCor = '#34d399';
        badgeBg = 'rgba(52, 211, 153, 0.15)';
        badgeBorder = 'rgba(52, 211, 153, 0.3)';
      } else if (user.perfil === 'Social') {
        badgeCor = '#fbbf24';
        badgeBg = 'rgba(251, 191, 36, 0.15)';
        badgeBorder = 'rgba(251, 191, 36, 0.3)';
      }

      widget.innerHTML =
        '<div style="display:flex; align-items:center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; background:' + badgeBg + '; color:' + badgeCor + '; border: 1px solid ' + badgeBorder + ';">' +
        '  <i class="bi bi-person-circle"></i>' +
        '  <span>' + escapeText(user.nome || user.matricula) + '</span>' +
        '  <span style="opacity:0.75; font-size:0.68rem; margin-left:2px;">(' + escapeText(user.perfil) + ')</span>' +
        '</div>' +
        '<button type="button" class="btn btn-sm btn-outline-danger" id="btn-top-logout" title="Encerrar Sessão" style="font-size: 0.72rem; padding: 3px 8px; display:inline-flex; align-items:center; gap:4px;">' +
        '  <i class="bi bi-box-arrow-right"></i> Sair' +
        '</button>';

      topActions.appendChild(widget);

      var btnLog = document.getElementById('btn-top-logout');
      if (btnLog) {
        btnLog.addEventListener('click', function (e) {
          e.preventDefault();
          if (confirm('Deseja realmente sair do sistema?')) {
            logout();
          }
        });
      }
    }

    // 2. Atualiza badge na Sidebar
    var sideBadge = document.querySelector('.sidebar-hover-menu__user-badge');
    if (sideBadge) {
      sideBadge.innerHTML = '<i class="bi bi-shield-check"></i> <span>' + escapeText(user.nome || user.matricula) + ' (' + escapeText(user.perfil) + ')</span>';
    }
  }

  function escapeText(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Executa verificação inicial de autenticação imediatamente
  checkPageAuth();

  // Garante renderização dos widgets e restrições após o DOM carregar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      var user = getLoggedUser();
      if (user) {
        applyProfileRestrictions(user);
        renderUserWidgets(user);
      }
    });
  } else {
    var user = getLoggedUser();
    if (user) {
      applyProfileRestrictions(user);
      renderUserWidgets(user);
    }
  }

  // Exporta métodos globalmente no objeto window.OmegaAuth
  window.OmegaAuth = {
    getUser: getLoggedUser,
    logout: logout,
    checkAuth: checkPageAuth
  };

})();
