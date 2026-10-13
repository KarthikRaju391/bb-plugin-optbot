// BB's server can freeze for seconds (synchronous SQLite, provider catalog refreshes) and a plugin's call to
// its own API then fails with a network error even though nothing went wrong with the work itself.
export const TRANSIENT_NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|other side closed/i;
