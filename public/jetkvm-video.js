'use strict';

// --- Constants ---
const MAX_BACKOFF = 30000;
const METADATA_TIMEOUT = 10000;
const DISCONNECT_GRACE = 5000;
const INITIAL_BACKOFF = 1000;

// --- Logging ---
function log(msg) {
  console.log(`[jetkvm-video] ${new Date().toISOString()} ${msg}`);
}

// --- SDP Encoding ---

/**
 * Encode an RTCSessionDescription for the JetKVM signaling protocol.
 * Format: base64(JSON.stringify(description))
 */
function encodeSDP(description) {
  return btoa(JSON.stringify(description));
}

/**
 * Decode a base64-encoded SDP string from JetKVM into an RTCSessionDescription.
 */
function decodeSDP(base64) {
  return JSON.parse(atob(base64));
}

// --- Signaling ---

/**
 * Build a signaling message in JetKVM's format.
 */
function buildSignalMessage(type, data) {
  return JSON.stringify({ type, data });
}

/**
 * Parse a signaling message. Returns null if invalid JSON.
 */
function parseSignalMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Build the WebSocket URL for a given host.
 * @param {string} host - Device host (ip:port or hostname)
 * @param {string} pageProtocol - The page's protocol ('http:' or 'https:')
 */
function buildWebSocketUrl(host, pageProtocol) {
  const wsProtocol = pageProtocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${host}/webrtc/signaling/client`;
}

// --- JetKVM Video Viewer ---

/**
 * Create a JetKVM video viewer instance.
 * @param {Object} options
 * @param {string} options.host - JetKVM device address
 * @param {HTMLVideoElement} options.videoElement - Video element to render to
 * @param {string} [options.pageProtocol] - Page protocol for WS URL (default: window.location.protocol)
 * @returns {{ connect: Function, cleanup: Function }}
 */
function createViewer({ host, videoElement, pageProtocol }) {
  if (!host) throw new Error('host is required');
  if (!videoElement) throw new Error('videoElement is required');

  let pc = null;
  let ws = null;
  let reconnecting = false;
  let backoff = INITIAL_BACKOFF;
  let disconnectTimer = null;
  let metadataTimer = null;
  let offerSent = false;

  function cleanup() {
    clearTimeout(disconnectTimer);
    clearTimeout(metadataTimer);
    disconnectTimer = null;
    metadataTimer = null;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch (_) { /* ignore */ }
      pc = null;
    }
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch (_) { /* ignore */ }
      ws = null;
    }
    videoElement.srcObject = null;
  }

  function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    cleanup();
    log(`Reconnecting in ${backoff}ms...`);
    setTimeout(() => {
      reconnecting = false;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }

  function sendSignal(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buildSignalMessage(type, data));
    }
  }

  async function createAndSendOffer() {
    if (offerSent || !pc) return;
    offerSent = true;
    clearTimeout(metadataTimer);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sd = encodeSDP(pc.localDescription);
      sendSignal('offer', { sd });
      log('SDP offer sent');
    } catch (err) {
      log(`Error creating offer: ${err.message}`);
      scheduleReconnect();
    }
  }

  async function connect() {
    cleanup();
    offerSent = false;

    log(`Connecting to ${host}...`);

    try {
      pc = new RTCPeerConnection({
        iceServers: []
      });

      pc.addTransceiver('video', { direction: 'recvonly' });

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          videoElement.srcObject = event.streams[0];
          log('Video track received');
          backoff = INITIAL_BACKOFF;
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        log(`PeerConnection state: ${state}`);
        if (state === 'failed') {
          scheduleReconnect();
        } else if (state === 'disconnected') {
          disconnectTimer = setTimeout(() => scheduleReconnect(), DISCONNECT_GRACE);
        } else if (state === 'connected') {
          clearTimeout(disconnectTimer);
        }
      };

      const wsUrl = buildWebSocketUrl(host, pageProtocol);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        log('WebSocket connected');
        metadataTimer = setTimeout(() => {
          log('device-metadata timeout, sending offer anyway');
          createAndSendOffer();
        }, METADATA_TIMEOUT);
      };

      ws.onmessage = async (event) => {
        const msg = parseSignalMessage(event.data);
        if (!msg) return;

        if (msg.type === 'device-metadata') {
          log(`Device version: ${msg.data?.deviceVersion || 'unknown'}`);
          createAndSendOffer();
        } else if (msg.type === 'answer') {
          try {
            const remoteDesc = decodeSDP(msg.data);
            await pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
            log('Remote description set');
          } catch (err) {
            log(`Error setting remote description: ${err.message}`);
            scheduleReconnect();
          }
        } else if (msg.type === 'new-ice-candidate') {
          try {
            if (msg.data && msg.data.candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(msg.data));
            }
          } catch (err) {
            log(`Error adding ICE candidate: ${err.message}`);
          }
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate !== '') {
          sendSignal('new-ice-candidate', event.candidate.toJSON());
        }
      };

      ws.onerror = () => {
        log('WebSocket error');
      };

      ws.onclose = (event) => {
        log(`WebSocket closed (code: ${event.code})`);
        scheduleReconnect();
      };

    } catch (err) {
      log(`Connection error: ${err.message}`);
      scheduleReconnect();
    }
  }

  return { connect, cleanup };
}

// --- Auto-start when loaded in a browser ---
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const host = params.get('host');
  const videoElement = document.getElementById('video');

  if (!host) {
    videoElement.style.display = 'none';
    document.body.style.display = 'flex';
    document.body.style.alignItems = 'center';
    document.body.style.justifyContent = 'center';
    const msg = document.createElement('p');
    msg.textContent = 'Missing required host parameter. Example: ?host=192.168.1.100';
    msg.style.cssText = 'color:#fff;font-family:system-ui,sans-serif;font-size:1.2rem;text-align:center;padding:2rem;max-width:40rem;';
    document.body.appendChild(msg);
  } else if (videoElement) {
    const viewer = createViewer({
      host,
      videoElement,
      pageProtocol: window.location.protocol,
    });
    viewer.connect();
  }
}

// --- Exports for testing ---
// Using named exports (ESM). When loaded via <script> in the browser,
// export statements are ignored by non-module scripts.
export {
  encodeSDP,
  decodeSDP,
  buildSignalMessage,
  parseSignalMessage,
  buildWebSocketUrl,
  createViewer,
  MAX_BACKOFF,
  METADATA_TIMEOUT,
  DISCONNECT_GRACE,
  INITIAL_BACKOFF,
};
