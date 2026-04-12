const aedes = require('aedes')();
const http = require('http');
const net = require('net');
const ws = require('ws');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const mqtt = require('mqtt');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;
const MQTT_PORT = 1883;
const WS_PORT = 8888;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== SQLite Auth Database ====================
const dataDir = path.join(__dirname, 'data');
fs.ensureDirSync(dataDir);

const dbPath = path.join(dataDir, 'app.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      name TEXT,
      location TEXT,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_devices (
      user_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, device_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);
});

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function upsertDevice(externalDeviceId) {
  if (!externalDeviceId) return null;

  let row = await dbGet('SELECT * FROM devices WHERE device_id = ?', [externalDeviceId]);
  if (!row) {
    const result = await dbRun(
      'INSERT INTO devices (device_id, name, last_seen) VALUES (?, ?, datetime("now"))',
      [externalDeviceId, externalDeviceId]
    );
    row = await dbGet('SELECT * FROM devices WHERE id = ?', [result.lastID]);
  } else {
    await dbRun('UPDATE devices SET last_seen = datetime("now") WHERE id = ?', [row.id]);
  }

  return row;
}

async function requireDeviceAccess(req, res, next) {
  try {
    const externalDeviceId = req.params.deviceId;
    const userId = req.user.id;

    const row = await dbGet(
      `SELECT d.id AS internalDeviceId, d.device_id AS deviceId, d.name, d.location
       FROM devices d
       JOIN user_devices ud ON ud.device_id = d.id
       WHERE d.device_id = ? AND ud.user_id = ?`,
      [externalDeviceId, userId]
    );

    if (!row) {
      return res.status(404).json({ success: false, error: 'Device not found or no permission' });
    }

    req.device = row;
    next();
  } catch (error) {
    console.error('[API] Device access error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authenticateToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing token' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// Tạo thư mục lưu firmware
const firmwareDir = path.join(__dirname, 'firmware');
fs.ensureDirSync(firmwareDir);

// Cấu hình multer cho upload firmware
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, firmwareDir);
  },
  filename: (req, file, cb) => {
    const version = req.body.version || Date.now();
    cb(null, `firmware_v${version}.bin`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// Lưu trữ dữ liệu thiết bị
const devices = new Map();
const deviceStatus = new Map();

// ==================== AUTH API ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Thiếu username hoặc password' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'Mật khẩu phải có ít nhất 6 ký tự' });
    }

    const exists = await dbGet('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (exists) {
      return res.status(409).json({ success: false, error: 'Username đã tồn tại' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username.trim(), passwordHash]
    );

    const user = { id: result.lastID, username: username.trim() };
    const token = createToken(user);

    res.json({ success: true, token, user });
  } catch (error) {
    console.error('[AUTH] Register error:', error);
    res.status(500).json({ success: false, error: 'Lỗi đăng ký' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Thiếu username hoặc password' });
    }

    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });
    }

    const payload = { id: user.id, username: user.username };
    const token = createToken(payload);

    res.json({ success: true, token, user: payload });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({ success: false, error: 'Lỗi đăng nhập' });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/devices/claim', authenticateToken, async (req, res) => {
  try {
    const { deviceId, name, location } = req.body;

    if (!deviceId || !String(deviceId).trim()) {
      return res.status(400).json({ success: false, error: 'deviceId is required' });
    }

    const normalizedDeviceId = String(deviceId).trim();
    const device = await upsertDevice(normalizedDeviceId);

    await dbRun(
      `INSERT OR IGNORE INTO user_devices (user_id, device_id, role)
       VALUES (?, ?, 'owner')`,
      [req.user.id, device.id]
    );

    if ((name && String(name).trim()) || (location && String(location).trim())) {
      await dbRun(
        'UPDATE devices SET name = COALESCE(?, name), location = COALESCE(?, location) WHERE id = ?',
        [
          name && String(name).trim() ? String(name).trim() : null,
          location && String(location).trim() ? String(location).trim() : null,
          device.id
        ]
      );
    }

    const updated = await dbGet(
      'SELECT device_id AS deviceId, name, location, last_seen AS lastSeen FROM devices WHERE id = ?',
      [device.id]
    );

    res.json({ success: true, device: updated });
  } catch (error) {
    console.error('[API] Claim device error:', error);
    res.status(500).json({ success: false, error: 'Không thể thêm thiết bị' });
  }
});

// ==================== MQTT Broker ====================
const mqttServer = net.createServer(aedes.handle);

aedes.on('client', (client) => {
  console.log(`[MQTT] Client connected: ${client.id}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] Client disconnected: ${client.id}`);
  devices.delete(client.id);
  deviceStatus.delete(client.id);
  broadcastToWebSocket({ type: 'device_disconnected', deviceId: client.id });
});

aedes.on('publish', (packet, client) => {
  if (client) {
    const topic = packet.topic;
    const message = packet.payload.toString();
    const topicMatch = topic.match(/^device\/([^/]+)\//);
    const deviceId = topicMatch ? topicMatch[1] : client.id;
    
    try {
      const data = JSON.parse(message);
      
      // Xử lý OTA status
      if (topic.includes('/ota/status')) {
        console.log(`[OTA] Device ${deviceId}: ${data.status} - ${data.message}`);
        
        // Broadcast OTA status đến WebSocket clients
        broadcastToWebSocket({
          type: 'ota_status',
          deviceId: deviceId,
          status: data.status,
          message: data.message,
          version: data.version,
          timestamp: data.timestamp
        });
      }
      // Lưu trạng thái thiết bị
      else if (topic.startsWith('device/')) {
        deviceStatus.set(deviceId, { ...data, lastUpdate: new Date() });
        upsertDevice(deviceId).catch((error) => {
          console.error('[DB] upsert device failed:', error);
        });
        
        // Broadcast đến WebSocket clients
        broadcastToWebSocket({
          type: 'device_data',
          deviceId: deviceId,
          data: data
        });
      }
    } catch (e) {
      // Không phải JSON, xử lý như text
      console.log(`[MQTT] ${topic}: ${message}`);
    }
  }
});

aedes.on('subscribe', (subscriptions, client) => {
  console.log(`[MQTT] Client ${client.id} subscribed to:`, subscriptions.map(s => s.topic));
});

// Khởi động MQTT server
mqttServer.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`[MQTT] Broker running on 0.0.0.0:${MQTT_PORT}`);
});

// ==================== WebSocket Server ====================
const wss = new ws.Server({ port: WS_PORT });

wss.on('connection', (wsClient) => {
  console.log('[WebSocket] Client connected');
  
  // Gửi danh sách thiết bị hiện tại
  const deviceList = Array.from(deviceStatus.entries()).map(([id, data]) => ({
    deviceId: id,
    ...data
  }));
  wsClient.send(JSON.stringify({ type: 'device_list', devices: deviceList }));
  
  wsClient.on('message', (message) => {
    try {
      const command = JSON.parse(message);
      handleWebSocketCommand(command, wsClient);
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });
  
  wsClient.on('close', () => {
    console.log('[WebSocket] Client disconnected');
  });
});

function handleWebSocketCommand(command, wsClient) {
  switch (command.type) {
    case 'control':
      wsClient.send(JSON.stringify({
        type: 'error',
        message: 'Control via WebSocket is disabled. Use authenticated REST API.'
      }));
      break;
      
    case 'get_device_status':
      const status = deviceStatus.get(command.deviceId);
      wsClient.send(JSON.stringify({
        type: 'device_status',
        deviceId: command.deviceId,
        data: status || null
      }));
      break;
      
    default:
      console.log('[WebSocket] Unknown command type:', command.type);
  }
}

function broadcastToWebSocket(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === ws.OPEN) {
      client.send(message);
    }
  });
}

// ==================== REST API ====================

// API: Lấy danh sách thiết bị
app.get('/api/devices', authenticateToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT d.device_id AS deviceId, d.name, d.location, d.last_seen AS lastSeen
       FROM devices d
       JOIN user_devices ud ON ud.device_id = d.id
       WHERE ud.user_id = ?
       ORDER BY COALESCE(d.last_seen, d.created_at) DESC`,
      [req.user.id]
    );

    const deviceList = rows.map((row) => {
      const live = deviceStatus.get(row.deviceId) || {};
      return {
        ...row,
        ...live
      };
    });

    res.json(deviceList);
  } catch (error) {
    console.error('[API] devices list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Lấy trạng thái thiết bị
app.get('/api/devices/:deviceId', authenticateToken, requireDeviceAccess, (req, res) => {
  const status = deviceStatus.get(req.params.deviceId);
  if (status) {
    return res.json(status);
  }

  res.json({
    deviceId: req.device.deviceId,
    gasValue: 0,
    fireValue: 0,
    relay1State: 0,
    relay2State: 0,
    windowState: 0,
    autoManual: 1,
    threshold: 4000,
    ipAddress: '-',
    lastUpdate: null
  });
});

// API: Điều khiển thiết bị
app.post('/api/devices/:deviceId/control', authenticateToken, requireDeviceAccess, (req, res) => {
  const { deviceId } = req.params;
  const { relay1, relay2, window, autoManual, threshold } = req.body;
  
  const controlTopic = `device/${deviceId}/control`;
  const controlMessage = JSON.stringify({
    relay1, relay2, window, autoManual, threshold
  });
  
  aedes.publish({
    topic: controlTopic,
    payload: Buffer.from(controlMessage),
    qos: 1
  }, (err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to send control command' });
    } else {
      res.json({ success: true, message: 'Control command sent' });
    }
  });
});

// API: Upload firmware
app.post('/api/firmware/upload', authenticateToken, upload.single('firmware'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No firmware file uploaded' });
  }
  
  const version = req.body.version || Date.now().toString();
  const filename = req.file.filename;
  
  // Lưu metadata
  const metadata = {
    version: version,
    filename: filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    path: path.join(firmwareDir, filename)
  };
  
  const metadataPath = path.join(firmwareDir, `metadata_${version}.json`);
  fs.writeJsonSync(metadataPath, metadata);
  
  res.json({
    success: true,
    message: 'Firmware uploaded successfully',
    metadata: metadata
  });
});

// API: Lấy danh sách firmware
app.get('/api/firmware', authenticateToken, (req, res) => {
  const files = fs.readdirSync(firmwareDir);
  const firmwareList = files
    .filter(f => f.startsWith('metadata_'))
    .map(f => {
      try {
        return fs.readJsonSync(path.join(firmwareDir, f));
      } catch (e) {
        return null;
      }
    })
    .filter(f => f !== null)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  
  res.json(firmwareList);
});

// API: Download firmware
app.get('/api/firmware/:version', (req, res) => {
  const { version } = req.params;
  const metadataPath = path.join(firmwareDir, `metadata_${version}.json`);
  
  if (!fs.existsSync(metadataPath)) {
    return res.status(404).json({ error: 'Firmware version not found' });
  }
  
  const metadata = fs.readJsonSync(metadataPath);
  const firmwarePath = metadata.path;
  
  if (!fs.existsSync(firmwarePath)) {
    return res.status(404).json({ error: 'Firmware file not found' });
  }
  
  console.log(`[OTA] Serving firmware: ${firmwarePath} (${metadata.size} bytes)`);
  
  // Set headers for binary download
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
  res.setHeader('Content-Length', metadata.size);
  
  res.download(firmwarePath, metadata.filename);
});

// Helper function to get server IP address
function getServerIP() {
  const interfaces = os.networkInterfaces();
  const preferredInterfaces = ['Wi-Fi', 'Ethernet', 'eth0', 'wlan0', 'en0'];
  
  // First, try to find preferred interfaces
  for (const ifaceName of preferredInterfaces) {
    if (interfaces[ifaceName]) {
      for (const iface of interfaces[ifaceName]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`[Network] Using interface ${ifaceName}: ${iface.address}`);
          return iface.address;
        }
      }
    }
  }
  
  // Fallback: find any non-internal IPv4 address
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      // Also skip addresses that look like gateway (ending in .1)
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.endsWith('.1')) {
        console.log(`[Network] Using interface ${name}: ${iface.address}`);
        return iface.address;
      }
    }
  }
  
  // Last resort: return first non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`[Network] Using fallback interface ${name}: ${iface.address}`);
        return iface.address;
      }
    }
  }
  
  console.log('[Network] Warning: Could not find network IP, using localhost');
  return 'localhost'; // Fallback
}

// API: Gửi lệnh OTA update
app.post('/api/devices/:deviceId/ota', authenticateToken, requireDeviceAccess, (req, res) => {
  const { deviceId } = req.params;
  const { version, url } = req.body;
  
  if (!version && !url) {
    return res.status(400).json({ error: 'Version or URL required' });
  }
  
  let firmwareUrl = url;
  if (version && !url) {
    // Use actual IP address instead of localhost so ESP32 can access it
    const serverIP = getServerIP();
    const port = PORT;
    firmwareUrl = `http://${serverIP}:${port}/api/firmware/${version}`;
    console.log(`[OTA] Firmware URL: ${firmwareUrl}`);
  }
  
  const otaTopic = `device/${deviceId}/ota`;
  const otaMessage = JSON.stringify({
    version: version,
    url: firmwareUrl,
    timestamp: Date.now()
  });
  
  aedes.publish({
    topic: otaTopic,
    payload: Buffer.from(otaMessage),
    qos: 1
  }, (err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to send OTA command' });
    } else {
      res.json({ success: true, message: 'OTA update command sent', url: firmwareUrl });
    }
  });
});

// Khởi động Express server
app.listen(PORT, '0.0.0.0', () => {
  const serverIP = getServerIP();
  console.log(`[HTTP] Server running on http://localhost:${PORT}`);
  console.log(`[HTTP] Server also accessible at http://${serverIP}:${PORT}`);
  console.log(`[WebSocket] Server running on ws://localhost:${WS_PORT}`);
  console.log(`[WebSocket] Server also accessible at ws://${serverIP}:${WS_PORT}`);
});

