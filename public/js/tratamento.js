(function () {
  'use strict';

  // Base dinâmica da API: local vazio; hospedado (Render/GH Pages) aponta ao backend
  var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? ''
    : 'https://omega-metrics1.onrender.com';

  var MAX_PREVIEW_ROWS = 50;
  var MAX_INCONS_ROWS = 200;

  var STATUS_CONFIG = {
    PRESENCA: {
      lista: ["PRESENTE", "ADVERTÊNCIA"],
      badgeClass: "badge-success",
      bgHex: "#10B981",
      contaComoPresenca: true,
      geraAbsenteismo: false
    },
    ABSENTEISMO: {
      lista: ["FALTA", "ATESTADO MÉDICO", "ATESTADO DE ÓBITO", "DECLARAÇÃO", "BO", "ÓBITO", "LICENÇA CASAMENTO", "LICENÇA PATERNIDADE"],
      badgeClass: "badge-danger",
      bgHex: "#EF4444",
      contaComoPresenca: false,
      geraAbsenteismo: true
    },
    ISENCAO: {
      lista: ["COMPENSAÇÃO", "FÉRIAS", "FOLGA", "EXAME PERIÓDICO", "LICENÇA MATERNIDADE", "INSS", "AGUARDANDO CRACHÁ"],
      badgeClass: "badge-secondary",
      bgHex: "#6B7280",
      contaComoPresenca: false,
      geraAbsenteismo: false
    },
    DEMISSAO: {
      lista: ["DEMITIDO"],
      badgeClass: "badge-purple",
      bgHex: "#8B5CF6",
      contaComoPresenca: false,
      geraAbsenteismo: false,
      requerJustificativa: true
    }
  };

  var STATUS_ALIASES = {
    ADVERTENCIA: 'ADVERTÊNCIA',
    ATESTADO: 'ATESTADO MÉDICO',
    'ATESTADO MEDICO': 'ATESTADO MÉDICO',
    DECARACAO: 'DECLARAÇÃO',
    'DECLARACAO BANCO': 'DECLARAÇÃO',
    'DECLARACAO': 'DECLARAÇÃO',
    'ATESTADO DE OBITO': 'ATESTADO DE ÓBITO',
    OBITO: 'ÓBITO',
    'BOLETIM DE OCORRENCIA': 'BO',
    'FALTA SEM JUSTIFICATIVA': 'FALTA',
    'LICENCA CASAMENTO': 'LICENÇA CASAMENTO',
    'LICENCA PATERNIDADE': 'LICENÇA PATERNIDADE',
    EXAME: 'EXAME PERIÓDICO',
    'EXAME PERIODICO': 'EXAME PERIÓDICO',
    'LICENCA MATERNIDADE': 'LICENÇA MATERNIDADE',
    'JUSTIFICADO FOLGA': 'FOLGA',
    'LICENCA INSS': 'INSS',
    COMPENSACAO: 'COMPENSAÇÃO',
    FERIAS: 'FÉRIAS',
    'AGUARDANDO CRACHA': 'AGUARDANDO CRACHÁ',
    DEMISSAO: 'DEMITIDO',
    DEMISSÃO: 'DEMITIDO',
    DESLIGADO: 'DEMITIDO',
    RESCISAO: 'DEMITIDO',
    RESCISÃO: 'DEMITIDO'
  };

  function normalizeStatusKey(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function sanitizeStatus(raw) {
    var key = normalizeStatusKey(raw);
    if (!key) return '';
    var alias = STATUS_ALIASES[key];
    if (alias) return alias;
    var hit = statusIndex[key];
    if (hit) return hit.label;
    return String(raw || '').trim();
  }

  var statusIndex = {};
  (function buildStatusIndex() {
    Object.keys(STATUS_CONFIG).forEach(function (grupo) {
      var cfg = STATUS_CONFIG[grupo];
      cfg.lista.forEach(function (item) {
        statusIndex[normalizeStatusKey(item)] = {
          grupo: grupo,
          badgeClass: cfg.badgeClass,
          contaComoPresenca: !!cfg.contaComoPresenca,
          geraAbsenteismo: !!cfg.geraAbsenteismo,
          requerJustificativa: !!cfg.requerJustificativa,
          label: item
        };
      });
    });
  })();

  function getStatusMeta(status) {
    var key = normalizeStatusKey(sanitizeStatus(status));
    if (!key) {
      return { grupo: 'DESCONHECIDO', badgeClass: 'badge-gray', contaComoPresenca: false, geraAbsenteismo: false, requerJustificativa: false, label: '' };
    }
    return statusIndex[key] ||
      { grupo: 'DESCONHECIDO', badgeClass: 'badge-gray', contaComoPresenca: false, geraAbsenteismo: false, requerJustificativa: false, label: String(status) };
  }

  function badgeForStatus(status) {
    return getStatusMeta(status).badgeClass;
  }

  function classificarRegistros(rows) {
    var c = { presenca: 0, absenteismo: 0, isencoes: 0, demissoes: 0, desconhecidos: 0 };
    (rows || []).forEach(function (row) {
      var meta = getStatusMeta(row && row.status);
      if (meta.grupo === 'PRESENCA') c.presenca++;
      else if (meta.grupo === 'ABSENTEISMO') c.absenteismo++;
      else if (meta.grupo === 'ISENCAO') c.isencoes++;
      else if (meta.grupo === 'DEMISSAO') c.demissoes++;
      else c.desconhecidos++;
    });
    c.totalPrevistos = c.presenca + c.absenteismo;
    return c;
  }

  function calcularAbsenteismo(rows) {
    var g = classificarRegistros(rows);
    var percentual = g.totalPrevistos > 0 ? (g.absenteismo / g.totalPrevistos) * 100 : 0;
    return {
      percentual: Math.round(percentual * 100) / 100,
      totalAusencias: g.absenteismo,
      totalPrevistos: g.totalPrevistos,
      excluidos: { isencoes: g.isencoes, demissoes: g.demissoes, desconhecidos: g.desconhecidos }
    };
  }

  function getStatusOpcionesOrdenadas() {
    var ordem = ['PRESENCA', 'ABSENTEISMO', 'ISENCAO', 'DEMISSAO'];
    var gruposLabels = {
      PRESENCA: 'Presença',
      ABSENTEISMO: 'Absenteísmo',
      ISENCAO: 'Isenção / Ausência Legal',
      DEMISSAO: 'Demissão'
    };
    return ordem.map(function (grupo) {
      return {
        grupo: grupo,
        labelGrupo: gruposLabels[grupo],
        opcoes: STATUS_CONFIG[grupo].lista.slice()
      };
    });
  }

  var currentLoteId = null;
  var demissoesPendentes = [];
  var justificativas = {};
  var editingDemissaoId = null;

  var dadosProcessados = [];
  var inconsistencias = [];
  var highlightRow = null;
  var rowIndexEditando = null;

  var form = document.getElementById('upload-form');
  var btnProcessar = document.getElementById('btn-processar');
  var btnLimpar = document.getElementById('btn-limpar');
  var btnEnviarBi = document.getElementById('btn-enviar-bi');
  var btnNovoUpload = document.getElementById('btn-novo-upload');
  var uploadStatus = document.getElementById('upload-status');
  var uploadStatusText = document.getElementById('upload-status-text');
  var uploadError = document.getElementById('upload-error');
  var previewSection = document.getElementById('preview-section');
  var filePontoInput = document.getElementById('file_ponto');
  var filePontoName = document.getElementById('file-ponto-name');

  var modal = document.getElementById('modal-justificativa');
  var modalClose = document.getElementById('modal-close');
  var modalCancelar = document.getElementById('modal-cancelar');
  var modalSalvar = document.getElementById('modal-salvar');

  var modalCorrecao = document.getElementById('modal-correcao');
  var modalCorrecaoClose = document.getElementById('modal-correcao-close');
  var modalCorrecaoCancelar = document.getElementById('modal-correcao-cancelar');
  var modalCorrecaoSalvar = document.getElementById('modal-correcao-salvar');

  // Limpeza inicial: remove resíduos de previews/testes antigos no navegador.
  // A gravação só volta a ocorrer no sucesso do "Enviar para o BI".
  try {
    localStorage.removeItem('fDB_Ponto_Tratado');
    localStorage.removeItem('omega_ponto_data');
  } catch (e) {
    console.warn('Erro ao limpar LocalStorage:', e);
  }

  form.addEventListener('submit', handleSubmit);
  btnLimpar.addEventListener('click', handleLimpar);
  btnEnviarBi.addEventListener('click', handleEnviarBi);
  btnNovoUpload.addEventListener('click', handleLimpar);
  modalClose.addEventListener('click', closeModal);
  modalCancelar.addEventListener('click', closeModal);
  modalSalvar.addEventListener('click', handleSalvarJustificativa);
  modalCorrecaoClose.addEventListener('click', closeCorrecaoModal);
  modalCorrecaoCancelar.addEventListener('click', closeCorrecaoModal);
  modalCorrecaoSalvar.addEventListener('click', handleSalvarCorrecao);

  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });
  modalCorrecao.addEventListener('click', function (e) {
    if (e.target === modalCorrecao) closeCorrecaoModal();
  });

  var radioInputs = document.querySelectorAll('input[name="justificativa"]');
  radioInputs.forEach(function (r) {
    r.addEventListener('change', function () {
      modalSalvar.disabled = false;
    });
  });

  filePontoInput.addEventListener('change', function () {
    filePontoName.textContent = this.files[0] ? this.files[0].name : 'Nenhum arquivo selecionado';
  });

  function formatExcelDate(serial) {
    if (serial === null || serial === undefined || serial === '') return serial;
    if (typeof serial === 'string' && serial.includes('/')) return serial;
    if (isNaN(serial)) return serial;
    var utc_days = Math.floor(serial - 25569);
    var utc_value = utc_days * 86400;
    var date_info = new Date(utc_value * 1000);
    var day = String(date_info.getUTCDate()).padStart(2, '0');
    var month = String(date_info.getUTCMonth() + 1).padStart(2, '0');
    var year = date_info.getUTCFullYear();
    return day + '/' + month + '/' + year;
  }

  function excelDecimalToTime(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      var t = v.trim();
      if (t === '') return null;
      if (/^\d{1,2}[.:]\d{2}$/.test(t)) return t.replace('.', ':');
      var n = Number(t);
      if (isNaN(n)) return t;
      v = n;
    }
    if (typeof v === 'number') {
      if (v < 0 || v >= 1) return String(v);
      var totalMinutes = Math.round(v * 24 * 60);
      var h = Math.floor(totalMinutes / 60) % 24;
      var m = totalMinutes % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
    return null;
  }

  function formatHoursToHHMM(value) {
    if (value === undefined || value === null || value === '' || value === '—') return '00:00';
    if (typeof value === 'number') {
      if (value < 1) {
        var totalMin = Math.round(value * 24 * 60);
        var h0 = String(Math.floor(totalMin / 60)).padStart(2, '0');
        var m0 = String(totalMin % 60).padStart(2, '0');
        return h0 + ':' + m0;
      }
      var h = String(Math.floor(value)).padStart(2, '0');
      var m = String(Math.round((value % 1) * 60)).padStart(2, '0');
      return h + ':' + m;
    }
    if (typeof value === 'string') {
      if (value.includes(':')) return value;
      var parsed = parseFloat(value.replace('h', ''));
      if (!isNaN(parsed)) return formatHoursToHHMM(parsed);
    }
    return '00:00';
  }

  function handleSubmit(e) {
    e.preventDefault();

    var filePonto = filePontoInput.files[0];
    if (!filePonto) {
      showError('Selecione o arquivo fDB_Ponto Tratado antes de processar.');
      return;
    }

    hideError();
    setLoading(true, 'Processando planilha...');

    var formData = new FormData();
    formData.append('file_ponto', filePonto);

    fetch(API_URL + '/api/tratamento/processar-arquivo', {
      method: 'POST',
      body: formData
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Erro HTTP ' + res.status);
          return data;
        });
      })
      .then(function (data) {
        if (!data.success) throw new Error(data.error || 'Erro no processamento.');
        currentLoteId = data.loteId;
        demissoesPendentes = data.demissoesPendentes || [];
        justificativas = {};
        highlightRow = null;
        if (data.preview && data.preview.statusConfig) {
          // Mantém STATUS_CONFIG local; servidor envia cópia p/ auditoria.
        }
        buildStateFromResponse(data);
        renderAll();
        if (data.preview && data.preview.previsaoAbsenteismo) {
          var elKpi = document.getElementById('kpi-absenteismo-preview');
          if (elKpi && dadosProcessados.length === 0) {
            var p = data.preview.previsaoAbsenteismo;
            elKpi.textContent = 'Absenteísmo: ' + p.percentual.toFixed(1) + '%';
          }
        }
        setLoading(false);
        btnLimpar.disabled = false;
        previewSection.style.display = 'block';
        previewSection.classList.add('fade-in');
      })
      .catch(function (err) {
        showError(err.message || 'Erro ao comunicar com o servidor.');
        setLoading(false);
      });
  }

  function buildStateFromResponse(data) {
    var linhas = (data.preview && data.preview.linhas) || [];
    dadosProcessados = linhas.map(function (r, i) {
      return {
        rowIndex: r.rowIndex !== undefined ? r.rowIndex : i,
        linhaPlanilha: r.linhaPlanilha !== undefined ? r.linhaPlanilha : (r.linha !== undefined ? r.linha : i + 1),
        matricula: r.matricula || '',
        funcionario: r.funcionario || '',
        funcao: r.funcao || '',
        dia: r.dia || '',
        status: r.status || '',
        cid: r.cid || '',
        entrada1: r.entrada1,
        saida2: r.saida2,
        totalNormais: r.totalNormais,
        corrigido: false
      };
    });

    var registros = ((data.inconsistencias && data.inconsistencias.registros) || [])
      .filter(function (r) { return r.tipo !== 'CID_PENDENTE'; });
    inconsistencias = registros.map(function (r) {
      return {
        id: r.id || (r.tipo + ':' + r.rowIndex),
        rowIndex: r.rowIndex,
        tipo: r.tipo,
        linhaPlanilha: r.linhaPlanilha !== undefined ? r.linhaPlanilha : r.linha,
        funcionario: r.funcionario || '',
        departamento: r.departamento || '',
        detalhe: r.detalhe || '',
        campos: r.campos || camposPorTipo(r.tipo)
      };
    }).filter(function (r) {
      return typeof r.rowIndex === 'number' && r.rowIndex >= 0;
    });
  }

  function camposPorTipo(tipo) {
    if (tipo === 'STATUS_VAZIO') return ['status'];
    if (tipo === 'STATUS_DESCONHECIDO') return ['status'];
    if (tipo === 'CID_PENDENTE') return ['cid'];
    if (tipo === 'SAIDA_2_AUSENTE') return ['saida2', 'status'];
    return [];
  }

  function revalidateRow(row) {
    var novas = [];
    var status = (row.status || '').trim();
    var statusKey = normalizeStatusKey(sanitizeStatus(status));

    if (!status) {
      novas.push({
        id: 'STATUS_VAZIO:' + row.rowIndex,
        rowIndex: row.rowIndex,
        tipo: 'STATUS_VAZIO',
        linhaPlanilha: row.linhaPlanilha,
        funcionario: row.funcionario,
        departamento: '',
        detalhe: 'Coluna Status sem preenchimento.',
        campos: ['status']
      });
    } else if (statusKey && !statusIndex[statusKey]) {
      novas.push({
        id: 'STATUS_DESCONHECIDO:' + row.rowIndex,
        rowIndex: row.rowIndex,
        tipo: 'STATUS_DESCONHECIDO',
        linhaPlanilha: row.linhaPlanilha,
        funcionario: row.funcionario,
        departamento: '',
        detalhe: 'Status "' + status + '" fora do catálogo (não conta no absenteísmo).',
        campos: ['status']
      });
    }

    var entradaEhHora = isHoraValue(row.entrada1);
    var saidaVazia = isEmptyValue(row.saida2);
    if (entradaEhHora && saidaVazia) {
      novas.push({
        id: 'SAIDA_2_AUSENTE:' + row.rowIndex,
        rowIndex: row.rowIndex,
        tipo: 'SAIDA_2_AUSENTE',
        linhaPlanilha: row.linhaPlanilha,
        funcionario: row.funcionario,
        departamento: '',
        detalhe: 'Entrada 1 registrada, mas Saída 2 está vazia sem justificativa.',
        campos: ['saida2', 'status']
      });
    }
    return novas;
  }

  function isHoraValue(val) {
    if (val === null || val === undefined || val === '') return false;
    if (typeof val === 'object') return val.type === 'time';
    var s = String(val).trim();
    return /^\d{1,2}:\d{2}$/.test(s);
  }

  function isEmptyValue(val) {
    if (val === null || val === undefined) return true;
    if (typeof val === 'object') return val.type === 'empty' || !val.text;
    return String(val).trim() === '';
  }

  function getVisibleRows() {
    return dadosProcessados.filter(function (r) {
      return r.corrigido || r.rowIndex < MAX_PREVIEW_ROWS;
    });
  }

  function renderAll() {
    renderPreview();
    renderInconsistencias();
    renderDemissoes(demissoesPendentes);
    renderAbsenteismoKpi();
    updateSendButton();
  }

  function renderAbsenteismoKpi() {
    var el = document.getElementById('kpi-absenteismo-preview');
    if (!el) return;
    var abs = calcularAbsenteismo(dadosProcessados);
    el.textContent = 'Absenteísmo: ' + abs.percentual.toFixed(1) + '%';
    el.title = 'Ausências reais: ' + abs.totalAusencias +
      ' / Dias previstos: ' + abs.totalPrevistos +
      ' | Isenções excluídas: ' + abs.excluidos.isencoes;
    el.className = 'badge ' + (abs.percentual > 0 ? 'badge-danger' : 'badge-success');
  }

  function renderPreview() {
    document.getElementById('badge-total-registros').textContent =
      dadosProcessados.length + ' registros';

    var tbody = document.getElementById('preview-tbody');
    var rows = getVisibleRows();
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">Nenhum registro encontrado.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      var cls = r.corrigido ? ' class="row-corrigida"' : '';
      return '<tr' + cls + ' data-row-index="' + r.rowIndex + '">' +
        '<td class="text-muted">' + r.rowIndex + '</td>' +
        '<td>' + esc(r.matricula || '—') + '</td>' +
        '<td>' + esc(r.funcionario) + '</td>' +
        '<td>' + esc(r.funcao || '—') + '</td>' +
        '<td>' + esc(formatExcelDate(r.dia) || '—') + '</td>' +
        '<td>' + renderStatusBadge(r.status, r.cid) + '</td>' +
        '<td>' + esc(formatTimeValue(r.entrada1)) + '</td>' +
        '<td>' + esc(formatTimeValue(r.saida2)) + '</td>' +
        '<td>' + formatHoursToHHMM(r.totalNormais) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderStatusBadge(status, cid) {
    if (!status) return '<span class="badge badge-gray">—</span>';
    var cls = badgeForStatus(status);
    var html = '<span class="badge ' + cls + '">' + esc(status) + '</span>';
    if (cid && String(cid).trim()) {
      html += ' <span class="badge badge-info" title="CID do atestado">CID: ' + esc(String(cid).trim()) + '</span>';
    }
    return html;
  }

  function formatTimeValue(val) {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'object') return val.text || '—';
    if (typeof val === 'number') return excelDecimalToTime(val) || '—';
    return val;
  }

  function renderInconsistencias() {
    var section = document.getElementById('inconsistencias-section');
    var badge = document.getElementById('badge-inconsistencias');
    var summary = document.getElementById('inconsistencias-summary');
    var tbody = document.getElementById('inconsistencias-tbody');

    if (!inconsistencias || inconsistencias.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    badge.textContent = inconsistencias.length;

    var porCategoria = {};
    inconsistencias.forEach(function (inc) {
      porCategoria[inc.tipo] = (porCategoria[inc.tipo] || 0) + 1;
    });
    var labels = {
      'STATUS_VAZIO': 'Status Vazio',
      'STATUS_DESCONHECIDO': 'Status Fora do Catálogo',
      'ERRO_DIGITACAO': 'Erro de Digitação',
      'SAIDA_2_AUSENTE': 'Saída 2 Ausente',
      'MATRICULA_VAZIA': 'Matrícula Vazia',
      'NOME_VAZIO_DESLIG': 'Nome Vazio',
      'MOTIVO_VAZIO': 'Motivo Vazio'
    };
    summary.innerHTML = Object.keys(porCategoria).map(function (tipo) {
      return '<span class="badge badge-warning" style="margin-right:6px;margin-bottom:4px;">' +
        (labels[tipo] || tipo) + ': ' + porCategoria[tipo] + '</span>';
    }).join('');

    var rows = inconsistencias.slice(0, MAX_INCONS_ROWS);
    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td><span class="badge badge-warning">' + esc(r.tipo) + '</span></td>' +
        '<td>' + r.linhaPlanilha + '</td>' +
        '<td>' + esc(r.funcionario) + '</td>' +
        '<td>' + esc(r.departamento) + '</td>' +
        '<td>' + esc(r.detalhe) + '</td>' +
        '<td><button type="button" class="btn btn-sm btn-primary btn-corrigir" data-row-index="' + r.rowIndex + '" data-tipo="' + esc(r.tipo) + '">' +
          '<i class="bi bi-pencil-square"></i> Corrigir' +
        '</button></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('.btn-corrigir').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openCorrecaoModal(parseInt(this.getAttribute('data-row-index'), 10), this.getAttribute('data-tipo'));
      });
    });
  }

  function openCorrecaoModal(rowIndex, tipo) {
    var row = dadosProcessados.find(function (r) { return r.rowIndex === rowIndex; });
    if (!row) return;

    rowIndexEditando = rowIndex;
    var incon = inconsistencias.find(function (i) {
      return i.rowIndex === rowIndex && i.tipo === tipo;
    }) || inconsistencias.find(function (i) { return i.rowIndex === rowIndex; });

    var campos = (incon && incon.campos) || camposPorTipo(tipo);

    document.getElementById('correcao-funcionario').textContent =
      (row.funcionario || '—') + (row.matricula ? ' (Mat. ' + row.matricula + ')' : '');
    document.getElementById('correcao-detalhe').textContent =
      formatExcelDate(row.dia) + ' — Tipo: ' + tipo + (incon ? ' — ' + incon.detalhe : '');

    document.getElementById('correcao-atuais').innerHTML =
      '<span class="badge badge-gray">Status: ' + esc(formatTimeValue(row.status) || '—') + '</span>' +
      (row.cid && String(row.cid).trim() ? '<span class="badge badge-info">CID: ' + esc(row.cid) + '</span>' : '') +
      '<span class="badge badge-gray">Entrada 1: ' + esc(formatTimeValue(row.entrada1)) + '</span>' +
      '<span class="badge badge-gray">Saída 2: ' + esc(formatTimeValue(row.saida2)) + '</span>';

    var camposDiv = document.getElementById('correcao-campos');
    var html = '';

    if (campos.indexOf('saida2') !== -1) {
      var saidaVal = formatTimeValue(row.saida2);
      var saidaEhHora = saidaVal !== '—' && /^\d{1,2}:\d{2}$/.test(saidaVal);
      var saidaTexto = (!saidaEhHora && saidaVal !== '—') ? saidaVal : '';

      html += '<div class="correcao-field" data-field="saida2">' +
        '<label class="label">Saída 2 <span class="text-danger">*</span></label>' +
        '<div class="correcao-field-row">' +
          '<input type="time" id="corr-saida2-hora" class="input" value="' + (saidaEhHora ? saidaVal : '') + '">' +
          '<label class="correcao-check"><input type="checkbox" id="corr-saida2-texto-mode"' + (saidaTexto ? ' checked' : '') + '> Texto</label>' +
        '</div>' +
        '<input type="text" id="corr-saida2-texto" class="input" placeholder="Ex.: Justificado FOLGA" value="' + esc(saidaTexto) + '" style="display:' + (saidaTexto ? 'block' : 'none') + ';margin-top:0.5rem;">' +
        '</div>';
    }

    if (campos.indexOf('status') !== -1) {
      var currentKey = normalizeStatusKey(sanitizeStatus(row.status));
      var gruposHtml = getStatusOpcionesOrdenadas().map(function (g) {
        var opts = g.opcoes.map(function (opt) {
          var selected = normalizeStatusKey(opt) === currentKey ? ' selected' : '';
          return '<option value="' + esc(opt) + '"' + selected + '>' + esc(opt) + '</option>';
        }).join('');
        return '<optgroup label="' + esc(g.labelGrupo) + '">' + opts + '</optgroup>';
      }).join('');
      var extra = '';
      if (currentKey && !statusIndex[currentKey]) {
        extra = '<optgroup label="Atual (não catalogado)">' +
          '<option value="' + esc(row.status) + '" selected>' + esc(row.status) + '</option></optgroup>';
      }
      html += '<div class="correcao-field" data-field="status">' +
        '<label class="label">Status</label>' +
        '<select id="corr-status" class="input">' + extra + gruposHtml + '</select>' +
        '<span class="form-hint">Selecione o status canônico para classificação correta da badge e do absenteísmo.</span>' +
        '</div>';
    }

    var showCid = campos.indexOf('cid') !== -1 ||
      normalizeStatusKey(sanitizeStatus(row.status)) === 'ATESTADO MEDICO';
    if (showCid || campos.indexOf('status') !== -1) {
      html += '<div class="correcao-field" data-field="cid" id="correcao-cid-field" style="display:' +
        (showCid ? 'block' : 'none') + ';">' +
        '<label class="label">CID (Código de Doença) <span class="text-muted small">— opcional</span></label>' +
        '<input type="text" id="corr-cid" class="input" maxlength="10" placeholder="Ex.: J06.9" value="' + esc(row.cid || '') + '">' +
        '<span class="form-hint">Informação complementar do atestado — preenchimento opcional.</span>' +
        '</div>';
    }

    camposDiv.innerHTML = html;

    var statusSel = document.getElementById('corr-status');
    if (statusSel) {
      statusSel.addEventListener('change', function () {
        var cidField = document.getElementById('correcao-cid-field');
        if (cidField) {
          var isAtestado = normalizeStatusKey(sanitizeStatus(this.value)) === 'ATESTADO MEDICO';
          var isCidCampo = campos.indexOf('cid') !== -1;
          cidField.style.display = (isAtestado || isCidCampo) ? 'block' : 'none';
        }
      });
    }

    var cbTexto = document.getElementById('corr-saida2-texto-mode');
    if (cbTexto) {
      cbTexto.addEventListener('change', function () {
        var hora = document.getElementById('corr-saida2-hora');
        var texto = document.getElementById('corr-saida2-texto');
        if (this.checked) {
          hora.style.display = 'none';
          texto.style.display = 'block';
        } else {
          hora.style.display = 'block';
          texto.style.display = 'none';
        }
        validateCorrecaoForm();
      });
    }

    camposDiv.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', validateCorrecaoForm);
      inp.addEventListener('change', validateCorrecaoForm);
    });

    validateCorrecaoForm();
    modalCorrecao.classList.add('open', 'active', 'show');
    document.body.style.overflow = 'hidden';
  }

  function validateCorrecaoForm() {
    var ok = true;
    var statusField = document.getElementById('corr-status');
    if (statusField) {
      ok = ok && statusField.value.trim() !== '';
    }
    var saidaField = document.querySelector('.correcao-field[data-field="saida2"]');
    if (saidaField) {
      var modoTexto = document.getElementById('corr-saida2-texto-mode');
      if (modoTexto && modoTexto.checked) {
        var texto = document.getElementById('corr-saida2-texto');
        ok = ok && texto && texto.value.trim() !== '';
      }
    }
    modalCorrecaoSalvar.disabled = !ok;
  }

  function closeCorrecaoModal() {
    modalCorrecao.classList.remove('open', 'active', 'show');
    document.body.style.overflow = '';
    rowIndexEditando = null;
    document.getElementById('correcao-campos').innerHTML = '';
  }

  function handleSalvarCorrecao() {
    if (rowIndexEditando === null) return;
    var row = dadosProcessados.find(function (r) { return r.rowIndex === rowIndexEditando; });
    if (!row) return;

    var incon = inconsistencias.find(function (i) { return i.rowIndex === rowIndexEditando; });
    var campos = (incon && incon.campos) || [];

    if (campos.indexOf('saida2') !== -1) {
      var modoTexto = document.getElementById('corr-saida2-texto-mode');
      if (modoTexto && modoTexto.checked) {
        var texto = document.getElementById('corr-saida2-texto');
        if (!texto || !texto.value.trim()) return;
        row.saida2 = texto.value.trim();
      } else {
        var hora = document.getElementById('corr-saida2-hora');
        if (!hora || !hora.value) return;
        row.saida2 = hora.value;
      }
    }

    if (campos.indexOf('status') !== -1) {
      var statusInput = document.getElementById('corr-status');
      if (statusInput) row.status = sanitizeStatus(statusInput.value.trim());
    }

    var cidInput = document.getElementById('corr-cid');
    if (cidInput && document.getElementById('correcao-cid-field') &&
        document.getElementById('correcao-cid-field').style.display !== 'none') {
      row.cid = cidInput.value.trim();
    }

    row.corrigido = true;
    highlightRow = row.rowIndex;

    inconsistencias = inconsistencias.filter(function (i) {
      return i.rowIndex !== row.rowIndex;
    }).concat(revalidateRow(row));

    closeCorrecaoModal();
    renderAll();
    showToast('Correção aplicada e linha atualizada na prévia.', 'success');

    var tr = document.querySelector('#preview-tbody tr[data-row-index="' + highlightRow + '"]');
    if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });

    var meta = getStatusMeta(row.status);
    if (meta.grupo === 'DEMISSAO') {
      ensureDemissaoPendente(row);
      window.__openModal(getDemissaoIdForRow(row));
    }
  }

  function getDemissaoIdForRow(row) {
    var existing = demissoesPendentes.find(function (d) {
      return d._rowIndex === row.rowIndex;
    });
    if (existing) return existing.id;
    var byNameDia = demissoesPendentes.find(function (d) {
      return (d.nomeFuncionario || '').trim().toUpperCase() === (row.funcionario || '').trim().toUpperCase() &&
        d.dia === formatExcelDate(row.dia);
    });
    return byNameDia ? byNameDia.id : null;
  }

  function ensureDemissaoPendente(row) {
    var id = getDemissaoIdForRow(row);
    if (id) return id;
    var novoId = 'dem_corr_' + row.rowIndex;
    demissoesPendentes.push({
      id: novoId,
      _rowIndex: row.rowIndex,
      nomeFuncionario: row.funcionario,
      matricula: row.matricula,
      dia: formatExcelDate(row.dia),
      cargo: row.funcao,
      departamento: '',
      campoDetectado: 'status',
      valorOriginal: row.status,
      palavraChave: 'demitido'
    });
    return novoId;
  }

  function coletarCorrecoes() {
    return dadosProcessados.filter(function (r) { return r.corrigido; }).map(function (r) {
      var campos = {};
      campos.status = r.status;
      campos.saida2 = normalizeFieldForSave(r.saida2);
      campos.entrada1 = normalizeFieldForSave(r.entrada1);
      campos.cid = r.cid || '';
      return { rowIndex: r.rowIndex, campos: campos };
    });
  }

  function normalizeFieldForSave(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'object') {
      if (val.type === 'time' && val.time !== null && val.time !== undefined) {
        var h = Math.floor(val.time / 60);
        var m = val.time % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      }
      return val.text || null;
    }
    return val;
  }

  function renderDemissoes(pendentes) {
    var section = document.getElementById('demissoes-section');
    var badge = document.getElementById('badge-demissoes');
    var list = document.getElementById('demissoes-list');

    if (!pendentes || pendentes.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    updateDemissoesBadge();

    var fieldLabels = { status: 'Status', entrada1: 'Entrada 1', saida2: 'Saída 2' };

    list.innerHTML = pendentes.map(function (d) {
      var answered = justificativas[d.id];
      return '<div class="demissao-item ' + (answered ? 'answered' : 'pending') + '" id="dem-item-' + d.id + '">' +
        '<div class="demissao-info">' +
          '<div class="demissao-name">' +
            '<i class="bi bi-person-x"></i> ' + esc(d.nomeFuncionario) +
            (answered ? ' <span class="badge badge-success"><i class="bi bi-check"></i> Respondido</span>' : ' <span class="badge badge-danger">Pendente</span>') +
          '</div>' +
          '<div class="demissao-meta">' +
            '<span><i class="bi bi-calendar3"></i> ' + esc(d.dia) + '</span>' +
            '<span><i class="bi bi-briefcase"></i> ' + esc(d.cargo || '—') + '</span>' +
            '<span><i class="bi bi-building"></i> ' + esc(d.departamento || '—') + '</span>' +
            '<span><i class="bi bi-search"></i> Campo: ' + (fieldLabels[d.campoDetectado] || d.campoDetectado) + '</span>' +
            '<span><code>' + esc(d.valorOriginal) + '</code></span>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-sm ' + (answered ? 'btn-outline' : 'btn-primary') + '" onclick="window.__openModal(\'' + d.id + '\')">' +
          (answered ? '<i class="bi bi-pencil"></i> Editar' : '<i class="bi bi-pencil-square"></i> Justificar') +
        '</button>' +
      '</div>';
    }).join('');
  }

  window.__openModal = function (demissaoId) {
    editingDemissaoId = demissaoId;
    var d = demissoesPendentes.find(function (x) { return x.id === demissaoId; });
    if (!d) return;

    var fieldLabels = { status: 'Status', entrada1: 'Entrada 1', saida2: 'Saída 2' };
    document.getElementById('modal-funcionario').textContent = d.nomeFuncionario + (d.matricula ? ' (Mat. ' + d.matricula + ')' : '');
    document.getElementById('modal-detalhe').textContent = d.dia + ' — Campo: ' + (fieldLabels[d.campoDetectado] || d.campoDetectado);
    document.getElementById('modal-valor').textContent = d.valorOriginal;

    var existing = justificativas[demissaoId];
    radioInputs.forEach(function (r) {
      r.checked = existing && r.value === existing;
    });
    modalSalvar.disabled = !existing;

    modal.classList.add('open', 'active', 'show');
    document.body.style.overflow = 'hidden';
  };

  function closeModal() {
    modal.classList.remove('open', 'active', 'show');
    document.body.style.overflow = '';
    editingDemissaoId = null;
  }

  function handleSalvarJustificativa() {
    if (!editingDemissaoId) return;
    var selected = document.querySelector('input[name="justificativa"]:checked');
    if (!selected) return;

    justificativas[editingDemissaoId] = selected.value;
    closeModal();

    var d = demissoesPendentes.find(function (x) { return x.id === editingDemissaoId; });
    if (d) renderDemissoes(demissoesPendentes);
    updateSendButton();
  }

  function updateDemissoesBadge() {
    var total = demissoesPendentes.length;
    var answered = Object.keys(justificativas).length;
    var badge = document.getElementById('badge-demissoes');
    if (answered >= total && total > 0) {
      badge.textContent = total + ' respondidas';
      badge.className = 'badge badge-success';
    } else {
      badge.textContent = (total - answered) + ' pendentes';
      badge.className = 'badge badge-danger';
    }
  }

  function updateSendButton() {
    var total = demissoesPendentes.length;
    var answered = Object.keys(justificativas).length;
    var allAnswered = total === 0 || answered >= total;
    btnEnviarBi.disabled = !allAnswered || !currentLoteId;

    var text = btnEnviarBi.querySelector('span:not(.spinner)');
    if (total > 0 && !allAnswered) {
      text.textContent = 'Justifique as demissões (' + answered + '/' + total + ')';
    } else if (total > 0) {
      text.textContent = 'Enviar para o BI (' + total + ' demissão(ões))';
    } else {
      text.textContent = 'Enviar para o BI';
    }
    updateDemissoesBadge();
  }

  function handleEnviarBi() {
    if (!currentLoteId) return;

    var abs = calcularAbsenteismo(dadosProcessados);
    if (abs.totalPrevistos === 0 && dadosProcessados.length > 0) {
      var naoCatalogados = abs.excluidos.desconhecidos;
      if (naoCatalogados > 0 && !confirm(
        'Atenção: ' + naoCatalogados + ' registro(s) têm status fora do catálogo ' +
        '(não entram no cálculo de absenteísmo). Deseja enviar mesmo assim?'
      )) {
        return;
      }
    }

    var items = demissoesPendentes.filter(function (d) {
      return justificativas[d.id];
    }).map(function (d) {
      return {
        id: d.id,
        codigo: justificativas[d.id],
        nomeFuncionario: d.nomeFuncionario,
        matricula: d.matricula,
        cargo: d.cargo,
        departamento: d.departamento,
        dia: d.dia,
        campoDetectado: d.campoDetectado,
        valorOriginal: d.valorOriginal
      };
    });

    var correcoes = coletarCorrecoes();

    btnEnviarBi.disabled = true;
    var spinner = document.getElementById('btn-bi-spinner');
    if (spinner) spinner.style.display = 'inline-block';
    var text = btnEnviarBi.querySelector('span:not(.spinner)');
    var prevText = text.textContent;
    text.textContent = 'Enviando...';

    fetch(API_URL + '/api/tratamento/confirmar-e-salvar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loteId: currentLoteId, justificativas: items, correcoes: correcoes })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Erro HTTP ' + res.status);
          return data;
        });
      })
      .then(function (data) {
        if (!data.success) throw new Error(data.error);
        try {
          if (data.dadosGravados && data.dadosGravados.length > 0) {
            localStorage.setItem('fDB_Ponto_Tratado', JSON.stringify(data.dadosGravados));
            localStorage.setItem('omega_ponto_data', JSON.stringify(data.dadosGravados));
          }
        } catch (e) {
          console.warn('Erro ao salvar dados confirmados no LocalStorage:', e);
        }
        showSuccess(data.resumo);
      })
      .catch(function (err) {
        alert('Erro ao enviar para o BI: ' + err.message);
        if (spinner) spinner.style.display = 'none';
        text.textContent = prevText;
        updateSendButton();
      });
  }

  function showSuccess(resumo) {
    document.getElementById('demissoes-section').style.display = 'none';
    document.getElementById('inconsistencias-section').style.display = 'none';

    var section = document.getElementById('success-section');
    section.style.display = 'block';
    section.classList.add('fade-in');

    document.getElementById('success-message').innerHTML =
      '<strong>' + resumo.registrosInseridos + '</strong> registros inseridos, ' +
      '<strong>' + resumo.registrosAtualizados + '</strong> atualizados, ' +
      '<strong>' + resumo.desligamentosSalvos + '</strong> desligamento(ões) justificado(s).' +
      (resumo.correcoesAplicadas ? '<br>Correções aplicadas: <strong>' + resumo.correcoesAplicadas + '</strong>' : '') +
      '<br>Turnover Operacional: <strong>' + resumo.turnoverOperacional + '</strong> | ' +
      'Redução de Quadro (excluída): <strong>' + resumo.reducaoQuadro + '</strong>';

    showToast('Dados enviados para o BI com sucesso!', 'success');
    currentLoteId = null;
    btnLimpar.disabled = true;
    btnEnviarBi.disabled = true;
    previewSection.scrollIntoView({ behavior: 'smooth' });
  }

  function handleLimpar() {
    form.reset();
    filePontoName.textContent = 'Nenhum arquivo selecionado';
    previewSection.style.display = 'none';
    hideError();
    setLoading(false);
    btnLimpar.disabled = true;
    currentLoteId = null;
    demissoesPendentes = [];
    justificativas = {};
    editingDemissaoId = null;
    dadosProcessados = [];
    inconsistencias = [];
    highlightRow = null;
    rowIndexEditando = null;
    btnEnviarBi.disabled = true;
    var kpiEl = document.getElementById('kpi-absenteismo-preview');
    if (kpiEl) {
      kpiEl.textContent = 'Absenteísmo: —';
      kpiEl.className = 'badge badge-danger';
    }
    ['preview-section', 'inconsistencias-section', 'demissoes-section', 'success-section'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setLoading(loading, msg) {
    btnProcessar.disabled = loading;
    uploadStatus.style.display = loading ? 'flex' : 'none';
    uploadStatusText.textContent = loading ? (msg || 'Processando...') : '';
    var spinner = document.getElementById('btn-spinner');
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
  }

  function showError(msg) {
    uploadError.textContent = msg;
    uploadError.style.display = 'block';
  }

  function hideError() {
    uploadError.style.display = 'none';
  }

  function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'success');
    toast.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i> <span>' + esc(msg) + '</span>';
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
