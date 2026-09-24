const aiCleanerService = require('../services/aiCleanerService');
const aiInsightService = require('../services/aiInsightService');
const snapshotService = require('../services/snapshotService');

async function handleCleanData(req, res) {
  try {
    var pontoData = req.body.pontoData;
    var desligamentoData = req.body.desligamentoData;

    if (!pontoData || !Array.isArray(pontoData) || pontoData.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Dados de ponto são obrigatórios e devem ser um array.'
      });
    }

    if (!desligamentoData || !Array.isArray(desligamentoData)) {
      desligamentoData = [];
    }

    var result = await aiCleanerService.cleanDataWithAI(pontoData, desligamentoData);

    return res.json({
      success: true,
      corrections: result.corrections,
      stats: result.stats
    });
  } catch (err) {
    console.error('Erro na higienização:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno na higienização de dados.'
    });
  }
}

async function handleGenerateInsights(req, res) {
  try {
    var kpis = req.body.kpis;
    var graficos = req.body.graficos;

    if (!kpis) {
      return res.status(400).json({
        success: false,
        error: 'KPIs são obrigatórios para geração de insights.'
      });
    }

    if (!graficos) {
      graficos = {};
    }

    var result = await aiInsightService.generateInsights(kpis, graficos);

    return res.json({
      success: true,
      source: result.source,
      provider: result.provider,
      insights: result.insights
    });
  } catch (err) {
    console.error('Erro na geração de insights:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno na geração de insights.'
    });
  }
}

function handleSaveSnapshot(req, res) {
  try {
    var data = req.body.data;
    var corrections = req.body.corrections || [];
    var insights = req.body.insights || null;

    if (!data) {
      return res.status(400).json({
        success: false,
        error: 'Dados são obrigatórios para salvar snapshot.'
      });
    }

    var result = snapshotService.saveSnapshot(data, corrections, insights);

    if (!result.success) {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('Erro ao salvar snapshot:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao salvar snapshot.'
    });
  }
}

function handleListSnapshots(req, res) {
  try {
    var result = snapshotService.listSnapshots();
    return res.json(result);
  } catch (err) {
    console.error('Erro ao listar snapshots:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao listar snapshots.'
    });
  }
}

function handleGetSnapshot(req, res) {
  try {
    var id = req.params.id;
    var result = snapshotService.getSnapshot(id);
    return res.json(result);
  } catch (err) {
    console.error('Erro ao buscar snapshot:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao buscar snapshot.'
    });
  }
}

function handleDeleteSnapshot(req, res) {
  try {
    var id = req.params.id;
    var result = snapshotService.deleteSnapshot(id);
    return res.json(result);
  } catch (err) {
    console.error('Erro ao excluir snapshot:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao excluir snapshot.'
    });
  }
}

function handleSnapshotDiff(req, res) {
  try {
    var id1 = req.params.id1;
    var id2 = req.params.id2;
    var result = snapshotService.getSnapshotDiff(id1, id2);
    return res.json(result);
  } catch (err) {
    console.error('Erro ao comparar snapshots:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro interno ao comparar snapshots.'
    });
  }
}

module.exports = {
  handleCleanData: handleCleanData,
  handleGenerateInsights: handleGenerateInsights,
  handleSaveSnapshot: handleSaveSnapshot,
  handleListSnapshots: handleListSnapshots,
  handleGetSnapshot: handleGetSnapshot,
  handleDeleteSnapshot: handleDeleteSnapshot,
  handleSnapshotDiff: handleSnapshotDiff
};
