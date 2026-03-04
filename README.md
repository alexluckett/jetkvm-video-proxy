# JetKVM Video Proxy

A minimal, zero-dependency video viewer for [JetKVM](https://jetkvm.com/) devices. Strips the full KVM UI and displays only the HDMI video feed at 100% viewport size — ideal for embedding in dashboards or iframes.

## Quick Start

### Option 1: Open directly

Open `public/index.html` in a browser with a `?host=` parameter:

```
public/index.html?host=<JETKVM_IP>
```

### Option 2: Docker

```bash
docker run -d -p 8080:80 ghcr.io/alexluckett/jetkvm-video-proxy:latest
```

Then open `http://localhost:8080/?host=<JETKVM_IP>`

## Usage

### Query Parameters

| Parameter | Required | Default | Description                  |
|-----------|----------|---------|------------------------------|
| `host`    | **Yes**  | none    | JetKVM device IP or hostname |

### Iframe Embedding

```html
<iframe
  src="http://your-server:8080/?host=<JETKVM_IP>"
  style="width: 100%; height: 100%; border: none;"
  allow="autoplay"
></iframe>
```

## How It Works

1. Opens a WebSocket to the JetKVM signalling endpoint (`/webrtc/signaling/client`)
2. Receives device metadata, then creates a WebRTC offer (video receive-only)
3. Exchanges SDP and ICE candidates with the device
4. Renders the H.264 video stream in a full-viewport `<video>` element

No keyboard, mouse, or control signals are sent. This is a view-only connection.

## Features

- **Zero dependencies** — single HTML file with inline CSS and JS
- **Auto-reconnect:** exponential backoff (1s to 30s) on connection loss
- **Cross-origin:** works when served from a different host than the JetKVM device
- **Stretch-to-fill:** video uses `object-fit: fill` to cover the entire viewport

## Requirements

- JetKVM device running firmware v0.4+ with WebRTC support
- Modern browser with WebRTC support (Chrome, Firefox, Safari, Edge)
- Network access from the browser to the JetKVM device (WebSocket + WebRTC)

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Black screen, no console logs | Wrong device IP | Verify `?host=` parameter matches the JetKVM device IP |
| Black screen, "WebSocket error" in console | Device unreachable or firmware too old | Check network connectivity, ensure firmware v0.4+ |
| Video doesn't autoplay | Browser autoplay policy | Ensure `muted` attribute is present (it is by default); some browsers require a user gesture for iframes, so add `allow="autoplay"` to the iframe tag |
| No video when served over HTTPS | Mixed content blocked | Browsers block `ws://` from `https://` pages. Serve the page over HTTP, or use a reverse proxy that terminates TLS and connects to the JetKVM over plain WS internally |
| Reconnect loop every few seconds | JetKVM busy with another session | Only one WebRTC session at a time per device; close other tabs/clients |

## Architecture

```
Browser ──WebSocket──▶ JetKVM Device (:80/webrtc/signaling/client)
Browser ◀──WebRTC───▶ JetKVM Device (H.264 video, peer-to-peer)
```

The browser connects directly to the JetKVM device. No proxy server is required.
