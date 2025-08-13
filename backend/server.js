import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import http from 'http';
import pkg from 'pg';
import { stringify } from 'csv-stringify';

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN?.split(',') || '*' }
});

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '1234';

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('DB: using DATABASE_URL');
} else {
  console.log('DB: no DATABASE_URL, using in-memory store');
}

const mem = {
  logins: [],
  settings: {
    rules: {
      text: `1. Vis respekt – Behandl andre brugere høfligt og med venlighed.
2. Ingen krænkende indhold – Det er forbudt at dele, vise eller sende seksuelt eksplicit materiale, nøgenbilleder eller andet stødende indhold.
3. Sikkerhed først – Del ikke personlige oplysninger som adresse, CPR-nummer eller økonomiske oplysninger med andre brugere.
4. Kun voksne – Du skal være 18 år eller ældre for at bruge VideoChat.tv.
5. Overhold loven – Al brug af platformen skal ske i overensstemmelse med gældende lovgivning.`
    }
  }
};

// slet logs ældre end 30 dage
async function cleanupOldLogs() {
  if (pool) {
    await pool.query("delete from vc_users_logins where created_at < now() - interval '30 days'");
  } else {
    const cutoff = Date.now() - 30*24*60*60*1000;
    mem.logins = mem.logins.filter(l => l.created_at >= cutoff);
  }
}

let dummyCleared = false;

async function recordLogin(entry) {
  if (pool) {
    if (!dummyCleared) {
      await pool.query("delete from vc_users_logins where username like 'TestBruger%'");
      dummyCleared = true;
    }
    await pool.query(
      "insert into vc_users_logins (username, age, city, relation_type, gender_pref, distance_km) values($1,$2,$3,$4,$5,$6)",
      [entry.username, entry.age, entry.city, entry.relation_type, entry.gender_pref, entry.distance_km || 0]
    );
  } else {
    if (!dummyCleared) {
      mem.logins = mem.logins.filter(x => !String(x.username).startsWith('TestBruger'));
      dummyCleared = true;
    }
    mem.logins.push({ ...entry, created_at: Date.now() });
  }
}

async function getRules() {
  if (pool) {
    const res = await pool.query("select value from vc_settings where key='rules'");
    if (res.rows.length) return res.rows[0].value;
  }
  return mem.settings.rules;
}

async function setRules(text) {
  if (pool) {
    await pool.query(
      "insert into vc_settings(key,value) values('rules',$1) on conflict (key) do update set value=$1",
      [ { text } ]
    );
  } else {
    mem.settings.rules = { text };
  }
}

app.get('/health', (req,res)=>res.json({ok:true}));

let onlineCount = 0;
app.get('/api/online-count', (req,res)=>res.json({ online: onlineCount }));

app.post('/api/login', async (req,res)=>{
  const { username, age, city, relation_type, gender_pref, distance_km } = req.body || {};
  if (!username || !age) return res.status(400).json({ error: 'Manglende felter' });
  await recordLogin({ username, age, city, relation_type, gender_pref, distance_km });
  await cleanupOldLogs();
  res.json({ ok:true });
});

app.post('/api/admin/login', (req,res)=>{
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) return res.json({ ok:true });
  return res.status(401).json({ error: 'Forkert login' });
});

app.get('/api/admin/rules', async (req,res)=>{
  const r = await getRules();
  res.json(r);
});

app.post('/api/admin/rules', async (req,res)=>{
  await setRules(req.body.text || '');
  res.json({ ok:true });
});

app.get('/api/admin/logs', async (req,res)=>{
  if (pool) {
    const r = await pool.query("select username, age, city, relation_type, gender_pref, distance_km, created_at from vc_users_logins order by created_at desc limit 1000");
    res.json(r.rows);
  } else {
    res.json(mem.logins);
  }
});

app.get('/api/admin/stats', async (req,res)=>{
  if (pool) {
    const sql = "select date_trunc('day', created_at) as day, count(*) as logins from vc_users_logins group by 1 order by 1 desc limit 30";
    const r = await pool.query(sql);
    res.json(r.rows);
  } else {
    const byDay = {};
    for (const l of mem.logins) {
      const d = new Date(l.created_at);
      const key = d.toISOString().split('T')[0];
      byDay[key] = (byDay[key]||0)+1;
    }
    const arr = Object.entries(byDay).map(([day,logins])=>({day, logins})).sort((a,b)=>a.day<b.day?1:-1).slice(0,30);
    res.json(arr);
  }
});

app.get('/api/admin/logs.csv', async (req,res)=>{
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="logins-${new Date().toISOString().slice(0,10)}.csv"`);
  const columns = ['Brugernavn','Alder','By','Relationstype','Køn (ønsket)','Afstand (km)','Login-tidspunkt'];
  const stringifier = stringify({ header: true, columns });
  stringifier.pipe(res);
  if (pool) {
    const r = await pool.query("select username, age, city, relation_type, gender_pref, distance_km, created_at from vc_users_logins order by created_at desc");
    for (const row of r.rows) {
      stringifier.write([row.username,row.age,row.city,row.relation_type,row.gender_pref,row.distance_km || 0, row.created_at.toISOString()]);
    }
  } else {
    for (const row of mem.logins) {
      stringifier.write([row.username,row.age,row.city,row.relation_type,row.gender_pref,row.distance_km || 0, new Date(row.created_at).toISOString()]);
    }
  }
  stringifier.end();
});

// --- Matchmaking ("Næste") ---
const waitQueues = new Map(); // signature -> [socketId,...]
function sigFromFilters(f) {
  const age = f.age_group || 'any';
  const rel = f.relation_type || 'any';
  const gender = f.gender || 'any';
  const dist = f.max_distance_km || 'any';
  const country = f.country || 'any';
  return `${age}|${rel}|${gender}|${dist}|${country}`;
}

io.on('connection', (socket)=>{
  onlineCount++;
  socket.data.partner = null;
  socket.data.signature = null;

  socket.on('disconnect', ()=>{
    onlineCount = Math.max(0, onlineCount-1);
    if (socket.data.signature && waitQueues.has(socket.data.signature)) {
      waitQueues.set(socket.data.signature, waitQueues.get(socket.data.signature).filter(id=>id!==socket.id));
    }
    if (socket.data.partner) {
      const p = io.sockets.sockets.get(socket.data.partner);
      if (p) {
        p.emit('partner-disconnected');
        p.data.partner = null;
      }
    }
  });

  socket.on('find-partner', async (filters)=>{
    if (socket.data.partner) {
      const p = io.sockets.sockets.get(socket.data.partner);
      if (p) { p.emit('partner-left'); p.data.partner = null; }
      socket.data.partner = null;
    }
    const sig = sigFromFilters(filters || {});
    socket.data.signature = sig;
    if (!waitQueues.has(sig)) waitQueues.set(sig, []);
    const q = waitQueues.get(sig);

    if (q.length > 0) {
      const otherId = q.shift();
      if (otherId !== socket.id) {
        const other = io.sockets.sockets.get(otherId);
        if (other) {
          socket.data.partner = other.id;
          other.data.partner = socket.id;
          socket.emit('partner-found', { id: other.id });
          other.emit('partner-found', { id: socket.id });
          return;
        }
      }
    }

    q.push(socket.id);
    setTimeout(()=>{
      const q2 = waitQueues.get(sig) || [];
      const stillWaiting = q2.includes(socket.id) && !socket.data.partner;
      if (stillWaiting) {
        waitQueues.set(sig, q2.filter(id=>id!==socket.id));
        socket.emit('partner-dummy', { message: 'Ingen online med dine filtre lige nu. Viser demo.' });
      }
    }, 3000);
  });

  socket.on('signal', (payload)=>{
    const { to, data } = payload || {};
    const peer = io.sockets.sockets.get(to);
    if (peer) peer.emit('signal', { from: socket.id, data });
  });
});

server.listen(PORT, ()=> console.log(`Backend running on port ${PORT}`));
