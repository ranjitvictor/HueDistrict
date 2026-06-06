const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

const ALLOWED_EMAILS = new Set([
  'shriyaranjit28@gmail.com',
  'arnuranj@gmail.com',
  'ranjitvictor@gmail.com',
]);

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (email && ALLOWED_EMAILS.has(email)) {
      return done(null, { email, name: profile.displayName });
    }
    return done(null, false);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

const loginPage = (error = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — HueDistrict</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 48px 40px; width: 100%; max-width: 380px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06); text-align: center; }
    h1 { font-size: 20px; font-weight: 600; color: #111; margin-bottom: 6px; }
    .sub { color: #6b7280; font-size: 14px; margin-bottom: 32px; }
    .error { color: #b91c1c; font-size: 13px; margin-bottom: 20px; background: #fef2f2; border: 1px solid #fecaca; padding: 10px 14px; border-radius: 8px; }
    .google-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; padding: 11px 20px; text-decoration: none; color: #111; font-size: 14px; font-weight: 500; transition: background 0.15s, box-shadow 0.15s; cursor: pointer; }
    .google-btn:hover { background: #f9fafb; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <h1>HueDistrict Admin</h1>
    <p class="sub">Sign in to access the admin panel</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <a href="/auth/google" class="google-btn">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.32-8.16 2.32-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google
    </a>
  </div>
</body>
</html>`;

const dashboardPage = (user) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — HueDistrict</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; min-height: 100vh; }
    header { background: #fff; border-bottom: 1px solid #e5e7eb; height: 58px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 15px; font-weight: 600; color: #111; }
    .right { display: flex; align-items: center; gap: 14px; }
    .email { font-size: 13px; color: #6b7280; }
    .logout { font-size: 13px; color: #374151; text-decoration: none; padding: 5px 12px; border: 1px solid #d1d5db; border-radius: 6px; transition: background 0.15s; }
    .logout:hover { background: #f3f4f6; }
    main { max-width: 1100px; margin: 0 auto; padding: 40px 28px; }
    h1 { font-size: 22px; font-weight: 600; color: #111; }
  </style>
</head>
<body>
  <header>
    <span class="logo">HueDistrict Admin</span>
    <div class="right">
      <span class="email">${user.email}</span>
      <a href="/logout" class="logout">Sign out</a>
    </div>
  </header>
  <main>
    <h1>Dashboard</h1>
  </main>
</body>
</html>`;

app.get('/login', (req, res) => {
  const error = req.query.error === 'access_denied'
    ? 'Your account is not authorized to access this panel.'
    : '';
  res.send(loginPage(error));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=access_denied' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

app.get('/', requireAuth, (req, res) => {
  res.send(dashboardPage(req.user));
});

app.listen(process.env.PORT || 3000);
