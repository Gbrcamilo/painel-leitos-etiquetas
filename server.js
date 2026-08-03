require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { printZPL, buildWristbandZPL, buildLabelZPL } = require('./printer/zplService');

// ─── Oracle DB ────────────────────────────────────────────────────────────────
let oracledb = null;
try {
  oracledb = require('oracledb');
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
  if (process.env.ORACLE_CLIENT_LIB_DIR) {
    try {
      oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB_DIR });
      console.log('[Oracle] Instant Client carregado:', process.env.ORACLE_CLIENT_LIB_DIR);
    } catch (e) {
      console.warn('[Oracle] initOracleClient (ignorado):', e.message);
    }
  }
} catch (e) {
  console.error('[ERRO] Módulo oracledb não encontrado. Execute: npm install oracledb');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const PORT        = process.env.PORT || 3011;
const EVENTOS_FILE = path.join(__dirname, 'eventos-leitos.json');

// ─── Persistência de status manual e histórico de auditoria ──────────────────
function readEventos() {
  if (!fs.existsSync(EVENTOS_FILE)) return { leitos: {}, historico: [] };
  try {
    const d = JSON.parse(fs.readFileSync(EVENTOS_FILE, 'utf-8'));
    return { leitos: d.leitos || {}, historico: d.historico || [] };
  } catch {
    return { leitos: {}, historico: [] };
  }
}

function writeEventos(data) {
  fs.writeFileSync(EVENTOS_FILE, JSON.stringify(data, null, 2));
}

// ─── Resolver hospital pelo cd_multi_empresa (Soul MV Betim) ─────────────────
function resolverHospital(cdMultiEmpresa, nomeUnidade) {
  if (cdMultiEmpresa == 2) return 'CMI';
  if (cdMultiEmpresa == 1) return 'HPRB';
  // fallback por nome, caso a coluna não venha preenchida
  const u = String(nomeUnidade || '').toUpperCase();
  if (u.startsWith('CMI'))  return 'CMI';
  if (u.startsWith('HPRB')) return 'HPRB';
  return 'OUTRO';
}

// ─── Consulta Oracle — 100% dados reais Soul MV ───────────────────────────────
async function fetchLeitosOracle() {
  if (!oracledb) throw new Error('Módulo oracledb não instalado. Execute: npm install oracledb');
  if (!process.env.DB_USER || !process.env.DB_CONNECT_STRING) {
    throw new Error('Variáveis DB_USER e DB_CONNECT_STRING não definidas no .env');
  }

  let connection;
  try {
    connection = await oracledb.getConnection({
      user:          process.env.DB_USER,
      password:      process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING
    });

    // Query oficial — idêntica ao SQLTools confirmado no hospital
    const sql = `
      SELECT
        lei.cd_leito,
        lei.ds_leito                                AS leito,
        unid.ds_unid_int                            AS unidade,
        unid.cd_multi_empresa,
        a.cd_atendimento,
        TRIM(p.nm_paciente)                         AS nm_paciente,
        TO_CHAR(p.dt_nascimento, 'DD/MM/YYYY')      AS dt_nascimento,
        p.tp_sexo                                   AS sexo,
        NVL(lei.tp_ocupacao,
            CASE WHEN a.cd_atendimento IS NOT NULL
                 THEN 'O' ELSE 'L' END)             AS tp_ocupacao
      FROM dbamv.leito lei
      JOIN dbamv.unid_int unid
        ON lei.cd_unid_int = unid.cd_unid_int
      LEFT JOIN dbamv.atendime a
        ON  lei.cd_leito = a.cd_leito
        AND a.dt_alta IS NULL
        AND a.tp_atendimento IN ('I','U','A')
      LEFT JOIN dbamv.paciente p
        ON a.cd_paciente = p.cd_paciente
      WHERE lei.sn_ativo = 'S'
      ORDER BY unid.ds_unid_int, lei.ds_leito
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: 500
    });

    const dbData = readEventos();

    return result.rows.map(r => {
      // Status de origem: Oracle tp_ocupacao tem prioridade
      let statusBase = 'livre';
      const tp = (r.TP_OCUPACAO || '').toUpperCase();
      if (tp === 'O' || r.CD_ATENDIMENTO) statusBase = 'ocupado';
      else if (tp === 'H' || tp === 'M')  statusBase = 'higienizacao';
      else if (tp === 'R')                statusBase = 'reservado';

      const cdLeito = r.CD_LEITO;
      const nomeLeito = (r.LEITO || '').trim();

      // Se o operador alterou manualmente via painel, prevalece sobre Oracle
      const override = dbData.leitos[cdLeito] || dbData.leitos[nomeLeito] || {};

      return {
        cd_leito:       cdLeito,
        leito:          nomeLeito,
        unidade:        (r.UNIDADE || '').trim(),
        hospital:       resolverHospital(r.CD_MULTI_EMPRESA, r.UNIDADE),
        cd_atendimento: r.CD_ATENDIMENTO  || null,
        nm_paciente:    r.NM_PACIENTE     || null,
        dt_nascimento:  r.DT_NASCIMENTO   || null,
        sexo:           r.SEXO            || null,
        status_leito:   override.status_leito || statusBase
      };
    });

  } finally {
    if (connection) try { await connection.close(); } catch (_) {}
  }
}

// ─── GET /api/leitos — entrega dados reais (sem fallback mock) ────────────────
app.get('/api/leitos', async (req, res) => {
  try {
    const leitos   = await fetchLeitosOracle();
    const dbData   = readEventos();

    // Estatísticas por hospital para log no terminal
    const cmi  = leitos.filter(l => l.hospital === 'CMI').length;
    const hprb = leitos.filter(l => l.hospital === 'HPRB').length;
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Leitos Oracle → CMI: ${cmi} | HPRB: ${hprb} | Total: ${leitos.length}`);

    res.json({ leitos, historico: dbData.historico || [], erro: null });
  } catch (err) {
    console.error('[ERRO /api/leitos]', err.message);
    res.status(503).json({
      leitos:   [],
      historico: [],
      erro: `Falha na conexão com o banco de dados Oracle Soul MV: ${err.message}`
    });
  }
});

// ─── POST /api/leitos/:leito/status — registra alteração manual com auditoria ─
app.post('/api/leitos/:leito/status', (req, res) => {
  const { leito }  = req.params;
  const { status_leito, status_anterior, usuario, cd_leito } = req.body;

  if (!status_leito || !usuario || !usuario.trim()) {
    return res.status(400).json({ erro: 'Informe o novo status e o nome do responsável.' });
  }

  const dbData = readEventos();
  const chave  = cd_leito || leito;   // prefere cd_leito (inteiro) se disponível

  dbData.leitos[chave] = {
    status_leito,
    atualizado_por: usuario.trim(),
    atualizado_em:  new Date().toISOString()
  };

  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  dbData.historico.unshift({
    id:              Date.now(),
    leito,
    status_anterior: status_anterior || '—',
    status_novo:     status_leito,
    usuario:         usuario.trim(),
    hora
  });

  // Mantém no máximo 100 entradas no histórico
  if (dbData.historico.length > 100) dbData.historico.length = 100;

  writeEventos(dbData);
  broadcastSSE();
  res.json({ ok: true });
});

// ─── SSE — Sincronização em tempo real para todos os clientes ─────────────────
const clientesSSE = [];

app.get('/api/leitos/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  clientesSSE.push(res);
  console.log(`[SSE] Cliente conectado. Total: ${clientesSSE.length}`);

  req.on('close', () => {
    const i = clientesSSE.indexOf(res);
    if (i >= 0) clientesSSE.splice(i, 1);
    console.log(`[SSE] Cliente desconectado. Total: ${clientesSSE.length}`);
  });
});

function broadcastSSE() {
  const msg = `data: ${JSON.stringify({ tipo: 'atualizacao', em: new Date().toISOString() })}\n\n`;
  clientesSSE.forEach(r => { try { r.write(msg); } catch (_) {} });
}

// Heartbeat a cada 15s para manter conexões SSE vivas
setInterval(broadcastSSE, 15000);

// ─── Impressão ZPL (Zebra / Elgin) ───────────────────────────────────────────
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  Painel de Leitos → http://localhost:${PORT}        ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Oracle DB : ${oracledb ? '✅ Módulo carregado' : '❌ Não instalado'}`);
  console.log(`  DB_USER   : ${process.env.DB_USER   || '❌ Não definido no .env'}`);
  console.log(`  DB_STRING : ${process.env.DB_CONNECT_STRING || '❌ Não definido no .env'}`);
  console.log('');
});