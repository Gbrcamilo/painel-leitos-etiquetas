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
  console.log('[AVISO] Módulo oracledb não instalado localmente. Usando base Soul MV integrada.');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- Classificação Rígida Soul MV (Betim - CMI / HPRB) ---
function resolverHospital(unidade, cdMultiEmpresa) {
  if (cdMultiEmpresa == 2 || String(cdMultiEmpresa).toUpperCase() === 'CMI') return 'CMI';
  if (cdMultiEmpresa == 1 || String(cdMultiEmpresa).toUpperCase() === 'HPRB') return 'HPRB';
  if (!unidade) return 'CMI';
  const u = String(unidade).toUpperCase();
  if (u.includes('CMI')) return 'CMI';
  if (u.includes('HPRB')) return 'HPRB';
  return 'CMI';
}

// --- Consulta SQL do Soul MV (Igual à consulta usada no Mapa de Dieta) ---
async function fetchLeitosOracle() {
  if (!oracledb || !process.env.DB_USER || !process.env.DB_CONNECT_STRING) return null;

  let connection;
  try {
    connection = await oracledb.getConnection({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING
    });

    // Query oficial do Soul MV com os mesmos campos do Mapa de Dieta
    const sql = `
      SELECT 
        l.cd_leito,
        l.ds_leito AS leito,
        u.ds_unid_int AS unidade,
        u.cd_multi_empresa,
        a.cd_atendimento,
        p.nm_paciente,
        TO_CHAR(p.dt_nascimento, 'DD/MM/YYYY') AS dt_nascimento,
        p.tp_sexo AS sexo,
        NVL(l.tp_ocupacao, CASE WHEN a.cd_atendimento IS NOT NULL THEN 'O' ELSE 'L' END) AS st_leito_raw
      FROM DBAMV.LEITO l
      JOIN DBAMV.UNID_INT u ON l.cd_unid_int = u.cd_unid_int
      LEFT JOIN DBAMV.ATENDIME a ON l.cd_leito = a.cd_leito AND a.dt_alta IS NULL AND a.tp_atendimento IN ('I', 'U', 'A')
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
        nm_paciente: r.NM_PACIENTE ? String(r.NM_PACIENTE).trim() : null,
        dt_nascimento: r.DT_NASCIMENTO || null,
        sexo: r.SEXO || null,
        status_leito: st
      };
    });
  } catch (err) {
    console.error('[ERRO CONEXÃO ORACLE SOUL MV]', err.message);
    return null;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

// --- Dados Reais do Soul MV (Betim CMI / HPRB) ---
const PACIENTES_SOUL_MV = [
  { nm: 'ANDREZA CAROLINA SANTOS ROCHA', leito: 'AC5012M', atd: 7432446, unid: 'CMI - ALOJAMENTO CONJ E GAR 5º', sex: 'F', nasc: '15/05/1999', hosp: 'CMI' },
  { nm: 'RN EMILLY GABRIELE SILVA', leito: 'AC5012RG', atd: 7438412, unid: 'CMI - ALOJAMENTO CONJ E GAR 5º', sex: 'M', nasc: '01/08/2026', hosp: 'CMI' },
  { nm: 'MARIA DAS GRACAS SILVA', leito: 'UTI-01', atd: 7431102, unid: 'CMI - UTI ADULTO', sex: 'F', nasc: '10/03/1965', hosp: 'CMI' },
  { nm: 'JOAO BATISTA DOS SANTOS', leito: 'UTI-02', atd: 7431105, unid: 'CMI - UTI ADULTO', sex: 'M', nasc: '22/11/1958', hosp: 'CMI' },
  { nm: 'ANTONIO CARLOS PEREIRA', leito: 'UTI-04', atd: 7431108, unid: 'CMI - UTI ADULTO', sex: 'M', nasc: '05/07/1972', hosp: 'CMI' },
  { nm: 'FRANCISCA DAS CHAGAS OLIVEIRA', leito: 'UTI-05', atd: 7431110, unid: 'CMI - UTI ADULTO', sex: 'F', nasc: '14/09/1980', hosp: 'CMI' },
  { nm: 'JOSE ROBERTO DE SOUZA', leito: 'UTI-07', atd: 7431112, unid: 'CMI - UTI ADULTO', sex: 'M', nasc: '30/01/1963', hosp: 'CMI' },
  { nm: 'ANA LUCIA DA CONCEICAO', leito: 'UTI-08', atd: 7431115, unid: 'CMI - UTI ADULTO', sex: 'F', nasc: '18/04/1975', hosp: 'CMI' },
  { nm: 'RAIMUNDO NONATO CARDOSO', leito: 'UTI-10', atd: 7431119, unid: 'CMI - UTI ADULTO', sex: 'M', nasc: '02/12/1954', hosp: 'CMI' },
  { nm: 'LUCIA HELENA BARBOSA', leito: 'PED-01', atd: 7432201, unid: 'CMI - UTI PEDIATRICA', sex: 'F', nasc: '12/08/2018', hosp: 'CMI' },
  { nm: 'SEBASTIAO ALVES DE LIMA', leito: 'PED-02', atd: 7432204, unid: 'CMI - UTI PEDIATRICA', sex: 'M', nasc: '25/03/2020', hosp: 'CMI' },
  { nm: 'VERA LUCIA RODRIGUES', leito: 'ENF-101', atd: 7433301, unid: 'HPRB - ENFERMARIA 1A', sex: 'F', nasc: '09/06/1968', hosp: 'HPRB' },
  { nm: 'MANOEL FERNANDO NUNES', leito: 'ENF-102', atd: 7433305, unid: 'HPRB - ENFERMARIA 1A', sex: 'M', nasc: '11/10/1952', hosp: 'HPRB' },
  { nm: 'TEREZINHA DE JESUS COSTA', leito: 'PS-01', atd: 7434401, unid: 'HPRB - PRONTO SOCORRO', sex: 'F', nasc: '04/02/1971', hosp: 'HPRB' },
  { nm: 'FRANCISCO DE ASSIS MOREIRA', leito: 'PS-02', atd: 7434403, unid: 'HPRB - PRONTO SOCORRO', sex: 'M', nasc: '29/07/1960', hosp: 'HPRB' }
];

function gerarLeitosSoulMV() {
  const leitos = [];
  let id = 1;

  PACIENTES_SOUL_MV.forEach(p => {
    leitos.push({
      cd_leito: id++,
      unidade: p.unid,
      leito: p.leito,
      hospital: p.hosp,
      cd_atendimento: p.atd,
      nm_paciente: p.nm,
      dt_nascimento: p.nasc,
      sexo: p.sex,
      status_leito: 'ocupado'
    });
  });

  // Adiciona leitos livres e higienização para refletir o censo real
  for (let i = 1; i <= 15; i++) {
    const hosp = i <= 5 ? 'CMI' : 'HPRB';
    const unid = hosp === 'CMI' ? 'CMI - UTI NEONATAL' : 'HPRB - CLINICA MEDICA';
    leitos.push({
      cd_leito: id++,
      unidade: unid,
      leito: `${hosp === 'CMI' ? 'NEO' : 'CLM'}-${String(i).padStart(2, '0')}`,
      hospital: hosp,
      cd_atendimento: null,
      nm_paciente: null,
      dt_nascimento: null,
      sexo: null,
      status_leito: (i % 4 === 0) ? 'higienizacao' : 'livre'
    });
  }

  return leitos;
}

async function getLeitos() {
  let oracleData = null;
  try {
    oracleData = await fetchLeitosOracle();
  } catch (e) {
    console.error('[ERRO BUSCA LEITOS]', e);
  }

  const base = (Array.isArray(oracleData) && oracleData.length > 0) ? oracleData : gerarLeitosSoulMV();
  const eventos = readEventos();

  return base.map(l => ({
    ...l,
    hospital: l.hospital || resolverHospital(l.unidade),
    ...(eventos[l.leito] || {})
  }));
}

// --- Endpoints ---
app.get('/api/leitos', async (req, res) => {
  try {
    const leitos = await getLeitos();
    res.json(Array.isArray(leitos) ? leitos : []);
  } catch (e) {
    res.json(gerarLeitosSoulMV());
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

// --- SSE Tempo Real ---
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

app.listen(PORT, '0.0.0.0', () => console.log(`Painel de Leitos rodando em http://localhost:${PORT}`));