require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { printZPL, buildWristbandZPL, buildLabelZPL } = require('./printer/zplService');

let oracledb;
try {
  oracledb = require('oracledb');
  if (process.env.ORACLE_CLIENT_LIB_DIR) {
    try { oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB_DIR }); } catch (_) {}
  }
} catch (_) {
  console.log('[AVISO] Módulo oracledb não instalado. Modo Fallback/Mock ativo.');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rota Raiz explícita para garantir entrega do index.html no Codespaces
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = 3011;
const EVENTOS_FILE = path.join(__dirname, 'eventos-leitos.json');

function readEventos() {
  if (!fs.existsSync(EVENTOS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(EVENTOS_FILE, 'utf-8')); } catch { return {}; }
}
function writeEventos(data) {
  fs.writeFileSync(EVENTOS_FILE, JSON.stringify(data, null, 2));
}

// --- Classificação CMI vs HPRB ---
const UNIDADES_CMI = ['UTI ADULTO', 'UTI PEDIATRICA', 'UTI NEONATAL', 'SEMI INTENSIVA', 'CMI'];
const UNIDADES_HPRB = ['ENFERMARIA', 'PRONTO SOCORRO', 'MATERNIDADE', 'CLINICA MEDICA', 'CLINICA CIRURGICA', 'HPRB'];

function resolverHospital(unidade, cdMultiEmpresa) {
  if (cdMultiEmpresa == 2 || String(cdMultiEmpresa).toUpperCase() === 'CMI') return 'CMI';
  if (cdMultiEmpresa == 1 || String(cdMultiEmpresa).toUpperCase() === 'HPRB') return 'HPRB';
  if (!unidade) return 'HPRB';
  const u = String(unidade).toUpperCase();
  if (UNIDADES_CMI.some(x => u.includes(x))) return 'CMI';
  if (UNIDADES_HPRB.some(x => u.includes(x))) return 'HPRB';
  return 'HPRB';
}

// --- Consulta Oracle DB ---
async function fetchLeitosOracle() {
  if (!oracledb || !process.env.DB_USER || !process.env.DB_CONNECT_STRING) return null;

  let connection;
  try {
    connection = await oracledb.getConnection({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING
    });

    const sql = `
      SELECT 
        l.cd_leito,
        l.ds_leito AS leito,
        u.ds_unid_int AS unidade,
        u.cd_multi_empresa,
        a.cd_atendimento,
        p.nm_paciente,
        TO_CHAR(p.dt_nascimento, 'YYYY-MM-DD') AS dt_nascimento,
        p.tp_sexo AS sexo,
        NVL(l.tp_ocupacao, CASE WHEN a.cd_atendimento IS NOT NULL THEN 'O' ELSE 'L' END) AS st_leito_raw
      FROM DBAMV.LEITO l
      JOIN DBAMV.UNID_INT u ON l.cd_unid_int = u.cd_unid_int
      LEFT JOIN DBAMV.ATENDIME a ON l.cd_leito = a.cd_leito AND a.dt_alta IS NULL AND a.tp_atendimento = 'I'
      LEFT JOIN DBAMV.PACIENTE p ON a.cd_paciente = p.cd_paciente
      WHERE l.sn_ativo = 'S'
      ORDER BY u.ds_unid_int, l.ds_leito
    `;

    const result = await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    
    return result.rows.map(r => {
      let st = 'livre';
      if (r.CD_ATENDIMENTO || r.ST_LEITO_RAW === 'O') st = 'ocupado';
      else if (r.ST_LEITO_RAW === 'H' || r.ST_LEITO_RAW === 'M') st = 'higienizacao';
      else if (r.ST_LEITO_RAW === 'R') st = 'reservado';

      return {
        cd_leito: r.CD_LEITO,
        leito: r.LEITO,
        unidade: r.UNIDADE,
        hospital: resolverHospital(r.UNIDADE, r.CD_MULTI_EMPRESA),
        cd_atendimento: r.CD_ATENDIMENTO || null,
        nm_paciente: r.NM_PACIENTE || null,
        dt_nascimento: r.DT_NASCIMENTO || null,
        sexo: r.SEXO || null,
        status_leito: st
      };
    });
  } catch (err) {
    console.error('[ERRO ORACLE]', err.message);
    return null;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

// --- Base de Dados (CMI e HPRB) ---
const UNIDADES_SEED = [
  { unidade: 'UTI ADULTO CMI', qtdLeitos: 10, hospital: 'CMI' },
  { unidade: 'UTI PEDIATRICA CMI', qtdLeitos: 6, hospital: 'CMI' },
  { unidade: 'UTI NEONATAL CMI', qtdLeitos: 8, hospital: 'CMI' },
  { unidade: 'SEMI INTENSIVA CMI', qtdLeitos: 8, hospital: 'CMI' },
  { unidade: 'ENFERMARIA 1A HPRB', qtdLeitos: 12, hospital: 'HPRB' },
  { unidade: 'ENFERMARIA 2A HPRB', qtdLeitos: 12, hospital: 'HPRB' },
  { unidade: 'PRONTO SOCORRO HPRB', qtdLeitos: 15, hospital: 'HPRB' },
  { unidade: 'MATERNIDADE HPRB', qtdLeitos: 10, hospital: 'HPRB' },
  { unidade: 'CLINICA MEDICA HPRB', qtdLeitos: 14, hospital: 'HPRB' }
];

function gerarLeitosMock() {
  const leitos = [];
  let atdId = 200001;
  UNIDADES_SEED.forEach((u, uIdx) => {
    for (let i = 1; i <= u.qtdLeitos; i++) {
      const isOcupado = (i % 3 !== 0);
      const isHig = (i === 3);
      const st = isOcupado ? 'ocupado' : (isHig ? 'higienizacao' : 'livre');
      leitos.push({
        cd_leito: uIdx * 100 + i,
        unidade: u.unidade,
        leito: `L-${String(i).padStart(2, '0')}`,
        hospital: u.hospital,
        cd_atendimento: isOcupado ? atdId++ : null,
        nm_paciente: isOcupado ? `PACIENTE LEITO ${u.hospital} ${i}` : null,
        dt_nascimento: isOcupado ? '1985-05-12' : null,
        sexo: isOcupado ? (i % 2 === 0 ? 'M' : 'F') : null,
        status_leito: st
      });
    }
  });
  return leitos;
}

async function getLeitos() {
  let oracleData = null;
  try {
    oracleData = await fetchLeitosOracle();
  } catch (e) {
    console.error('[ERRO BUSCA LEITOS]', e);
  }

  const base = (Array.isArray(oracleData) && oracleData.length > 0) ? oracleData : gerarLeitosMock();
  const eventos = readEventos();

  return base.map(l => ({
    ...l,
    hospital: l.hospital || resolverHospital(l.unidade),
    ...(eventos[l.leito] || {})
  }));
}

// --- API REST ---
app.get('/api/leitos', async (req, res) => {
  try {
    const leitos = await getLeitos();
    res.json(Array.isArray(leitos) ? leitos : []);
  } catch (e) {
    console.error('[ERRO ROTA /api/leitos]', e);
    res.json(gerarLeitosMock());
  }
});

app.post('/api/leitos/:leito/status', (req, res) => {
  const { leito } = req.params;
  const { status_leito, usuario } = req.body;
  const eventos = readEventos();
  eventos[leito] = { ...(eventos[leito] || {}), status_leito, atualizado_por: usuario || 'painel', atualizado_em: new Date().toISOString() };
  writeEventos(eventos);
  broadcastSSE();
  res.json({ ok: true });
});

// --- Server-Sent Events (SSE) ---
const clientesSSE = [];

app.get('/api/leitos/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clientesSSE.push(res);

  req.on('close', () => {
    const idx = clientesSSE.indexOf(res);
    if (idx >= 0) clientesSSE.splice(idx, 1);
  });
});

function broadcastSSE() {
  clientesSSE.forEach(res => {
    try { res.write(`data: ${JSON.stringify({ tipo: 'atualizacao', em: new Date().toISOString() })}\n\n`); } catch (_) {}
  });
}

setInterval(broadcastSSE, 10000);

// --- Rotas de Impressão (ZPL) ---
app.post('/api/imprimir/pulseira', async (req, res) => {
  try {
    const zpl = buildWristbandZPL(req.body);
    await printZPL(zpl, req.body.printer);
    res.json({ ok: true, zpl });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/imprimir/etiqueta', async (req, res) => {
  try {
    const zpl = buildLabelZPL(req.body);
    await printZPL(zpl, req.body.printer);
    res.json({ ok: true, zpl });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/imprimir/preview', (req, res) => {
  const { tipo, ...dados } = req.body;
  const zpl = tipo === 'etiqueta' ? buildLabelZPL(dados) : buildWristbandZPL(dados);
  res.json({ zpl });
});

// ESCUTA EM 0.0.0.0 PARA COMPATIBILIDADE COM GITHUB CODESPACES E CONTAINERS
app.listen(PORT, '0.0.0.0', () => console.log(`Painel de Leitos rodando na porta ${PORT}: http://0.0.0.0:${PORT}`));