const net = require('net');

/**
 * Envia comandos ZPL para impressora de rede (Zebra ou Elgin compativel ZPL) via socket TCP porta 9100.
 * Para USB/compartilhada no Windows, ver README (usar copy /b para porta compartilhada ou node-printer).
 */
function printZPL(zpl, printerConfig = {}) {
  return new Promise((resolve, reject) => {
    const ip = printerConfig.ip || process.env.PRINTER_DEFAULT_IP;
    const port = printerConfig.port || Number(process.env.PRINTER_DEFAULT_PORT) || 9100;

    if (!ip) return reject(new Error('IP da impressora nao configurado'));

    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.connect(port, ip, () => {
      socket.write(zpl, 'utf8', () => {
        socket.end();
        resolve(true);
      });
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout ao conectar na impressora')); });
    socket.on('error', (err) => reject(err));
  });
}

function escapeZPL(text = '') {
  return String(text).replace(/\^/g, '').replace(/~/g, '').toUpperCase();
}

/**
 * Gera ZPL de pulseira de identificacao do paciente (formato ~50mm x 25mm tipico Z-Band).
 * Compativel com Zebra e a maioria das Elgin que suportam linguagem ZPL II.
 */
function buildWristbandZPL({ nm_paciente, cd_atendimento, dt_nascimento, sexo, leito, unidade, alergia }) {
  const nome = escapeZPL(nm_paciente);
  const alergiaTxt = alergia ? `ALERGIA: ${escapeZPL(alergia)}` : '';
  return `^XA
^PW600
^LL200
^CF0,28
^FO20,10^FD${nome}^FS
^CF0,20
^FO20,45^FDAtend: ${cd_atendimento || ''}   Nasc: ${dt_nascimento || ''}   Sexo: ${sexo || ''}^FS
^FO20,75^FDLeito: ${escapeZPL(leito)}   Unidade: ${escapeZPL(unidade)}^FS
^CF0,24
^FO20,105^FD${alergiaTxt}^FS
^BY2,2,60
^FO20,135^BCN,60,Y,N,N
^FD${cd_atendimento || ''}^FS
^XZ`;
}

/**
 * Gera ZPL de etiqueta de identificacao (prontuario, tubo de coleta, dieta, prescricao) 40mm x 30mm.
 */
function buildLabelZPL({ nm_paciente, cd_atendimento, leito, unidade, tipo }) {
  const nome = escapeZPL(nm_paciente);
  return `^XA
^PW400
^LL300
^CF0,26
^FO15,10^FD${nome}^FS
^CF0,20
^FO15,45^FDAtend: ${cd_atendimento || ''}^FS
^FO15,70^FDLeito: ${escapeZPL(leito)} - ${escapeZPL(unidade)}^FS
^FO15,95^FDTipo: ${escapeZPL(tipo || 'GERAL')}^FS
^BY2,2,50
^FO15,125^BCN,50,Y,N,N
^FD${cd_atendimento || ''}^FS
^XZ`;
}

module.exports = { printZPL, buildWristbandZPL, buildLabelZPL, escapeZPL };
