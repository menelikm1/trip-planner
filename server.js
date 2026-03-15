require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Init DB tables on startup ─────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      dest TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      pin_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stays (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      checkin DATE,
      checkout DATE,
      address TEXT,
      confirmation TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'other',
      time TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      note TEXT,
      yes_count INT DEFAULT 0,
      no_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rsvps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'going',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      paid_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add columns introduced after initial deploy (safe to run repeatedly)
  await pool.query(`
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_with TEXT[] DEFAULT '{}';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS settled BOOLEAN DEFAULT FALSE;
  `);
  console.log('✅ Database tables ready');
}

// ── Helper: verify PIN ────────────────────────────────────────────────────────
async function verifyPin(tripId, pin) {
  const { rows } = await pool.query('SELECT pin_hash FROM trips WHERE id = $1', [tripId]);
  if (!rows.length) return false;
  return bcrypt.compare(pin, rows[0].pin_hash);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create a new trip
app.post('/api/trip', async (req, res) => {
  try {
    const { name, dest, start, end, pin } = req.body;
    if (!name || !dest || !start || !end || !pin) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (pin.length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 digits' });
    }

    const id = uuidv4();
    const pinHash = await bcrypt.hash(pin, 10);

    await pool.query(
      'INSERT INTO trips (id, name, dest, start_date, end_date, pin_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, dest, start, end, pinHash]
    );

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// Get full trip data (no PIN needed — viewer access)
app.get('/api/trip/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const tripRes = await pool.query('SELECT id, name, dest, start_date, end_date FROM trips WHERE id = $1', [id]);
    if (!tripRes.rows.length) return res.status(404).json({ error: 'Trip not found' });

    const staysRes = await pool.query('SELECT * FROM stays WHERE trip_id = $1 ORDER BY checkin', [id]);
    const activitiesRes = await pool.query('SELECT * FROM activities WHERE trip_id = $1 ORDER BY day, time', [id]);
    const votesRes = await pool.query('SELECT * FROM votes WHERE trip_id = $1 ORDER BY created_at', [id]);
    const rsvpsRes = await pool.query('SELECT * FROM rsvps WHERE trip_id = $1 ORDER BY created_at', [id]);
    const expensesRes = await pool.query('SELECT * FROM expenses WHERE trip_id = $1 ORDER BY created_at', [id]);

    const trip = tripRes.rows[0];
    res.json({
      id: trip.id,
      name: trip.name,
      dest: trip.dest,
      start: trip.start_date,
      end: trip.end_date,
      stays: staysRes.rows,
      activities: activitiesRes.rows,
      votes: votesRes.rows,
      rsvps: rsvpsRes.rows,
      expenses: expensesRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trip' });
  }
});

// Verify PIN (returns isPlanner: true/false)
app.post('/api/trip/:id/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const valid = await verifyPin(req.params.id, pin);
    res.json({ isPlanner: valid });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Add a stay (PIN required)
app.post('/api/trip/:id/stays', async (req, res) => {
  try {
    const { pin, name, checkin, checkout, address, confirmation } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    const { rows } = await pool.query(
      'INSERT INTO stays (trip_id, name, checkin, checkout, address, confirmation) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, name, checkin, checkout, address, confirmation]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add stay' });
  }
});

// Delete a stay (PIN required)
app.delete('/api/trip/:id/stays/:stayId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    await pool.query('DELETE FROM stays WHERE id = $1 AND trip_id = $2', [req.params.stayId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete stay' });
  }
});

// Add an activity (PIN required)
app.post('/api/trip/:id/activities', async (req, res) => {
  try {
    const { pin, day, name, type, time, note } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    const { rows } = await pool.query(
      'INSERT INTO activities (trip_id, day, name, type, time, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, day, name, type, time, note]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add activity' });
  }
});

// Delete an activity (PIN required)
app.delete('/api/trip/:id/activities/:actId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    await pool.query('DELETE FROM activities WHERE id = $1 AND trip_id = $2', [req.params.actId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

// Add a vote option (PIN required)
app.post('/api/trip/:id/votes', async (req, res) => {
  try {
    const { pin, title, category, note } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    const { rows } = await pool.query(
      'INSERT INTO votes (trip_id, title, category, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, title, category, note]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add vote' });
  }
});

// Cast a vote (no PIN needed — open to group)
app.post('/api/trip/:id/votes/:voteId/cast', async (req, res) => {
  try {
    const { type, prev } = req.body; // type: 'yes'|'no', prev: previous vote if changing
    if (!['yes', 'no'].includes(type)) return res.status(400).json({ error: 'type must be yes or no' });
    if (prev && !['yes', 'no'].includes(prev)) return res.status(400).json({ error: 'prev must be yes or no' });

    const newCol = type === 'yes' ? 'yes_count' : 'no_count';

    let query, params;
    if (prev && prev !== type) {
      const oldCol = prev === 'yes' ? 'yes_count' : 'no_count';
      query = `UPDATE votes SET ${newCol} = ${newCol} + 1, ${oldCol} = GREATEST(${oldCol} - 1, 0) WHERE id = $1 AND trip_id = $2 RETURNING *`;
      params = [req.params.voteId, req.params.id];
    } else {
      query = `UPDATE votes SET ${newCol} = ${newCol} + 1 WHERE id = $1 AND trip_id = $2 RETURNING *`;
      params = [req.params.voteId, req.params.id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to cast vote' });
  }
});

// Delete a vote option (PIN required)
app.delete('/api/trip/:id/votes/:voteId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });

    await pool.query('DELETE FROM votes WHERE id = $1 AND trip_id = $2', [req.params.voteId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete vote' });
  }
});

// Add RSVP (no PIN — open to group; same name updates existing instead of duplicating)
app.post('/api/trip/:id/rsvp', async (req, res) => {
  try {
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const validStatuses = ['going', 'maybe', 'cant'];
    const s = validStatuses.includes(status) ? status : 'going';

    const existing = await pool.query(
      'SELECT id FROM rsvps WHERE trip_id = $1 AND LOWER(name) = LOWER($2)',
      [req.params.id, name.trim()]
    );
    if (existing.rows.length) {
      const { rows } = await pool.query(
        'UPDATE rsvps SET status = $1 WHERE id = $2 RETURNING *',
        [s, existing.rows[0].id]
      );
      return res.json(rows[0]);
    }

    const { rows } = await pool.query(
      'INSERT INTO rsvps (trip_id, name, status) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, name.trim(), s]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add RSVP' });
  }
});

// Delete RSVP (PIN required)
app.delete('/api/trip/:id/rsvp/:rsvpId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });
    await pool.query('DELETE FROM rsvps WHERE id = $1 AND trip_id = $2', [req.params.rsvpId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete RSVP' });
  }
});

// Add expense (no PIN — anyone can log what they paid)
app.post('/api/trip/:id/expenses', async (req, res) => {
  try {
    const { description, amount, paid_by, split_with } = req.body;
    if (!description || !amount || !paid_by) return res.status(400).json({ error: 'All fields required' });
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const splitArr = Array.isArray(split_with) ? split_with : [];
    const { rows } = await pool.query(
      'INSERT INTO expenses (trip_id, description, amount, paid_by, split_with) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, description, parseFloat(amount).toFixed(2), paid_by, splitArr]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add expense' });
  }
});

// Toggle expense settled (no PIN — the person who paid marks when they're paid back)
app.patch('/api/trip/:id/expenses/:expId/settle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE expenses SET settled = NOT settled WHERE id = $1 AND trip_id = $2 RETURNING *',
      [req.params.expId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// Delete expense (PIN required)
app.delete('/api/trip/:id/expenses/:expId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!await verifyPin(req.params.id, pin)) return res.status(401).json({ error: 'Invalid PIN' });
    await pool.query('DELETE FROM expenses WHERE id = $1 AND trip_id = $2', [req.params.expId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Trip planner running on port ${PORT}`));
});
