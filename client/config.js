/* ECFC Remote Desktop — client configuration.
 *
 * Point SERVER_URL at your relay/signaling server. It must accept WebSocket
 * connections and speak the JSON protocol described in README.md, including:
 *   { type: 'ping', t }  ->  { type: 'pong', t }
 * (If the server does not implement ping/pong, the client degrades gracefully
 * and simply shows "—" for the ping value.)
 *
 * You can also override this at runtime: the login screen has a server field,
 * and whatever you type there is saved in the browser (localStorage) and used
 * instead of this value.
 */
const SERVER_URL = 'wss://ecfc-remote-desktop.onrender.com';
