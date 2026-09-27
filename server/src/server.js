import express from 'express';
import cors from 'cors';
import http from 'http';
import dotenv from 'dotenv';
import { Server } from 'socket.io';

dotenv.config();

const app = express();
const preferredPort = Number(process.env.PORT || 4000);
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
const boardExpiryHours = Number(process.env.BOARD_EXPIRY_HOURS || 2);
let server = null;
let io = null;

const getAllowedOrigins = () => {
  const configured = (process.env.CLIENT_URL || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const localPorts = ['5173', '5174', '5175', '5176', '4173'];

  return Array.from(
    new Set([
      ...configured,
      ...localPorts.map((port) => `http://localhost:${port}`),
      ...localPorts.map((port) => `http://127.0.0.1:${port}`),
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      'http://127.0.0.1:5175',
    ]),
  );
};

const startServerOnPort = (port) => {
  if (server) {
    server.close(() => {
      server = null;
      startServerOnPort(port);
    });
    return;
  }

  server = http.createServer(app);
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || getAllowedOrigins().includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  setupSocketHandlers(io);

  const listener = server.listen(port, '0.0.0.0', () => {
    console.log(`SyncBoard server running on http://localhost:${port}`);
    process.env.PORT = String(port);
  });

  listener.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy. Retrying on ${nextPort}...`);
      server.close(() => {
        server = null;
        startServerOnPort(nextPort);
      });
      return;
    }

    console.error('Server failed to start:', error);
    process.exit(1);
  });
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || getAllowedOrigins().includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

const boards = new Map();
const socketToBoard = new Map();
const codeToBoardId = new Map();

const createBoardCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  while (code.length < 5) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
};

const buildBoardId = () => `SB-${Math.floor(1000 + Math.random() * 9000)}`;

const generateBoard = () => {
  let boardId = buildBoardId();
  let limit = 0;
  while (boards.has(boardId) && limit < 20) {
    boardId = buildBoardId();
    limit += 1;
  }

  const boardCode = createBoardCode();
  const board = {
    id: boardId,
    code: boardCode,
    createdAt: Date.now(),
    strokes: [],
    history: [],
    connectedSockets: new Set(),
    metadata: {
      lastActivity: Date.now(),
      createdBy: 'owner',
    },
  };

  boards.set(boardId, board);
  codeToBoardId.set(boardCode.toUpperCase(), boardId);

  return board;
};

const sanitizeStroke = (stroke) => {
  if (!stroke || typeof stroke !== 'object') return null;

  const points = Array.isArray(stroke.points) ? stroke.points.filter((point) => point && typeof point.x === 'number' && typeof point.y === 'number') : [];
  const width = Number(stroke.width);
  const color = typeof stroke.color === 'string' ? stroke.color : '#000000';
  const tool = stroke.tool === 'eraser' || stroke.tool === 'pen' ? stroke.tool : 'pen';

  if (points.length === 0) return null;

  return {
    id: typeof stroke.id === 'string' ? stroke.id : `${Date.now()}-${Math.random()}`,
    tool,
    color,
    width: Number.isFinite(width) ? Math.min(Math.max(width, 1), 40) : 4,
    points: points.slice(0, 250),
    createdAt: Date.now(),
  };
};

const getBoardState = (board) => ({
  id: board.id,
  code: board.code,
  strokes: board.strokes,
  history: board.history,
  metadata: board.metadata,
});

const broadcastBoardState = (io, boardId) => {
  const board = boards.get(boardId);
  if (!board) return;

  board.metadata.lastActivity = Date.now();
  io.to(boardId).emit('board:state', getBoardState(board));
};

const pruneInactiveBoards = () => {
  const now = Date.now();
  const expiryMs = boardExpiryHours * 60 * 60 * 1000;

  for (const [boardId, board] of boards.entries()) {
    if (now - board.metadata.lastActivity > expiryMs && board.connectedSockets.size === 0) {
      boards.delete(boardId);
      codeToBoardId.delete(board.code.toUpperCase());
    }
  }
};

app.get('/health', (_, res) => res.json({ ok: true, boards: boards.size }));

app.post('/api/boards', (_, res) => {
  const board = generateBoard();
  res.json({ board: getBoardState(board) });
});

app.get('/api/boards/:boardCode', (req, res) => {
  const boardId = codeToBoardId.get(String(req.params.boardCode).toUpperCase());
  const board = boardId ? boards.get(boardId) : undefined;

  if (!board) {
    return res.status(404).json({ message: 'Board not found.' });
  }

  return res.json({ board: getBoardState(board) });
});

const setupSocketHandlers = (socketServer) => {
socketServer.on('connection', (socket) => {
  socket.on('board:create', (_, callback) => {
    const board = generateBoard();
    callback?.({ board: getBoardState(board) });
  });

  socket.on('board:join', ({ code }, callback) => {
    const boardId = codeToBoardId.get(String(code || '').toUpperCase());
    const board = boardId ? boards.get(boardId) : undefined;

    if (!board) {
      callback?.({ ok: false, message: 'Board not found.' });
      return;
    }

    const previousBoardId = socketToBoard.get(socket.id);
    if (previousBoardId && previousBoardId !== board.id) {
      const prevBoard = boards.get(previousBoardId);
      prevBoard?.connectedSockets.delete(socket.id);
      socket.leave(previousBoardId);
    }

    socketToBoard.set(socket.id, board.id);
    board.connectedSockets.add(socket.id);
    socket.join(board.id);
    board.metadata.lastActivity = Date.now();

    socket.emit('board:joined', { board: getBoardState(board), socketId: socket.id });
    io.to(board.id).emit('board:participants', {
      count: board.connectedSockets.size,
      boardId: board.id,
    });

    callback?.({ ok: true, board: getBoardState(board) });
    broadcastBoardState(io, board.id);
  });

  socket.on('board:leave', () => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (board) {
      board.connectedSockets.delete(socket.id);
      board.metadata.lastActivity = Date.now();
      socket.leave(boardId);
      io.to(boardId).emit('board:participants', {
        count: board.connectedSockets.size,
        boardId: board.id,
      });
      broadcastBoardState(io, boardId);
    }

    socketToBoard.delete(socket.id);
  });

  socket.on('stroke:begin', (payload) => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (!board) return;
    const sanitized = sanitizeStroke(payload);
    if (!sanitized) return;

    board.strokes.push(sanitized);
    board.history.push(sanitized);
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('stroke:begin', sanitized);
  });

  socket.on('stroke:move', (payload) => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (!board) return;
    const sanitized = sanitizeStroke(payload);
    if (!sanitized) return;

    const index = board.strokes.findIndex((stroke) => stroke.id === sanitized.id);
    if (index >= 0) board.strokes[index] = sanitized;
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('stroke:move', sanitized);
  });

  socket.on('stroke:end', (payload) => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const sanitized = sanitizeStroke(payload);
    if (!sanitized) return;

    const board = boards.get(boardId);
    if (!board) return;
    const index = board.strokes.findIndex((stroke) => stroke.id === sanitized.id);
    if (index >= 0) board.strokes[index] = sanitized;
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('stroke:end', sanitized);
  });

  socket.on('board:undo', () => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (!board || board.strokes.length === 0) return;

    const removed = board.strokes.pop();
    board.history.push({ ...removed, undone: true });
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('board:undo', { removed });
    broadcastBoardState(io, boardId);
  });

  socket.on('board:redo', () => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (!board || !board.history.some((item) => item?.undone)) return;

    const undone = board.history.filter((item) => item?.undone).pop();
    if (!undone) return;

    board.strokes.push({ ...undone, undone: false });
    board.history = board.history.filter((item) => item !== undone);
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('board:redo', { stroke: { ...undone, undone: false } });
    broadcastBoardState(io, boardId);
  });

  socket.on('board:clear', () => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (!board) return;
    board.strokes = [];
    board.history = [];
    board.metadata.lastActivity = Date.now();
    io.to(boardId).emit('board:clear');
    broadcastBoardState(io, boardId);
  });

  socket.on('disconnect', () => {
    const boardId = socketToBoard.get(socket.id);
    if (!boardId) return;

    const board = boards.get(boardId);
    if (board) {
      board.connectedSockets.delete(socket.id);
      board.metadata.lastActivity = Date.now();
      io.to(boardId).emit('board:participants', {
        count: board.connectedSockets.size,
        boardId: board.id,
      });
      broadcastBoardState(io, boardId);
    }

    socketToBoard.delete(socket.id);
  });
});
};

setInterval(pruneInactiveBoards, 60 * 1000);

startServerOnPort(preferredPort);
