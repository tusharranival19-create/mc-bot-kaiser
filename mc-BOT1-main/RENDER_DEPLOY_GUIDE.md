# Render.com Pe Deploy Kaise Kare — Step by Step Guide

## Pehle Kya Chahiye
- GitHub account (free): https://github.com
- Render account (free): https://render.com

---

## Step 1: GitHub Pe Upload Karo

### 1a. GitHub account banao (agar nahi hai)
1. https://github.com jao
2. "Sign up" click karo
3. Email, password, username dalo
4. Account verify karo

### 1b. Naya repository banao
1. GitHub pe login karo
2. Upar `+` button click karo → "New repository"
3. Repository name: `mc-afk-bot`
4. Private select karo (recommended)
5. "Create repository" click karo

### 1c. Files upload karo
1. Repository page pe "uploading an existing file" link click karo
2. `mc-afk-bot-newversion/` folder ke andar ki sab files select karo:
   - `server.js`
   - `package.json`
   - `public/` folder (poora)
3. "Commit changes" click karo

---

## Step 2: Render.com Account Banao

1. https://render.com jao
2. "Get Started for Free" click karo
3. GitHub se sign up karo (same GitHub account jo abhi banaya)
4. GitHub authorize karo

---

## Step 3: New Web Service Banao

1. Render dashboard pe **"New +"** button click karo
2. **"Web Service"** select karo
3. GitHub account connect karo (agar nahi hua)
4. Repository list mein **`mc-afk-bot`** dhundho → **"Connect"** click karo

---

## Step 4: Service Configure Karo

Yeh fields fill karo:

| Field | Value |
|-------|-------|
| **Name** | mc-afk-bot (ya jo chahiye) |
| **Region** | Singapore (Asia ke liye best) |
| **Branch** | main |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | Free |

---

## Step 5: Environment Variables Set Karo

"Environment Variables" section mein yeh add karo:

| Key | Value |
|-----|-------|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |

Click **"Add Environment Variable"** for each one.

---

## Step 6: Deploy Karo

1. "Create Web Service" button click karo
2. Render automatically build karega (2-3 minute lagenge)
3. Logs mein `[Server] Running on port 10000` dikhega
4. Upar URL milega: `https://mc-afk-bot-xxxx.onrender.com`

---

## Step 7: Website Access Karo

1. Render ne jo URL diya use browser mein open karo
2. 100 bot slots ka Discord-jaisa panel dikhega
3. Kisi bhi slot pe click karo → Register → settings dalo → Start Bot!

---

## Important Notes

### Free Plan Ki Limitations
- Free plan pe service **15 minute inactivity** ke baad sleep ho jati hai
- Bot **automatically ping karta hai** har 4 minute mein (already code mein hai)
- Phir bhi agar sleep ho jaye to pehla request aane pe 30-50 second lagenge

### 24/7 Ke Liye
- Render ka **Starter plan** ($7/month) lelo — sleep nahi hogi
- Ya **UptimeRobot** (free) se har 5 minute mein ping karwa sakte ho:
  1. https://uptimerobot.com jao → free account banao
  2. "Add New Monitor" → HTTP(S) select karo
  3. URL: `https://your-app.onrender.com/api/healthz`
  4. Interval: 5 minutes

### Bot Data Storage
- Bot settings `bot-slots.json` file mein save hoti hain
- Render pe har restart pe file **delete ho jati hai** (Ephemeral storage)
- Data save rakhne ke liye **Render Disk** add karo:
  1. Service settings mein "Disks" section jao
  2. "Add Disk" click karo
  3. Mount Path: `/opt/render/project/src` (ya project folder)
  4. Size: 1 GB (free mein available)

### Logs Kaise Dekhe
1. Render dashboard mein service pe click karo
2. "Logs" tab mein jao
3. Real-time logs dikhenge

---

## Koi Problem Aaye To

### Build fail ho rahi hai
- Check karo `package.json` mein `node version` >= 20 hai
- Build Command: `npm install` (exactly yahi hona chahiye)

### Website open nahi ho rahi
- Logs mein error dekho
- PORT environment variable set hai ya nahi

### Bot join nahi ho raha
- Minecraft server ka IP/Port check karo
- Version match karo (server ka version aur bot ka version same hona chahiye)

---

## Support
Koi issue ho to logs copy karo aur share karo.

**Made by King Khizar**
