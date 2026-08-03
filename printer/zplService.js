const net = require('net');

/**
 * Converte dados de um paciente em código ZPL II (Zebra) 100x50mm
 */
function gerarCodigoZPL(paciente) {
  const leito = (paciente.leito || '').toUpperCase();
  const setor = (paciente.setor || '').toUpperCase();
  const nome = (paciente.nome_paciente || paciente.nome || '').toUpperCase();
  const atend = paciente.cd_atendimento || 'N/A';
  const nasc = paciente.data_nasc || 'N/I';
  const dieta = (paciente.dieta || 'GERAL').toUpperCase();
  const alergia = (paciente.alergia || 'NENHUMA').toUpperCase();

  return `
^XA
^PW800
^LL400
^FO30,30^GB740,0,3^FS
^FO30,40^A0N,28,28^FDHOSPITAL CMI - PAINEL DE LEITOS^FS
^FO580,35^GB180,45,45,B,0^FS
^FO590,45^A0N,30,30^FR^FD${leito}^FS
^FO30,85^A0N,22,22^FDSETOR: ${setor}^FS
^FO30,120^A0N,32,32^FD${nome.substring(0, 32)}^FS
^FO30,170^A0N,24,24^FDATEND: #${atend}^FS
^FO400,170^A0N,24,24^FDNASC: ${nasc}^FS
^FO30,210^A0N,24,24^FDDIETA: ${dieta}^FS
^FO400,210^A0N,24,24^FDALERGIA: ${alergia}^FS
^FO30,260^GB740,0,2^FS
^FO30,275^BQN,2,4^FDQA,CMI|ATEND:${atend}|LEITO:${leito}^FS
^FO200,290^A0N,20,20^FDPACIENTE ATIVO EM TEMPO REAL^FS
^FO200,320^A0N,18,18^FDEMISSAO: ${new Date().toLocaleString('pt-BR')}^FS
^XZ
`;
}

/**
 * Envia string ZPL via TCP Socket (porta 9100) para a impressora na rede
 */
function enviarParaImpressoraZPL(listaPacientes, ipImpressora = '192.168.1.200', porta = 9100) {
  return new Promise((resolve, reject) => {
    if (!listaPacientes || listaPacientes.length === 0) {
      return reject(new Error('Nenhum paciente fornecido para envio ZPL.'));
    }

    const zplAcumulado = listaPacientes.map(gerarCodigoZPL).join('\n');
    const client = new net.Socket();

    client.connect(porta, ipImpressora, () => {
      client.write(zplAcumulado, () => {
        client.destroy();
        resolve({ impressos: listaPacientes.length });
      });
    });

    client.on('error', (err) => {
      client.destroy();
      reject(err);
    });
  });
}

module.exports = {
  gerarCodigoZPL,
  enviarParaImpressoraZPL
};