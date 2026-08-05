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

// ─── Oracle (Thick Mode, mesmo padrao do mapa-dieta-cmi) ──────────────────
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

// Bloqueia acesso a arquivos sensiveis (mesmo padrao do mapa-dieta-cmi)
app.use((req, res, next) => {
  const bloqueados = ['.env', 'server.js', 'package.json', 'package-lock.json', '.gitignore'];
  if (bloqueados.includes(path.basename(req.path))) return res.status(403).json({ error: 'Acesso negado.' });
  next();
});

app.use(express.static(PUBLIC_DIR));

// Lista de termos para descartar cadastros ficticios/teste
const TERMOS_INVALIDOS = [
  'TESTE', 'TREINAMENTO', 'SIMULACAO', 'SIMULAÇÃO', 'DUMMY', 'DEMO',
  'PACIENTE TESTE', 'LEITO VAGO', 'VAGO', 'DESOCUPADO', 'LIVRE',
  'BLOQUEADO', 'MANUTENÇÃO', 'MANUTENCAO', 'HIGIENIZACAO', 'HIGIENIZAÇÃO'
];

/**
 * Funcao de validacao: Retorna true apenas para pacientes reais e ativos
 */
function ePacienteReal(item) {
  if (!item) return false;

  const nome = (item.nome_paciente || item.nm_paciente || item.paciente || item.nome || '').trim();
  if (!nome) return false;

  const nomeUpper = nome.toUpperCase();
  const ehInvalido = TERMOS_INVALIDOS.some(termo => nomeUpper.includes(termo));
  if (ehInvalido) return false;

  const atendimento = item.cd_atendimento || item.atendimento_id || item.atendimento || item.prontuario;
  if (!atendimento || String(atendimento).trim() === '0' || String(atendimento).trim() === '') {
    return false;
  }

  const dtAlta = item.dt_alta || item.data_alta || item.dataAlta;
  if (dtAlta && String(dtAlta).trim() !== '') {
    return false;
  }

  return true;
}

// SIMULACAO DE BANCO DE DADOS / ERP HOSPITALAR (fallback quando Oracle nao esta configurado)
let bancoLeitosERP = [
  { id: 101, leito: 'UTI-01', setor: 'UTI NEONATAL', nome_paciente: 'HELENA SILVA SANTOS', cd_atendimento: '849201', data_nasc: '2026-07-10', dieta: 'ENTERAL', alergia: 'Lactose', dt_internacao: '2026-07-15 10:30', previsao_alta: '2026-08-07', tem_previsao_alta: true },
  { id: 102, leito: 'UTI-02', setor: 'UTI NEONATAL', nome_paciente: 'ARTHUR OLIVEIRA COSTA', cd_atendimento: '849205', data_nasc: '2026-07-18', dieta: 'ZERO', alergia: 'Nenhuma', dt_internacao: '2026-07-20 14:15', previsao_alta: null, tem_previsao_alta: false },
  { id: 103, leito: 'UTI-03', setor: 'UTI NEONATAL', nome_paciente: 'PACIENTE TESTE TREINAMENTO', cd_atendimento: '999999', data_nasc: '2020-01-01', dieta: 'GERAL' },
  { id: 104, leito: 'UTI-04', setor: 'UTI NEONATAL', nome_paciente: 'LEITO VAGO', cd_atendimento: '0' },
  { id: 201, leito: 'MAT-101', setor: 'MATERNIDADE', nome_paciente: 'MARIA EDUARDA PEREIRA', cd_atendimento: '850112', data_nasc: '1998-04-12', dieta: 'GERAL', alergia: 'Dipirona', dt_internacao: '2026-08-02 11:20', previsao_alta: '2026-08-06', tem_previsao_alta: true },
  { id: 202, leito: 'MAT-102', setor: 'MATERNIDADE', nome_paciente: 'BEATRIZ FERREIRA LIMA', cd_atendimento: '850115', data_nasc: '1995-11-23', dieta: 'BRANDA', alergia: 'Penicilina', dt_internacao: '2026-08-02 16:40', previsao_alta: null, tem_previsao_alta: false },
  { id: 203, leito: 'MAT-103', setor: 'MATERNIDADE', nome_paciente: 'SIMULACAO SISTEMA CMI', cd_atendimento: '88888' },
  { id: 301, leito: 'ENF-201-A', setor: 'ENFERMARIA', nome_paciente: 'JOAO GABRIEL RODRIGUES', cd_atendimento: '847330', data_nasc: '1972-03-15', dieta: 'PASTOSA', alergia: 'Nenhuma', dt_internacao: '2026-07-28 09:10', previsao_alta: '2026-08-05', tem_previsao_alta: true },
  { id: 302, leito: 'ENF-201-B', setor: 'ENFERMARIA', nome_paciente: 'CARLOS ALBERTO SOUZA', cd_atendimento: '847335', data_nasc: '1965-09-08', dieta: 'LIQUIDA', alergia: 'AAS', dt_internacao: '2026-07-29 15:00', previsao_alta: null, tem_previsao_alta: false },
  { id: 401, leito: 'PED-01', setor: 'PEDIATRIA', nome_paciente: 'GABRIEL ENZO ALVES', cd_atendimento: '850401', data_nasc: '2021-05-19', dieta: 'BRANDA', alergia: 'Nenhuma', dt_internacao: '2026-08-01 18:22', previsao_alta: null, tem_previsao_alta: false }
];

// ─── SQL Leitos + Pacientes Internados (BASE validada pelo usuario) ───────
// Baseado na query real que retorna corretamente os pacientes internados:
//   tp_atendimento = 'I', dt_alta IS NULL, cd_multi_empresa filtrado.
// Join extra com previsao_alta (LEFT JOIN) para nao perder nenhum atendimento
// caso o paciente ainda nao tenha previsao cadastrada.
const SQL_LEITOS = `
SELECT
    unid_int.cd_unid_int                               AS CD_UNID_INT,
    unid_int.ds_unid_int                               AS DS_UNID_INT,
    atendime.cd_atendimento                            AS CD_ATENDIMENTO,
    atendime.cd_paciente                               AS CD_PACIENTE,
    paciente.nm_paciente                               AS NM_PACIENTE,
    TO_CHAR(paciente.dt_nascimento, 'DD/MM/YYYY')      AS DT_NASCIM,
    paciente.tp_sexo                                   AS TP_SEXO,
    leito.ds_leito                                     AS DS_LEITO,
    leito.ds_resumo                                    AS DS_RESUMO,
    TO_CHAR(atendime.dt_entrada, 'DD/MM/YYYY HH24:MI') AS DT_INTERNACAO,
    TO_CHAR(prev_alta.dt_previsao_alta, 'DD/MM/YYYY')  AS DT_PREVISAO_ALTA,
    CASE WHEN prev_alta.dt_previsao_alta IS NOT NULL THEN 'SIM' ELSE 'NAO' END AS TEM_PREVISAO_ALTA
FROM dbamv.atendime atendime,
     dbamv.unid_int  unid_int,
     dbamv.leito     leito,
     dbamv.paciente  paciente
LEFT JOIN dbamv.previsao_alta prev_alta ON prev_alta.cd_atendimento = atendime.cd_atendimento
WHERE atendime.tp_atendimento = 'I'
  AND atendime.cd_leito = leito.cd_leito
  AND leito.cd_unid_int = unid_int.cd_unid_int
  AND atendime.cd_paciente = paciente.cd_paciente
  AND atendime.dt_alta IS NULL
  AND atendime.cd_multi_empresa IN (:cdMultiEmpresa)
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
      leito: r.DS_LEITO,
      setor: r.DS_UNID_INT,
      nome_paciente: r.NM_PACIENTE,
      cd_atendimento: r.CD_ATENDIMENTO,
      cd_paciente: r.CD_PACIENTE,
      data_nasc: r.DT_NASCIM,
      sexo: r.TP_SEXO,
      dt_internacao: r.DT_INTERNACAO,
      previsao_alta: r.DT_PREVISAO_ALTA || null,
      tem_previsao_alta: r.TEM_PREVISAO_ALTA === 'SIM',
    }));
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }
}

// Endpoint em Tempo Real (Retorna todos os leitos ocupados com paciente e previsao de alta)
app.get('/api/leitos', async (req, res) => {
  try {
    const brutos = USE_ORACLE ? await getLeitosDoHospital() : bancoLeitosERP;
    const processados = brutos.map(item => ({
      ...item,
      eh_real: ePacienteReal(item)
    }));
    res.json({
      sucesso: true,
      fonte: USE_ORACLE ? 'oracle' : 'json_local',
      timestamp: new Date().toISOString(),
      total_bruto: processados.length,
      dados: processados
    });
  } catch (error) {
    console.error('[/api/leitos] Falha ao consultar Oracle, usando fallback local:', error.message);
    const processados = bancoLeitosERP.map(item => ({ ...item, eh_real: ePacienteReal(item) }));
    res.json({
      sucesso: true,
      fonte: 'json_local_fallback',
      erro_oracle: error.message,
      timestamp: new Date().toISOString(),
      total_bruto: processados.length,
      dados: processados
    });
  }
});

// Endpoint para Envio de Impressao Direta em ZPL (Termica Zebra)
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
  console.log(`Fonte de dados: ${USE_ORACLE ? 'Oracle (DBAMV)' : 'JSON local (fallback)'}`);
  console.log(`Refresh automatico sugerido no painel: ${REFRESH_MINUTES} min`);
});
