# RamonFlix - Streaming Engine
Link para acesso do sistema em produção: https://ramonflix.vercel.app/
<br> Horários entre as 20h e 8h estão sujeitos a maior latência de tráfego

Este repositório contém o microsserviço de streaming do ecossistema RamonFlix, desenvolvido em **Node.js**. Este serviço atua como um motor de processamento e transmissão de vídeo, responsável por conectar-se a redes descentralizadas (P2P), realizar o buffering de mídia e entregar um fluxo de vídeo compatível com navegadores web (HTTP Stream).

## Sobre o Projeto

O maior desafio técnico em aplicações de streaming baseadas em protocolos P2P (como BitTorrent) é que navegadores web modernos não suportam nativamente a reprodução direta desses protocolos.

Este microsserviço resolve esse problema atuando como um **Protocol Bridge (Ponte de Protocolo)**. Ele recebe um Magnet Link, conecta-se aos "peers" da rede para baixar os fragmentos do arquivo sequencialmente e, em tempo real, converte esses dados em um stream de vídeo MP4 contínuo que pode ser consumido pela tag `<video>` do HTML5 no Frontend.

Frontend: https://github.com/ramonpps/ramonflix-frontend/ <br>
Backend: https://github.com/ramonpps/ramonflix-backend <br>
Stream service: https://github.com/ramonpps/ramonflix-stream-service <br>

> **Escopo de Demonstração:** Este serviço é agnóstico ao conteúdo. No contexto do projeto RamonFlix, ele é utilizado para demonstrar a transmissão de conteúdo Open Source (Creative Commons) em alta definição, validando a arquitetura de distribuição de carga.

## Tecnologias Utilizadas

* **Runtime:** Node.js
* **Framework Web:** Express.js
* **P2P Engine:** WebTorrent
* **Gestão de Processos:** Nodemon (Dev)
* **Deploy:** Configurado para execução em containers (Render.com)

## Funcionalidades Técnicas

1.  **Transcoding On-the-Fly:** Converte o fluxo de entrada (BitTorrent) em um fluxo de saída (HTTP Video Stream) sem a necessidade de baixar o arquivo inteiro primeiro.
2.  **Gestão de Buffer Inteligente:** Prioriza o download das peças iniciais do vídeo para garantir um tempo de início (Start-up Time) reduzido.
3.  **Suporte a Range Requests:** Implementa o suporte ao cabeçalho HTTP `Range`, permitindo que o usuário avance ou retroceda o vídeo (Seek) instantaneamente.
4.  **Limpeza de Recursos:** Gerencia a memória e conexões ativas, encerrando processos órfãos para otimizar o uso de recursos em ambientes de hospedagem limitada (Free Tier).

## Pré-requisitos

* Node.js (versão 16 ou superior)
* NPM ou Yarn

## Instalação e Execução

1.  Clone o repositório:
    ```bash
    git clone [https://github.com/SEU_USUARIO/ramonflix-stream.git](https://github.com/SEU_USUARIO/ramonflix-stream.git)
    cd ramonflix-stream
    ```

2.  Instale as dependências:
    ```bash
    npm install
    ```

3.  Inicie o servidor:
    ```bash
    npm start
    ```

O serviço estará disponível em `http://localhost:8080`.

## Utilização da API

O serviço expõe um endpoint principal para streaming:

### `GET /stream`

Inicia o streaming de um arquivo baseado no Magnet Link fornecido.

**Parâmetros (Query Params):**
* `magnet`: O Magnet Link completo do conteúdo a ser reproduzido.

**Exemplo de Requisição:**

```http
GET http://localhost:8080/stream?magnet=magnet:?xt=urn:btih:08ada5a7...
```

Resposta:

Content-Type: video/mp4

Accept-Ranges: bytes

O corpo da resposta será o fluxo binário do vídeo.

## Arquitetura do Sistema
Este serviço é a camada de infraestrutura do ecossistema:

Frontend (React): Solicita o vídeo apontando o src do player para este serviço.

Backend API (Rails): Fornece o Magnet Link correto para o Frontend.

Stream Engine (Este repositório): Realiza o trabalho pesado de conexão P2P e transmissão de dados.

Desenvolvido por Ramon Pedro Pereira Santos
