# ✦ Spark — AI Video Chat Coach (Serverless)

A fully serverless video chat app with real-time AI coaching powered by **Google Gemini**. No backend required — just open the HTML file (or host it on GitHub Pages).

## How it works

- **PeerJS** (free hosted signaling) handles WebRTC matchmaking — no server needed
- **WebRTC** sends video/audio directly peer-to-peer between browsers
- **Web Speech API** transcribes speech in real time (Chrome)
- **Gemini 1.5 Flash** analyzes actual video frames + the transcript every ~14 seconds and gives you coaching hints

## No server. No backend. Just static files.

---

## Setup

### Option A — GitHub Pages (free, permanent URL)

1. Fork or push this folder to a GitHub repo
2. Go to repo **Settings → Pages → Source → main branch / root**
3. Your app is live at `https://YOUR_USERNAME.github.io/REPO_NAME`
4. Open it, enter your Gemini API key, share the room code

### Option B — Open locally

Just open `index.html` directly in Chrome.

> ⚠️ Camera/mic require either `localhost` or `https://`. If opening as a file (`file://`), camera may be blocked by the browser. Use a simple local server instead:
> ```bash
> npx serve .
> # or
> python3 -m http.server 8080
> ```
> Then open http://localhost:8080

### Option C — Netlify Drop

Drag the entire folder to [netlify.com/drop](https://app.netlify.com/drop) — instant public URL, no account needed.

---

## How to connect with someone

1. Both people open the same URL
2. Person A enters a room code (e.g. `spark-aurora-4521`) and clicks **Start**
3. Person A shares that room code with Person B
4. Person B enters the **same room code** and clicks **Start**
5. They connect automatically

> Each person uses their own Gemini API key — it never leaves their browser.

---

## Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key**
3. Free tier is generous — enough for many hours of analysis

---

## What gets analyzed

Every ~14 seconds (or when you click 🔍), Gemini receives:
- A JPEG frame from **your video** (your expressions)
- A JPEG frame from **your partner's video** (their expressions, body language, environment)
- The last 10 lines of **transcript** (speech-to-text from both sides)

Gemini returns:
- A coaching hint (what to notice, how to respond)
- Conversation mood scores (energy, curiosity, humor, depth)
- Detected topics
- 3 questions you could ask
- Suggested topic directions

---

## Files

```
spark-gemini/
├── index.html        ← Main app (open this)
├── css/
│   └── style.css     ← All styles
└── js/
    ├── speech.js     ← Web Speech API (mic transcription)
    ├── gemini.js     ← Gemini API calls + coach UI
    └── app.js        ← PeerJS WebRTC + app logic
```

---

## Browser support

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| WebRTC video | ✅ | ✅ | ✅ |
| Auto speech transcription | ✅ | ❌ | Partial |
| Video frame analysis | ✅ | ✅ | ✅ |
| Manual text input | ✅ | ✅ | ✅ |

**Use Chrome** for the best experience (full speech-to-text support).

---

## Privacy

- Your API key is stored **only in memory** for the session — never in localStorage, never sent anywhere except directly to Google's API
- Video goes **peer-to-peer** (WebRTC) — it never passes through any server
- A compressed JPEG frame is sent to Google Gemini every ~14 seconds for analysis
- PeerJS signaling server only sees room codes, not any video/audio data
