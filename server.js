require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { printZPL, buildWristbandZPL, buildLabelZPL } = require('./printer/zplService');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3006;
const EVENTOS_FILE = path.join(__dirname, 'eventos-leitos.json');

// ---------- Persistencia simples de status de leitos (fallback JSON) ----------
function readEventos() {
  if (!fs.existsSync(EVENTOS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(EVENTOS_FILE, 'utf-8')); } catch { return {}; }
}
function writeEventos(data) {
  fs.writeFileSync(EVENTOS_FILE, JSON.stringify(data, null, 2));
}

// ---------- Mapeamento de unidade -> hospital (CMI / HPRB) ----------
// Ajuste esta lista de acordo com os nomes reais das unidades no HIS (Soul MV, Tasy, MV2000).
const UNIDADES_CMI = ['UTI Adulto', 'UTI Pediatrica', 'UTI Neonatal', 'CMI'];
const UNIDADES_HPRB = ['Enfermaria 3A', 'Enfermaria 3B', 'Pronto Socorro', 'HPRB'];

function resolverHospital(unidade) {
  if (!unidade) return 'HPRB';
  const u = unidade.toUpperCase();
  if (UNIDADES_CMI.some(x => u.includes(x.toUpperCase()))) return 'CMI';
  if (UNIDADES_HPRB.some(x => u.includes(x.toUpperCase()))) return 'HPRB';
  // fallback: se o nome da unidade comecar com CMI ou HPRB
  if (u.startsWith('CMI')) return 'CMI';
  if (u.startsWith('HPRB')) return 'HPRB';
  return 'HPRB';
}

// ---------- Mock/adaptador de dados de leitos (substituir por consulta Oracle no HIS) ----------
// Em producao, plugar aqui uma consulta como a usada em mapa-dieta-cmi (server.js) via oracledb.
async function getLeitosDoHospital() {
  // Estrutura esperada — adaptar aos campos reais do HIS (ex.: Soul MV, Tasy, MV2000)
  const eventos = readEventos();
  const leitosBase = [
    { unidade: 'UTI Adulto', leito: '01', cd_atendimento: 100234, nm_paciente: 'JOAO DA SILVA', dt_nascimento: '1980-05-10', sexo: 'M', status_leito: 'ocupado' },
    { unidade: 'UTI Adulto', leito: '02', cd_atendimento: null, nm_paciente: null, status_leito: 'livre' },
    { unidade: 'Enfermaria 3A', leito: '301', cd_atendimento: 100235, nm_paciente: 'MARIA OLIVEIRA', dt_nascimento: '1975-02-20', sexo: 'F', status_leito: 'ocupado' },
    { unidade: 'Enfermaria 3A', leito: '302', cd_atendimento: null, nm_paciente: null, status_leito: 'higienizacao' },
  ];
  return leitosBase.map(l => ({
    ...l,
    hospital: resolverHospital(l.unidade),
    ...(eventos[l.leito] || {})
  }));
}

app.get('/api/leitos', async (req, res) => {
  try {
    const leitos = await getLeitosDoHospital();
    res.json(leitos);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/leitos/:leito/status', (req, res) => {
  const { leito } = req.params;
  const { status_leito, usuario } = req.body;
  const eventos = readEventos();
  eventos[leito] = { ...(eventos[leito] || {}), status_leito, atualizado_por: usuario || 'sistema', atualizado_em: new Date().toISOString() };
  writeEventos(eventos);
  res.json({ ok: true });
});

// ---------- Impressao de pulseira/etiqueta ----------
app.post('/api/imprimir/pulseira', async (req, res) => {
  try {
    const { nm_paciente, cd_atendimento, dt_nascimento, sexo, leito, unidade, alergia, printer } = req.body;
    const zpl = buildWristbandZPL({ nm_paciente, cd_atendimento, dt_nascimento, sexo, leito, unidade, alergia });
    await printZPL(zpl, printer);
    res.json({ ok: true, zpl });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/imprimir/etiqueta', async (req, res) => {
  try {
    const { nm_paciente, cd_atendimento, leito, unidade, tipo, printer } = req.body;
    const zpl = buildLabelZPL({ nm_paciente, cd_atendimento, leito, unidade, tipo });
    await printZPL(zpl, printer);
    res.json({ ok: true, zpl });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Preview do ZPL sem enviar a impressora (usa Labelary para renderizar no front)
app.post('/api/imprimir/preview', (req, res) => {
  const { tipo, ...dados } = req.body;
  const zpl = tipo === 'etiqueta' ? buildLabelZPL(dados) : buildWristbandZPL(dados);
  res.json({ zpl });
});

app.listen(PORT, () => console.log(`Painel de Leitos rodando em http://localhost:${PORT}`));
