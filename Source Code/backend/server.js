const aedes = require('aedes')();
const http = require('http');
const net = require('net');
const ws = require('ws');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;
const MQTT_PORT = 1883;
const WS_PORT = 8888;
const JWT_SECRET = process.env.JWT_SECRET || 'iot_jwt_secret_change_me';
const JWT_EXPIRES_IN = '7d';

// ==================== Middleware ====================
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

// ==================== Directories ====================
const firmwareDir = path.join(__dirname, 'firmware');
fs.ensureDirSync(firmwareDir);

const cameraDir = path.join(__dirname, 'captures');
fs.ensureDirSync(cameraDir);
app.use('/captures', express.static(cameraDir));

const dataDir = path.join(__dirname, 'data');
fs.ensureDirSync(dataDir);

const dbPath = path.join(dataDir, 'users.db');
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function initAuthDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  });
}

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase();
}

function createAuthToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await dbGet('SELECT id, username, full_name FROM users WHERE id = ?', [payload.userId]);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = {
      id: user.id,
      username: user.username,
      fullName: user.full_name || null
    };

    next();
  } catch (_) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

initAuthDatabase();

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// ==================== Multer for firmware ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, firmwareDir),
  filename: (req, file, cb) => {
    const version = req.body.version || Date.now();
    cb(null, `firmware_v${version}.bin`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ==================== In-memory state ====================
const devices = new Map();
const deviceStatus = new Map();
const cameraCaptures = [];
const CAMERA_CAPTURE_LIMIT = 100;

// chống spam capture khi cháy liên tục
const lastCaptureBySource = new Map();
const CAPTURE_COOLDOWN_MS = 10000;

// ==================== Helpers ====================
function pushCapture(captureInfo) {
  cameraCaptures.unshift(captureInfo);
  if (cameraCaptures.length > CAMERA_CAPTURE_LIMIT) {
    cameraCaptures.length = CAMERA_CAPTURE_LIMIT;
  }
}

function saveCaptureBuffer({ buffer, eventId, reason, source, deviceId }) {
  const timestamp = Date.now();
  const safeEventId = (eventId || `evt_${timestamp}`).replace(/[^\w.-]/g, '_');
  const safeReason = (reason || 'manual').replace(/[^\w.-]/g, '_');

  const filename = `${safeEventId}_${safeReason}.jpg`;
  const filepath = path.join(cameraDir, filename);

  fs.writeFileSync(filepath, buffer);

  const captureInfo = {
    eventId: safeEventId,
    deviceId: deviceId || 'esp32cam',
    source: source || 'unknown',
    reason: safeReason,
    timestamp,
    serverTimestamp: timestamp,
    filename,
    filepath,
    url: `/captures/${filename}`,
    size: buffer.length
  };

  pushCapture(captureInfo);

  console.log(`[CAMERA] Saved image: ${filename} (${buffer.length} bytes)`);

  broadcastToWebSocket({
    type: 'camera_image_saved',
    data: captureInfo
  });

  return captureInfo;
}

function isFireAlert(payloadText) {
  if (!payloadText) return false;

  const text = String(payloadText).toLowerCase();
  if (
    text.includes('fire detected') ||
    text.includes('"type":"fire"') ||
    text.includes('"type": "fire"') ||
    text.includes('"message":"fire') ||
    text.includes('"message": "fire') ||
    text.includes('"fire":1') ||
    text.includes('"fire":true')
  ) {
    return true;
  }

  try {
    const data = JSON.parse(payloadText);
    if (data.type && String(data.type).toLowerCase() === 'fire') return true;
    if (data.message && String(data.message).toLowerCase().includes('fire')) return true;
    if (data.fire === true || data.fire === 1) return true;
  } catch (_) {}

  return false;
}

function canTriggerCapture(sourceDeviceId) {
  const now = Date.now();
  const last = lastCaptureBySource.get(sourceDeviceId) || 0;
  if (now - last < CAPTURE_COOLDOWN_MS) return false;
  lastCaptureBySource.set(sourceDeviceId, now);
  return true;
}

function publishCaptureCommand(reason, sourceDeviceId) {
  const eventId = `${reason || 'event'}_${Date.now()}`;
  const payload = {
    eventId,
    reason: reason || 'manual',
    source: sourceDeviceId || 'server',
    ts: Date.now()
  };

  aedes.publish(
    {
      topic: 'camera/esp32cam/capture',
      payload: Buffer.from(JSON.stringify(payload)),
      qos: 1
    },
    (err) => {
      if (err) {
        console.error('[MQTT] Error publishing capture command:', err);
      } else {
        console.log('[SYSTEM] Capture command sent:', payload);
        broadcastToWebSocket({
          type: 'camera_capture_command_sent',
          data: payload
        });
      }
    }
  );

  return payload;
}

function getServerIP() {
  const interfaces = os.networkInterfaces();
  const preferredInterfaces = ['Wi-Fi', 'Ethernet', 'eth0', 'wlan0', 'en0'];

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

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.endsWith('.1')) {
        console.log(`[Network] Using interface ${name}: ${iface.address}`);
        return iface.address;
      }
    }
  }

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`[Network] Using fallback interface ${name}: ${iface.address}`);
        return iface.address;
      }
    }
  }

  console.log('[Network] Warning: Could not find network IP, using localhost');
  return 'localhost';
}

function broadcastToWebSocket(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === ws.OPEN) {
      client.send(message);
    }
  });
}

// ==================== MQTT Broker ====================
const mqttServer = net.createServer(aedes.handle);

aedes.on('client', (client) => {
  console.log(`[MQTT] Client connected: ${client.id}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] Client disconnected: ${client.id}`);
  devices.delete(client.id);
  deviceStatus.delete(client.id);

  broadcastToWebSocket({
    type: 'device_disconnected',
    deviceId: client.id
  });
});

aedes.on('subscribe', (subscriptions, client) => {
  console.log(
    `[MQTT] Client ${client.id} subscribed to:`,
    subscriptions.map((s) => s.topic)
  );
});

aedes.on('publish', (packet, client) => {
  // ignore broker internal publishes
  if (!client) return;

  const topic = packet.topic;
  const payloadBuffer = packet.payload || Buffer.alloc(0);

  // backward compatibility: still accept raw image via MQTT
  if (topic === 'camera/esp32cam/image') {
    if (!payloadBuffer.length) {
      console.log('[CAMERA] Empty binary image payload');
      return;
    }

    const captureInfo = saveCaptureBuffer({
      buffer: payloadBuffer,
      eventId: `mqtt_${Date.now()}`,
      reason: 'mqtt_capture',
      source: client.id,
      deviceId: client.id
    });

    return;
  }

  const message = payloadBuffer.toString();

  // camera status
  if (topic === 'camera/esp32cam/status') {
    try {
      const data = JSON.parse(message);
      broadcastToWebSocket({
        type: 'camera_status',
        data
      });
    } catch (_) {
      broadcastToWebSocket({
        type: 'camera_status',
        data: { raw: message }
      });
    }
    return;
  }

  // OTA status
  if (topic.includes('/ota/status')) {
    try {
      const data = JSON.parse(message);
      const deviceId = client.id;
      console.log(`[OTA] Device ${deviceId}: ${data.status} - ${data.message}`);

      broadcastToWebSocket({
        type: 'ota_status',
        deviceId,
        status: data.status,
        message: data.message,
        version: data.version,
        timestamp: data.timestamp
      });
    } catch (e) {
      console.error('[OTA] Invalid OTA status payload:', e.message);
    }
    return;
  }

  // all device topics
  if (topic.startsWith('device/')) {
    const topicParts = topic.split('/');
    const deviceIdFromTopic = topicParts[1] || client.id;
    const suffix = topicParts[2] || '';

    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch (_) {
      parsed = { raw: message };
    }

    deviceStatus.set(deviceIdFromTopic, {
      ...parsed,
      lastUpdate: new Date(),
      topic
    });

    broadcastToWebSocket({
      type: 'device_data',
      deviceId: deviceIdFromTopic,
      data: parsed
    });

    // Keep terminal concise: only log critical sensor events.
    if (suffix === 'data') {
      const gasValue = Number(parsed?.gasValue);
      const threshold = Number(parsed?.threshold);
      const fireValue = Number(parsed?.fireValue);
      const overThreshold =
        Number.isFinite(gasValue) &&
        Number.isFinite(threshold) &&
        gasValue > threshold;
      const fireDetected = Number.isFinite(fireValue) && fireValue > 0;

      if (overThreshold || fireDetected) {
        console.log(
          `[ALERT] ${deviceIdFromTopic} gas=${Number.isFinite(gasValue) ? gasValue : 'N/A'} threshold=${Number.isFinite(threshold) ? threshold : 'N/A'} fire=${Number.isFinite(fireValue) ? fireValue : 'N/A'}`
        );
      }
    }

    // alert -> auto trigger camera
    if (suffix === 'alert' && isFireAlert(message)) {
      if (canTriggerCapture(deviceIdFromTopic)) {
        publishCaptureCommand('fire', deviceIdFromTopic);
      } else {
        console.log(`[SYSTEM] Skip capture for ${deviceIdFromTopic} بسبب cooldown`);
      }

      broadcastToWebSocket({
        type: 'fire_alert',
        deviceId: deviceIdFromTopic,
        data: parsed
      });
    }

    return;
  }
});

// start MQTT broker
mqttServer.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`[MQTT] Broker running on 0.0.0.0:${MQTT_PORT}`);
});

// ==================== WebSocket Server ====================
const wss = new ws.Server({ port: WS_PORT });

wss.on('connection', async (wsClient, req) => {
  try {
    const requestUrl = new URL(req.url || '/', 'ws://localhost');
    const token = requestUrl.searchParams.get('token') || '';

    if (!token) {
      wsClient.close(1008, 'Unauthorized');
      return;
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await dbGet('SELECT id, username FROM users WHERE id = ?', [payload.userId]);
    if (!user) {
      wsClient.close(1008, 'Unauthorized');
      return;
    }

    wsClient.user = { id: user.id, username: user.username };
  } catch (err) {
    wsClient.close(1008, 'Unauthorized');
    return;
  }

  console.log('[WebSocket] Client connected');

  const deviceList = Array.from(deviceStatus.entries()).map(([id, data]) => ({
    deviceId: id,
    ...data
  }));

  wsClient.send(JSON.stringify({ type: 'device_list', devices: deviceList }));
  wsClient.send(JSON.stringify({ type: 'camera_captures', captures: cameraCaptures.slice(0, 20) }));

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
    case 'control': {
      const controlTopic = `device/${command.deviceId}/control`;
      const controlMessage = JSON.stringify({
        relay1: command.relay1,
        relay2: command.relay2,
        window: command.window,
        autoManual: command.autoManual,
        threshold: command.threshold
      });

      aedes.publish(
        {
          topic: controlTopic,
          payload: Buffer.from(controlMessage),
          qos: 1
        },
        (err) => {
          if (err) {
            console.error('[MQTT] Error publishing control:', err);
            wsClient.send(JSON.stringify({ type: 'error', message: 'Failed to send control command' }));
          } else {
            console.log(`[MQTT] Control sent to ${command.deviceId}:`, controlMessage);
          }
        }
      );
      break;
    }

    case 'get_device_status': {
      const status = deviceStatus.get(command.deviceId);
      wsClient.send(
        JSON.stringify({
          type: 'device_status',
          deviceId: command.deviceId,
          data: status || null
        })
      );
      break;
    }

    case 'camera_capture': {
      const reason = command.reason || 'manual';
      const source = command.source || 'websocket';
      const payload = publishCaptureCommand(reason, source);

      wsClient.send(
        JSON.stringify({
          type: 'camera_capture_requested',
          data: payload
        })
      );
      break;
    }

    default:
      console.log('[WebSocket] Unknown command type:', command.type);
  }
}

// ==================== REST API ====================

// upload raw jpeg from ESP32-CAM
app.post(
  '/api/upload-image',
  express.raw({ type: 'image/jpeg', limit: '2mb' }),
  (req, res) => {
    try {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ ok: false, error: 'Empty image body' });
      }

      const eventId = req.header('X-Event-Id') || `evt_${Date.now()}`;
      const deviceId = req.header('X-Device-Id') || 'esp32cam';
      const reason = req.header('X-Reason') || 'manual';
      const source = req.header('X-Source') || 'unknown';

      const captureInfo = saveCaptureBuffer({
        buffer: req.body,
        eventId,
        reason,
        source,
        deviceId
      });

      res.json({
        ok: true,
        message: 'Image uploaded successfully',
        capture: captureInfo
      });
    } catch (err) {
      console.error('[HTTP] upload-image error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// API: lấy danh sách thiết bị
app.get('/api/devices', authMiddleware, (req, res) => {
  const deviceList = Array.from(deviceStatus.entries()).map(([id, data]) => ({
    deviceId: id,
    ...data
  }));
  res.json(deviceList);
});

// API: lấy trạng thái thiết bị
app.get('/api/devices/:deviceId', authMiddleware, (req, res) => {
  const status = deviceStatus.get(req.params.deviceId);
  if (status) {
    res.json(status);
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

// API: điều khiển thiết bị
app.post('/api/devices/:deviceId/control', authMiddleware, (req, res) => {
  const { deviceId } = req.params;
  const { relay1, relay2, window, autoManual, threshold } = req.body;

  const controlTopic = `device/${deviceId}/control`;
  const controlMessage = JSON.stringify({
    relay1,
    relay2,
    window,
    autoManual,
    threshold
  });

  aedes.publish(
    {
      topic: controlTopic,
      payload: Buffer.from(controlMessage),
      qos: 1
    },
    (err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to send control command' });
      } else {
        res.json({ success: true, message: 'Control command sent' });
      }
    }
  );
});

// API: gửi lệnh camera capture thủ công
app.post('/api/camera/capture', authMiddleware, (req, res) => {
  const reason = req.body.reason || 'manual';
  const source = req.body.source || 'api';
  const payload = publishCaptureCommand(reason, source);

  res.json({
    success: true,
    message: 'Capture command sent',
    payload
  });
});

// API: lấy danh sách ảnh camera
app.get('/api/camera/captures', authMiddleware, (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
  res.json({
    total: cameraCaptures.length,
    captures: cameraCaptures.slice(0, limit)
  });
});

// API: upload firmware
app.post('/api/firmware/upload', authMiddleware, upload.single('firmware'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No firmware file uploaded' });
  }

  const version = req.body.version || Date.now().toString();
  const filename = req.file.filename;

  const metadata = {
    version,
    filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    path: path.join(firmwareDir, filename)
  };

  const metadataPath = path.join(firmwareDir, `metadata_${version}.json`);
  fs.writeJsonSync(metadataPath, metadata);

  res.json({
    success: true,
    message: 'Firmware uploaded successfully',
    metadata
  });
});

// API: lấy danh sách firmware
app.get('/api/firmware', authMiddleware, (req, res) => {
  const files = fs.readdirSync(firmwareDir);
  const firmwareList = files
    .filter((f) => f.startsWith('metadata_'))
    .map((f) => {
      try {
        return fs.readJsonSync(path.join(firmwareDir, f));
      } catch (e) {
        return null;
      }
    })
    .filter((f) => f !== null)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  res.json(firmwareList);
});

// API: download firmware
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

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
  res.setHeader('Content-Length', metadata.size);

  res.download(firmwarePath, metadata.filename);
});

// API: gửi lệnh OTA
app.post('/api/devices/:deviceId/ota', authMiddleware, (req, res) => {
  const { deviceId } = req.params;
  const { version, url } = req.body;

  if (!version && !url) {
    return res.status(400).json({ error: 'Version or URL required' });
  }

  let firmwareUrl = url;
  if (version && !url) {
    const serverIP = getServerIP();
    firmwareUrl = `http://${serverIP}:${PORT}/api/firmware/${version}`;
    console.log(`[OTA] Firmware URL: ${firmwareUrl}`);
  }

  const otaTopic = `device/${deviceId}/ota`;
  const otaMessage = JSON.stringify({
    version,
    url: firmwareUrl,
    timestamp: Date.now()
  });

  aedes.publish(
    {
      topic: otaTopic,
      payload: Buffer.from(otaMessage),
      qos: 1
    },
    (err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to send OTA command' });
      } else {
        res.json({
          success: true,
          message: 'OTA update command sent',
          url: firmwareUrl
        });
      }
    }
  );
});

// ==================== Auth APIs ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    const fullName = String(req.body.fullName || '').trim();

    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username phải từ 3-32 ký tự (a-z, 0-9, _, ., -)' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password phải có ít nhất 6 ký tự' });
    }

    const existingUser = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(409).json({ error: 'Username đã tồn tại' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, password_hash, full_name) VALUES (?, ?, ?)',
      [username, passwordHash, fullName || null]
    );

    const user = {
      id: result.lastID,
      username,
      fullName: fullName || null
    };

    const token = createAuthToken(user);
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    console.error('[AUTH] register error:', err);
    res.status(500).json({ error: 'Register failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Thiếu username hoặc password' });
    }

    const userRow = await dbGet('SELECT id, username, full_name, password_hash FROM users WHERE username = ?', [
      username
    ]);

    if (!userRow) {
      return res.status(401).json({ error: 'Sai username hoặc password' });
    }

    const isValidPassword = await bcrypt.compare(password, userRow.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Sai username hoặc password' });
    }

    const user = {
      id: userRow.id,
      username: userRow.username,
      fullName: userRow.full_name || null
    };

    const token = createAuthToken(user);
    res.json({ success: true, token, user });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ==================== Start HTTP ====================
app.listen(PORT, '0.0.0.0', () => {
  const serverIP = getServerIP();
  console.log(`[HTTP] Server running on http://localhost:${PORT}`);
  console.log(`[HTTP] Server also accessible at http://${serverIP}:${PORT}`);
  console.log(`[WebSocket] Server running on ws://localhost:${WS_PORT}`);
  console.log(`[WebSocket] Server also accessible at ws://${serverIP}:${WS_PORT}`);
});