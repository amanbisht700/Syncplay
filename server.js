const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Rooms live in memory only — they reset when the server restarts.
// (Uploaded videos are also on local disk, so they're equally temporary for now.)
const rooms = new Map(); // code -> { hostEmail, createdAt }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
});
app.use(sessionMiddleware);

// Share the same session data with Socket.io connections
io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ---------- Auth ----------
app.post('/api/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  const key = email.trim().toLowerCase();
  if (users[key]) return res.status(400).json({ error: 'An account with that email already exists' });

  users[key] = { name, passwordHash: bcrypt.hashSync(password, 10) };
  saveUsers(users);

  req.session.user = { email: key, name };
  res.json({ email: key, name });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const users = loadUsers();
  const key = (email || '').trim().toLowerCase();
  const user = users[key];
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.user = { email: key, name: user.name };
  res.json({ email: key, name: user.name });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// ---------- Rooms ----------
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A1B2C3"
}

app.post('/api/rooms', requireAuth, (req, res) => {
  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));
  rooms.set(code, { hostEmail: req.session.user.email, createdAt: Date.now() });
  fs.mkdirSync(path.join(UPLOAD_DIR, code), { recursive: true });
  res.json({ code });
});

app.get('/api/rooms/:code', requireAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!rooms.has(code)) return res.status(404).json({ error: 'Room not found' });
  res.json({ code });
});

// ---------- Upload (per room) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const code = req.params.code.toUpperCase();
    const roomDir = path.join(UPLOAD_DIR, code);
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
    cb(null, roomDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'current' + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB cap

app.post('/api/rooms/:code/upload', requireAuth, (req, res, next) => {
  const code = req.params.code.toUpperCase();
  if (!rooms.has(code)) return res.status(404).json({ error: 'Room not found' });
  next();
}, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename });
});

app.get('/api/rooms/:code/current-video', requireAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const roomDir = path.join(UPLOAD_DIR, code);
  if (!fs.existsSync(roomDir)) return res.json({ filename: null });
  const files = fs.readdirSync(roomDir).filter(f => f.startsWith('current'));
  res.json({ filename: files[0] || null });
});

// ---------- Video streaming (per room, range-request support for seeking) ----------
app.get('/video/:code/:filename', requireAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const filePath = path.join(UPLOAD_DIR, code, req.params.filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ---------- Real-time sync, scoped per room ----------
io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (!sess || !sess.user) {
    socket.disconnect();
    return;
  }

  socket.on('join-room', (rawCode) => {
    const code = (rawCode || '').toUpperCase();
    if (!rooms.has(code)) return;
    socket.join(code);
    socket.data.roomCode = code;
    socket.to(code).emit('user-joined', { name: sess.user.name });
  });

  socket.on('sync-event', (data) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('sync-event', data);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (code) socket.to(code).emit('user-left', { name: sess.user.name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch party server running at http://localhost:${PORT}`);
});
