const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BOT_NAME = '小助手Bot';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = 'deepseek-chat';
const users = new Map();
const publicHistory = [];
const MAX_HISTORY = 500;
const rooms = new Map();
const roomHistory = new Map();
const dmHistory = new Map();
const botHistory = new Map();
const userRooms = new Map();
const roomOwners = new Map();
const MAX_ROOM_MEMBERS = 500;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/assistant/status', (req, res) => {
  res.json({ provider: DEEPSEEK_API_KEY ? 'deepseek' : 'local', enabled: Boolean(DEEPSEEK_API_KEY), model: DEEPSEEK_API_KEY ? DEEPSEEK_MODEL : null });
});
app.get('/assistant/echo', async (req, res) => {
  const input = String(req.query.text || '你好');
  const out = await askAssistant(input);
  res.json({ input, output: out, provider: DEEPSEEK_API_KEY ? 'deepseek' : 'local' });
});

io.on('connection', socket => {
  const user = registerUser(socket);

  socket.emit('room:list', listUserRooms(socket.id));
  if (publicHistory.length > 0) {
    socket.emit('history:load', publicHistory);
  }

  socket.emit('systemMessage', '欢迎来到聊天室！');
  socket.emit(
    'chatMessage',
    createBotMessage('你好，我是小助手Bot，@我 或提到我时我会回复你。')
  );
  io.emit('user:list', getUserList());
  socket.broadcast.emit(
    'systemMessage',
    `${user.name} 加入了聊天室，快去和 TA 打个招呼吧！`
  );

  socket.on('room:create', payload => {
    const name = normalizeName(payload?.name) || `群聊-${cryptoRandomId()}`;
    const id = `room-${cryptoRandomId()}`;
    rooms.set(id, { id, name, createdAt: Date.now() });
    socket.join(id);
    addUserRoom(socket.id, id);
    roomOwners.set(id, socket.id);
    socket.emit('room:list', listUserRooms(socket.id));
    const sys = createSystemMessage(`${user.name} 创建并加入了 ${name}`);
    addRoomHistory(id, sys);
    io.to(id).emit('systemMessage', sys.text);
    socket.emit('room:created', { roomId: id, name });
  });

  socket.on('room:join', payload => {
    const id = String(payload?.roomId || '');
    if (!rooms.has(id)) return;
    socket.join(id);
    addUserRoom(socket.id, id);
    socket.emit('room:list', listUserRooms(socket.id));
    const sys = createSystemMessage(`${user.name} 加入了群聊 ${rooms.get(id).name}`);
    addRoomHistory(id, sys);
    io.to(id).emit('systemMessage', sys.text);
  });

  socket.on('room:leave', payload => {
    const id = String(payload?.roomId || '');
    socket.leave(id);
    removeUserRoom(socket.id, id);
    socket.emit('room:list', listUserRooms(socket.id));
    if (rooms.has(id)) {
      const sys = createSystemMessage(`${user.name} 离开了群聊 ${rooms.get(id).name}`);
      addRoomHistory(id, sys);
      io.to(id).emit('systemMessage', sys.text);
    }
  });

  socket.on('history:fetch', payload => {
    const target = normalizeTarget(payload?.to);
    const scope = resolveScope(target);
    let messages = [];
    if (scope === 'public') {
      messages = publicHistory;
    } else if (scope === 'bot') {
      messages = botHistory.get(socket.id) || [];
    } else if (scope === 'room') {
      messages = roomHistory.get(target) || [];
    } else if (scope === 'dm') {
      const key = dmKey(socket.id, target);
      messages = dmHistory.get(key) || [];
    }
    socket.emit('history:response', { to: target, scope, messages });
  });

  socket.on('room:invite', payload => {
    const roomId = String(payload?.roomId || '');
    const memberIds = Array.isArray(payload?.memberIds) ? payload.memberIds : [];
    if (!rooms.has(roomId)) return;
    const roomSet = io.sockets.adapter.rooms.get(roomId);
    const currentSize = roomSet ? roomSet.size : 0;
    if (currentSize + memberIds.length > MAX_ROOM_MEMBERS) {
      socket.emit('systemMessage', `群人数上限 ${MAX_ROOM_MEMBERS}，无法邀请这么多成员`);
      return;
    }
    memberIds.forEach(id => {
      const peer = io.sockets.sockets.get(id);
      if (peer) {
        peer.join(roomId);
        addUserRoom(id, roomId);
        peer.emit('room:list', listUserRooms(id));
      }
    });
    const names = memberIds.map(id => users.get(id)?.name || id).join('、');
    const sys = createSystemMessage(`${user.name} 邀请 ${names} 加入群聊 ${rooms.get(roomId).name}`);
    addRoomHistory(roomId, sys);
    io.to(roomId).emit('systemMessage', sys.text);
  });

  socket.on('chat:file', payload => {
    const file = payload?.file || {};
    const type = String(file?.type || '');
    const name = String(file?.name || '').slice(0, 200);
    const size = Number(file?.size || 0);
    const data = String(file?.data || '');
    if (!name || !type || !data) {
      socket.emit('systemMessage', '文件无效或为空。');
      return;
    }
    const target = normalizeTarget(payload?.to);
    const scope = resolveScope(target);
    const current = users.get(socket.id);
    const msg = {
      id: cryptoRandomId(),
      user: current?.name ?? '匿名用户',
      timestamp: new Date().toISOString(),
      fromId: socket.id,
      to: target,
      scope,
      kind: type.startsWith('image/') ? 'image' : 'file',
      file: { name, size, type, data }
    };

    if (scope === 'public') {
      addPublic(msg);
      io.emit('chatMessage', msg);
      return;
    }
    if (scope === 'bot') {
      addBot(socket.id, msg);
      socket.emit('chatMessage', msg);
      return;
    }
    if (scope === 'room') {
      addRoom(target, msg);
      io.to(target).emit('chatMessage', msg);
      return;
    }
    const key = dmKey(socket.id, target);
    addDm(key, msg);
    socket.emit('chatMessage', msg);
    io.to(target).emit('chatMessage', msg);
  });

  socket.on('chat:location', payload => {
    const { to, lat, lng } = payload || {};
    const target = normalizeTarget(to);
    const scope = resolveScope(target);
    const current = users.get(socket.id);
    const msg = {
      id: cryptoRandomId(),
      user: current?.name ?? '匿名用户',
      timestamp: new Date().toISOString(),
      fromId: socket.id,
      to: target,
      scope,
      kind: 'location',
      location: { lat, lng }
    };
    if (scope === 'public') { addPublic(msg); io.emit('chatMessage', msg); return; }
    if (scope === 'bot') { addBot(socket.id, msg); socket.emit('chatMessage', msg); return; }
    if (scope === 'room') { addRoom(target, msg); io.to(target).emit('chatMessage', msg); return; }
    const key = dmKey(socket.id, target); addDm(key, msg); socket.emit('chatMessage', msg); io.to(target).emit('chatMessage', msg);
  });

  socket.on('chat:pat', payload => {
    const { to, targetUserId } = payload || {};
    const target = normalizeTarget(to);
    const scope = resolveScope(target);
    const current = users.get(socket.id);
    const msg = {
      id: cryptoRandomId(),
      user: current?.name ?? '匿名用户',
      timestamp: new Date().toISOString(),
      fromId: socket.id,
      to: target,
      scope,
      kind: 'pat',
      targetUserId
    };
    if (scope === 'public') { addPublic(msg); io.emit('chatMessage', msg); return; }
    if (scope === 'bot') { addBot(socket.id, msg); socket.emit('chatMessage', msg); return; }
    if (scope === 'room') { addRoom(target, msg); io.to(target).emit('chatMessage', msg); return; }
    const key = dmKey(socket.id, target); addDm(key, msg); socket.emit('chatMessage', msg); io.to(target).emit('chatMessage', msg);
  });

  socket.on('message:recall', payload => {
    const id = String(payload?.id || '');
    if (!id) return;
    const found = findMessageById(id);
    if (!found) return;
    const { message, container, scope, to } = found;
    const now = Date.now();
    const ts = Date.parse(message.timestamp || new Date().toISOString());
    if (message.fromId !== socket.id) { socket.emit('systemMessage', '只能撤回自己发送的消息'); return; }
    if (now - ts > 120000) { socket.emit('systemMessage', '只能在2分钟内撤回'); return; }
    const idx = container.findIndex(m => m.id === id);
    if (idx >= 0) container.splice(idx, 1);
    const evt = { id, scope, to };
    if (scope === 'public') io.emit('message:recalled', evt);
    else if (scope === 'bot') socket.emit('message:recalled', evt);
    else if (scope === 'room') io.to(to).emit('message:recalled', evt);
    else { socket.emit('message:recalled', evt); io.to(to).emit('message:recalled', evt); }
  });
  socket.on('user:update', payload => {
    const nextName = normalizeName(payload);
    const prev = users.get(socket.id);
    if (!nextName || !prev) {
      return;
    }

    if (prev.name === nextName) {
      return;
    }

    users.set(socket.id, { ...prev, name: nextName });
    io.emit('user:list', getUserList());
    socket.broadcast.emit(
      'systemMessage',
      `${prev.name} 将昵称修改为 ${nextName}`
    );
  });

  socket.on('chatMessage', async payload => {
    const text = String(payload?.text ?? '').slice(0, 500);
    if (!text.trim()) {
      socket.emit('systemMessage', '消息不能为空。');
      return;
    }

    const current = users.get(socket.id);
    const target = normalizeTarget(payload?.to);
    const scope = resolveScope(target);
    const baseMsg = {
      id: cryptoRandomId(),
      text,
      user: current?.name ?? '匿名用户',
      timestamp: new Date().toISOString(),
      fromId: socket.id,
      to: target,
      scope,
      kind: 'text'
    };

    const url = extractFirstUrl(text);
    if (scope === 'public') {
      if (url) {
        const meta = await safeFetchLinkPreview(url);
        const linkMsg = { ...baseMsg, kind: 'link', link: meta };
        addPublic(linkMsg);
        io.emit('chatMessage', linkMsg);
      } else {
        addPublic(baseMsg);
        io.emit('chatMessage', baseMsg);
      }
      maybeReplyAsBot(baseMsg);
      return;
    }
    if (scope === 'bot') {
      if (url) {
        const meta = await safeFetchLinkPreview(url);
        const linkMsg = { ...baseMsg, kind: 'link', link: meta };
        addBot(socket.id, linkMsg);
        socket.emit('chatMessage', linkMsg);
      } else {
        addBot(socket.id, baseMsg);
        socket.emit('chatMessage', baseMsg);
        const botMessage = createBotMessage('', { to: 'bot', scope: 'bot' });
        addBot(socket.id, botMessage);
        socket.emit('chatMessage', botMessage);
        streamAssistant(text, (delta) => {
          botMessage.text += delta;
          socket.emit('chat:stream', { id: botMessage.id, delta });
        }).catch(async () => {
          const fallback = composeBotReply(text);
          botMessage.text = fallback;
          socket.emit('chat:stream', { id: botMessage.id, delta: fallback, done: true });
        });
      }
      return;
    }
    if (scope === 'room') {
      if (text.includes('@所有人')) {
        const ownerId = roomOwners.get(target);
        if (ownerId !== socket.id) {
          socket.emit('系统消息', '仅群主可 @所有人');
        } else {
          baseMsg.mentionAll = true;
        }
      }
      if (url) {
        const meta = await safeFetchLinkPreview(url);
        const linkMsg = { ...baseMsg, kind: 'link', link: meta };
        addRoom(target, linkMsg);
        io.to(target).emit('chatMessage', linkMsg);
      } else {
        addRoom(target, baseMsg);
        io.to(target).emit('chatMessage', baseMsg);
      }
      return;
    }
    const key = dmKey(socket.id, target);
    if (url) {
      const meta = await safeFetchLinkPreview(url);
      const linkMsg = { ...baseMsg, kind: 'link', link: meta };
      addDm(key, linkMsg);
      socket.emit('chatMessage', linkMsg);
      io.to(target).emit('chatMessage', linkMsg);
    } else {
      addDm(key, baseMsg);
      socket.emit('chatMessage', baseMsg);
      io.to(target).emit('chatMessage', baseMsg);
    }
  });

  socket.on('disconnect', () => {
    const info = users.get(socket.id);
    users.delete(socket.id);
    io.emit('user:list', getUserList());
    if (info) {
      socket.broadcast.emit(
        'systemMessage',
        `${info.name} 离开了聊天室，期待下次相遇。`
      );
    }
  });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const hostLabel = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`服务器已启动，访问 http://${hostLabel}:${addr.port}`);
  console.log(`健康检查: http://${hostLabel}:${addr.port}/health`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口被占用: ${PORT}`);
  } else if (err && err.code === 'EACCES') {
    console.error('权限不足，无法绑定端口');
  } else {
    console.error('服务器启动错误', err);
  }
  process.exit(1);
});

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function addPublic(message) {
  publicHistory.push(message);
  if (publicHistory.length > MAX_HISTORY) publicHistory.shift();
}

function addRoom(roomId, message) {
  const list = roomHistory.get(roomId) || [];
  list.push(message);
  if (list.length > MAX_HISTORY) list.shift();
  roomHistory.set(roomId, list);
}

function addDm(key, message) {
  const list = dmHistory.get(key) || [];
  list.push(message);
  if (list.length > MAX_HISTORY) list.shift();
  dmHistory.set(key, list);
}

function addBot(userId, message) {
  const list = botHistory.get(userId) || [];
  list.push(message);
  if (list.length > MAX_HISTORY) list.shift();
  botHistory.set(userId, list);
}

async function maybeReplyAsBot(message) {
  if (message.user === BOT_NAME) {
    return;
  }

  const cleanText = message.text.trim();
  if (!cleanText) {
    return;
  }

  // 检查是否@机器人或明确提到机器人
  const isMentioned = checkBotMention(cleanText);
  if (!isMentioned) {
    return; // 没有提到机器人，不回复
  }

  const botMessage = createBotMessage('', { to: 'all', scope: 'public' });
  addPublic(botMessage);
  io.emit('chatMessage', botMessage);
  streamAssistant(cleanText, (delta) => {
    botMessage.text += delta;
    io.emit('chat:stream', { id: botMessage.id, delta });
  }).catch(async () => {
    const fallback = composeBotReply(cleanText);
    botMessage.text = fallback;
    io.emit('chat:stream', { id: botMessage.id, delta: fallback, done: true });
  });
}

function checkBotMention(text) {
  const normalized = text.toLowerCase();
  const botNameLower = BOT_NAME.toLowerCase();
  
  // 检查@机器人
  if (/@小助手|@bot|@机器人/.test(normalized)) {
    return true;
  }
  
  // 检查明确提到机器人名字
  if (normalized.includes(botNameLower) || normalized.includes('小助手') || normalized.includes('机器人')) {
    // 进一步检查是否是明确对话（避免误判）
    const mentionPatterns = [
      /小助手[，,。！!?？]/,  // "小助手，"
      /机器人[，,。！!?？]/,  // "机器人，"
      /bot[，,。！!?？]/,      // "bot,"
      /问.*小助手/,           // "问小助手"
      /告诉.*小助手/,         // "告诉小助手"
      /小助手.*你好/,         // "小助手你好"
      /你好.*小助手/,         // "你好小助手"
    ];
    
    return mentionPatterns.some(pattern => pattern.test(normalized));
  }
  
  return false;
}

function composeBotReply(text) {
  const normalized = text.toLowerCase();

  if (/谢谢|thx|thank/.test(text)) {
    return '不用客气，祝你聊天愉快！';
  }

  if (/再见|拜拜|bye|see you/.test(normalized)) {
    return '好的，下次再聊！';
  }

  if (/你是谁|who are you/.test(text)) {
    return '我是一个简单的机器人助手，随时陪你聊天。';
  }

  if (/时间/.test(text)) {
    return `现在是 ${new Date().toLocaleTimeString('zh-CN')}，时间不等人哦。`;
  }

  if (/天气/.test(text)) {
    return '我还不会查天气，但你可以告诉我你那里的情况吗？';
  }

  if (/你好|hello|hi|hey/.test(normalized)) {
    return '你好呀，很高兴认识你！';
  }

  if (/[?？]$/.test(text)) {
    return '这个问题有点意思，我会记在小本本上，继续学习。';
  }

  const fallbacks = [
    '听起来很有趣，可以再多说一点吗？',
    '我明白了，你还有别的想法吗？',
    '收到，我会记住的！',
    '嗯嗯，我在认真听哦~',
    '谢谢分享，让我也了解到了新东西。'
  ];

  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function createBotMessage(text, extra = {}) {
  return {
    id: cryptoRandomId(),
    text,
    user: BOT_NAME,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

async function safeFetchLinkPreview(url) {
  try {
    const https = require('https');
    return await new Promise((resolve) => {
      const req = https.request({
        hostname: new URL(url).hostname,
        path: new URL(url).pathname + (new URL(url).search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 ChatPreview',
          'Accept': 'text/html'
        }
      }, (res) => {
        res.setEncoding('utf8');
        let html = '';
        res.on('data', (c) => (html += c));
        res.on('end', () => {
          const meta = parseOgMeta(html, url);
          resolve(meta);
        });
      });
      req.on('error', () => resolve({ url, title: url, image: '', site: new URL(url).hostname }));
      req.end();
    });
  } catch {
    return { url, title: url, image: '', site: (new URL(url)).hostname };
  }
}

function parseOgMeta(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const ogDesc = html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const ogImage = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const site = new URL(url).hostname;
  return {
    url,
    title: (ogTitle && ogTitle[1]) || (titleMatch && titleMatch[1]) || url,
    description: (ogDesc && ogDesc[1]) || '',
    image: (ogImage && ogImage[1]) || '',
    site
  };
}

async function askAssistant(text) {
  const fallback = composeBotReply(text);
  const input = String(text || '').slice(0, 1000);
  if (DEEPSEEK_API_KEY) {
    try {
      console.log('[assistant] using deepseek');
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [
            { role: 'system', content: '你是一个中文聊天助手，请简洁友好地回答用户问题。' },
            { role: 'user', content: input }
          ]
        })
      });
      const json = await resp.json();
      const out = json?.choices?.[0]?.message?.content;
      return out || fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function streamAssistant(text, onDelta) {
  return new Promise(async (resolve, reject) => {
    if (!DEEPSEEK_API_KEY) {
      reject(new Error('no key'));
      return;
    }
    try {
      const https = require('https');
      const payload = JSON.stringify({
        model: DEEPSEEK_MODEL,
        stream: true,
        messages: [
          { role: 'system', content: '你是一个中文聊天助手，请简洁友好地回答用户问题。' },
          { role: 'user', content: String(text || '').slice(0, 1000) }
        ]
      });
      const req = https.request({
        hostname: 'api.deepseek.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        res.setEncoding('utf8');
        let finalText = '';
        res.on('data', (chunk) => {
          const lines = String(chunk).split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') { resolve(finalText); return; }
            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || json?.output_text || '';
              if (delta) {
                finalText += delta;
                onDelta?.(delta);
              }
            } catch {}
          }
        });
        res.on('end', () => resolve(finalText));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function registerUser(socket) {
  const visitorName = normalizeName() || generateVisitorName();
  const record = {
    id: socket.id,
    name: visitorName,
    joinedAt: Date.now()
  };
  users.set(socket.id, record);
  return record;
}

function getUserList() {
  return Array.from(users.values()).map(({ id, name, joinedAt }) => ({
    id,
    name,
    joinedAt
  }));
}

function generateVisitorName() {
  const suffix = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `访客${suffix}`;
}

function normalizeName(input) {
  const value = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  if (!value) {
    return '';
  }
  return value;
}

function normalizeTarget(target) {
  const t = String(target || '').trim();
  if (t === 'bot') return 'bot';
  if (!t || t === 'all') return 'all';
  return t;
}

function resolveScope(target) {
  if (target === 'all') return 'public';
  if (target === 'bot') return 'bot';
  if (rooms.has(target)) return 'room';
  return 'dm';
}

function dmKey(a, b) {
  return [a, b].sort().join(':');
}

function addUserRoom(uid, roomId) {
  const set = userRooms.get(uid) || new Set();
  set.add(roomId);
  userRooms.set(uid, set);
}

function removeUserRoom(uid, roomId) {
  const set = userRooms.get(uid);
  if (set) {
    set.delete(roomId);
    userRooms.set(uid, set);
  }
}

function listUserRooms(uid) {
  const ids = Array.from(userRooms.get(uid) || []);
  return ids.map(id => ({ id, name: rooms.get(id)?.name || id }));
}

function addRoomHistory(roomId, message) {
  const list = roomHistory.get(roomId) || [];
  list.push(message);
  if (list.length > MAX_HISTORY) list.shift();
  roomHistory.set(roomId, list);
}

function createSystemMessage(text) {
  return { id: cryptoRandomId(), text, user: '系统消息', timestamp: new Date().toISOString(), system: true };
}

function findMessageById(id) {
  const inArr = (arr) => arr.find(m => m.id === id);
  const mPub = inArr(publicHistory);
  if (mPub) return { message: mPub, container: publicHistory, scope: 'public', to: 'all' };
  for (const [roomId, list] of roomHistory.entries()) {
    const m = inArr(list);
    if (m) return { message: m, container: list, scope: 'room', to: roomId };
  }
  for (const [key, list] of dmHistory.entries()) {
    const m = inArr(list);
    if (m) {
      const parts = key.split(':');
      const otherId = parts[0];
      const to = m.fromId === otherId ? parts[1] : otherId;
      return { message: m, container: list, scope: 'dm', to };
    }
  }
  for (const [uid, list] of botHistory.entries()) {
    const m = inArr(list);
    if (m) return { message: m, container: list, scope: 'bot', to: 'bot' };
  }
  return null;
}
