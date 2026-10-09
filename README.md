# ⬇ Social Video Downloader

Extensão do Chrome (Manifest V3) para baixar vídeos e fotos do **Instagram** (reels, posts, carrosséis e stories), do **X** (antigo Twitter) e do **TikTok** em lote, usando a sessão do seu próprio navegador. Não usa nenhum servidor externo.

| Plataforma | O que baixa | Login |
|---|---|---|
| Instagram | reels, posts (inclusive carrosséis), stories | **necessário** |
| X | vídeos, GIFs e fotos de tweets | não precisa para tweets públicos; tweets restritos (conteúdo sensível, conta protegida) exigem login no X |
| TikTok | vídeos (sem marca d'água) e posts de fotos | não precisa para vídeos públicos; vídeos privados/restritos exigem login no TikTok |

> O YouTube continua no app desktop.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto.
4. (Opcional) Fixe a extensão na barra de ferramentas pelo ícone de quebra-cabeça.

**Edge:** funciona igual. Abra `edge://extensions`, ative o *Modo de desenvolvedor* e use **Carregar sem pacote**.

Se você já tinha a versão "Instagram Downloader" instalada, basta clicar em **Recarregar** na página de extensões.

## Como usar

### Pelo popup (em lote)

1. Clique no ícone da extensão.
2. Cole os links, um por linha (linhas começando com `#` são ignoradas). Instagram, X e TikTok podem vir **misturados** na mesma lista:
   - `instagram.com/reel/…`, `/reels/…`, `/p/…`, `/tv/…`, `instagram.com/stories/{usuario}/{id}/`
   - `x.com/{usuario}/status/{id}`, `twitter.com/…`, `mobile.twitter.com/…`, `x.com/i/status/{id}` (aceita `/video/1`, `/photo/1` e parâmetros como `?s=20`)
   - `tiktok.com/@{usuario}/video/{id}`, `/photo/{id}`, `m.tiktok.com/v/{id}.html` e links curtos (`vm.tiktok.com/…`, `vt.tiktok.com/…`, `tiktok.com/t/…`)
3. Se o conteúdo já está aberto no navegador, use **＋ Aba atual** ou **＋ Todas as abas** para inserir os links sem copiar.
4. Clique em **Baixar vídeos**. O progresso aparece no log, com `[IG]`, `[X]` ou `[TT]` em cada item.
5. **Parar** interrompe a fila depois do item atual. **Limpar** apaga a lista e o log.

O processamento roda em segundo plano: pode fechar o popup e reabrir depois, que o log continua lá. O texto da caixa também é guardado.

Os arquivos vão para `Downloads/Instagram/`, `Downloads/X/` e `Downloads/TikTok/`, com o nome `{usuario} - {shortcode ou id}.mp4`. Com várias mídias (carrossel, tweet ou post do TikTok com várias fotos/vídeos), cada item recebe `_1`, `_2`… Se o arquivo já existir, o Chrome acrescenta `(1)` ao nome.

Entre um link e outro a extensão espera de 1,5 a 3 segundos, para reduzir a chance de bloqueio.

### Pelos botões nas páginas

- **Instagram:** em `/reel/`, `/reels/` e `/p/` aparece o botão **⬇ Baixar** no canto inferior direito.
- **X:** um botão **⬇** aparece na barra de ações (ao lado de responder, curtir etc.) de cada tweet com vídeo ou GIF.
- **TikTok:** em `/@usuario/video/…` e `/@usuario/photo/…` aparece o botão **⬇ Baixar** no canto inferior direito.

Um clique envia o link para a mesma fila do popup.

## Mensagens do log

| Situação | Mensagem |
|---|---|
| Instagram sem sessão | Faça login no Instagram neste navegador |
| Instagram 404 | Post apagado ou privado |
| Tweet sem mídia | Tweet sem vídeo |
| Tweet apagado | Tweet apagado ou indisponível |
| Tweet restrito sem sessão | Conteúdo restrito: faça login no X neste navegador |
| TikTok apagado | Vídeo apagado ou indisponível |
| TikTok privado | Vídeo privado ou restrito: faça login no TikTok neste navegador |
| TikTok pediu verificação | O TikTok pediu verificação: abra tiktok.com neste navegador, conclua e tente de novo |
| Post do TikTok sem mídia | Post sem vídeo ou foto |
| 429 | Muitas requisições, aguarde alguns minutos |
| Link fora do padrão | Link não reconhecido |

Em caso de falta de login no Instagram, de 429 ou de verificação do TikTok, os links **daquela plataforma** que ainda estavam na fila são descartados para não insistir; os da outra plataforma continuam.

## Como funciona (resumo)

**Instagram**
1. O link é normalizado (sem `utm_source`, `igsh` etc.) e o shortcode é convertido em `media_id` (base 64, 11 primeiros caracteres, com `BigInt`).
2. `GET /api/v1/media/{media_id}/info/` com o header `X-IG-App-ID`.
3. Se vier 401/403 ou a página de login, a consulta é refeita **dentro de uma aba do instagram.com** (aberta em segundo plano e fechada ao final, se a extensão a criou).
4. Escolhe a maior versão (vídeo ou imagem) e baixa com `chrome.downloads`.

**X**
1. O ID do tweet é extraído do link (como texto, porque não cabe em `Number`).
2. Método principal: endpoint de embed `cdn.syndication.twimg.com/tweet-result`, que não exige login. Escolhe o mp4 de maior bitrate; fotos em `?name=orig`. Se o tweet não tem mídia mas cita outro com vídeo, baixa o do citado (e avisa no log).
3. Fallback (embed vazio, 404, tombstone ou conteúdo sensível): abre o tweet numa aba em segundo plano, lê as respostas GraphQL que a **própria página** do X faz (`TweetDetail` / `TweetResultByRestId`), espera até 15 s e fecha a aba. Não há query IDs nem tokens fixos no código.

**TikTok**
1. O link é normalizado (links curtos são seguidos pelo próprio navegador). A página do vídeo é lida e o JSON que ela embute (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) traz os dados, sem login.
2. A proteção anti-robô do TikTok às vezes barra a consulta direta (403). A extensão tenta duas vezes e, se continuar barrada, abre o vídeo numa aba em segundo plano, lê os dados da própria página e fecha a aba. Download recusado pelo servidor de vídeos também é repetido uma vez.
3. Vídeo: escolhe a versão h264 de maior bitrate (toca em qualquer lugar; sem marca d'água). Post de fotos: baixa todas as imagens.
5. O CDN do TikTok recusa (403) pedidos sem o cookie da página e sem `Referer: tiktok.com`. Os cookies vêm da própria consulta à página; o `Referer` é colocado por uma regra `declarativeNetRequest` que vale **só para pedidos da própria extensão** (não altera a sua navegação).

## Estrutura

```
background.js          fila, roteamento por plataforma, log e downloads (módulo)
platforms/instagram.js lógica do Instagram
platforms/x.js         lógica do X
platforms/tiktok.js    lógica do TikTok
platforms/common.js    utilidades compartilhadas
platforms/index.js     detecção da plataforma pelo hostname
content.js             botão do Instagram e do TikTok
content-x*.js          captura (world MAIN), ponte e botão do X
popup.*                interface
tests/                 testes (Node)
```

## Testes

```bash
npm test
```

Rodam `tests/test.js` (funções puras: shortcode → media_id, links, token da syndication, JSON do TikTok, escolha de mídia, nomes de arquivo, respostas sem login/404/429), `tests/capture.js` (script de captura do X) e `tests/flow.js` (fluxo completo com `chrome`/`fetch` simulados: lista mista Instagram + X, fallback pela página, 429 por plataforma e regressão do Instagram).
Há também um auto-teste dentro da extensão: `chrome.runtime.sendMessage({type: 'selfTest'})` no console do service worker.

## Limitações

- Só Instagram, X e TikTok.
- Nenhuma das três fontes é oficial: mudanças podem exigir ajustes (principalmente o fallback do X, que depende do formato das respostas da página).
- Conteúdo de contas privadas só baixa se a sua conta as seguir.
- Stories do Instagram expiram em 24 h; highlights (`/stories/highlights/…`) não são suportados.
- No TikTok, o áudio de posts de fotos e as legendas não são baixados; lives não são suportadas.
- No X, vídeos de espaços/transmissões ao vivo (HLS) não são suportados; só mp4.
- Use apenas para conteúdo seu ou que você tenha permissão de baixar.
