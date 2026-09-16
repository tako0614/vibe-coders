import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ClipboardPaste, Copy, Maximize, Minus, Plus, RefreshCw, X } from 'lucide-react';
import { api, type Snapshot } from './api';

export function TerminalView({
  run,
  stopped,
  focused = true,
}: {
  run: Snapshot['runs'][number];
  stopped: boolean;
  focused?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    surface = useRef<HTMLDivElement>(null),
    current = useRef(run),
    stoppedRef = useRef(stopped),
    focusedRef = useRef(focused);
  current.current = run;
  stoppedRef.current = stopped;
  focusedRef.current = focused;
  const terminalRef = useRef<Terminal | null>(null),
    retry = useRef<() => void>(() => {}),
    fitRef = useRef<() => void>(() => {});
  const [connection, setConnection] = useState('接続中…'),
    [notice, setNotice] = useState(''),
    [paste, setPaste] = useState<string | null>(null);
  const copy = async () => {
    const text = terminalRef.current?.getSelection();
    if (!text) {
      setNotice('コピーする範囲を選択してください。');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error();
      }
      setNotice('コピーしました。');
    } catch {
      setNotice('コピーできませんでした。ブラウザのコピー操作を使ってください。');
    }
  };
  useEffect(() => {
    let disposed = false,
      socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      connecting = false;
    let offset = 0,
      sequence = 0,
      lastPacket = Date.now(),
      lastSize = '',
      receivedOffset = 0;
    const unconfirmed = new Set<number>();
    const terminal = new Terminal({
      fontFamily: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
      fontSize: (() => {
        try {
          return Math.max(
            11,
            Math.min(22, Number(localStorage.getItem('vibe-terminal-font')) || 14),
          );
        } catch {
          return 14;
        }
      })(),
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      scrollback: 10000,
      scrollSensitivity: 3,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      theme: {
        background: '#202938',
        foreground: '#e6ebf4',
        cursor: '#91a9ff',
        selectionBackground: '#43567d',
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface.current!);
    const writable = () =>
      current.current.owner === 'human' &&
      current.current.state === 'running' &&
      !stoppedRef.current;
    const send = (value: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    const resize = () => {
      if (disposed || !surface.current?.clientWidth) return;
      fit.fit();
      const cols = Math.max(20, Math.min(300, terminal.cols)),
        rows = Math.max(5, Math.min(150, terminal.rows)),
        size = `${cols}:${rows}`;
      if (writable() && socket?.readyState === WebSocket.OPEN && size !== lastSize) {
        lastSize = size;
        send({ type: 'resize', cols, rows });
      }
    };
    fitRef.current = resize;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(surface.current!);
    void document.fonts.ready.then(() => {
      if (!disposed) resize();
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return true;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform),
        key = event.key.toLowerCase();
      if (
        ((event.ctrlKey && event.shiftKey && key === 'c') ||
          (mac && event.metaKey && key === 'c') ||
          (event.ctrlKey && event.key === 'Insert')) &&
        terminal.hasSelection()
      ) {
        event.preventDefault();
        void copy();
        return false;
      }
      if (
        (event.ctrlKey && event.shiftKey && key === 'v') ||
        (mac && event.metaKey && key === 'v') ||
        (event.shiftKey && event.key === 'Insert')
      ) {
        event.preventDefault();
        if (writable()) {
          if (navigator.clipboard?.readText)
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (!disposed && writable()) terminal.paste(text);
              })
              .catch(() => {
                if (!disposed) setPaste('');
              });
          else setPaste('');
        }
        return false;
      }
      if (
        !mac &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        ['w', 't', 'n', 'r', 's', 'p', 'j'].includes(key)
      )
        event.preventDefault();
      return true;
    });
    const input = terminal.onData((text) => {
      if (!writable()) return;
      if (socket?.readyState !== WebSocket.OPEN) {
        setNotice('再接続中です。接続後に入力してください。');
        return;
      }
      if (text.length > 128000 || socket.bufferedAmount + text.length * 3 > 512 * 1024) {
        setNotice('入力が大きすぎます。分けて貼り付けてください。');
        return;
      }
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 16000, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const id = ++sequence;
        unconfirmed.add(id);
        send({ type: 'input', id, text: text.slice(start, end) });
        start = end;
      }
    });
    const connect = async () => {
      if (disposed || connecting) return;
      connecting = true;
      clearTimeout(reconnect);
      setConnection('接続中…');
      try {
        if (stoppedRef.current || !['running', 'stopping'].includes(current.current.state)) {
          let more = true;
          while (more && !disposed) {
            const data = await api<{ text: string; nextOffset: number; hasMore: boolean }>(
              `/runs/${run.id}?offset=${offset}`,
            );
            if (!disposed) {
              if (data.text) terminal.write(data.text);
              offset = data.nextOffset;
              setConnection(stoppedRef.current ? '停止中' : '終了');
            }
            more = data.hasMore;
          }
          return;
        }
        // Drain xterm's queued writes before choosing the replay offset.
        await new Promise<void>((resolve) => terminal.write('', resolve));
        if (disposed) return;
        const { ticket } = await api<{ ticket: string }>(`/runs/${run.id}/ticket`, 'POST', {
          offset,
        });
        if (disposed) return;
        const ws = new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/runs/${run.id}/socket?ticket=${encodeURIComponent(ticket)}`,
        );
        socket = ws;
        receivedOffset = offset;
        lastSize = '';
        lastPacket = Date.now();
        ws.onopen = () => {
          if (disposed) return ws.close();
          setConnection('接続済み');
          resize();
          if (writable() && focusedRef.current) terminal.focus();
        };
        ws.onmessage = (event) => {
          if (disposed || socket !== ws) return;
          lastPacket = Date.now();
          const value = JSON.parse(String(event.data));
          if (value.type === 'output') {
            if (value.truncated) {
              terminal.reset();
              receivedOffset = value.offset;
            }
            if (value.offset !== receivedOffset) {
              ws.close();
              return;
            }
            receivedOffset = value.nextOffset;
            terminal.write(value.text, () => {
              if (disposed) return;
              offset = value.nextOffset;
              if (socket === ws && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'ack', offset }));
            });
          } else if (value.type === 'state') {
            current.current = {
              ...current.current,
              state: value.state,
              owner: value.owner,
              epoch: value.epoch,
            };
            terminal.options.disableStdin = !writable();
            setConnection(
              value.state === 'running'
                ? '接続済み'
                : value.state === 'stopping'
                  ? '停止中…'
                  : '終了',
            );
            resize();
          } else if (value.type === 'accepted') unconfirmed.delete(value.id);
          else if (value.type === 'error') setNotice(value.message);
        };
        ws.onclose = () => {
          if (disposed || socket !== ws) return;
          if (unconfirmed.size) {
            setNotice(
              '接続が切れ、届いたか確認できない入力があります。画面を確認してから続けてください。',
            );
            unconfirmed.clear();
          }
          setConnection(
            ['running', 'stopping'].includes(current.current.state) ? '再接続中…' : '終了',
          );
          if (!stoppedRef.current && ['running', 'stopping'].includes(current.current.state))
            reconnect = setTimeout(() => void connect(), 700);
        };
        ws.onerror = () => ws.close();
      } catch (error) {
        if (!disposed) {
          setConnection('接続できません');
          setNotice(error instanceof Error ? error.message : '接続を確認してください。');
          if (!stoppedRef.current) reconnect = setTimeout(() => void connect(), 2000);
        }
      } finally {
        connecting = false;
      }
    };
    retry.current = () => {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      else void connect();
    };
    heartbeat = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastPacket > 30000) socket.close();
        else send({ type: 'ping' });
      }
    }, 10000);
    resize();
    void connect();
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      input.dispose();
      socket?.close();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [run.id]);
  useEffect(() => {
    if (focused && run.owner === 'human') {
      const frame = requestAnimationFrame(() => {
        fitRef.current();
        terminalRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [focused, run.owner]);
  const canType = run.owner === 'human' && run.state === 'running' && !stopped;
  const key = (value: string) => {
    terminalRef.current?.input(value, true);
    terminalRef.current?.focus();
  };
  return (
    <div className="terminal-widget" ref={root}>
      <div className="terminal-tools">
        <span
          className={`terminal-connection ${connection === '接続済み' ? 'connected' : ''}`}
          role="status"
        >
          {connection}
        </span>
        <div>
          <button
            onClick={() => void copy()}
            title="選択範囲をコピー"
            aria-label="選択範囲をコピー"
          >
            <Copy size={15} />
          </button>
          <button
            disabled={!canType}
            onClick={() => setPaste('')}
            title="貼り付け"
            aria-label="貼り付け"
          >
            <ClipboardPaste size={15} />
          </button>
          <button
            onClick={() => {
              const t = terminalRef.current;
              if (t) {
                t.options.fontSize = Math.max(11, Number(t.options.fontSize) - 1);
                try {
                  localStorage.setItem('vibe-terminal-font', String(t.options.fontSize));
                } catch {}
                fitRef.current();
              }
            }}
            title="文字を小さく"
            aria-label="文字を小さく"
          >
            <Minus size={15} />
          </button>
          <button
            onClick={() => {
              const t = terminalRef.current;
              if (t) {
                t.options.fontSize = Math.min(22, Number(t.options.fontSize) + 1);
                try {
                  localStorage.setItem('vibe-terminal-font', String(t.options.fontSize));
                } catch {}
                fitRef.current();
              }
            }}
            title="文字を大きく"
            aria-label="文字を大きく"
          >
            <Plus size={15} />
          </button>
          <button onClick={() => retry.current()} title="端末へ再接続" aria-label="端末へ再接続">
            <RefreshCw size={15} />
          </button>
          <button
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else
                void root.current
                  ?.requestFullscreen()
                  .catch(() => setNotice('このブラウザでは全画面表示を利用できません。'));
            }}
            title="全画面"
            aria-label="全画面"
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>
      {notice && (
        <div className="terminal-notice" role="status">
          <span>{notice}</span>
          <button aria-label="端末の通知を閉じる" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {paste !== null && (
        <form
          className="terminal-paste"
          onSubmit={(e) => {
            e.preventDefault();
            terminalRef.current?.paste(paste);
            setPaste(null);
            terminalRef.current?.focus();
          }}
        >
          <label>
            貼り付ける内容
            <textarea
              autoFocus
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              maxLength={128000}
              rows={3}
            />
          </label>
          <div>
            <button type="submit" disabled={!canType || !paste}>
              端末に貼り付け
            </button>
            <button type="button" onClick={() => setPaste(null)}>
              閉じる
            </button>
          </div>
        </form>
      )}
      <div className="terminal-surface" ref={surface} />
      <div className="terminal-keys">
        {[
          ['Esc', '\u001b'],
          ['Tab', '\t'],
          ['Ctrl+C', '\u0003'],
          ['↑', '\u001b[A'],
          ['↓', '\u001b[B'],
          ['←', '\u001b[D'],
          ['→', '\u001b[C'],
        ].map(([label, value]) => (
          <button key={label} disabled={!canType} onClick={() => key(value)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
