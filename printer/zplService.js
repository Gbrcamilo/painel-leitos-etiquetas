const net = require('net');

function printZPL(zpl, printerConfig = {}) {
  return new Promise((resolve, reject) => {
    const ip = printerConfig.ip || process.env.PRINTER_DEFAULT_IP || '192.168.0.50';
    const port = Number(printerConfig.port || process.env.PRINTER_DEFAULT_PORT) || 9100;

    if (!ip) return reject(new Error('IP da impressora não configurado.'));

    const socket = new net.Socket();
    socket.setTimeout(6000);

    socket.connect(port, ip, () => {
      socket.write(zpl, 'utf8', () => {
        socket.end();
        resolve(true);
      });
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error(`Timeout ao conectar na impressora no IP ${ip}:${port}`)); });
    socket.on('error', (err) => reject(new Error(`Erro de comunicação com impressora (${ip}): ${err.message}`)));
  });
}

function escapeZPL(text = '') {
  return String(text).replace(/\^/g, '').replace(/~/g, '').toUpperCase();
}

function buildWristbandZPL(dados = {}) {
  const nm = escapeZPL(dados.nm_paciente || '');
  const atd = escapeZPL(dados.cd_atendimento || '');
  const nasc = escapeZPL(dados.dt_nascimento || '');
  const sexo = escapeZPL(dados.sexo || '');
  const leito = escapeZPL(dados.leito || '');
  const unidade = escapeZPL(dados.unidade || '');
  const hosp = escapeZPL(dados.hospital || '');
  const dark = dados.printer?.darkness || 15;

  return `
^XA
~SD${dark}
^PW200
^LL1200
^POO
^FO20,30^A0N,28,28^FDHOSPITAL ${hosp}^FS
^FO20,65^A0N,22,22^FDLEITO: ${leito} - ${unidade}^FS
^FO20,100^A0N,26,26^FDPACIENTE:^FS
^FO20,130^A0N,28,28^FB180,2,,^FD${nm}^FS
^FO20,190^A0N,22,22^FDATD: ${atd}^FS
^FO20,220^A0N,22,22^FDNASC: ${nasc}  SEXO: ${sexo}^FS
^FO20,260^BY2,2.0,50^BCN,50,Y,N,N^FD${atd}^FS
^XZ
  `.trim();
}

function buildLabelZPL(dados = {}) {
  const nm = escapeZPL(dados.nm_paciente || '');
  const atd = escapeZPL(dados.cd_atendimento || '');
  const leito = escapeZPL(dados.leito || '');
  const unidade = escapeZPL(dados.unidade || '');
  const dark = dados.printer?.darkness || 15;

  return `
^XA
~SD${dark}
^FO20,20^A0N,24,24^FDPACIENTE: ${nm}^FS
^FO20,50^A0N,22,22^FDLEITO: ${leito} | ATD: ${atd}^FS
^FO20,80^A0N,20,20^FDUNIDADE: ${unidade}^FS
^FO20,110^BY2,2.0,40^BCN,40,Y,N,N^FD${atd}^FS
^XZ
  `.trim();
}

module.exports = { printZPL, buildWristbandZPL, buildLabelZPL };