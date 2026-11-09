# PT TV Tuner

A sleek, modern web player for **live Portuguese TV and radio** — RTP channels, plus TVI and CNN Portugal — packaged as a self-contained Docker stack.

![PT TV Tuner screenshot](screenshot.png)

It is **a player, not a host**: the app fetches publicly available live streams from the broadcasters' own endpoints and plays them in the browser. No media is stored or served from the project.

## What it does

- **Live TV**: RTP 1, RTP 3, RTP Açores, RTP Madeira, RTP Mundo, TVI, CNN Portugal.
- **Live radio**: the RTP radio family (Antena 1/2/3, regional stations, Lusitânia, Fado, Jazzin, Ópera, Zig Zag).
- **"Canais só-PT" toggle**: reveals channels that are limited to Portuguese connections (SIC, SIC Notícias, RTP 2, RTP Memória, RTP África, RTP Vida). They only play when the host's egress is in Portugal — otherwise the player explains why instead of failing silently.
- Responsive, dark, app-like UI. Keyboard `↑`/`↓` switches channels.
- Resilient playback: native HLS on Safari/iOS, [hls.js](https://github.com/video-dev/hls.js) everywhere else.

## Quick start

Requires Docker with the Compose plugin.

```bash
docker compose up -d --build
```

Open <http://localhost:8090>.

To use a different port:

```bash
WEB_PORT=9090 docker compose up -d --build
```

## How it works

Two small services:

| Service | Role |
| --- | --- |
| `web` | nginx serving the built React app and reverse-proxying stream routes to the proxy. |
| `proxy` | A zero-dependency Node service that resolves a channel to its HLS playlist, fetches it with the headers broadcasters expect, rewrites every child URL back through itself, and streams segments through. |

The proxy exists because browsers cannot set the `Referer` / `User-Agent` some broadcasters require, and many streams do not send CORS headers. Routing everything through the same origin removes both problems. It also keeps the real source URLs server-side.

```
browser ──▶ nginx (/ , /channels , /stream/:id , /seg) ──▶ proxy ──▶ broadcaster CDN
```

## Adding or changing channels

Everything lives in [`data/channels.json`](data/channels.json). Each entry:

```json
{
  "id": "rtp1",
  "name": "RTP 1",
  "type": "tv",
  "group": "RTP",
  "region": "world",
  "source": "https://streaming-live.rtp.pt/liverepeater/smil:rtp1HD.smil/playlist.m3u8"
}
```

- `type`: `"tv"` or `"radio"`.
- `region`: `"world"` (always shown) or `"pt"` (hidden behind the PT-only toggle).
- `source`: an HLS (`.m3u8`) URL, or a playlist URL that points to one.

The proxy reads this file at start-up; restart the stack after editing it:

```bash
docker compose restart proxy
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8090` | Host port for the web UI (bound to `127.0.0.1`). |
| `WEB_BIND` | `127.0.0.1` | Host interface to bind. |
| `ALLOW_HOSTS` | `rtp.pt,iol.pt,impresa.pt,githubusercontent.com` | Upstream domains the proxy may fetch (SSRF guard). |

## Legal & responsible use

This project does **not** host, store or redistribute any media. It is a player that streams content from publicly reachable broadcaster endpoints, the same way a browser or media player does. The streams and their content remain the property of the broadcasters and are subject to their terms of service; some are geo-restricted.

Use it for **personal viewing**. Do not operate a public relay that re-streams broadcaster content to third parties, and do not use it to circumvent geographic restrictions you are not entitled to bypass. If you add channels, make sure you have the right to access them from where you run the stack.

## License

MIT — see [LICENSE](LICENSE).
