# Deploy: SAT practice VPS backend (EC2 t3.medium, Ubuntu 24.04)

## 0. Provision (once)

```bash
sudo apt update && sudo apt install -y nodejs npm postgresql nginx certbot python3-certbot-nginx
sudo -u postgres psql -c "CREATE USER waleed WITH PASSWORD 'waleedface';"
sudo -u postgres psql -c "CREATE DATABASE satbank OWNER waleed;"
cd server   # wherever schema.sql lives
sudo -u postgres psql -d satbank -f schema.sql
```

## 1. Configure + run

```bash
cd server && npm install
cp .env.example .env   # fill DATABASE_URL, CORS_ORIGIN=https://your-domain.com, TZ
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
sudo cp nginx-satbank.conf /etc/nginx/sites-available/satbank  # set server_name + root
sudo ln -s /etc/nginx/sites-available/satbank /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
curl https://your-domain.com/api/health  # {"ok":true,...}
# No domain? Use the sslip.io hostname for your VPS IP (dashes, not dots):
# server_name 51-84-109-28.sslip.io + `sudo certbot --nginx -d 51-84-109-28.sslip.io`.
# Direct https:// access is required — browsers block HTTPS pages from calling
# plain http://IP backends (mixed content), which is why the Netlify proxy existed.
```

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
# daily backup
(crontab -l; echo "0 3 * * * pg_dump \$DATABASE_URL | gzip > ~/satbank-backup.sql.gz") | crontab -
```

## 2. Parallel run → cutover → rollback

1. Deploy frontend with `SATBANK_BACKEND = { url: "https://your-domain.com", enabled: false }`.
   Test one machine via `?backend=1` (answer → presence pills → challenge → history).
2. Parallel run: set `localStorage.satbank_dualwrite = "1"` on every machine —
   answers also forward to Firestore (best effort), so rollback keeps data.
3. Cutover at a low-traffic hour: flip `enabled: true`, redeploy static files.
   Keep the Firestore project untouched for 1 week.
4. Rollback: flip `enabled: false` and redeploy (or just run
   `localStorage.satbank_backend = "0"`). No restore needed.
5. After 1 clean week: remove dual-write, then decommission Firebase.

## 3. Ops notes

- Single PM2 instance (fork). Do NOT scale to cluster: socket rooms, the
  invite sweep, and the presence refresh live in-process.
- If presence looks stale, check server TZ (`TZ=Asia/Hebron` in `.env`) and
  `SELECT name, last_seen FROM status`.
- Edits (reset a PIN, delete a user): use `psql` directly — no admin panel.
  `UPDATE users SET pin='123456' WHERE name='ali';`

## 4. See your data (pgweb dashboard, optional)

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo docker run -d --name pgweb --network host --restart unless-stopped \
  -e DATABASE_URL="postgres://waleed:waleedface@localhost:5432/satbank" \
  sosedoff/pgweb --bind=0.0.0.0 --listen=8081
```

Open TCP `8081` in the security group (same flow as port 3001), then browse to
`http://YOUR_VPS_IP:8081` — tables in the left sidebar, click to browse,
Query tab for SQL. No login (lock down before any public use).
