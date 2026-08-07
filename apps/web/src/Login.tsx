import { useState } from "react";
import { api } from "./api";

/**
 * The reviewer sign-in screen.
 *
 * Used to be server-rendered HTML the API handed back for any unauthenticated
 * page load. Now the API is a pure JSON service with nothing to render, so the
 * login screen lives here instead — same flow (POST /api/login sets a session
 * cookie), just as a React view.
 */
export function Login({ onSignedIn }: { onSignedIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.login(username, password);
      onSignedIn(result.username);
    } catch {
      setError("Invalid credentials");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1>RegReview</h1>
        {error && <div className="login-error">{error}</div>}
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
