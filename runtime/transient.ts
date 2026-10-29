// BB's server can freeze for seconds (synchronous SQLite, provider catalog refreshes) and a plugin's call to
// its own API then fails with a network error even though nothing went wrong with the work itself.
// BB's own relay can also fail a call it never delivered: a 502/503/504 from the server, or a host session that is
// reconnecting (live, 10-27/28: "Failed to call tool: 502 Bad Gateway", "Server session is not open").
export const TRANSIENT_NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|other side closed|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Timeout|Server session is not open|Failed to call tool/i;
