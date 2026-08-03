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
const UNIDADES_CMI = ['UTI Adulto', 'UTI Pediatrica', 'UTI Neonatal', 'Semi Intensiva', 'CMI'];
const UNIDADES_HPRB = ['Enfermaria', 'Pronto Socorro', 'Maternidade', 'Clinica Medica', 'Clinica Cirurgica', 'HPRB'];

function resolverHospital(unidade) {
  if (!unidade) return 'HPRB';
  const u = unidade.toUpperCase();
  if (UNIDADES_CMI.some(x => u.includes(x.toUpperCase()))) return 'CMI';
  if (UNIDADES_HPRB.some(x => u.includes(x.toUpperCase()))) return 'HPRB';
  if (u.startsWith('CMI')) return 'CMI';
  if (u.startsWith('HPRB')) return 'HPRB';
  return 'HPRB';
}

// ---------- Base ampliada de unidades e leitos (mock) ----------
// Em producao, substituir getLeitosDoHospital() por consulta Oracle real (oracledb),
// seguindo o padrao usado em mapa-dieta-cmi/server.js.
const UNIDADES_SEED = [
  { unidade: 'UTI Adulto', qtdLeitos: 10 },
  { unidade: 'UTI Pediatrica', qtdLeitos: 6 },
  { unidade: 'UTI Neonatal', qtdLeitos: 8 },
  { unidade: 'Semi Intensiva', qtdLeitos: 8 },
  { unidade: 'Enfermaria 1A', qtdLeitos: 12 },
  { unidade: 'Enfermaria 2A', qtdLeitos: 12 },
  { unidade: 'Enfermaria 3A', qtdLeitos: 12 },
  { unidade: 'Pronto Socorro', qtdLeitos: 15 },
  { unidade: 'Maternidade', qtdLeitos: 10 },
  { unidade: 'Clinica Medica', qtdLeitos: 14 },
  { unidade: 'Clinica Cirurgica', qtdLeitos: 10 },
];

const NOMES_MOCK = [
  'JOAO DA SILVA', 'MARIA OLIVEIRA', 'CARLOS SOUZA', 'ANA PEREIRA', 'PEDRO LIMA',
  'FRANCISCA ALVES', 'JOSE FERREIRA', 'ANTONIA RODRIGUES', 'PAULO GOMES', 'MARCIA COSTA',
  'RAIMUNDO MARTINS', 'LUCIA BARBOSA', 'SEBASTIAO ROCHA', 'VERA DIAS', 'MANOEL NUNES',
  'TEREZA CARDOSO', 'FRANCISCO MOREIRA', 'ROSA TEIXEIRA', 'GERALDO PINTO', 'IVONE CAMPOS'
];

function gerarStatusAleatorio(seed) {
  const opcoes = ['ocupado', 'ocupado', 'ocupado', 'livre', 'higienizacao'];
  return opcoes[seed % opcoes.length];
}

// Gera a base de leitos de forma deterministica (mesmos dados a cada chamada,
// a menos que sejam sobrescritos pelos eventos de status salvos em disco).
function gerarLeitosBase() {
  const leitos = [];
  let contadorPaciente = 100001;
  let nomeIdx = 0;

  UNIDADES_SEED.forEach((u, uIdx) => {
    for (let i = 1; i <= u.qtdLeitos; i++) {
      const seed = uIdx * 100 + i;
      const status = gerarStatusAleatorio(seed);
      const ocupado = status === 'ocupado';
      const leitoNum = String(i).padStart(2, '0');

      leitos.push({
        unidade: u.unidade,
        leito: `${u.unidade.replace(/\s+/g, '').slice(0,3).toUpperCase()}-${leitoNum}`,
        cd_atendimento: ocupado ? contadorPaciente++ : null,
        nm_paciente: ocupado ? NOMES_MOCK[nomeIdx++ % NOMES_MOCK.length] : null,
        dt_nascimento: ocupado ? `19${60 + (seed % 40)}-0${1 + (seed % 9)}-1${seed % 10}` : null,
        sexo: ocupado ? (seed % 2 === 0 ? 'M' : 'F') : null,
        status_leito: status
      });
    }
  });

  return leitos;
}

// ---------- Adaptador de dados de leitos ----------
// Em producao, plugar aqui uma consulta Oracle como a usada em mapa-dieta-cmi (server.js) via oracledb.
async function getLeitosDoHospital() {
  const eventos = readEventos();
  const leitosBase = gerarLeitosBase();

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
  broadcastAtualizacao();
  res.json({ ok: true });
});

// ---------- Tempo real via Server-Sent Events (SSE) ----------
// O front assina /api/leitos/stream e recebe um evento sempre que os dados mudarem,
// alem de um heartbeat periodico para manter viva a conexao e forcar refresh.
const clientesSSE = [];

app.get('/api/leitos/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clientesSSE.push(res);

  req.on('close', () => {
    const idx = clientesSSE.indexOf(res);
    if (idx >= 0) clientesSSE.splice(idx, 1);
  });
});

function broadcastAtualizacao() {
  clientesSSE.forEach(res => {
    try { res.write(`data: ${JSON.stringify({ tipo: 'atualizacao', em: new Date().toISOString() })}\n\n`); } catch {}
  });
}

// Heartbeat: garante atualizacao periodica mesmo sem mudancas manuais (ex.: sincronizacao com HIS)
setInterval(broadcastAtualizacao, 10000);

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
