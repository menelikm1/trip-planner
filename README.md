# Trip Planner

A shared birthday trip planner with PIN-protected editing and group voting.

## Stack
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (via Railway plugin)
- **Frontend**: Vanilla HTML/CSS/JS (served as a static file by Express)

## Project structure
```
trip-planner/
├── server.js          ← Express API + serves frontend
├── public/
│   └── index.html     ← Full frontend app
├── package.json
├── railway.toml       ← Railway deploy config
├── .env.example       ← Copy to .env for local dev
└── .gitignore
```

---

## Local development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```
Edit `.env` and add your local Postgres connection string:
```
DATABASE_URL=postgresql://user:password@localhost:5432/tripplanner
NODE_ENV=development
PORT=3000
```

### 3. Create a local Postgres database
```bash
createdb tripplanner
```
(Tables are created automatically on first run.)

### 4. Run the dev server
```bash
npm run dev
```
Visit http://localhost:3000

---

## Deploy to Railway

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/trip-planner.git
git push -u origin main
```

### 2. Create a Railway project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `trip-planner` repo

### 3. Add a Postgres database
1. In your Railway project, click **+ New**
2. Select **Database** → **PostgreSQL**
3. Railway automatically sets the `DATABASE_URL` environment variable — no manual config needed

### 4. Set environment variables
In your Railway service settings → **Variables**, add:
```
NODE_ENV=production
```
(`DATABASE_URL` and `PORT` are set automatically by Railway.)

### 5. Deploy
Railway auto-deploys on every push to `main`. Your app will be live at:
```
https://your-project-name.up.railway.app
```

---

## How sharing works

1. The planner creates a trip and sets a 4-digit PIN
2. A unique trip ID is generated (UUID)
3. Share the link: `https://your-app.up.railway.app?trip=TRIP_ID`
4. Group members open the link → view itinerary + cast votes (no PIN needed)
5. Only the PIN holder can add/edit/delete items

## API routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/trip` | — | Create a new trip |
| GET | `/api/trip/:id` | — | Get trip data (viewer) |
| POST | `/api/trip/:id/verify` | — | Verify planner PIN |
| POST | `/api/trip/:id/stays` | PIN | Add accommodation |
| DELETE | `/api/trip/:id/stays/:stayId` | PIN | Delete accommodation |
| POST | `/api/trip/:id/activities` | PIN | Add activity |
| DELETE | `/api/trip/:id/activities/:actId` | PIN | Delete activity |
| POST | `/api/trip/:id/votes` | PIN | Add vote option |
| POST | `/api/trip/:id/votes/:voteId/cast` | — | Cast a vote |
| DELETE | `/api/trip/:id/votes/:voteId` | PIN | Delete vote option |
