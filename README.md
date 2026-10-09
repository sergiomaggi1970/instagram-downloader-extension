# ⬇ Instagram Downloader

Extensão do Chrome (Manifest V3) para baixar vídeos e fotos de **reels, posts (inclusive carrosséis) e stories** do Instagram em lote, usando a sessão do seu próprio navegador. Não usa nenhum servidor externo.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta `instagram-downloader-extension`.
4. (Opcional) Fixe a extensão na barra de ferramentas pelo ícone de quebra-cabeça.

**Edge:** funciona igual. Abra `edge://extensions`, ative o *Modo de desenvolvedor* e use **Carregar sem pacote**.

## Pré-requisito

Estar **logado no Instagram** neste navegador. A extensão usa os cookies da sua sessão; sem login, o log mostra "Faça login no Instagram neste navegador".

## Como usar

### Pelo popup (em lote)

1. Clique no ícone da extensão.
2. Cole os links, um por linha (linhas começando com `#` são ignoradas). Aceita:
   - `instagram.com/reel/…`, `/reels/…`, `/p/…`, `/tv/…`
   - `instagram.com/stories/{usuario}/{id}/`
3. Clique em **Baixar vídeos**. O progresso aparece no log.
4. **Parar** interrompe a fila depois do item atual. **Limpar** apaga a lista e o log.

O processamento roda em segundo plano: pode fechar o popup e reabrir depois, que o log continua lá. O texto da caixa também é guardado.

Os arquivos vão para `Downloads/Instagram/` com o nome `{usuario} - {shortcode}.mp4`. Em carrosséis, cada item recebe `_1`, `_2`… e as imagens também são baixadas (`.jpg`). Se o arquivo já existir, o Chrome acrescenta `(1)` ao nome.

Entre um link e outro a extensão espera de 1,5 a 3 segundos, para reduzir a chance de bloqueio.

### Pelo botão na página

Nas páginas `/reel/`, `/reels/` e `/p/` aparece o botão **⬇ Baixar** no canto inferior direito. Um clique envia o link atual para a mesma fila do popup.

## Mensagens do log

| Situação | Mensagem |
|---|---|
| Sem sessão | Faça login no Instagram neste navegador |
| 404 | Post apagado ou privado |
| 429 | Muitas requisições, aguarde alguns minutos |
| Link fora do padrão | Link não reconhecido |

Em caso de login ausente ou de 429, a fila é interrompida para não insistir.

## Como funciona (resumo)

1. O link é normalizado (sem `utm_source`, `igsh` etc.) e o shortcode é convertido em `media_id` (base 64, 11 primeiros caracteres, com `BigInt`).
2. `GET /api/v1/media/{media_id}/info/` com o header `X-IG-App-ID`.
3. Se vier 401/403 ou a página de login, a mesma consulta é refeita **dentro de uma aba do instagram.com** (aberta em segundo plano e fechada ao final, se a extensão a criou).
4. Escolhe a versão de maior largura (vídeo ou imagem) e baixa com `chrome.downloads`.

## Testes

```bash
node tests/test.js
```

Cobrem a conversão shortcode → media_id, os tipos de link, reel, carrossel, foto e story, as respostas sem login/404/429 e nomes de arquivo com acentos e emojis (emojis são removidos; acentos ficam). Há também um auto-teste dentro da extensão: `chrome.runtime.sendMessage({type: 'selfTest'})` no console do service worker.

## Limitações

- Funciona **somente com o Instagram**.
- A API não é oficial: mudanças no Instagram podem exigir ajustes.
- Conteúdo de contas privadas só baixa se a sua conta as seguir.
- Stories expiram em 24 h; highlights (`/stories/highlights/…`) não são suportados.
- Use apenas para conteúdo seu ou que você tenha permissão de baixar.
