import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Eye, EyeOff, X, Check } from "lucide-react";
import panelImage from "./assets/Rg.png";

function getStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

const SOCIALS = [
  { id: "google", label: "Continue with Google", glyph: "G" },
  { id: "discord", label: "Continue with Discord", glyph: "D" },
  { id: "facebook", label: "Continue with Facebook", glyph: "f" },
  { id: "x", label: "Continue with X", glyph: "X" },
];

export default function FlowRegister() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefilledName = new URLSearchParams(location.search).get("name") || "";

  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState(prefilledName ? "register" : "login"); // register | login
  const [username, setUsername] = useState(prefilledName);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState("idle"); // idle | checking | available | taken | invalid
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    const trimmed = username.trim();

    if (!trimmed) {
      setUsernameStatus("idle");
      return;
    }
    if (trimmed.length < 3) {
      setUsernameStatus("invalid");
      return;
    }
    if (mode === "login") {
      setUsernameStatus("idle");
      return;
    }

    setUsernameStatus("checking");
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        setUsernameStatus(data.exists ? "taken" : "available");
      } catch (err) {
        console.error(err);
        setUsernameStatus("idle");
      }
    }, 550);

    return () => clearTimeout(timer.current);
  }, [username, mode]);

  const strength = getStrength(password);
  const confirmMatches = confirm.length > 0 && confirm === password;
  const confirmMismatch = confirm.length > 0 && confirm !== password;

  const canSubmit =
    mode === "login"
      ? username.trim().length >= 3 && password.length > 0
      : usernameStatus === "available" &&
        password.length >= 8 &&
        confirmMatches &&
        agreed;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    
    try {
      const endpoint = mode === "register" ? "/api/users/register" : "/api/users/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: username.trim(), password })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }
      
      setSuccess(true);
      setTimeout(() => {
        if (mode === "register") {
          navigate("/");
        } else {
          navigate(`/viewer?user=${encodeURIComponent(username.trim())}`);
        }
      }, 1200);
    } catch (err) {
      console.error(err);
      alert(err.message);
      setSubmitting(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setSuccess(false);
    setConfirm("");
    setAgreed(false);
  };

  return (
    <div className="flow-reg-root">
      <style>{css}</style>
      <div className="backdrop">
        <div className="blob blob-a" />
        <div className="blob blob-b" />

        <div className="card">
          <div className="panel-image">
            <img src={panelImage} alt="" />
            <div className="panel-scrim" />
            <div className="panel-copy">
              <span className="wordmark">
                <span className="wordmark-dot" />
                FLOW
              </span>
              <h2>Welcome, wanderer</h2>
              <p>your legend starts here</p>
            </div>
          </div>

          <div className="panel-form">
            <button
              type="button"
              className="close-btn"
              onClick={() => navigate("/")}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            {success ? (
              <div className="success-state">
                <div className="success-ring">
                  <Check size={26} />
                </div>
                <h3>{mode === "register" ? "Account created" : "Welcome back"}</h3>
                <p>
                  {mode === "register"
                    ? `${username}, your gates are open.`
                    : `Good to see you again, ${username}.`}
                </p>
                {mode === "register" && <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setSuccess(false);
                    setUsername("");
                    setPassword("");
                    setConfirm("");
                  }}
                >
                  ← Back to form
                </button>}
              </div>
            ) : (
              <>
                <div className="tabs">
                  <button
                    type="button"
                    className={mode === "register" ? "tab tab-active" : "tab"}
                    onClick={() => switchMode("register")}
                  >
                    REGISTRATION
                  </button>
                  <span className="tab-sep">/</span>
                  <button
                    type="button"
                    className={mode === "login" ? "tab tab-active" : "tab"}
                    onClick={() => switchMode("login")}
                  >
                    LOGIN
                  </button>
                </div>

                <form onSubmit={handleSubmit} noValidate>
                  <label className="field-label" htmlFor="username">
                    Username
                  </label>
                  <div className={`field status-${usernameStatus}`}>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      maxLength={20}
                      autoComplete="username"
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter your username"
                    />
                    {mode === "register" && (
                      <span className="status-icon" aria-hidden="true">
                        {usernameStatus === "checking" && <span className="spinner" />}
                        {usernameStatus === "available" && <Check size={16} />}
                        {usernameStatus === "taken" && <X size={16} />}
                      </span>
                    )}
                  </div>
                  {mode === "register" && (
                    <p className={`hint msg-${usernameStatus}`} role="status">
                      {
                        {
                          idle: "\u00A0",
                          invalid: "At least 3 characters",
                          checking: "Checking availability…",
                          available: "This name is free — claim it",
                          taken: "Someone already walks under that name",
                        }[usernameStatus]
                      }
                    </p>
                  )}

                  <div className="field-row">
                    <label className="field-label" style={mode === "register" ? {marginTop: '-15px'} : undefined} htmlFor="password">
                      Password
                    </label>
                    {mode === "register" && (
                      <div className="strength" aria-hidden="true">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className={
                              "strength-seg" +
                              (i < strength ? (strength === 4 ? " full" : " filled") : "")
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <input
                      id="password"
                      type={showPw ? "text" : "password"}
                      value={password}
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowPw((v) => !v)}
                      aria-label={showPw ? "Hide password" : "Show password"}
                    >
                      {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>

                  {mode === "register" && (
                    <>
                      <label className="field-label" htmlFor="confirm">
                        Confirm password
                      </label>
                      <div className={`field ${confirmMismatch ? "status-taken" : confirmMatches ? "status-available" : ""}`}>
                        <input
                          id="confirm"
                          type={showConfirm ? "text" : "password"}
                          value={confirm}
                          autoComplete="new-password"
                          onChange={(e) => setConfirm(e.target.value)}
                          placeholder="Re-enter your password"
                        />
                        <button
                          type="button"
                          className="eye-btn"
                          onClick={() => setShowConfirm((v) => !v)}
                          aria-label={showConfirm ? "Hide password" : "Show password"}
                        >
                          {showConfirm ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                      <p
                        className={
                          "hint " + (confirmMismatch ? "msg-taken" : confirmMatches ? "msg-available" : "")
                        }
                        role="status"
                      >
                        {confirmMismatch
                          ? "Passwords don't match"
                          : confirmMatches
                          ? "Passwords match"
                          : "\u00A0"}
                      </p>

                      <label className="checkbox-row" style={mode === "register" ? {marginTop: '0px'} : undefined}>
                        <input
                          type="checkbox"
                          checked={agreed}
                          onChange={(e) => setAgreed(e.target.checked)}
                        />
                        <span>
                          I agree to the <a href="#terms">Terms of Service</a> and{" "}
                          <a href="#privacy">Privacy Policy</a>.
                        </span>
                      </label>

                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={subscribed}
                          onChange={(e) => setSubscribed(e.target.checked)}
                        />
                        <span>Send me updates about new worlds and events.</span>
                      </label>
                    </>
                  )}

                  <button type="submit" className="submit-btn" disabled={!canSubmit || submitting}>
                    {submitting ? (
                      <span className="spinner spinner-dark" />
                    ) : mode === "register" ? (
                      "CREATE ACCOUNT"
                    ) : (
                      "LOG IN"
                    )}
                  </button>
                </form>

                <div className="divider" style={mode === "register" ? {marginTop: '10px'} : undefined}>
                  <span>or via social network</span>
                </div>

                <div className="social-row">
                  {SOCIALS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="social-btn"
                      aria-label={s.label}
                      title={s.label}
                    >
                      {s.glyph}
                    </button>
                  ))}
                </div>

                <p className="footer-line">
                  {mode === "register" ? (
                    <>
                      Have an account?{" "}
                      <a href="#login" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>
                        Login
                      </a>
                    </>
                  ) : (
                    <>
                      New here?{" "}
                      <a href="#register" onClick={(e) => { e.preventDefault(); switchMode("register"); }}>
                        Create an account
                      </a>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Manrope:wght@400;500;600;700;800&display=swap');

.flow-reg-root {
  --void: #05060c;
  --panel: #0c0e1a;
  --panel-border: rgba(244, 236, 221, 0.1);
  --parchment: #f4ecdd;
  --slate: #93a0c2;
  --cyan: #63c9ff;
  --magenta: #c85fa8;
  --pink: #ef5d84;
  --pink-deep: #c73f66;
  --amber: #d8b76c;
  --error: #ff7a7a;
  font-family: 'Manrope', sans-serif;
  color: var(--parchment);
  width: 100%;
}

.backdrop {
  position: relative;
  height: 100vh;
  box-sizing: border-box;
  width: 100%;
  overflow: hidden;
  background: radial-gradient(ellipse at 30% 0%, #10122a 0%, var(--void) 55%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.35;
  pointer-events: none;
}

.blob-a {
  width: 420px;
  height: 420px;
  background: var(--magenta);
  bottom: -140px;
  right: -100px;
}

.blob-b {
  width: 320px;
  height: 320px;
  background: var(--cyan);
  top: -100px;
  left: -80px;
  opacity: 0.22;
}

.card {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 960px;
  height: min(700px, 95vh);
  display: grid;
  grid-template-columns: 42% 1fr;
  background: var(--panel);
  border-radius: 22px;
  overflow: hidden;
  border: 1px solid var(--panel-border);
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.7);
  animation: rise-in 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes rise-in {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

.panel-image {
  position: relative;
  overflow: hidden;
}

.panel-image img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.panel-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(5,6,12,0.15) 0%, rgba(5,6,12,0.2) 45%, rgba(5,6,12,0.92) 100%),
    linear-gradient(90deg, rgba(5,6,12,0.1) 60%, rgba(5,6,12,0.55) 100%);
}

.panel-copy {
  position: absolute;
  left: 26px;
  right: 26px;
  bottom: 26px;
  z-index: 2;
}

.panel-copy .wordmark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.35em;
  opacity: 0.9;
  margin-bottom: 16px;
}

.wordmark-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 8px 2px var(--cyan);
}

.panel-copy h2 {
  margin: 0 0 4px;
  font-family: 'Cinzel', serif;
  font-weight: 700;
  font-size: clamp(22px, 2.4vw, 28px);
}

.panel-copy p {
  margin: 0;
  color: var(--slate);
  font-size: 13.5px;
  letter-spacing: 0.02em;
}

.panel-form {
  position: relative;
  padding: 24px clamp(20px, 3.6vw, 40px) 20px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--slate);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease;
}

.close-btn:hover {
  background: rgba(244, 236, 221, 0.08);
  color: var(--parchment);
}

.tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 24px;
}

.tab {
  background: none;
  border: none;
  padding: 0;
  font-family: 'Manrope', sans-serif;
  font-weight: 800;
  font-size: 17px;
  letter-spacing: 0.03em;
  color: var(--slate);
  cursor: pointer;
}

.tab-active {
  color: var(--parchment);
}

.tab-sep {
  color: var(--slate);
  opacity: 0.5;
}

.field-label {
  display: block;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin: 14px 0 7px;
  text-align: left;
}

.field-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.field-row .field-label {
  margin-bottom: 7px;
}

.strength {
  display: flex;
  gap: 4px;
  padding-bottom: 8px;
}

.strength-seg {
  width: 18px;
  height: 4px;
  border-radius: 2px;
  background: rgba(244, 236, 221, 0.14);
}

.strength-seg.filled {
  background: var(--cyan);
}

.strength-seg.full {
  background: var(--parchment);
  box-shadow: 0 0 6px 1px var(--cyan);
}

.field {
  position: relative;
  display: flex;
  align-items: center;
  height: 48px;
  border-radius: 12px;
  background: rgba(244, 236, 221, 0.05);
  border: 1.5px solid rgba(244, 236, 221, 0.16);
  padding: 0 14px;
  transition: border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}

.field:focus-within {
  border-color: var(--cyan);
  background: rgba(99, 201, 255, 0.06);
  box-shadow: 0 0 0 4px rgba(99, 201, 255, 0.12);
}

.field.status-available {
  border-color: var(--cyan);
}

.field.status-taken,
.field.status-invalid {
  border-color: var(--error);
}

.field input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--parchment);
  font-family: 'Manrope', sans-serif;
  font-weight: 600;
  font-size: 14.5px;
  text-align: left;
}

/* Disable the default browser eye icon for password inputs */
.field input[type="password"]::-ms-reveal,
.field input[type="password"]::-ms-clear {
  display: none;
}

.field input::placeholder {
  color: rgba(244, 236, 221, 0.4);
  font-weight: 500;
}

.status-icon {
  display: inline-flex;
  color: var(--slate);
  flex-shrink: 0;
}

.status-available .status-icon { color: var(--cyan); }
.status-taken .status-icon { color: var(--error); }

.eye-btn {
  background: none;
  border: none;
  color: var(--slate);
  cursor: pointer;
  display: flex;
  padding: 4px;
  transition: color 160ms ease;
}

.eye-btn:hover {
  color: var(--parchment);
}

.spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(244, 236, 221, 0.25);
  border-top-color: var(--amber);
  animation: spin 700ms linear infinite;
}

.spinner-dark {
  border: 2px solid rgba(26, 8, 16, 0.25);
  border-top-color: #1a0810;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.hint {
  min-height: 16px;
  margin: 6px 2px 0;
  font-size: 12px;
  color: var(--slate);
}

.msg-available { color: var(--cyan); }
.msg-taken, .msg-invalid { color: var(--error); }
.msg-checking { color: var(--amber); }

.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--slate);
  cursor: pointer;
  text-align: left;
}

.checkbox-row input {
  margin-top: 2px;
  width: 16px;
  height: 16px;
  accent-color: var(--cyan);
  flex-shrink: 0;
  cursor: pointer;
}

.checkbox-row a {
  color: var(--cyan);
  text-decoration: underline;
}

.submit-btn {
  margin-top: 22px;
  height: 50px;
  border-radius: 12px;
  border: none;
  width: 100%;
  font-family: 'Manrope', sans-serif;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.06em;
  color: #1a0810;
  background: linear-gradient(135deg, var(--pink) 0%, var(--pink-deep) 100%);
  box-shadow: 0 10px 26px -10px rgba(239, 93, 132, 0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 14px 30px -10px rgba(239, 93, 132, 0.75);
}

.submit-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  box-shadow: none;
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 26px 0 18px;
  color: var(--slate);
  font-size: 12.5px;
}

.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(244, 236, 221, 0.12);
}

.social-row {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.social-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1.5px solid rgba(244, 236, 221, 0.16);
  background: rgba(244, 236, 221, 0.04);
  color: var(--parchment);
  font-family: 'Manrope', sans-serif;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
}

.social-btn:hover {
  border-color: var(--cyan);
  background: rgba(99, 201, 255, 0.08);
  transform: translateY(-2px);
}

.footer-line {
  margin: 22px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--slate);
}

.footer-line a {
  color: var(--cyan);
  text-decoration: underline;
}

.success-state {
  margin: auto 0;
  text-align: center;
  padding: 20px 0;
  animation: rise-in 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.success-ring {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  margin: 0 auto 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--cyan);
  background: rgba(99, 201, 255, 0.1);
  border: 1.5px solid var(--cyan);
  box-shadow: 0 0 20px 2px rgba(99, 201, 255, 0.25);
}

.success-state h3 {
  font-family: 'Cinzel', serif;
  margin: 0 0 8px;
  font-size: 22px;
}

.success-state p {
  color: var(--slate);
  font-size: 14px;
  margin: 0 0 22px;
}

.reopen-btn {
  position: relative;
  z-index: 2;
  height: 48px;
  padding: 0 26px;
  border-radius: 12px;
  border: 1.5px solid rgba(244, 236, 221, 0.25);
  background: rgba(244, 236, 221, 0.05);
  color: var(--parchment);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}

.ghost-btn {
  height: 44px;
  padding: 0 24px;
  border-radius: 12px;
  background: rgba(244, 236, 221, 0.05);
  border: 1.5px solid rgba(244, 236, 221, 0.2);
  color: var(--parchment);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}

.ghost-btn:hover {
  border-color: var(--cyan);
}

@media (max-width: 760px) {
  .card {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .panel-image {
    height: 200px;
  }
  .panel-form {
    max-height: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .card, .success-state { animation: none !important; }
  .spinner { animation: none !important; }
}
`;
