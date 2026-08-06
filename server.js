const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { enviarParaImpressoraZPL, gerarCodigoZPL } = require('./printer/zplService');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 1);
const USE_ORACLE = process.env.USE_ORACLE === 'true' || !!process.env.DB_CONNECT_STRING;
const CD_MULTI_EMPRESA = process.env.CD_MULTI_EMPRESA || '1';
const PUBLIC_DIR = path.join(__dirname, 'public');

let oracledb = null;
if (USE_ORACLE) {
  oracledb = require('oracledb');
  if (process.env.ORACLE_CLIENT_LIB_DIR) {
    try {
      oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB_DIR });
      console.log('[Oracle] Thick mode:', process.env.ORACLE_CLIENT_LIB_DIR);
    } catch (err) {
      console.error('[Oracle] Falha ao inicializar client:', err.message);
    }
  }
}

app.use(express.json());
app.use((req, res, next) => {
  const bloqueados = ['.env', 'server.js', 'package.json', 'package-lock.json', '.gitignore'];
  if (bloqueados.includes(path.basename(req.path))) return res.status(403).json({ error: 'Acesso negado.' });
  next();
});
app.use(express.static(PUBLIC_DIR));

const TERMOS_INVALIDOS = [
  'TESTE', 'TREINAMENTO', 'SIMULACAO', 'SIMULAÇÃO', 'DUMMY', 'DEMO',
  'PACIENTE TESTE', 'LEITO VAGO', 'VAGO', 'DESOCUPADO', 'LIVRE',
  'BLOQUEADO', 'MANUTENÇÃO', 'MANUTENCAO', 'HIGIENIZACAO', 'HIGIENIZAÇÃO'
];

function ePacienteReal(item) {
  if (!item) return false;
  const nome = (item.nome_paciente || item.nm_paciente || item.paciente || item.nome || '').trim();
  if (!nome) return false;
  if (TERMOS_INVALIDOS.some(termo => nome.toUpperCase().includes(termo))) return false;
  const atendimento = item.cd_atendimento || item.atendimento_id || item.atendimento || item.prontuario;
  if (!atendimento || String(atendimento).trim() === '0' || String(atendimento).trim() === '') return false;
  const dtAlta = item.dt_alta || item.data_alta || item.dataAlta;
  if (dtAlta && String(dtAlta).trim() !== '') return false;
  return true;
}

// REMOVIDO: bancoLeitosERP com pacientes fixos. A fonte agora é sempre Oracle quando configurado corretamente.

const SQL_LEITOS = `
SELECT
    unid_int.cd_unid_int AS CD_UNID_INT,
    unid_int.ds_unid_int AS DS_UNID_INT,
    atendime.cd_atendimento AS CD_ATENDIMENTO,
    atendime.cd_paciente AS CD_PACIENTE,
    paciente.nm_paciente AS NM_PACIENTE
FROM dbamv.atendime,
     dbamv.unid_int,
     dbamv.leito,
     dbamv.paciente
WHERE atendime.tp_atendimento = 'I'
  AND atendime.cd_leito = leito.cd_leito
  AND leito.cd_unid_int = unid_int.cd_unid_int
  AND atendime.cd_paciente = paciente.cd_paciente
  AND atendime.dt_alta IS NULL
  AND atendime.cd_multi_empresa IN (:cdMultiEmpresa)
  AND unid_int.ds_unid_int LIKE '%CMI%'
ORDER BY atendime.cd_atendimento
`;

async function getConnection() {
  return oracledb.getConnection({
    user: process.env.DB_USER || 'DBAMV',
    password: process.env.DB_PASSWORD,
    connectString: process.env.DB_CONNECT_STRING,
  });
}

async function getLeitosDoHospital() {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(
      SQL_LEITOS,
      { cdMultiEmpresa: CD_MULTI_EMPRESA },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return result.rows.map(r => ({
      id: r.CD_ATENDIMENTO,
      setor: r.DS_UNID_INT,
      nome_paciente: r.NM_PACIENTE,
      cd_atendimento: r.CD_ATENDIMENTO,
      cd_paciente: r.CD_PACIENTE,
      cd_unid_int: r.CD_UNID_INT,
      leito: null,
      data_nasc: null,
      sexo: null,
      dt_internacao: null,
      previsao_alta: null,
      tem_previsao_alta: false,
    }));
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }
}

app.get('/api/leitos', async (req, res) => {
  try {
    if (!USE_ORACLE) {
      return res.status(500).json({
        sucesso: false,
        mensagem: 'USE_ORACLE precisa estar como true e DB_CONNECT_STRING configurado para usar pacientes reais.',
      });
    }

    const brutos = await getLeitosDoHospital();
    const processados = brutos.map(item => ({ ...item, eh_real: ePacienteReal(item) }));

    res.json({
      sucesso: true,
      fonte: 'oracle',
      timestamp: new Date().toISOString(),
      total_bruto: processados.length,
      dados: processados,
    });
  } catch (error) {
    console.error('[/api/leitos] Falha ao consultar Oracle:', error.message);
    res.status(500).json({
      sucesso: false,
      fonte: 'oracle',
      erro_oracle: error.message,
      timestamp: new Date().toISOString(),
      dados: [],
    });
  }
});

app.post('/api/imprimir-zpl', async (req, res) => {
  try {
    const { pacientes, ipImpressora } = req.body;
    const pacientesValidos = pacientes.filter(ePacienteReal);
    if (pacientesValidos.length === 0) {
      return res.status(400).json({ sucesso: false, mensagem: 'Nenhum paciente real valido para impressao.' });
    }
    const resultado = await enviarParaImpressoraZPL(pacientesValidos, ipImpressora);
    res.json({ sucesso: true, mensagem: `Etiquetas enviadas com sucesso! (${pacientesValidos.length})`, resultado });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao imprimir etiquetas ZPL', erro: error.message });
  }
});

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`Servidor de Leitos & Etiquetas rodando em http://localhost:${PORT}`);
  console.log(`Fonte de dados: ${USE_ORACLE ? 'Oracle (DBAMV)' : 'Oracle desativado - configure USE_ORACLE=true e DB_CONNECT_STRING)`);
  console.log(`Refresh automatico sugerido no painel: ${REFRESH_MINUTES} min`);
});
