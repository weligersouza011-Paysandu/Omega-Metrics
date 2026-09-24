const fs = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'snapshots');
const INDEX_FILE = path.join(SNAPSHOTS_DIR, 'index.json');

function ensureSnapshotsDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function loadIndex() {
  ensureSnapshotsDir();
  if (!fs.existsSync(INDEX_FILE)) {
    return { snapshots: [] };
  }
  try {
    var raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { snapshots: [] };
  }
}

function saveIndex(index) {
  ensureSnapshotsDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

function generateSnapshotId() {
  var now = new Date();
  var year = now.getFullYear();
  var month = String(now.getMonth() + 1).padStart(2, '0');
  return year + '-' + month;
}

function saveSnapshot(data, corrections, insights) {
  ensureSnapshotsDir();

  var id = generateSnapshotId();
  var filePath = path.join(SNAPSHOTS_DIR, id + '.json');

  if (fs.existsSync(filePath)) {
    return {
      success: false,
      error: 'Snapshot para este período já existe: ' + id + '. Exclua o existente antes de salvar um novo.',
      snapshotId: id
    };
  }

  var snapshot = {
    id: id,
    createdAt: new Date().toISOString(),
    periodo: data.processamento ? data.processamento.ponto.periodo : null,
    kpis: data.kpis || null,
    graficos: data.graficos || null,
    processamento: data.processamento || null,
    inconsistencias: data.inconsistencias || null,
    efetivoTotal: data.efetivoTotal || null,
    corrections: corrections || [],
    insights: insights || null
  };

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

  var index = loadIndex();
  var kpisResumo = null;
  if (snapshot.kpis) {
    kpisResumo = {
      absenteismo: snapshot.kpis.absenteismo ? snapshot.kpis.absenteismo.percentual : 0,
      aderencia: snapshot.kpis.aderencia ? snapshot.kpis.aderencia.percentual : 0,
      turnover: snapshot.kpis.turnover ? snapshot.kpis.turnover.percentual : 0
    };
  }

  index.snapshots.push({
    id: id,
    periodo: snapshot.periodo
      ? snapshot.periodo.inicio + ' — ' + snapshot.periodo.fim
      : 'Período não informado',
    createdAt: snapshot.createdAt,
    kpisResumo: kpisResumo
  });

  index.snapshots.sort(function (a, b) {
    return b.id.localeCompare(a.id);
  });

  saveIndex(index);

  return {
    success: true,
    snapshotId: id,
    path: 'snapshots/' + id + '.json'
  };
}

function getSnapshot(id) {
  var filePath = path.join(SNAPSHOTS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'Snapshot não encontrado: ' + id };
  }
  try {
    var raw = fs.readFileSync(filePath, 'utf-8');
    return { success: true, data: JSON.parse(raw) };
  } catch (e) {
    return { success: false, error: 'Erro ao ler snapshot: ' + e.message };
  }
}

function listSnapshots() {
  var index = loadIndex();
  return {
    success: true,
    snapshots: index.snapshots,
    total: index.snapshots.length
  };
}

function deleteSnapshot(id) {
  var filePath = path.join(SNAPSHOTS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'Snapshot não encontrado: ' + id };
  }

  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    return { success: false, error: 'Erro ao excluir arquivo: ' + e.message };
  }

  var index = loadIndex();
  index.snapshots = index.snapshots.filter(function (s) {
    return s.id !== id;
  });
  saveIndex(index);

  return { success: true, message: 'Snapshot ' + id + ' excluído com sucesso.' };
}

function getSnapshotDiff(id1, id2) {
  var snap1 = getSnapshot(id1);
  var snap2 = getSnapshot(id2);

  if (!snap1.success || !snap2.success) {
    return {
      success: false,
      error: !snap1.success ? snap1.error : snap2.error
    };
  }

  var s1 = snap1.data;
  var s2 = snap2.data;

  function diff(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
      return {
        anterior: a,
        atual: b,
        variacao: parseFloat((b - a).toFixed(2)),
        variacaoPercentual: a !== 0 ? parseFloat((((b - a) / a) * 100).toFixed(2)) : null
      };
    }
    return { anterior: a, atual: b };
  }

  var kpiDiff = {};
  if (s1.kpis && s2.kpis) {
    kpiDiff = {
      absenteismo: diff(
        s1.kpis.absenteismo ? s1.kpis.absenteismo.percentual : 0,
        s2.kpis.absenteismo ? s2.kpis.absenteismo.percentual : 0
      ),
      aderencia: diff(
        s1.kpis.aderencia ? s1.kpis.aderencia.percentual : 0,
        s2.kpis.aderencia ? s2.kpis.aderencia.percentual : 0
      ),
      turnover: diff(
        s1.kpis.turnover ? s1.kpis.turnover.percentual : 0,
        s2.kpis.turnover ? s2.kpis.turnover.percentual : 0
      )
    };
  }

  return {
    success: true,
    comparativo: {
      snapshot1: { id: s1.id, periodo: s1.periodo },
      snapshot2: { id: s2.id, periodo: s2.periodo },
      kpis: kpiDiff
    }
  };
}

module.exports = {
  saveSnapshot: saveSnapshot,
  getSnapshot: getSnapshot,
  listSnapshots: listSnapshots,
  deleteSnapshot: deleteSnapshot,
  getSnapshotDiff: getSnapshotDiff
};
