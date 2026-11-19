type Credential = { username: string; password: string; userId: number; origin: string };

// Previous upstream versions stored a password here. Discard it without reading
// or migrating it. WebView storage may be disabled.
try { localStorage.removeItem("hghubx_credential_v1"); } catch { /* storage unavailable */ }

let current: Credential | null = null;

export function saveCredential(username: string, password: string, userId: number, origin: string) {
  current = { username, password, userId, origin };
}

export function credentialFor(userId: number) {
  return current?.userId === userId ? current : null;
}

export function forgetCredential() {
  current = null;
}
