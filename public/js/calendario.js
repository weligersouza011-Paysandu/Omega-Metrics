/* =========================================================
   calendario.js — Calendário Operacional · Omega Metrics
   v2 — Visão Anual 12 meses + Auto-preenchimento + Compacto
   ========================================================= */

/* ------------------------------------------------------------------ */
/* CONSTANTES                                                           */
/* ------------------------------------------------------------------ */
const TIPOS = ['UTIL', 'COMPENSADO', 'FERIADO'];

const TIPO_META = {
  UTIL:       { label: 'Útil',        badge: 'badge-util',       cor: '#4ade80', icon: 'bi-check-circle-fill' },
  FERIADO:    { label: 'Feriado',     badge: 'badge-feriado',    cor: '#f87171', icon: 'bi-x-circle-fill'     },
  COMPENSADO: { label: 'Compensado',  badge: 'badge-compensado', cor: '#fbbf24', icon: 'bi-dash-circle-fill'  }
};

const MESES_PT  = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_ABR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const DIAS_SEMANA = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const DIAS_MINI   = ['D','S','T','Q','Q','S','S'];

/* ------------------------------------------------------------------ */
/* ESTADO GLOBAL                                                        */
/* ------------------------------------------------------------------ */
let estadoDias  = {};   // 'YYYY-MM-DD' → { tipo_dia, descricao }
let estadoOriginal = {}; // snapshot vindo do banco (para salvar só o que mudou)
let modoVisao   = 'mensal';   // 'mensal' | 'anual'
let mesAtual    = new Date().getMonth() + 1;
let anoAtual    = new Date().getFullYear();
let salvando    = false;
let alterado    = false;
let modalDataAtual = null;

/* ------------------------------------------------------------------ */
/* HELPERS                                                              */
/* ------------------------------------------------------------------ */
const fmt2     = n  => String(n).padStart(2, '0');
const dataStr  = (a,m,d) => `${a}-${fmt2(m)}-${fmt2(d)}`;
const hojeStr  = () => new Date().toISOString().slice(0, 10);
const tipoDe   = data => (estadoDias[data] || {}).tipo_dia || 'UTIL';
const descDe   = data => (estadoDias[data] || {}).descricao || '';
const proxTipo = tipo => TIPOS[(TIPOS.indexOf(tipo) + 1) % TIPOS.length];

/* ------------------------------------------------------------------ */
/* INIT                                                                 */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  preencherSeletorAno();
  document.getElementById('sel-mes').value = mesAtual;
  document.getElementById('sel-ano').value = anoAtual;

  /* Controles de navegação */
  document.getElementById('sel-mes').addEventListener('change',   onNavChange);
  document.getElementById('sel-ano').addEventListener('change',   onNavChange);
  document.getElementById('btn-mes-ant').addEventListener('click',  () => navegarMes(-1));
  document.getElementById('btn-mes-prox').addEventListener('click', () => navegarMes(+1));

  /* Alternador de visão */
  document.getElementById('btn-modo-mensal').addEventListener('click', () => setModo('mensal'));
  document.getElementById('btn-modo-anual').addEventListener('click',  () => setModo('anual'));

  /* Botões de ação */
  document.getElementById('btn-salvar-tudo').addEventListener('click',  salvarTudo);
  document.getElementById('btn-gerar-ano').addEventListener('click',    gerarAno);

  /* Modal de tipo do dia + descrição */
  document.getElementById('modal-salvar').addEventListener('click',   salvarModal);
  document.getElementById('modal-cancelar').addEventListener('click', fecharModal);
  document.getElementById('modal-tipo-select').addEventListener('change', e => {
    if (e.target.value === 'UTIL') {
      document.getElementById('modal-desc-input').value = '';
    }
  });
  document.getElementById('desc-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('desc-modal')) fecharModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModal(); });

  /* Data no topnav */
  const elData = document.getElementById('data-por-extenso');
  if (elData) {
    const now = new Date();
    elData.textContent = now.toLocaleDateString('pt-BR',
      { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  carregarEExibir();
});

/* ------------------------------------------------------------------ */
/* NAVEGAÇÃO                                                            */
/* ------------------------------------------------------------------ */
function preencherSeletorAno() {
  const sel = document.getElementById('sel-ano');
  sel.innerHTML = '';
  for (let a = anoAtual - 2; a <= anoAtual + 3; a++) {
    const o = document.createElement('option');
    o.value = a; o.textContent = a;
    sel.appendChild(o);
  }
}

function onNavChange() {
  mesAtual = parseInt(document.getElementById('sel-mes').value, 10);
  anoAtual = parseInt(document.getElementById('sel-ano').value, 10);
  carregarEExibir();
}

function navegarMes(delta) {
  mesAtual += delta;
  if (mesAtual > 12) { mesAtual = 1;  anoAtual++; }
  if (mesAtual < 1)  { mesAtual = 12; anoAtual--; }
  document.getElementById('sel-mes').value = mesAtual;
  document.getElementById('sel-ano').value = anoAtual;
  carregarEExibir();
}

function setModo(modo) {
  modoVisao = modo;
  document.getElementById('btn-modo-mensal').classList.toggle('modo-ativo', modo === 'mensal');
  document.getElementById('btn-modo-anual').classList.toggle('modo-ativo',  modo === 'anual');

  /* Mostra/esconde controles de mês */
  const ctrlMes = document.getElementById('ctrl-mes-grupo');
  if (ctrlMes) ctrlMes.style.display = modo === 'mensal' ? '' : 'none';

  carregarEExibir();
}

/* ------------------------------------------------------------------ */
/* CARGA DE DADOS                                                        */
/* ------------------------------------------------------------------ */
async function carregarEExibir() {
  setLoading(true);
  try {
    if (modoVisao === 'mensal') {
      await carregarMes(mesAtual, anoAtual);
      renderMensal();
    } else {
      await carregarAno(anoAtual);
      renderAnual();
    }
  } catch (err) {
    mostrarToast('Erro ao carregar: ' + err.message, 'erro');
  } finally {
    setLoading(false);
  }
}

async function carregarMes(mes, ano) {
  const resp = await fetch(`/api/calendario-operacional?mes=${mes}&ano=${ano}`);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error);
  for (const d of json.dias) {
    estadoDias[d.data] = { tipo_dia: d.tipo_dia, descricao: d.descricao || '' };
    estadoOriginal[d.data] = { tipo_dia: d.tipo_dia, descricao: d.descricao || '' };
  }
}

async function carregarAno(ano) {
  const resp = await fetch(`/api/calendario-operacional/ano?ano=${ano}`);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error);
  estadoDias = {};
  estadoOriginal = {};
  for (const d of json.dias) {
    estadoDias[d.data] = { tipo_dia: d.tipo_dia, descricao: d.descricao || '' };
    estadoOriginal[d.data] = { tipo_dia: d.tipo_dia, descricao: d.descricao || '' };
  }
}

function setLoading(on) {
  if (on) {
    document.getElementById('cal-grid').innerHTML = `
      <div class="cal-loading">
        <div class="cal-spinner"></div>
        <span>Carregando calendário…</span>
      </div>`;
  }
}

/* ------------------------------------------------------------------ */
/* RENDERIZAÇÃO — MODO MENSAL (COMPACTO)                               */
/* ------------------------------------------------------------------ */
function renderMensal() {
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  grid.className = 'cal-grid-mensal';

  const totalDias   = new Date(anoAtual, mesAtual, 0).getDate();
  const primeiroDia = new Date(anoAtual, mesAtual - 1, 1).getDay();
  const hoje        = hojeStr();

  /* Cabeçalho dias da semana */
  const cab = document.createElement('div');
  cab.className = 'cal-weekdays';
  DIAS_SEMANA.forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-weekday';
    el.textContent = d;
    cab.appendChild(el);
  });
  grid.appendChild(cab);

  /* Grade de dias */
  const corpo = document.createElement('div');
  corpo.className = 'cal-days';

  for (let i = 0; i < primeiroDia; i++) {
    const v = document.createElement('div');
    v.className = 'cal-day cal-day--vazio';
    corpo.appendChild(v);
  }

  for (let dia = 1; dia <= totalDias; dia++) {
    const ds     = dataStr(anoAtual, mesAtual, dia);
    const tipo   = tipoDe(ds);
    const meta   = TIPO_META[tipo];
    const diaSem = new Date(anoAtual, mesAtual - 1, dia).getDay();
    const fimSem = diaSem === 0 || diaSem === 6;
    const ehHoje = ds === hoje;
    const desc   = descDe(ds);

    const cell = document.createElement('div');
    cell.className = [
      'cal-day',
      `cal-day--${tipo.toLowerCase()}`,
      fimSem ? 'cal-day--fimde' : '',
      ehHoje ? 'cal-day--hoje' : ''
    ].filter(Boolean).join(' ');
    cell.dataset.data = ds;
    cell.title = `${ds}${desc ? ' — ' + desc : ''}`;

    cell.innerHTML = `
      <div class="cal-day__top">
        <span class="cal-day__num">${dia}</span>
        <span class="cal-day__badge ${meta.badge}">
          <i class="bi ${meta.icon}"></i>
          <span class="badge-label">${meta.label}</span>
        </span>
      </div>
      ${desc ? `<div class="cal-day__desc">${desc}</div>` : ''}`;

    cell.addEventListener('click', () => onClickDia(ds, cell));
    cell.addEventListener('contextmenu', e => { e.preventDefault(); abrirModal(ds); });

    corpo.appendChild(cell);
  }

  grid.appendChild(corpo);

  /* Título e resumo */
  document.getElementById('cal-titulo-mes').textContent =
    `${MESES_PT[mesAtual - 1]} ${anoAtual}`;
  atualizarResumoMes(totalDias);
}

/* ------------------------------------------------------------------ */
/* RENDERIZAÇÃO — MODO ANUAL (12 mini-grids 4×3)                      */
/* ------------------------------------------------------------------ */
function renderAnual() {
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  grid.className = 'cal-grid-anual';

  const hoje = hojeStr();

  for (let m = 1; m <= 12; m++) {
    const mini = document.createElement('div');
    mini.className = 'cal-mini';

    const titulo = document.createElement('div');
    titulo.className = 'cal-mini__titulo';
    titulo.textContent = MESES_ABR[m - 1];
    mini.appendChild(titulo);

    /* Mini cabeçalho */
    const cabRow = document.createElement('div');
    cabRow.className = 'cal-mini__semana';
    DIAS_MINI.forEach(d => {
      const s = document.createElement('span');
      s.textContent = d;
      cabRow.appendChild(s);
    });
    mini.appendChild(cabRow);

    /* Dias */
    const corpo = document.createElement('div');
    corpo.className = 'cal-mini__dias';

    const totalDias   = new Date(anoAtual, m, 0).getDate();
    const primeiroDia = new Date(anoAtual, m - 1, 1).getDay();

    for (let i = 0; i < primeiroDia; i++) {
      const v = document.createElement('span');
      v.className = 'cal-mini__dia cal-mini__dia--vazio';
      corpo.appendChild(v);
    }

    for (let dia = 1; dia <= totalDias; dia++) {
      const ds   = dataStr(anoAtual, m, dia);
      const tipo = tipoDe(ds);
      const desc = descDe(ds);
      const ehHoje = ds === hoje;

      const span = document.createElement('span');
      span.className = [
        'cal-mini__dia',
        `cal-mini__dia--${tipo.toLowerCase()}`,
        ehHoje ? 'cal-mini__dia--hoje' : ''
      ].filter(Boolean).join(' ');
      span.dataset.data = ds;
      span.title = `${ds}${desc ? ' — ' + desc : ''}`;
      span.textContent = dia;

      span.addEventListener('click', () => onClickDia(ds, span));

      corpo.appendChild(span);
    }

    mini.appendChild(corpo);
    grid.appendChild(mini);
  }

  atualizarResumoAno();
}

/* ------------------------------------------------------------------ */
/* INTERAÇÃO COM DIAS                                                   */
/* ------------------------------------------------------------------ */
function onClickDia(data, el) {
  const tipo  = tipoDe(data);
  const prox  = proxTipo(tipo);
  const desc  = descDe(data);
  // Voltar para "Dia Útil / Normal" descarta a anotação da exceção:
  // a data volta ao comportamento padrão e a exceção deixa de existir.
  estadoDias[data] = { tipo_dia: prox, descricao: prox === 'UTIL' ? '' : desc };
  marcarAlterado();

  /* Atualiza visual do elemento sem re-renderizar tudo */
  if (modoVisao === 'mensal') {
    atualizarCelulaMensal(el, data);
    atualizarResumoMes(new Date(anoAtual, mesAtual, 0).getDate());
  } else {
    atualizarCelulaMini(el, data);
    atualizarResumoAno();
  }
}

function atualizarCelulaMensal(cell, data) {
  const tipo = tipoDe(data);
  const meta = TIPO_META[tipo];
  const desc = descDe(data);
  const dia  = parseInt(data.split('-')[2], 10);
  const diaSem = new Date(data).getDay();
  const fimSem = diaSem === 0 || diaSem === 6;
  const ehHoje = data === hojeStr();

  cell.className = [
    'cal-day',
    `cal-day--${tipo.toLowerCase()}`,
    fimSem ? 'cal-day--fimde' : '',
    ehHoje ? 'cal-day--hoje' : ''
  ].filter(Boolean).join(' ');

  cell.innerHTML = `
    <div class="cal-day__top">
      <span class="cal-day__num">${dia}</span>
      <span class="cal-day__badge ${meta.badge}">
        <i class="bi ${meta.icon}"></i>
        <span class="badge-label">${meta.label}</span>
      </span>
    </div>
    ${desc ? `<div class="cal-day__desc">${desc}</div>` : ''}`;

  cell.addEventListener('click', () => onClickDia(data, cell));
  cell.addEventListener('contextmenu', e => { e.preventDefault(); abrirModal(data); });
  cell.title = `${data}${desc ? ' — ' + desc : ''}`;
}

function atualizarCelulaMini(span, data) {
  const tipo = tipoDe(data);
  const ehHoje = data === hojeStr();
  const diaSem = new Date(data).getDay();
  span.className = [
    'cal-mini__dia',
    `cal-mini__dia--${tipo.toLowerCase()}`,
    ehHoje ? 'cal-mini__dia--hoje' : ''
  ].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* RESUMO                                                               */
/* ------------------------------------------------------------------ */
function contarTipos(dias) {
  let uteis = 0, feriados = 0, compensados = 0;
  for (const ds of dias) {
    const tipo = tipoDe(ds);
    if (tipo === 'UTIL')            uteis++;
    else if (tipo === 'FERIADO')    feriados++;
    else if (tipo === 'COMPENSADO') compensados++;
  }
  return { uteis, feriados, compensados };
}

function atualizarResumoMes(totalDias) {
  const dias = [];
  for (let d = 1; d <= totalDias; d++) dias.push(dataStr(anoAtual, mesAtual, d));
  const { uteis, feriados, compensados } = contarTipos(dias);
  document.getElementById('resumo-uteis').textContent       = uteis;
  document.getElementById('resumo-feriados').textContent    = feriados;
  document.getElementById('resumo-compensados').textContent = compensados;
}

function atualizarResumoAno() {
  const dias = [];
  for (let m = 1; m <= 12; m++) {
    const totalDias = new Date(anoAtual, m, 0).getDate();
    for (let d = 1; d <= totalDias; d++) dias.push(dataStr(anoAtual, m, d));
  }
  const { uteis, feriados, compensados } = contarTipos(dias);
  document.getElementById('resumo-uteis').textContent       = uteis;
  document.getElementById('resumo-feriados').textContent    = feriados;
  document.getElementById('resumo-compensados').textContent = compensados;
}

/* ------------------------------------------------------------------ */
/* MODAL DE TIPO DO DIA + DESCRIÇÃO (clique direito)                   */
/* ------------------------------------------------------------------ */
function abrirModal(data) {
  modalDataAtual = data;
  const [ano, mes, dia] = data.split('-');
  document.getElementById('modal-data').textContent = `${dia}/${mes}/${ano}`;
  /* Seletor de tipo: sempre com as 3 opções (Dia Útil / Normal, Feriado,
     Compensado / Ponto Facultativo), independentemente do status atual */
  document.getElementById('modal-tipo-select').value = tipoDe(data);
  document.getElementById('modal-desc-input').value = descDe(data);
  document.getElementById('desc-modal').classList.add('modal--open');
  setTimeout(() => document.getElementById('modal-tipo-select').focus(), 50);
}

function fecharModal() {
  document.getElementById('desc-modal').classList.remove('modal--open');
  modalDataAtual = null;
}

function salvarModal() {
  if (!modalDataAtual) return;
  const data  = modalDataAtual;
  const sel   = document.getElementById('modal-tipo-select').value;
  const tipo  = TIPOS.includes(sel) ? sel : tipoDe(data);
  const desc  = document.getElementById('modal-desc-input').value.trim();
  estadoDias[data] = { tipo_dia: tipo, descricao: desc };
  fecharModal();
  marcarAlterado();
  if (modoVisao === 'mensal') renderMensal();
  else renderAnual();
}

/* ------------------------------------------------------------------ */
/* MARCAR ALTERADO                                                      */
/* ------------------------------------------------------------------ */
function marcarAlterado() {
  alterado = true;
  document.getElementById('btn-salvar-tudo').classList.add('btn-salvar--alterado');
}

/* ------------------------------------------------------------------ */
/* GERAR ANO (AUTO-PREENCHIMENTO)                                       */
/* ------------------------------------------------------------------ */
async function gerarAno() {
  const sobrescrever = document.getElementById('chk-sobrescrever') &&
                       document.getElementById('chk-sobrescrever').checked;

  const btn = document.getElementById('btn-gerar-ano');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split"></i><span>Gerando…</span>';

  try {
    const resp = await fetch('/api/calendario-operacional/gerar-ano', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ano: anoAtual, sobrescrever })
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    mostrarToast(
      `Ano ${anoAtual} gerado: ${json.inseridos} dias preenchidos, ${json.pulados} mantidos.`, 'ok'
    );
    /* Recarrega */
    estadoDias = {};
    estadoOriginal = {};
    alterado = false;
    document.getElementById('btn-salvar-tudo').classList.remove('btn-salvar--alterado');
    await carregarEExibir();
  } catch (err) {
    mostrarToast('Erro ao gerar ano: ' + err.message, 'erro');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-magic"></i><span>Auto-preencher Ano</span>';
  }
}

/* ------------------------------------------------------------------ */
/* SALVAR TUDO (somente o que mudou)                                    */
/* ------------------------------------------------------------------ */
function mudou(data, estado) {
  const orig = estadoOriginal[data];
  if (!orig) return true; // dia não existia no banco (novo ou removido)
  return orig.tipo_dia !== estado.tipo_dia ||
         (orig.descricao || '') !== (estado.descricao || '');
}

async function salvarTudo() {
  if (salvando) return;

  const pendentes = Object.entries(estadoDias).filter(([data, estado]) => mudou(data, estado));

  if (pendentes.length === 0) {
    alterado = false;
    document.getElementById('btn-salvar-tudo').classList.remove('btn-salvar--alterado');
    mostrarToast('Nenhuma alteração para salvar.', 'ok');
    return;
  }

  salvando = true;

  const btn = document.getElementById('btn-salvar-tudo');
  const ico = btn.querySelector('i');
  const lbl = btn.querySelector('span');
  btn.disabled = true;
  ico.className = 'bi bi-hourglass-split';
  lbl.textContent = 'Salvando…';

  const promises = pendentes.map(([data, estado]) =>
    fetch('/api/calendario-operacional', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data, tipo_dia: estado.tipo_dia, descricao: estado.descricao || null })
    }).then(r => r.json())
  );

  try {
    const resultados = await Promise.all(promises);
    const erros = resultados.filter(r => !r.success);
    if (erros.length > 0) {
      mostrarToast(`${erros.length} dia(s) falharam ao salvar.`, 'erro');
    } else {
      /* Gravado: o novo valor passa a ser o estado de referência */
      pendentes.forEach(([data, estado]) => {
        estadoOriginal[data] = { tipo_dia: estado.tipo_dia, descricao: estado.descricao || '' };
      });
      mostrarToast(`${pendentes.length} dia(s) salvos com sucesso!`, 'ok');
      alterado = false;
      btn.classList.remove('btn-salvar--alterado');
    }
  } catch (err) {
    mostrarToast('Erro de rede: ' + err.message, 'erro');
  } finally {
    salvando = false;
    btn.disabled = false;
    ico.className = 'bi bi-cloud-check-fill';
    lbl.textContent = 'Salvar';
  }
}

/* ------------------------------------------------------------------ */
/* TOAST                                                                */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function mostrarToast(msg, tipo = 'ok') {
  const toast = document.getElementById('cal-toast');
  const icon  = toast.querySelector('i');
  document.getElementById('cal-toast-msg').textContent = msg;
  icon.className = tipo === 'ok' ? 'bi bi-check2-circle' : 'bi bi-exclamation-triangle-fill';
  toast.className = `cal-toast cal-toast--${tipo} cal-toast--visivel`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('cal-toast--visivel'), 5000);
}
