import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';

type Chan = {
  id: string;
  name: string;
  type: 'tv' | 'radio';
  group: string;
  region: 'world' | 'pt';
  kind?: 'hls' | 'stream';
};

const initials = (name: string) =>
  name
    .split(/[\s/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

const hueFrom = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

export default function App() {
  const [channels, setChannels] = useState<Chan[]>([]);
  const [showPt, setShowPt] = useState<boolean>(() => localStorage.getItem('pttv.showpt') !== '0');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [needGesture, setNeedGesture] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    fetch('/channels')
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((data: Chan[]) => setChannels(data))
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    localStorage.setItem('pttv.showpt', showPt ? '1' : '0');
  }, [showPt]);

  const visible = useMemo(
    () => channels.filter((c) => c.region === 'world' || showPt),
    [channels, showPt],
  );
  const tv = visible.filter((c) => c.type === 'tv');
  const radio = visible.filter((c) => c.type === 'radio');
  const active = channels.find((c) => c.id === activeId) || null;

  const teardown = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  }, []);

  const play = useCallback(
    (ch: Chan) => {
      const video = videoRef.current;
      if (!video) return;
      teardown();
      setActiveId(ch.id);
      setReady(false);
      setNeedGesture(false);
      setStatus('A sintonizar ' + ch.name + '…');
      video.muted = false;

      const url = '/stream/' + ch.id;

      if ((ch.kind || 'hls') === 'stream') {
        video.src = '/live/' + ch.id;
        video.muted = false;
        video.addEventListener('error', () => setStatus('Estação indisponível neste momento.'), { once: true });
        video
          .play()
          .then(() => {
            setReady(true);
            setStatus('');
          })
          .catch(() => {
            setNeedGesture(true);
            setStatus('Prima ▶ para iniciar.');
          });
        return;
      }

      const onReady = () => {
        video
          .play()
          .then(() => {
            setReady(true);
            setStatus('');
          })
          .catch(() => {
            setNeedGesture(true);
            setStatus('Prima ▶ para iniciar.');
          });
      };

      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, backBufferLength: 30, lowLatencyMode: false });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          const code = (data as any).response?.code;
          if (ch.region === 'pt' || code === 403) {
            setStatus(
              'Este canal requer uma ligação portuguesa (VPN/relay PT). Indisponível fora de Portugal.',
            );
          } else {
            setStatus('Canal indisponível neste momento (' + (data.details || data.type) + ').');
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener(
          'error',
          () => setStatus('Canal indisponível neste momento.'),
          { once: true },
        );
      } else {
        setStatus('O seu navegador não suporta reprodução HLS.');
      }
    },
    [teardown],
  );

  const retry = () => {
    if (active) play(active);
  };

  const stop = useCallback(() => {
    teardown();
    setActiveId(null);
    setReady(false);
    setNeedGesture(false);
    setStatus('');
  }, [teardown]);

  useEffect(() => {
    // keyboard: up/down to move through the visible list
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stop();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = visible;
      if (!list.length) return;
      const i = list.findIndex((c) => c.id === activeId);
      const next =
        e.key === 'ArrowDown'
          ? list[(i + 1 + list.length) % list.length]
          : list[(i - 1 + list.length) % list.length];
      if (next) play(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, activeId, play, stop]);

  const renderItem = (c: Chan) => (
    <button
      key={c.id}
      className={'chan' + (c.id === activeId ? ' active' : '')}
      onClick={() => play(c)}
      title={c.name}
    >
      <span className="tile" style={{ ['--h' as any]: hueFrom(c.group || c.name) + 'deg' }}>
        <span className="mono">{initials(c.name)}</span>
        <img
          className="logo"
          src={`/logos/${c.id}.png`}
          alt=""
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      </span>
      <span className="chan-name">{c.name}</span>
      {c.region === 'pt' && <span className="ptbadge">PT</span>}
    </button>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="brand-name">PT TV Tuner</span>
          <span className="brand-sub">live · PT</span>
        </div>
        <label className="switch" title="Reveal channels that need a Portuguese connection">
          <input
            type="checkbox"
            checked={showPt}
            onChange={(e) => setShowPt(e.target.checked)}
          />
          <span className="track" />
          <span className="switch-label">Canais só-PT</span>
        </label>
      </header>

      <main className="layout">
        <aside className="rail">
          {loadError && <p className="notice">Não foi possível carregar a lista de canais.</p>}
          {!loadError && !channels.length && <p className="notice">A carregar canais…</p>}

          {tv.length > 0 && (
            <>
              <div className="group-label">Televisão</div>
              {tv.map(renderItem)}
            </>
          )}
          {radio.length > 0 && (
            <>
              <div className="group-label">Rádio</div>
              {radio.map(renderItem)}
            </>
          )}
        </aside>

        <section className="stage">
          <div className={'screen' + (active?.type === 'radio' ? ' is-radio' : '')}>
            <video ref={videoRef} playsInline controls preload="metadata" />
            {active && (
              <button className="stopbtn" onClick={stop} title="Parar (Esc)" aria-label="Parar">
                <span className="sq" />
                Parar
              </button>
            )}
            {active?.type === 'radio' && (
              <div className="radio-art" aria-hidden="true">
                <div className="bars">
                  <span /><span /><span /><span /><span /><span /><span />
                </div>
                <div className="radio-title">{active.name}</div>
                <div className="radio-sub">{active.group} · em direto</div>
              </div>
            )}
            {!active && (
              <div className="placeholder">
                <div className="ph-icon">▶</div>
                <div>Escolha um canal para começar</div>
              </div>
            )}
          </div>

          <div className="meta">
            <div className="meta-left">
              <h1>{active ? active.name : 'PT TV Tuner'}</h1>
              {active && (
                <span className="tag">
                  {active.type === 'tv' ? 'Televisão' : 'Rádio'} · {active.group}
                  {active.region === 'pt' ? ' · PT' : ''}
                </span>
              )}
            </div>
            {status && (
              <div className="status">
                <span>{status}</span>
                {needGesture && (
                  <button className="btn" onClick={retry}>▶ Reproduzir</button>
                )}
              </div>
            )}
          </div>
          <footer className="foot">
            Transmissões de fontes públicas e abertas. Alguns canais estão limitados a Portugal.
            <span className="sep">·</span> PT TV Tuner
          </footer>
        </section>
      </main>
    </div>
  );
}
