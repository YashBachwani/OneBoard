import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { io, type Socket } from 'socket.io-client';
import type { BoardState, DeviceMeta, Stroke, Tool } from './types';
import { DEFAULT_COLORS, formatDeviceName, generateShareLink, getBoardCodeFromUrl, themeStorageKey } from './lib/board';

const defaultServerUrls = [
  (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:4000',
  'http://localhost:4001',
  'http://localhost:4002',
];

const detectServerUrl = async () => {
  for (const url of defaultServerUrls) {
    try {
      const response = await fetch(`${url}/health`, { method: 'GET', cache: 'no-store' });
      if (response.ok) return url;
    } catch {
      // try the next port
    }
  }

  return defaultServerUrls[0];
};

type ThemeMode = 'dark' | 'light';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const pointerStateRef = useRef({ drawing: false, hasMoved: false });
  const themeRef = useRef<ThemeMode>('dark');

  const [serverUrl, setServerUrl] = useState<string>(defaultServerUrls[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(themeStorageKey) as ThemeMode | null;
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [board, setBoard] = useState<BoardState | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#111111');
  const [lineWidth, setLineWidth] = useState(4);
  const [isBoardView, setIsBoardView] = useState(false);
  const [participantCount, setParticipantCount] = useState(1);
  const [deviceLabel, setDeviceLabel] = useState('Your device');
  const [copyStatus, setCopyStatus] = useState('');
  const [toast, setToast] = useState('');
  const [showShareModal, setShowShareModal] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const devices: DeviceMeta[] = useMemo(
    () => [{ name: formatDeviceName(deviceLabel), isCurrent: true }, { name: 'Laptop', isCurrent: false }, { name: 'Phone', isCurrent: false }],
    [deviceLabel],
  );

  useEffect(() => {
    setIsMounted(true);
    const codeFromUrl = getBoardCodeFromUrl();
    if (codeFromUrl) {
      setCodeInput(codeFromUrl);
      joinBoard(codeFromUrl);
    }
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    let isCancelled = false;

    const setupSocket = async () => {
      const detectedUrl = await detectServerUrl();
      if (isCancelled) return;
      setServerUrl(detectedUrl);

      const socket = io(detectedUrl, { transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setConnected(true);
        if (board?.code) {
          socket.emit('board:join', { code: board.code }, (response: any) => {
            if (!response?.ok && response?.message) setJoinError(response.message);
          });
        }
      });

      socket.on('disconnect', () => setConnected(false));
      socket.on('board:state', (nextBoard: BoardState) => {
        setBoard(nextBoard);
        setStrokes(nextBoard.strokes ?? []);
      });
      socket.on('board:joined', (payload: { board: BoardState }) => {
        setBoard(payload.board);
        setStrokes(payload.board.strokes ?? []);
        setIsBoardView(true);
      });
      socket.on('stroke:begin', (stroke: Stroke) => {
        setStrokes((previous) => {
          if (previous.some((item) => item.id === stroke.id)) return previous;
          return [...previous, stroke];
        });
      });
      socket.on('stroke:move', (stroke: Stroke) => {
        setStrokes((previous) => previous.map((item) => (item.id === stroke.id ? { ...item, ...stroke, points: stroke.points } : item)));
      });
      socket.on('stroke:end', (stroke: Stroke) => {
        setStrokes((previous) => {
          if (!previous.some((item) => item.id === stroke.id)) {
            return [...previous, stroke];
          }
          return previous.map((item) => (item.id === stroke.id ? { ...item, ...stroke, points: stroke.points } : item));
        });
      });
      socket.on('board:participants', ({ count }: { count: number }) => setParticipantCount(count));
      socket.on('board:clear', () => {
        clearCanvas();
        setToast('Board cleared');
      });
      socket.on('board:undo', ({ removed }: { removed?: Stroke }) => {
        if (removed) {
          const next = strokesRef.current.filter((stroke) => stroke.id !== removed.id);
          setStrokes(next);
          requestAnimationFrame(() => drawBoard(next));
        }
      });
      socket.on('board:redo', ({ stroke }: { stroke?: Stroke }) => {
        if (stroke) {
          const next = [...strokesRef.current.filter((item) => item.id !== stroke.id), stroke];
          setStrokes(next);
          requestAnimationFrame(() => drawBoard(next));
        }
      });
    };

    setupSocket();

    return () => {
      isCancelled = true;
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isMounted) return;
    if (board) {
      const nextStrokes = board.strokes ?? [];
      strokesRef.current = nextStrokes;
      setStrokes(nextStrokes);
      requestAnimationFrame(() => drawBoard(nextStrokes));
    }
  }, [board, isMounted]);

  useEffect(() => {
    strokesRef.current = strokes;
    requestAnimationFrame(() => drawBoard(strokes));
  }, [strokes]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
  };

  const drawStrokeToContext = (ctx: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number) => {
    const normalizedPoints = stroke.points ?? [];
    if (!normalizedPoints.length) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.width || 4;

    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color || '#111111';
    }

    if (normalizedPoints.length === 1) {
      const { x, y } = normalizedPoints[0];
      ctx.beginPath();
      ctx.arc(x * width, y * height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color || '#111111';
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    const first = normalizedPoints[0];
    ctx.moveTo(first.x * width, first.y * height);

    for (let i = 1; i < normalizedPoints.length - 1; i += 1) {
      const current = normalizedPoints[i];
      const next = normalizedPoints[i + 1];
      const midX = ((current.x + next.x) / 2) * width;
      const midY = ((current.y + next.y) / 2) * height;
      ctx.quadraticCurveTo(current.x * width, current.y * height, midX, midY);
    }

    const last = normalizedPoints[normalizedPoints.length - 1];
    ctx.lineTo(last.x * width, last.y * height);
    ctx.stroke();
    ctx.restore();
  };

  const drawBoard = (items: Stroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    items.forEach((stroke) => drawStrokeToContext(ctx, stroke, rect.width, rect.height));
  };

  useEffect(() => {
    const handleResize = () => {
      if (strokesRef.current.length > 0) {
        requestAnimationFrame(() => drawBoard(strokesRef.current));
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const createBoard = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/boards`, { method: 'POST' });
      const payload = await response.json();
      setBoard(payload.board);
      setIsBoardView(true);
      setJoinError('');
      setCodeInput(payload.board.code);
      if (socketRef.current) {
        socketRef.current.emit('board:join', { code: payload.board.code }, (response: any) => {
          if (!response?.ok && response?.message) setJoinError(response.message);
        });
      }
      setToast('Board created');
      setShowShareModal(true);
      setStrokes(payload.board.strokes ?? []);
    } catch {
      setJoinError('Unable to connect right now. Please try again.');
    }
  };

  const joinBoard = async (inputCode?: string) => {
    const targetCode = (inputCode ?? codeInput).trim();
    if (!targetCode) return;

    try {
      const response = await fetch(`${serverUrl}/api/boards/${encodeURIComponent(targetCode)}`);
      if (!response.ok) {
        setJoinError('Board not found. Check the code and try again.');
        return;
      }
      const payload = await response.json();
      setBoard(payload.board);
      setCodeInput(payload.board.code);
      setIsBoardView(true);
      if (socketRef.current) {
        socketRef.current.emit('board:join', { code: payload.board.code }, (response: any) => {
          if (!response?.ok) setJoinError(response?.message ?? 'Unable to connect right now.');
        });
      }
      setToast('Connected');
      setStrokes(payload.board.strokes ?? []);
    } catch {
      setJoinError('Unable to connect right now. Please try again.');
    }
  };

  const getCanvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
      y: clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
    };
  };

  const renderLiveStroke = () => {
    if (!activeStrokeRef.current) return;
    const current = [...strokesRef.current, activeStrokeRef.current];
    requestAnimationFrame(() => drawBoard(current));
  };

  const addPoint = (clientX: number, clientY: number) => {
    const point = getCanvasPoint(clientX, clientY);
    if (!activeStrokeRef.current) {
      activeStrokeRef.current = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        tool,
        color: tool === 'eraser' ? '#000000' : color,
        width: lineWidth,
        points: [point],
      };
      socketRef.current?.emit('stroke:begin', activeStrokeRef.current);
      return;
    }

    activeStrokeRef.current.points.push(point);
    socketRef.current?.emit('stroke:move', activeStrokeRef.current);
    renderLiveStroke();
  };

  const beginDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!board) return;
    event.preventDefault();
    pointerStateRef.current.drawing = true;
    pointerStateRef.current.hasMoved = false;
    canvasRef.current?.setPointerCapture(event.pointerId);
    addPoint(event.clientX, event.clientY);
  };

  const continueDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerStateRef.current.drawing || !activeStrokeRef.current) return;
    event.preventDefault();
    pointerStateRef.current.hasMoved = true;
    addPoint(event.clientX, event.clientY);
  };

  const endDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerStateRef.current.drawing) return;
    event.preventDefault();

    if (activeStrokeRef.current) {
      const finalStroke: Stroke = {
        ...activeStrokeRef.current,
        points: [...activeStrokeRef.current.points],
      };

      strokesRef.current = [...strokesRef.current, finalStroke];
      setStrokes(strokesRef.current);
      socketRef.current?.emit('stroke:end', finalStroke);
      activeStrokeRef.current = null;
      requestAnimationFrame(() => drawBoard(strokesRef.current));
    }

    pointerStateRef.current.drawing = false;
    if (canvasRef.current && event.pointerId !== undefined) {
      try {
        canvasRef.current.releasePointerCapture(event.pointerId);
      } catch {
        // ignore pointer capture release errors
      }
    }
  };

  const undo = () => {
    if (!board) return;
    socketRef.current?.emit('board:undo');
    setToast('Undo');
  };

  const redo = () => {
    if (!board) return;
    socketRef.current?.emit('board:redo');
    setToast('Redo');
  };

  const clearBoard = () => {
    if (!board) return;
    socketRef.current?.emit('board:clear');
    setConfirmClear(false);
    setToast('Board cleared');
  };

  const saveBoard = () => {
    const canvas = canvasRef.current;
    if (!canvas || !board) return;

    const link = document.createElement('a');
    link.download = `syncboard-${board.id}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    setToast('Board saved');
  };

  const copyCode = async () => {
    if (!board) return;
    const url = generateShareLink(board.code);
    await navigator.clipboard.writeText(url);
    setCopyStatus('✓ Copied');
    setToast('Code copied');
    setTimeout(() => setCopyStatus(''), 1200);
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 1500);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className={`app ${theme}`}>
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand">SYNCBOARD</div>
          {board && <div className="board-tag">{board.id}</div>}
        </div>

        <div className="top-actions">
          {board && <div className="status-pill"><span className="dot" /> {participantCount} devices</div>}
          <button className="icon-button" aria-label="Toggle theme" onClick={() => setTheme((curr) => (curr === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {!isBoardView ? (
        <main className="landing-shell">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">ONE BOARD. EVERY SCREEN. LIVE.</p>
              <h1>Turn your phone, laptop, or tablet into one shared digital board.</h1>
              <p className="subtitle">Draw on one device and see it instantly everywhere.</p>
              <div className="cta-row">
                <button className="primary" onClick={createBoard}>Create Board</button>
                <button className="secondary" onClick={() => setIsBoardView(true)}>Join Board</button>
              </div>
              <small>No account required.</small>
            </div>
            <div className="mini-visual">
              <div className="device-row">
                <span>Phone</span>
                <span className="line" />
              </div>
              <div className="device-row">
                <span>Laptop</span>
                <span className="line" />
              </div>
              <div className="device-row">
                <span>Tablet</span>
                <span className="line" />
              </div>
              <div className="board-label">Shared Board</div>
            </div>
          </section>

          <section className="how-it-works">
            <div className="card">
              <span>01 — CREATE</span>
              <p>Create a board in seconds.</p>
            </div>
            <div className="card">
              <span>02 — CONNECT</span>
              <p>Scan the QR code or enter the board code.</p>
            </div>
            <div className="card">
              <span>03 — DRAW</span>
              <p>Write on any device and see it live everywhere.</p>
            </div>
          </section>

          <section className="join-panel">
            <h2>Join a board</h2>
            <div className="join-form">
              <input value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="Enter board code" />
              <button onClick={() => joinBoard()}>Join Board</button>
            </div>
            {joinError && <p className="error-text">{joinError}</p>}
          </section>
        </main>
      ) : (
        <main className="board-shell">
          <aside className="sidebar">
            <div className="sidebar-header">
              <div className="live-status">
                <span className="dot live" /> LIVE
              </div>
              <div className="board-id">Board: {board?.id ?? 'SB-0000'}</div>
              <div className="board-code">Code: {board?.code ?? '0000'}</div>
            </div>

            <div className="device-panel">
              <h3>DEVICES</h3>
              <ul>
                {devices.map((device) => (
                  <li key={device.name}>
                    <span className="device-bullet" />
                    {device.name}
                    {device.isCurrent && <span className="you"> — You</span>}
                  </li>
                ))}
              </ul>
              <small>{participantCount} devices connected</small>
            </div>
          </aside>

          <section className="canvas-panel">
            <div className="tools">
              <button className={tool === 'pen' ? 'tool active' : 'tool'} onClick={() => setTool('pen')} aria-label="Pen tool">✏</button>
              <button className={tool === 'eraser' ? 'tool active' : 'tool'} onClick={() => setTool('eraser')} aria-label="Eraser tool">⌫</button>

              <label className="slider-wrap">
                <span>Size</span>
                <input type="range" min={1} max={40} value={lineWidth} onChange={(e) => setLineWidth(Number(e.target.value))} />
              </label>

              <div className="color-group">
                {DEFAULT_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    className={color === swatch ? 'swatch active' : 'swatch'}
                    style={{ background: swatch }}
                    onClick={() => setColor(swatch)}
                    aria-label={`Set color ${swatch}`}
                  />
                ))}
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom color" />
              </div>

              <button className="tool" onClick={undo} aria-label="Undo">↶</button>
              <button className="tool" onClick={redo} aria-label="Redo">↷</button>
              <button className="tool danger" onClick={() => setConfirmClear(true)} aria-label="Clear board">Clear</button>
              <button className="tool" onClick={() => setShowShareModal(true)} aria-label="Share board">Share</button>
              <button className="tool" onClick={saveBoard} aria-label="Save board">Save</button>
            </div>

            <div className="canvas-wrap" ref={containerRef}>
              <canvas
                ref={canvasRef}
                className="board-canvas"
                style={{ touchAction: 'none' }}
                onPointerDown={beginDrawing}
                onPointerMove={continueDrawing}
                onPointerUp={endDrawing}
                onPointerLeave={endDrawing}
              />
            </div>
          </section>
        </main>
      )}

      {showShareModal && board && (
        <div className="modal-backdrop" onClick={() => setShowShareModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>SHARE BOARD</h3>
            <p>Scan to join</p>
            <div className="qr-box">
              <QRCodeSVG value={generateShareLink(board.code)} size={150} includeMargin />
            </div>
            <div className="code-line">
              <span>Board Code</span>
              <strong>{board.code}</strong>
            </div>
            <div className="modal-actions">
              <button onClick={copyCode}>Copy Join Link</button>
              <button className="secondary" onClick={() => setShowShareModal(false)}>Close</button>
            </div>
            {copyStatus && <div className="copy-status">{copyStatus}</div>}
          </div>
        </div>
      )}

      {confirmClear && (
        <div className="modal-backdrop" onClick={() => setConfirmClear(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Clear board?</h3>
            <p>This will remove the drawing for everyone connected to this board.</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="danger" onClick={clearBoard}>Clear</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      <footer className="footer">
        <div>SYNCBOARD</div>
        <p>One board. Every screen. Live.</p>
        <small>© 2026 SyncBoard</small>
      </footer>
    </div>
  );
}

export default App;
