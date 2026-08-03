# Painel de Leitos + Impressao de Etiquetas/Pulseiras (Zebra/Elgin)

Sistema web para gestao visual de leitos hospitalares (estilo "quadro branco digital") com impressao de etiquetas e pulseiras de identificacao de pacientes em impressoras termicas Zebra (ZPL) e Elgin (ZPL/EPL compativel), inspirado na arquitetura do projeto [mapa-dieta-cmi](https://github.com/Gbrcamilo/mapa-dieta-cmi) (Node.js + Express + Oracle + Vue 3).

## Funcionalidades

- **Painel de leitos em tempo real**: status ocupado, livre, higienizacao, reservado, por unidade/setor
- **Cards de leito coloridos** com dados do paciente (nome, atendimento, nascimento, sexo)
- **Atualizacao automatica** configuravel (`REFRESH_MINUTES`), assim como no mapa-dieta-cmi
- **Impressao de pulseira de identificacao** (Z-Band 25x279mm) com nome, atendimento, nascimento, sexo, leito, unidade, alergias e codigo de barras
- **Impressao de etiquetas** (prontuario, dieta, coleta, prescricao) com codigo de barras
- **Preview visual do ZPL** antes de imprimir, via API publica [Labelary](http://labelary.com/) (renderiza a etiqueta como imagem)
- **Compatibilidade multi-fabricante**: Zebra (ZD411, ZD421, GK420, HC100) e Elgin (L42 Pro, TT042, etc.) que aceitem comandos ZPL II
- **Envio via rede (TCP/IP porta 9100)** — mesmo padrao usado por praticamente todas impressoras termicas de etiqueta
- **Integracao Oracle opcional** para ler leitos/pacientes reais do HIS (Soul MV, Tasy, MV2000 etc.), seguindo o mesmo padrao de `.env` do mapa-dieta-cmi
- **Fallback em JSON local** para status de leitos quando nao ha integracao direta com o HIS

## Estrutura

```
painel-leitos-etiquetas/
├── server.js                 # Backend Express: API de leitos + impressao
├── printer/
│   └── zplService.js         # Geracao de ZPL (pulseira/etiqueta) + envio via socket TCP
├── public/
│   ├── index.html            # Painel de leitos (Vue 3)
│   └── imprimir.html         # Tela de preview e impressao manual
├── .env.example               # Configuracao (Oracle + impressoras)
└── eventos-leitos.json        # Criado automaticamente (status de leitos, fallback)
```

## Como funciona a impressao

Impressoras Zebra e a grande maioria das Elgin atuais (ex.: L42 Pro) aceitem a linguagem **ZPL II**, o mesmo protocolo usado por transportadoras (Correios etc). O backend gera o ZPL da pulseira/etiqueta e envia via socket TCP na porta `9100`, padrao de impressao de rede suportado nativamente por essas impressoras — sem necessidade de driver ou plugin no navegador.

Para impressoras conectadas via USB compartilhadas no Windows, e possivel adaptar o `zplService.js` para usar `copy /b arquivo.zpl \\SERVIDOR\NomeCompartilhado` ou bibliotecas como `node-printer`/`Zebra Browser Print` (ver referencias abaixo).

## Configuracao

```bash
npm install
copy .env.example .env
npm start
```

| Variavel | Descricao |
|---|---|
| `DB_USER` / `DB_PASSWORD` / `DB_CONNECT_STRING` | Conexao Oracle com o HIS (opcional, mesma logica do mapa-dieta-cmi) |
| `PORT` | Porta da aplicacao web |
| `PRINTER_DEFAULT_IP` / `PRINTER_DEFAULT_PORT` | Impressora padrao (pode ser sobrescrita por requisicao) |
| `PRINTER_DEFAULT_MODEL` | `zebra` ou `elgin` (ambas usam ZPL) |
| `USO_ORACLE_AUDITORIA` | Ativa auditoria/persistencia direto no Oracle |

## Endpoints

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/api/leitos` | Lista leitos com status e paciente |
| POST | `/api/leitos/:leito/status` | Atualiza status do leito (ocupado/livre/higienizacao) |
| POST | `/api/imprimir/pulseira` | Gera ZPL de pulseira e envia para a impressora |
| POST | `/api/imprimir/etiqueta` | Gera ZPL de etiqueta e envia para a impressora |
| POST | `/api/imprimir/preview` | Retorna o ZPL gerado sem imprimir (usado no preview visual) |

## Pesquisa de sistemas semelhantes

Para referencia e evolucao do projeto, foram pesquisados sistemas e solucoes correlatas:

- **Gestao a vista / painel de leitos**: modulos comerciais como Wareline "Gestao a Vista", uMov.me, Colmeia e SisHosp oferecem paineis de ocupacao de leitos, mas sao solucoes fechadas e pagas.
- **Identificacao de pacientes com pulseiras Zebra**: linha Z-Band (Comfort, Direct, LaserBand) e impressoras dedicadas HC100, alem de impressoras de etiqueta de uso geral (ZD411, ZD421, GK420) usadas tambem para identificacao de amostras/prontuario.
- **Modulos de identificacao Elgin**: impressoras L42 Pro/TT042 tambem usadas em ambiente hospitalar por custo menor, compativeis com ZPL.
- **Bibliotecas open-source de referencia**: `correios-zebra-js` (modulo Node para ZPL II via TCP/USB) e `zebra-printer-simulator` (simulador Node.js + Socket.IO + Labelary para testar ZPL sem impressora fisica) serviram de base conceitual para o servico `zplService.js` e a tela de preview.
- **Literatura academica**: artigos sobre gestao de leitos (Redalyc, Scielo) reforcam a importancia de indicadores de tempo de ocupacao, alta e higienizacao — considerados na modelagem dos status do leito.

## Compatibilidade de impressoras

| Fabricante | Modelos testados/compativeis | Protocolo |
|---|---|---|
| Zebra | ZD411, ZD421, GK420, GC420, HC100 (pulseiras) | ZPL II |
| Elgin | L42 Pro, TT042 Pro, i9 | ZPL (maioria dos modelos atuais) |

## Proximas evolucoes sugeridas

- [ ] Integracao real com consulta Oracle de leitos (adaptar `getLeitosDoHospital` em `server.js` nos mesmos moldes do `server.js` do mapa-dieta-cmi)
- [ ] Modo TV/painel grande para corredores e postos de enfermagem
- [ ] Suporte a leitura de codigo de barras da pulseira para conferencia (dupla checagem)
- [ ] Login por usuario/setor com controle de acesso
- [ ] Fila de impressao com reimpressao e log de auditoria
- [ ] Suporte a impressao via USB compartilhada no Windows (sem impressora de rede)
- [ ] Dockerfile e docker-compose (seguindo o padrao do mapa-dieta-cmi)

## Licenca

MIT
