# Activating accounts (5 minutes, free)

Accounts, friends, and private chat are fully built into the site, but they need a
free backend to store users and send verification emails. Until you finish these
steps, the site works exactly as before — the Sign in button just stays hidden.

## 1. Create the project
1. Go to https://supabase.com → **Start your project** → sign up (GitHub login works)
2. **New project** → any name (e.g. `spark`) → set a database password (save it somewhere) → region closest to you → **Create**
3. Wait ~2 minutes for it to provision

## 2. Create the database tables
1. In the left sidebar: **SQL Editor** → **New query**
2. Open the file `supabase/schema.sql` from this repo, copy ALL of it, paste it in
3. Click **Run** — you should see "Success. No rows returned"

## 3. Make the email send a 6-digit code
1. Left sidebar: **Authentication** → **Email Templates** → **Magic Link** tab
2. Replace the message body with:
   ```html
   <h2>Your Spark sign-in code</h2>
   <p>Enter this code in the app:</p>
   <h1 style="letter-spacing:6px">{{ .Token }}</h1>
   <p>It expires in 1 hour. If you didn't request this, ignore this email.</p>
   ```
3. Click **Save**

## 4. Set your site URL
1. **Authentication** → **URL Configuration**
2. Set **Site URL** to: `https://sudo-vermont.github.io/Spark/`

## 5. Paste the two keys into the site
1. **Project Settings** (gear icon) → **API**
2. Copy **Project URL** and the **anon public** key
3. Open `js/config.js` in this repo and fill them in:
   ```js
   const SPARK_CONFIG = {
     supabaseUrl: 'https://YOURPROJECT.supabase.co',
     supabaseAnonKey: 'eyJhbGciOi...'
   };
   ```
4. Commit and push — done. The 👤 Sign in button appears in the header.

> The anon key is **designed to be public** — it's safe in the repo. Every
> permission (who can read profiles, send requests, message whom) is enforced
> by the database's Row Level Security policies from step 2, which the browser
> cannot bypass or modify.

## Good to know
- **Email limits**: Supabase's built-in email sender allows only a few emails per
  hour — fine for testing. If you get real users, plug in free SMTP (e.g.
  resend.com) under **Project Settings → Auth → SMTP Settings**.
- **What's protected**: users can only edit their own profile, only message
  accepted friends, only read their own conversations, and only the recipient
  of a friend request can accept it.
