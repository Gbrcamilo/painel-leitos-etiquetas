const express = require('express');
const path = require('path');
const { enviarParaImpressoraZPL, gerarCodigoZPL } = require('./printer/zplService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lista de termos para descartar cadastros fictícios/teste
const TERMOS_INVALIDOS = [
  'TESTE', 'TREINAMENTO', 'SIMULACAO', 'SIMULAÇÃO', 'DUMMY', 'DEMO',
  'PACIENTE TESTE', 'LEITO VAGO', 'VAGO', 'DESOCUPADO', 'LIVRE',
  'BLOQUEADO', 'MANUTENÇÃO', 'MANUTENCAO', 'HIGIENIZACAO', 'HIGIENIZAÇÃO'
];

/**
 * Função de validação: Retorna true apenas para pacientes reais e ativos
 */
function ePacienteReal(item) {
  if (!item) return false;

  const nome = (item.nome_paciente || item.nm_paciente || item.paciente || item.nome || '').trim();
  if (!nome) return false;

  // 1. Excluir termos de teste/simulação
  const nomeUpper = nome.toUpperCase();
  const ehInvalido = TERMOS_INVALIDOS.some(termo => nomeUpper.includes(termo));
  if (ehInvalido) return false;

  // 2. Exigir código de atendimento válido (> 0)
  const atendimento = item.cd_atendimento || item.atendimento_id || item.atendimento || item.prontuario;
  if (!atendimento || String(atendimento).trim() === '0' || String(atendimento).trim() === '') {
    return false;
  }

  // 3. Excluir se houver data de alta confirmada
  const dtAlta = item.dt_alta || item.data_alta || item.dataAlta;
  if (dtAlta && String(dtAlta).trim() !== '') {
    return false;
  }

  return true;
}

// SIMULAÇÃO DE BANCO DE DADOS / ERP HOSPITALAR
let bancoLeitosERP = [
  { id: 101, leito: 'UTI-01', setor: 'UTI NEONATAL', nome_paciente: 'HELENA SILVA SANTOS', cd_atendimento: '849201', data_nasc: '2026-07-10', dieta: 'ENTERAL', alergia: 'Lactose', dt_internacao: '2026-07-15 10:30' },
  { id: 102, leito: 'UTI-02', setor: 'UTI NEONATAL', nome_paciente: 'ARTHUR OLIVEIRA COSTA', cd_atendimento: '849205', data_nasc: '2026-07-18', dieta: 'ZERO', alergia: 'Nenhuma', dt_internacao: '2026-07-20 14:15' },
  { id: 103, leito: 'UTI-03', setor: 'UTI NEONATAL', nome_paciente: 'PACIENTE TESTE TREINAMENTO', cd_atendimento: '999999', data_nasc: '2020-01-01', dieta: 'GERAL' }, // FILTRADO
  { id: 104, leito: 'UTI-04', setor: 'UTI NEONATAL', nome_paciente: 'LEITO VAGO', cd_atendimento: '0' }, // FILTRADO
  { id: 201, leito: 'MAT-101', setor: 'MATERNIDADE', nome_paciente: 'MARIA EDUARDA PEREIRA', cd_atendimento: '850112', data_nasc: '1998-04-12', dieta: 'GERAL', alergia: 'Dipirona', dt_internacao: '2026-08-02 11:20' },
  { id: 202, leito: 'MAT-102', setor: 'MATERNIDADE', nome_paciente: 'BEATRIZ FERREIRA LIMA', cd_atendimento: '850115', data_nasc: '1995-11-23', dieta: 'BRANDA', alergia: 'Penicilina', dt_internacao: '2026-08-02 16:40' },
  { id: 203, leito: 'MAT-103', setor: 'MATERNIDADE', nome_paciente: 'SIMULACAO SISTEMA CMI', cd_atendimento: '88888' }, // FILTRADO
  { id: 301, leito: 'ENF-201-A', setor: 'ENFERMARIA', nome_paciente: 'JOAO GABRIEL RODRIGUES', cd_atendimento: '847330', data_nasc: '1972-03-15', dieta: 'PASTOSA', alergia: 'Nenhuma', dt_internacao: '2026-07-28 09:10' },
  { id: 302, leito: 'ENF-201-B', setor: 'ENFERMARIA', nome_paciente: 'CARLOS ALBERTO SOUZA', cd_atendimento: '847335', data_nasc: '1965-09-08', dieta: 'LIQUIDA', alergia: 'AAS', dt_internacao: '2026-07-29 15:00' },
  { id: 401, leito: 'PED-01', setor: 'PEDIATRIA', nome_paciente: 'GABRIEL ENZO ALVES', cd_atendimento: '850401', data_nasc: '2021-05-19', dieta: 'BRANDA', alergia: 'Nenhuma', dt_internacao: '2026-08-01 18:22' }
];

// Endpoint em Tempo Real (Retorna leitos brutos e marcados)
app.get('/api/leitos', (req, res) => {
  const processados = bancoLeitosERP.map(item => ({
    ...item,
    eh_real: ePacienteReal(item)
  }));
  res.json({
    sucesso: true,
    timestamp: new Date().toISOString(),
    total_bruto: processados.length,
    dados: processados
  });
});

// Endpoint para Envio de Impressão Direta em ZPL (Térmica Zebra)
app.post('/api/imprimir-zpl', async (req, res) => {
  try {
    const { pacientes, ipImpressora } = req.body;
    
    // Filtra no backend garantindo que nenhuma etiqueta de teste seja enviada para a impressora
    const pacientesValidos = pacientes.filter(ePacienteReal);

    if (pacientesValidos.length === 0) {
      return res.status(400).json({ sucesso: false, mensagem: 'Nenhum paciente real válido para impressão.' });
    }

    const resultado = await enviarParaImpressoraZPL(pacientesValidos, ipImpressora);
    res.json({ sucesso: true, mensagem: `Etiquetas enviadas com sucesso! (${pacientesValidos.length})`, resultado });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao imprimir etiquetas ZPL', erro: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de Leitos & Etiquetas rodando em http://localhost:${PORT}`);
});