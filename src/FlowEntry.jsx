import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, Eye, EyeOff, ChevronDown } from "lucide-react";
import bgImage from "./assets/Bg.png";

// TAKEN_NAMES removed since we use the API backend bloom filter

const MOTE_COUNT = 7;
const MOTES = Array.from({ length: MOTE_COUNT }, (_, i) => ({
  id: i,
  left: 6 + ((i * 137) % 88),
  delay: (i * 1.3) % 8,
  duration: 10 + ((i * 2.7) % 8),
  size: 2 + ((i % 3) * 1.1),
}));

export default function FlowEntry() {
  const navigate = useNavigate();
  const [screen, setScreen] = useState("entry"); // entry | loading | world
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loginMode, setLoginMode] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | checking | available | taken | invalid

  // Map picker state
  const [mapPickerMode, setMapPickerMode] = useState(false);
  const [mapsList, setMapsList] = useState([]);
  const [selectedMapId, setSelectedMapId] = useState("");

  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    const trimmed = name.trim();

    if (!trimmed) {
      setStatus("idle");
      return;
    }
    if (trimmed.length < 3) {
      setStatus("invalid");
      return;
    }

    setStatus("checking");
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        setStatus(data.exists ? "taken" : "available");
      } catch (err) {
        console.error("Failed to check name", err);
        setStatus("idle");
      }
    }, 400);

    return () => clearTimeout(timer.current);
  }, [name]);

  const canProceed = status === "available" || status === "taken";

  const handleAction = async () => {
    if (!canProceed) return;
    const trimmed = name.trim();
    
    if (status === "available") {
      navigate(`/register?name=${encodeURIComponent(trimmed)}`);
    } else if (status === "taken") {
      if (!loginMode) {
        // Show password field
        setLoginMode(true);
      } else if (!mapPickerMode) {
        // Validate password, then show map picker
        try {
          const res = await fetch('/api/users/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed, password })
          });
          
          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Login failed");
          }
          
          // Password correct! Fetch maps list
          const mapsRes = await fetch('/api/maps');
          const maps = await mapsRes.json();
          setMapsList(maps);
          
          // Pre-select the user's current map if they have one
          const userRes = await fetch(`/api/users/${encodeURIComponent(trimmed)}`);
          if (userRes.ok) {
            const user = await userRes.json();
            if (user.map_id) {
              // User already has a map assigned, enter game directly!
              navigate(`/viewer?user=${encodeURIComponent(trimmed)}`);
              return;
            }
          }
          
          if (maps.length > 0) {
            setSelectedMapId(maps[maps.length - 1].mapId || maps[maps.length - 1].id);
          }
          
          setMapPickerMode(true);
        } catch (err) {
          console.error(err);
          alert(err.message);
        }
      } else {
        // Map selected — update user's map_id and enter game
        if (!selectedMapId) return;
        try {
          await fetch(`/api/users/${encodeURIComponent(trimmed)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ map_id: selectedMapId })
          });
          navigate(`/viewer?user=${encodeURIComponent(trimmed)}`);
        } catch (err) {
          console.error(err);
          alert("Failed to update map selection");
        }
      }
    }
  };

  const statusCopy = {
    idle: "",
    invalid: "At least 3 characters",
    checking: "Checking availability\u2026",
    available: "This name is free \u2014 claim it",
    taken: mapPickerMode 
      ? "Pick a world to explore"
      : "Someone already walks under that name, login if it\u2019s you",
  }[status];

  const buttonLabel = status === "available" 
    ? "Register" 
    : mapPickerMode 
      ? "Enter" 
      : loginMode 
        ? "Next" 
        : "Login";

  const buttonDisabled = !canProceed 
    || (loginMode && !mapPickerMode && !password)
    || (mapPickerMode && !selectedMapId);

  return (
    <div className="flow-root">
      <style>{css}</style>

      {screen === "entry" && (
        <div className="stage">
          <div className="motes" aria-hidden="true">
            {MOTES.map((m) => (
              <span
                key={m.id}
                className="mote"
                style={{
                  left: `${m.left}%`,
                  width: m.size,
                  height: m.size,
                  animationDelay: `${m.delay}s`,
                  animationDuration: `${m.duration}s`,
                }}
              />
            ))}
          </div>

          <header className="topbar">
            <div className="wordmark">
              <span className="wordmark-dot" />
              FLOW
            </div>
          </header>

          <main className="hero">
            <h1 className="headline">
              <span className="line line-1">Finding Legends:</span>
              <span className="line line-2">
                Open Worlds
                <span className="rule" aria-hidden="true" />
              </span>
            </h1>

            <p className="prompt">Start your journey from the starting village</p>

            <div className="cta-row">
              <div className={`name-field status-${status}${mapPickerMode ? ' map-picker-field' : ''}`}>
                {mapPickerMode ? (
                  <div className="map-select-wrap">
                    <select
                      value={selectedMapId}
                      onChange={(e) => setSelectedMapId(e.target.value)}
                      className="map-select"
                      autoFocus
                    >
                      <option value="" disabled>Select a world\u2026</option>
                      {mapsList.map((m) => (
                        <option key={m.mapId || m.id} value={m.mapId || m.id}>
                          Map {m.mapId} {m.frozen ? "\uD83D\uDD12 Frozen" : "\uD83C\uDF31 Active"}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} className="select-chevron" />
                  </div>
                ) : !loginMode ? (
                  <input
                    type="text"
                    value={name}
                    maxLength={20}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (loginMode) setLoginMode(false);
                    }}
                    placeholder="Enter your name"
                    aria-label="Enter your name"
                    onKeyDown={(e) => e.key === "Enter" && handleAction()}
                  />
                ) : (
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    aria-label="Enter password"
                    onKeyDown={(e) => e.key === "Enter" && handleAction()}
                    autoFocus
                  />
                )}
                {status === "taken" && loginMode && !mapPickerMode ? (
                  <button
                    type="button"
                    className="eye-btn"
                    onClick={() => setShowPw(!showPw)}
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                ) : !mapPickerMode ? (
                  <span className="status-icon" aria-hidden="true">
                    {status === "checking" && <span className="spinner" />}
                    {status === "available" && <Check size={16} />}
                    {status === "taken" && !loginMode && <X size={16} />}
                  </span>
                ) : null}
              </div>

              <button
                type="button"
                className="begin-btn"
                disabled={buttonDisabled}
                onClick={handleAction}
              >
                {buttonLabel}
              </button>
            </div>

            <p className={`status-msg ${mapPickerMode ? 'msg-available' : `msg-${status}`}`} role="status">
              {statusCopy || "\u00A0"}
            </p>
          </main>
        </div>
      )}

      {screen === "loading" && (
        <div className="stage loading-stage">
          <div className="loading-core">
            <span className="loading-ring" />
            <p>Entering the village\u2026</p>
          </div>
        </div>
      )}

      {screen === "world" && (
        <div className="stage world-stage">
          <div className="world-card">
            <span className="wordmark-dot" />
            <h2>Welcome, {name}.</h2>
            <p>The village gates are open. Your journey begins here.</p>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setScreen("entry");
                setName("");
                setStatus("idle");
              }}
            >
              \u2190 Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Manrope:wght@400;500;600;700;800&display=swap');

.flow-root {
  --void: #05060c;
  --scrim-top: rgba(4,6,14,0.5);
  --scrim-bottom: rgba(3,4,10,0.97);
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

.stage {
  position: relative;
  min-height: 640px;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: var(--void);
  display: flex;
  flex-direction: column;
}

.stage::before {
  content: "";
  position: absolute;
  inset: -2%;
  background-image: url(${bgImage});
  background-size: cover;
  background-position: center 30%;
  animation: pan 34s ease-in-out infinite alternate;
  z-index: 0;
}

.stage::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, var(--scrim-top) 0%, rgba(4,6,14,0.15) 32%, rgba(4,6,14,0.35) 55%, var(--scrim-bottom) 92%),
    linear-gradient(90deg, rgba(3,4,10,0.55) 0%, rgba(3,4,10,0.05) 42%, rgba(3,4,10,0) 70%);
  z-index: 1;
}

@keyframes pan {
  from { transform: scale(1.02) translate(0, 0); }
  to   { transform: scale(1.08) translate(-1%, -1%); }
}

.motes {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.mote {
  position: absolute;
  bottom: -4%;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 6px 1px var(--cyan);
  opacity: 0;
  animation-name: rise;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}

@keyframes rise {
  0%   { opacity: 0; transform: translateY(0); }
  12%  { opacity: 0.75; }
  85%  { opacity: 0.3; }
  100% { opacity: 0; transform: translateY(-92vh); }
}

.topbar {
  position: relative;
  z-index: 3;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 28px clamp(20px, 4vw, 56px) 0;
}

.wordmark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'Manrope', sans-serif;
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.38em;
  color: var(--parchment);
}

.wordmark-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 8px 2px var(--cyan);
  animation: pulse 2.6s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.55; transform: scale(0.85); }
  50%      { opacity: 1;    transform: scale(1.1); }
}

.hero {
  position: relative;
  z-index: 3;
  margin-top: auto;
  padding: 0 clamp(20px, 4vw, 56px) clamp(48px, 8vh, 88px);
  max-width: 640px;
  animation: rise-in 900ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes rise-in {
  from { opacity: 0; transform: translateY(18px); }
  to   { opacity: 1; transform: translateY(0); }
}

.headline {
  margin: 0 0 18px;
  font-family: 'Cinzel', serif;
}

.headline .line {
  display: block;
}

.line-1 {
  font-weight: 600;
  font-size: clamp(22px, 3.2vw, 32px);
  letter-spacing: 0.02em;
  color: var(--parchment);
  opacity: 0.92;
}

.line-2 {
  position: relative;
  font-weight: 900;
  font-size: clamp(40px, 6.4vw, 76px);
  line-height: 1.04;
  letter-spacing: 0.01em;
  color: var(--parchment);
  text-shadow: 0 0 34px rgba(99, 201, 255, 0.25);
  display: inline-flex;
  align-items: center;
  gap: clamp(14px, 3vw, 32px);
}

.rule {
  flex: 1 1 auto;
  min-width: 40px;
  height: 2px;
  background: linear-gradient(90deg, var(--cyan), var(--magenta), transparent);
  border-radius: 2px;
}

.prompt {
  margin: 0 0 22px;
  font-family: 'Manrope', sans-serif;
  font-weight: 600;
  font-size: clamp(13px, 1.5vw, 15px);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cyan);
  opacity: 0.9;
}

.cta-row {
  display: flex;
  align-items: stretch;
  gap: 14px;
  flex-wrap: wrap;
}

.name-field {
  position: relative;
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 54px;
  padding: 0 20px;
  border-radius: 999px;
  background: rgba(244, 236, 221, 0.06);
  border: 1.5px solid rgba(244, 236, 221, 0.3);
  backdrop-filter: blur(6px);
  transition: border-color 200ms ease, background 200ms ease, box-shadow 200ms ease;
}

.name-field:focus-within {
  border-color: var(--cyan);
  background: rgba(99, 201, 255, 0.08);
  box-shadow: 0 0 0 4px rgba(99, 201, 255, 0.14);
}

.name-field.status-available {
  border-color: var(--cyan);
}

.name-field.status-taken,
.name-field.status-invalid {
  border-color: var(--error);
}

.name-field.map-picker-field {
  border-color: var(--cyan);
}

.name-field input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--parchment);
  font-family: 'Manrope', sans-serif;
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.02em;
  text-align: left;
}

/* Disable the default browser eye icon for password inputs */
.name-field input[type="password"]::-ms-reveal,
.name-field input[type="password"]::-ms-clear {
  display: none;
}

.name-field input::placeholder {
  color: rgba(244, 236, 221, 0.45);
  font-weight: 500;
}

.map-select-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  position: relative;
}

.map-select {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--parchment);
  font-family: 'Manrope', sans-serif;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.02em;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  padding-right: 24px;
}

.map-select option {
  background: #1a1d24;
  color: var(--parchment);
}

.select-chevron {
  position: absolute;
  right: 0;
  pointer-events: none;
  color: var(--slate);
}

.status-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 13px;
  flex-shrink: 0;
}

.status-available .status-icon { color: var(--cyan); }
.status-taken .status-icon,
.status-invalid .status-icon { color: var(--error); }

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

@keyframes spin {
  to { transform: rotate(360deg); }
}

.begin-btn {
  flex: 0 0 auto;
  height: 54px;
  padding: 0 30px;
  border-radius: 999px;
  border: none;
  font-family: 'Manrope', sans-serif;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.03em;
  color: #1a0810;
  background: linear-gradient(135deg, var(--pink) 0%, var(--pink-deep) 100%);
  box-shadow: 0 10px 28px -8px rgba(239, 93, 132, 0.65);
  cursor: pointer;
  transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
}

.begin-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 14px 32px -8px rgba(239, 93, 132, 0.8);
}

.begin-btn:active:not(:disabled) {
  transform: translateY(0);
}

.begin-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

.begin-btn:focus-visible,
.ghost-btn:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 3px;
}

.name-field input:focus::placeholder {
  opacity: 0;
}

.status-msg {
  min-height: 18px;
  margin: 12px 2px 0;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--slate);
}

.msg-available { color: var(--cyan); }
.msg-taken, .msg-invalid { color: var(--error); }
.msg-checking { color: var(--amber); }

.loading-stage, .world-stage {
  align-items: center;
  justify-content: center;
}

.loading-stage::before, .world-stage::before {
  background-image: url(${bgImage});
  filter: brightness(0.35) saturate(0.8);
}

.loading-core {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  font-family: 'Manrope', sans-serif;
  letter-spacing: 0.08em;
  color: var(--slate);
}

.loading-ring {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid rgba(244, 236, 221, 0.15);
  border-top-color: var(--cyan);
  animation: spin 900ms linear infinite;
}

.world-card {
  position: relative;
  z-index: 3;
  text-align: center;
  max-width: 420px;
  padding: 0 24px;
  animation: rise-in 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.world-card h2 {
  font-family: 'Cinzel', serif;
  font-weight: 700;
  font-size: clamp(26px, 4vw, 36px);
  margin: 14px 0 10px;
}

.world-card p {
  color: var(--slate);
  font-size: 14.5px;
  margin: 0 0 26px;
}

.ghost-btn {
  height: 46px;
  padding: 0 26px;
  border-radius: 999px;
  background: rgba(244, 236, 221, 0.06);
  border: 1.5px solid rgba(244, 236, 221, 0.3);
  color: var(--parchment);
  font-family: 'Manrope', sans-serif;
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}

.ghost-btn:hover {
  border-color: var(--cyan);
  background: rgba(99, 201, 255, 0.08);
}

@media (max-width: 560px) {
  .cta-row { flex-direction: column; }
  .begin-btn { width: 100%; }
  .line-2 { gap: 12px; }
  .rule { min-width: 24px; }
}

@media (prefers-reduced-motion: reduce) {
  .stage::before, .mote, .wordmark-dot, .hero, .spinner, .loading-ring, .world-card {
    animation: none !important;
  }
}
`;
